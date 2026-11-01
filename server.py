#!/usr/bin/env python3
"""nginx-autohandler: web editor for nginx configs with safe apply, backups,
Cloudflare DNS, DNS-01 certificates and Discord/email notifications.

Runs next to nginx in one container (see entrypoint.sh). Standard library only,
apart from certbot, which is a system package.

Every save goes through apply_change(): snapshot the old file, write the new one,
run `nginx -t` on the whole config, reload if auto-reload is on, and put the old
file back if any step fails. An invalid config never stays on disk.
"""

import base64
import hmac
import json
import logging
import os
import shutil
import socket
import subprocess
import threading
import time
from dataclasses import asdict
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import certs
import cloudflare
import notify
import settings
from nginx_model import parse as parse_nginx
from nginx_model import render as render_nginx
from nginx_model.representation import Node

CONF_ROOT = Path(os.environ.get("NGINX_CONF_ROOT", "/etc/nginx")).resolve()
DATA_DIR = settings.DATA_DIR
BACKUP_DIR = DATA_DIR / "backups"
STATE_FILE = DATA_DIR / "state.json"

UI_PORT = int(os.environ.get("UI_PORT", "8080"))
UI_USER = os.environ.get("UI_USER", "admin")
UI_PASSWORD = os.environ.get("UI_PASSWORD", "")  # env only; empty disables login

MAX_BODY = 2 * 1024 * 1024
STATIC_DIR = Path(__file__).with_name("static")
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
}
ERROR_STATUS = [
    (PermissionError, 403),
    (FileNotFoundError, 404),
    (FileExistsError, 409),
    (IsADirectoryError, 400),
    (NotADirectoryError, 400),
    (settings.SettingError, 400),
    (certs.CertError, 400),
    (ValueError, 400),
    (cloudflare.CloudflareError, 502),
]

log = logging.getLogger("nginx-autohandler")
io_lock = threading.RLock()
dns_lock = threading.Lock()
state_lock = threading.Lock()
last_dns = {"last_run": None, "ip": None, "results": {}, "error": None}
_cf_cache = {"key": None, "client": None}


def now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def get_cf():
    """Cloudflare client for the current token, or None when no token is set."""
    token = settings.get("cloudflare_api_token")
    if not token:
        return None
    key = (token, settings.get("cloudflare_proxied"))
    if _cf_cache["key"] != key:
        _cf_cache.update(key=key, client=cloudflare.Cloudflare(*key))
    return _cf_cache["client"]


# ---------------------------------------------------------------- state

def load_state():
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"domains": [], "last_ip": None}


def save_state(state):
    with state_lock:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp = STATE_FILE.with_name(STATE_FILE.name + ".tmp")
        tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
        os.replace(tmp, STATE_FILE)


def add_domains(names):
    state = load_state()
    state["domains"] = sorted(set(state["domains"]) | set(names))
    save_state(state)


def tracked_domains():
    """Domains kept in DNS: saved in the UI, found in configs, or from CLOUDFLARE_DOMAINS."""
    env = [d.strip().lower() for d in os.environ.get("CLOUDFLARE_DOMAINS", "").split(",") if d.strip()]
    return set(load_state()["domains"]) | set(env)


# ---------------------------------------------------------------- files

def safe_path(rel_path):
    """Resolve a path under CONF_ROOT, refusing anything that escapes it."""
    target = (CONF_ROOT / (rel_path or "").lstrip("/")).resolve()
    if target != CONF_ROOT and CONF_ROOT not in target.parents:
        raise PermissionError("path is outside the nginx config root")
    return target


def rel(path):
    return "" if path == CONF_ROOT else path.relative_to(CONF_ROOT).as_posix()


def list_dir(path):
    if not path.is_dir():
        raise NotADirectoryError(f"'{rel(path)}' is not a directory")
    entries = []
    for p in sorted(path.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
        is_dir = p.is_dir()
        entries.append({
            "name": p.name,
            "path": rel(p),
            "dir": is_dir,
            "size": None if is_dir else p.stat().st_size,
        })
    return entries


def read_text(path):
    if not path.is_file():
        raise FileNotFoundError(f"'{rel(path)}' does not exist")
    if path.stat().st_size > MAX_BODY:
        raise ValueError("file is too large for the editor")
    return path.read_text(encoding="utf-8")  # UnicodeDecodeError is a ValueError


def atomic_write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name("." + path.name + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, path)


def backup_key(path):
    return rel(path).replace("/", "__")


def backups_for(path):
    """Snapshots of `path`, oldest first."""
    if not BACKUP_DIR.is_dir():
        return []
    prefix = backup_key(path) + "."
    names = sorted(name for name in os.listdir(BACKUP_DIR) if name.startswith(prefix))
    return [BACKUP_DIR / name for name in names]


def snapshot(path):
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    shutil.copy2(path, BACKUP_DIR / f"{backup_key(path)}.{stamp}")
    keep = max(1, settings.get("backup_keep"))
    for old in backups_for(path)[:-keep]:
        old.unlink(missing_ok=True)


def restore(path, old_content):
    if old_content is None:
        path.unlink(missing_ok=True)
    else:
        atomic_write(path, old_content)


# ---------------------------------------------------------------- nginx

def nginx(*args):
    proc = subprocess.run(["nginx", *args], capture_output=True, text=True, timeout=60)
    return proc.returncode == 0, (proc.stdout + proc.stderr).strip()


def server_names(content):
    """Hostnames declared with server_name in `content`."""
    try:
        nodes = parse_nginx(content)
    except ValueError:
        return []
    names = set()
    stack = list(nodes)
    while stack:
        node = stack.pop()
        stack.extend(node.children)
        if node.kind != "directive" or node.name != "server_name":
            continue
        for arg in node.args:
            host = arg.strip("'\"").lower()
            if cloudflare_hostname(host) and not host.split(".")[-1].isdigit():
                names.add(host)
    return sorted(names)


def cloudflare_hostname(host):
    return certs.HOST_RE.match(host) is not None and not host.startswith("*.")


def apply_change(path, content):
    """Write `content` to `path` (None deletes it), then test and reload.

    Restores the previous file if the test or the reload fails.
    """
    with io_lock:
        existed = path.is_file()
        old = path.read_text(encoding="utf-8") if existed else None
        if content == old:
            return {"ok": True, "saved": False, "reloaded": False, "output": "No changes to save."}

        if existed:
            snapshot(path)
        if content is None:
            path.unlink()
        else:
            atomic_write(path, content)

        ok, output = nginx("-t")
        reload_tried = False
        reloaded = False
        if ok and settings.get("auto_reload"):
            reload_tried = True
            reloaded, reload_out = nginx("-s", "reload")
            output = "\n".join(part for part in (output, reload_out) if part)
            ok = reloaded

        if not ok:
            restore(path, old)
            if reload_tried:
                nginx("-s", "reload")
            notify_safe(f"change to {rel(path)} rejected",
                        f"nginx-autohandler on {socket.gethostname()} rolled back {rel(path)}.\n\n{output}")
            return {"ok": False, "saved": False, "reloaded": False, "rolled_back": True, "output": output}

    result = {"ok": True, "saved": True, "reloaded": reloaded, "rolled_back": False, "output": output}
    if content is not None and get_cf() is not None and settings.get("cloudflare_dns_from_configs"):
        names = server_names(content)
        if names:
            add_domains(names)
            result["dns"] = sync_domains(names)
    verb = "deleted" if content is None else "saved"
    notify_safe(f"{verb} {rel(path)}", f"nginx-autohandler {verb} {rel(path)}"
                + (" and reloaded nginx." if reloaded else "."))
    return result


def notify_safe(subject, text):
    try:
        notify.send(subject, text)
    except Exception:  # notifications must never break a save
        log.exception("notification failed")


# ---------------------------------------------------------------- cloudflare

def config_domains():
    names = set()
    for conf in CONF_ROOT.rglob("*.conf"):
        if conf.is_file():
            try:
                names.update(server_names(conf.read_text(encoding="utf-8")))
            except (OSError, ValueError):
                continue
    return names


def sync_domains(domains, ip=None):
    """Point each domain's A record at `ip` (default: this host's public IP)."""
    client = get_cf()
    if client is None:
        return {"error": "Cloudflare API token is not set"}
    ip = ip or cloudflare.public_ip()
    results = {}
    for domain in sorted(domains):
        try:
            results[domain] = client.set_a(domain, ip)
        except cloudflare.CloudflareError as exc:
            log.error("DNS for %s failed: %s", domain, exc)
            results[domain] = f"error: {exc}"
    return {"ip": ip, "results": results}


def run_dns_sync():
    """Full sync: tracked domains plus every server_name found in the configs."""
    if get_cf() is None:
        return {"error": "Cloudflare API token is not set"}
    with dns_lock:
        status = {"last_run": now(), "ip": None, "results": {}, "error": None}
        try:
            domains = tracked_domains() | config_domains()
            synced = sync_domains(domains)
            status.update(ip=synced["ip"], results=synced["results"])
            state = load_state()
            state["last_ip"] = synced["ip"]
            state["domains"] = sorted(set(state["domains"]) | domains)
            save_state(state)
        except Exception as exc:  # the loop must survive; the UI shows the error
            log.exception("DNS sync failed")
            status["error"] = str(exc)
        last_dns.update(status)
        return dict(last_dns)


def dns_loop():
    """Re-check the public IP on the configured interval. Settings are read each pass."""
    while True:
        if get_cf() is not None and settings.get("cloudflare_ip_sync"):
            run_dns_sync()
        time.sleep(max(60, settings.get("cloudflare_check_interval_seconds")))


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "nginx-autohandler"

    def log_message(self, fmt, *args):
        log.info("%s %s", self.address_string(), fmt % args)

    def authorized(self):
        if not UI_PASSWORD:
            return True
        header = self.headers.get("Authorization", "")
        if not header.startswith("Basic "):
            return False
        try:
            user, _, password = base64.b64decode(header[6:]).decode("utf-8").partition(":")
        except ValueError:
            return False
        return (hmac.compare_digest(user.encode(), UI_USER.encode())
                and hmac.compare_digest(password.encode(), UI_PASSWORD.encode()))

    def send(self, status, body, content_type="application/json"):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def json(self, status, obj):
        self.send(status, json.dumps(obj))

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ValueError("request body is too large")
        data = json.loads(self.rfile.read(length) or b"{}")
        if not isinstance(data, dict):
            raise ValueError("request body must be a JSON object")
        return data

    def route(self, method):
        if not self.authorized():
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="nginx-autohandler"')
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        url = urlparse(self.path)
        if method == "GET" and (url.path == "/" or url.path.startswith("/static/")):
            return self.static(url.path)
        # A custom header forces browsers to preflight cross-site writes, which blocks CSRF.
        if method != "GET" and self.headers.get("X-Requested-With") != "nginx-autohandler":
            return self.json(403, {"error": "missing X-Requested-With header"})
        handler = ROUTES.get((method, url.path))
        if handler is None:
            return self.json(404, {"error": "not found"})
        try:
            handler(self, parse_qs(url.query))
        except Exception as exc:
            for exc_type, status in ERROR_STATUS:
                if isinstance(exc, exc_type):
                    return self.json(status, {"error": str(exc)})
            log.exception("unhandled error")
            self.json(500, {"error": "internal error, see container logs"})

    def static(self, url_path):
        name = "index.html" if url_path == "/" else url_path[len("/static/"):]
        path = (STATIC_DIR / name).resolve()
        if STATIC_DIR.resolve() not in path.parents or not path.is_file():
            return self.json(404, {"error": "not found"})
        self.send(200, path.read_bytes(), CONTENT_TYPES.get(path.suffix, "application/octet-stream"))

    def do_GET(self):
        self.route("GET")

    def do_PUT(self):
        self.route("PUT")

    def do_POST(self):
        self.route("POST")

    def do_DELETE(self):
        self.route("DELETE")


def field(body, name):
    value = body.get(name)
    if not isinstance(value, str):
        raise ValueError(f"'{name}' is required")
    return value


def get_config(h, q):
    h.json(200, {
        "auth": bool(UI_PASSWORD),
        "root": str(CONF_ROOT),
        "auto_reload": settings.get("auto_reload"),
        "backup_keep": settings.get("backup_keep"),
        "cloudflare": get_cf() is not None,
        "notify": notify.configured(),
    })


def get_tree(h, q):
    path = safe_path(q.get("path", [""])[0])
    h.json(200, {"root": str(CONF_ROOT), "path": rel(path), "entries": list_dir(path)})


def get_file(h, q):
    path = safe_path(q.get("path", [""])[0])
    h.json(200, {"path": rel(path), "content": read_text(path)})


def put_file(h, q):
    body = h.read_json()
    path = safe_path(field(body, "path"))
    if path.is_dir():
        raise IsADirectoryError(f"'{rel(path)}' is a directory")
    h.json(200, apply_change(path, field(body, "content")))


def post_file(h, q):
    body = h.read_json()
    path = safe_path(field(body, "path"))
    if path.exists():
        raise FileExistsError(f"'{rel(path)}' already exists")
    h.json(201, apply_change(path, body.get("content", "")))


def delete_file(h, q):
    path = safe_path(field(h.read_json(), "path"))
    if path == CONF_ROOT or not path.is_file():
        raise ValueError("only existing files can be deleted")
    h.json(200, apply_change(path, None))


def get_backups(h, q):
    path = safe_path(q.get("path", [""])[0])
    items = [{"name": p.name,
              "time": datetime.strptime(p.name.rsplit(".", 1)[-1], "%Y%m%d-%H%M%S-%f")
              .strftime("%Y-%m-%d %H:%M:%S")} for p in backups_for(path)]
    h.json(200, {"path": rel(path), "backups": list(reversed(items))})


def post_restore(h, q):
    body = h.read_json()
    path = safe_path(field(body, "path"))
    name = field(body, "backup")
    match = [p for p in backups_for(path) if p.name == name]
    if not match:
        raise FileNotFoundError(f"no backup named {name}")
    h.json(200, apply_change(path, match[0].read_text(encoding="utf-8")))


def post_blocks_parse(h, q):
    nodes = parse_nginx(field(h.read_json(), "content"))
    h.json(200, {"nodes": [asdict(node) for node in nodes]})


def post_blocks_render(h, q):
    raw = h.read_json().get("nodes")
    if not isinstance(raw, list):
        raise ValueError("'nodes' is required")
    nodes = [Node.from_dict(item) for item in raw]
    h.json(200, {"content": render_nginx(nodes)})


def post_test(h, q):
    ok, out = nginx("-t")
    h.json(200, {"ok": ok, "output": out})


def post_reload(h, q):
    ok, out = nginx("-t")
    if ok:
        ok, reload_out = nginx("-s", "reload")
        out = "\n".join(part for part in (out, reload_out) if part)
    h.json(200, {"ok": ok, "output": out})


def get_dns(h, q):
    h.json(200, {**last_dns, "configured": get_cf() is not None,
                 "domains": sorted(load_state()["domains"]),
                 "env_domains": sorted(tracked_domains() - set(load_state()["domains"]))})


def post_dns_domains(h, q):
    body = h.read_json()
    raw = body.get("domains", [])
    if isinstance(raw, str):
        raw = raw.replace(",", "\n").splitlines()
    domains = sorted({d.strip().lower() for d in raw if isinstance(d, str) and d.strip()})
    state = load_state()
    state["domains"] = domains
    save_state(state)
    h.json(200, {"domains": domains})


def post_dns_sync(h, q):
    if get_cf() is None:
        return h.json(400, {"error": "Cloudflare API token is not set"})
    h.json(200, run_dns_sync())


def get_settings(h, q):
    h.json(200, {"settings": settings.describe(), "notify": notify.configured(),
                 "ui_password_set": bool(UI_PASSWORD)})


def put_settings(h, q):
    settings.update(h.read_json().get("values", {}))
    if get_cf() is not None:
        certs.write_credentials()  # keep certbot's credentials file in step with the token
    else:
        certs.CREDENTIALS.unlink(missing_ok=True)  # no token, no stale copy on disk
    get_settings(h, q)


def post_notify_test(h, q):
    results = notify.send("test message", "Test from nginx-autohandler. If you can read this, the channel works.")
    if not results:
        return h.json(400, {"error": "Set a Discord webhook or SMTP host and recipients first"})
    h.json(200, {"results": results})


def get_certs(h, q):
    h.json(200, {"output": certs.list_certificates(), "staging": settings.get("acme_staging"),
                 "email": settings.get("acme_email")})


def post_certs_issue(h, q):
    body = h.read_json()
    domains = body.get("domains", [])
    if isinstance(domains, str):
        domains = domains.replace(",", "\n").splitlines()
    if not isinstance(domains, list):
        raise ValueError("'domains' must be a list")
    staging = bool(body.get("staging", settings.get("acme_staging")))
    names = certs.validate_domains(domains)
    ok, output = certs.issue(names, settings.get("acme_email"), staging)
    result = {"ok": ok, "output": output, "staging": staging, "domains": names, "dns": None}
    if ok and get_cf() is not None:
        add_domains(names)
        result["dns"] = sync_domains(names)
    notify_safe(
        f"certificate {'issued' if ok else 'failed'} for {', '.join(names)}",
        f"{'Issued' if ok else 'Failed'} ({'staging' if staging else 'production'}).\n\n{output}",
    )
    h.json(200, result)


ROUTES = {
    ("GET", "/api/config"): get_config,
    ("GET", "/api/tree"): get_tree,
    ("GET", "/api/file"): get_file,
    ("PUT", "/api/file"): put_file,
    ("POST", "/api/file"): post_file,
    ("DELETE", "/api/file"): delete_file,
    ("GET", "/api/backups"): get_backups,
    ("POST", "/api/restore"): post_restore,
    ("POST", "/api/blocks/parse"): post_blocks_parse,
    ("POST", "/api/blocks/render"): post_blocks_render,
    ("POST", "/api/test"): post_test,
    ("POST", "/api/reload"): post_reload,
    ("GET", "/api/dns"): get_dns,
    ("POST", "/api/dns/domains"): post_dns_domains,
    ("POST", "/api/dns/sync"): post_dns_sync,
    ("GET", "/api/settings"): get_settings,
    ("PUT", "/api/settings"): put_settings,
    ("POST", "/api/notify/test"): post_notify_test,
    ("GET", "/api/certs"): get_certs,
    ("POST", "/api/certs/issue"): post_certs_issue,
}


def main():
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(message)s",
    )
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not UI_PASSWORD:
        log.warning("UI_PASSWORD is empty: the editor has no login. Put an authenticating proxy in front.")
    threading.Thread(target=dns_loop, daemon=True).start()
    threading.Thread(target=certs.renew_loop, args=(notify_safe,), daemon=True).start()
    log.info("nginx-autohandler on :%s, editing %s", UI_PORT, CONF_ROOT)
    ThreadingHTTPServer(("0.0.0.0", UI_PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
