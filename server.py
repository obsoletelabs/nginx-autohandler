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
import errno
import hmac
import io
import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
import zipfile
from collections import deque
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from logging.handlers import RotatingFileHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import certs
import cloudflare
import ipsync
import gitsync
import logs
import notify
import overview
import settings
import watcher
import whoami
import workshop
from nginx_model import generate_files
from nginx_model import parse as parse_nginx
from nginx_model import render as render_nginx
from nginx_model.workspace import walk as walk_nodes

CONF_ROOT = Path(os.environ.get("NGINX_CONF_ROOT", "/etc/nginx")).resolve()
DATA_DIR = settings.DATA_DIR
BACKUP_DIR = DATA_DIR / "backups"
STATE_FILE = DATA_DIR / "state.json"

UI_PORT = int(os.environ.get("UI_PORT", "8080"))
UI_BIND = os.environ.get("UI_BIND") or "0.0.0.0"  # 127.0.0.1 keeps the editor off the network
UI_USER = os.environ.get("UI_USER", "admin")
UI_PASSWORD = os.environ.get("UI_PASSWORD", "")  # env only; empty disables login

MAX_BODY = 2 * 1024 * 1024
STATIC_DIR = Path(__file__).with_name("static")
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
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
activity = deque(maxlen=50)  # recent config events, newest first
watch = None  # the config watcher, started in main()
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


def read_exact(path):
    """File text with its line endings untouched, so a rollback writes back the same bytes."""
    with open(path, encoding="utf-8", newline="") as handle:
        return handle.read()


def atomic_write(path, content):
    """Replace a file in one step so nginx never reads half a file. The old file's mode and owner are kept,
    and a file that cannot be replaced (a single-file bind mount) is rewritten in place instead."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name("." + path.name + ".tmp")
    existing = None
    try:
        existing = path.stat()
    except OSError:
        pass
    with open(tmp, "w", encoding="utf-8", newline="") as handle:
        handle.write(content)
    if existing is not None:
        try:
            os.chmod(tmp, existing.st_mode & 0o7777)
            if hasattr(os, "chown"):
                os.chown(tmp, existing.st_uid, existing.st_gid)
        except OSError:
            pass
    try:
        os.replace(tmp, path)
    except OSError as exc:
        if exc.errno not in (errno.EBUSY, errno.EXDEV):
            tmp.unlink(missing_ok=True)
            raise
        with open(path, "w", encoding="utf-8", newline="") as handle:  # bind-mounted file: keep the same inode
            handle.write(content)
        tmp.unlink(missing_ok=True)


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
    """Run nginx. A missing binary or a hang counts as a failed test, so callers still roll back."""
    try:
        proc = subprocess.run(["nginx", *args], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, f"nginx did not run: {exc}"
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
        old = read_exact(path) if existed else None
        if content == old:
            return {"ok": True, "saved": False, "reloaded": False, "output": "No changes to save."}

        diff = file_diff(rel(path), old, content)
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
            accept_changes(False)
            report_event("❌ Nginx Config Test Failed", "The configuration test failed, so the change was rolled back.",
                         notify.RED, output, diff, [rel(path)], "rejected")
            return {"ok": False, "saved": False, "reloaded": False, "rolled_back": True, "output": output}
        accept_changes(True)

    result = {"ok": True, "saved": True, "reloaded": reloaded, "rolled_back": False, "output": output}
    if content is not None and get_cf() is not None and settings.get("cloudflare_dns_from_configs"):
        names = server_names(content)
        if names:
            add_domains(names)
            result["dns"] = sync_domains(names)
    report_applied([rel(path)], reloaded, diff)
    return result


def baseline(content):
    """The text the editor would render for `content`. Equal output means nothing changed."""
    try:
        return render_nginx(parse_nginx(content))
    except ValueError:
        return content


LIVE_CERT = re.compile(r"^/etc/letsencrypt/live/([^/]+)/fullchain\.pem$")


def wanted_certificates(contents):
    """Certificates the configs point at that are not on disk yet: {lineage: [server names]}."""
    wanted = {}
    for content in contents:
        try:
            nodes = parse_nginx(content)
        except ValueError:
            continue
        for node in walk_nodes(nodes):
            if node.kind != "block" or node.name != "server":
                continue
            names = [arg for child in node.children if child.kind == "directive" and child.name == "server_name"
                     for arg in child.args]
            for child in node.children:
                if child.kind != "directive" or child.name != "ssl_certificate" or not child.args:
                    continue
                match = LIVE_CERT.match(child.args[0].strip("'\""))
                if not match or Path(certs.CONFIG_DIR, "live", match.group(1), "fullchain.pem").exists():
                    continue
                wanted.setdefault(match.group(1), names)
    return wanted


def issue_missing_certificates(contents):
    """Issue each missing certificate for its server_name domains. Raises before anything is written."""
    issued = []
    for lineage, names in sorted(wanted_certificates(contents).items()):
        ok, output = certs.issue(names, settings.get("acme_email"), settings.get("acme_staging"), name=lineage)
        if not ok:
            raise certs.CertError(f"certificate for {lineage} failed: {certs.explain(output)}")
        issued.append(lineage)
    return issued


def apply_workspace(files, delete=()):
    """Write the editor's files that differ from disk, then test and reload once.

    A file whose rendered form matches what is already on disk is left alone, so its
    formatting stays as it was. Files named in `delete` are removed (this is how the
    editor renames and deletes). If nginx rejects the result, every file goes back,
    deleted ones included.
    """
    with io_lock:
        issued = issue_missing_certificates(files.values())
        changes = []
        for key, content in sorted(files.items()):
            path = safe_path(key)
            current = read_exact(path) if path.is_file() else None
            if current is not None and baseline(current) == content:
                continue
            changes.append((path, current, content))
        removals = []
        for key in sorted(set(delete) - set(files)):
            path = safe_path(key)
            if path == CONF_ROOT / "nginx.conf":
                raise ValueError("nginx.conf is the entry point and cannot be deleted")
            if path.is_file():
                removals.append((path, read_exact(path)))
        changed = [rel(path) for path, _, _ in changes]
        deleted = [rel(path) for path, _ in removals]
        if not changes and not removals:
            return {"ok": True, "saved": False, "reloaded": False, "rolled_back": False, "changed": [], "deleted": [],
                    "issued": issued, "output": "No changes to apply."}

        diff = "".join(file_diff(rel(path), current, content) for path, current, content in changes)
        diff += "".join(file_diff(rel(path), original, None) for path, original in removals)
        for path, current, _ in changes:
            if current is not None:
                snapshot(path)
        for path, _ in removals:
            snapshot(path)
        for path, _, content in changes:
            atomic_write(path, content)
        for path, _ in removals:
            path.unlink()

        ok, output = nginx("-t")
        reload_tried = False
        reloaded = False
        if ok and settings.get("auto_reload"):
            reload_tried = True
            reloaded, reload_out = nginx("-s", "reload")
            output = "\n".join(part for part in (output, reload_out) if part)
            ok = reloaded

        if not ok:
            for path, current, _ in changes:
                restore(path, current)
            for path, original in removals:
                restore(path, original)
            if reload_tried:
                nginx("-s", "reload")
            accept_changes(False)
            report_event("❌ Nginx Config Test Failed", "The configuration test failed, so the change was rolled back.",
                         notify.RED, output, diff, changed + deleted, "rejected")
            return {"ok": False, "saved": False, "reloaded": False, "rolled_back": True, "changed": changed,
                    "deleted": deleted, "output": output}
        accept_changes(True)

    result = {"ok": True, "saved": True, "reloaded": reloaded, "rolled_back": False, "changed": changed,
              "deleted": deleted, "issued": issued, "output": output}
    names = set()
    for _, _, content in changes:
        names.update(server_names(content))
    if names and get_cf() is not None and settings.get("cloudflare_dns_from_configs"):
        add_domains(names)
        result["dns"] = sync_domains(names)
    report_applied(changed + deleted, reloaded, diff)
    return result


def notify_safe(subject, text):
    """A plain note on every channel, sent in the background so a slow mail server never delays a save."""
    notify.fire(notify.send, subject, text)


def report_event(title, message, color, detail="", diff="", files=(), kind="info"):
    """Record a config event in the activity list and send it to Discord and email."""
    files = list(files)
    if files:
        message = f"{message}\nFiles: {', '.join(files)}"
    activity.appendleft({"time": now(), "kind": kind, "title": title, "message": message, "files": files})
    notify.fire(notify.config_event, title, message, color, detail, diff)


def report_applied(files, reloaded, diff):
    if reloaded:
        report_event("✅ Nginx Reloaded Successfully", "Nginx reloaded without errors.", notify.GREEN, "", diff,
                     files, "applied")
    else:
        report_event("✅ Config Saved", "Saved. Automatic reloading is off, so nginx was not reloaded.",
                     notify.GREY, "", diff, files, "applied")


def file_diff(rel_path, before, after):
    """Unified diff text for one file, or "" when change reports carry no diff."""
    if not settings.get("send_diff"):
        return ""
    return watcher.diff_text(rel_path, before, after, settings.get("diff_context"))


def accept_changes(good):
    """Tell the watcher the folder as it stands is what this page wrote (or restored), not an outside edit."""
    if watch is not None:
        watch.accept(good)


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
    if ip is None:
        ip, _ = whoami.lookup()
        if ip is None:
            return {"error": "could not detect the public IP: no whoami URL answered"}
    results = {}
    for domain in sorted(domains):
        try:
            results[domain] = client.set_a(domain, ip)
        except cloudflare.CloudflareError as exc:
            log.error("DNS for %s failed: %s", domain, exc)
            results[domain] = f"error: {exc}"
    return {"ip": ip, "results": results}


def remember_sync(domains, ip):
    state = load_state()
    state["last_ip"] = ip
    state["domains"] = sorted(set(state["domains"]) | set(domains))
    save_state(state)


ip_sync = ipsync.IpSync(get_cf, lambda: tracked_domains() | config_domains(), remember_sync)


def run_dns_sync():
    """Full sync: check the IP, move records, and keep tracked and config domains pointed at it."""
    return ip_sync.run()


def nginx_running():
    """True/False when nginx can be looked for, None where it cannot (no pidof, e.g. a development machine)."""
    try:
        return subprocess.run(["pidof", "nginx"], capture_output=True, timeout=10).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return None


def health_loop(interval=20):
    """Tell people when nginx is down (a broken config at start-up, a crash) and again when it is back.

    The container keeps retrying nginx on its own; this only reports. One message per outage."""
    time.sleep(25)  # the start-up scripts and the first nginx start take a moment
    reported = False
    misses = 0
    while True:
        try:
            running = nginx_running()
            if running is None:
                return
            misses = 0 if running else misses + 1
            if misses >= 2 and not reported:
                ok, output = nginx("-t")
                reason = ("The configuration test fails, so nginx cannot start. Fix it in the editor and it will "
                          "start by itself." if not ok else "The configuration passes its test, so nginx is restarting.")
                report_event("❌ Nginx Is Not Running", reason, notify.RED, output, "", (), "down")
                reported = True
            elif running and reported:
                report_event("✅ Nginx Is Running Again", "Nginx is back up.", notify.GREEN, "", "", (), "up")
                reported = False
        except Exception:  # the monitor must survive
            log.exception("health check failed")
        time.sleep(interval)


def dns_loop():
    """Check the public IP on the configured interval. Settings are read on every pass."""
    while True:
        wait = max(10, settings.get("cloudflare_check_interval_seconds"))
        if get_cf() is not None and settings.get("cloudflare_ip_sync"):
            status = run_dns_sync()
            if status.get("error") == "no whoami URL answered":
                wait = max(1, settings.get("retry_interval_seconds"))
        time.sleep(wait)


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

    def read_json(self, limit=None):
        length = int(self.headers.get("Content-Length") or 0)
        if length > (limit or MAX_BODY):
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


def get_palette(h, q):
    h.json(200, workshop.palette())


def get_workspace(h, q):
    h.json(200, workshop.load(CONF_ROOT))


def post_workspace_apply(h, q):
    body = h.read_json()
    delete = body.get("delete", [])
    if not isinstance(delete, list) or not all(isinstance(item, str) for item in delete):
        raise ValueError("'delete' must be a list of file paths")
    doc = workshop.document_from(body)
    h.json(200, apply_workspace(generate_files(doc), delete))


PREFS_FILE = DATA_DIR / "ui-prefs.json"
PREFS_MAX_BYTES = 64 * 1024


def get_prefs(h, q):
    """The editor's remembered choices (default view, per-file view, theme...). Free-form JSON."""
    try:
        prefs = json.loads(PREFS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        prefs = {}
    h.json(200, {"prefs": prefs if isinstance(prefs, dict) else {}})


def put_prefs(h, q):
    prefs = h.read_json().get("prefs")
    if not isinstance(prefs, dict):
        raise ValueError("'prefs' must be an object")
    text = json.dumps(prefs, indent=2)
    if len(text.encode("utf-8")) > PREFS_MAX_BYTES:
        raise ValueError("preferences are too large")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = PREFS_FILE.with_name(PREFS_FILE.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, PREFS_FILE)
    h.json(200, {"prefs": prefs})


def editor_route(path):
    def handler(h, q):
        h.json(200, workshop.post(path, h.read_json(), CONF_ROOT))
    return handler


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
    h.json(200, {**ip_sync.status, "configured": get_cf() is not None,
                 "ip_sync": settings.get("cloudflare_ip_sync"),
                 "persistent_ip": ipsync.read_persistent(),
                 "whoami_urls": whoami.configured(),
                 "domains": sorted(load_state()["domains"]),
                 "env_domains": sorted(tracked_domains() - set(load_state()["domains"]))})


def post_dns_verify(h, q):
    client = get_cf()
    if client is None:
        return h.json(400, {"error": "Cloudflare API token is not set"})
    ok, message = client.verify()
    h.json(200, {"ok": ok, "message": message})


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


def post_dns_set_ip(h, q):
    """Point domains at an IP you choose (for people who don't use dynamic DNS). Defaults to every listed domain."""
    import ipaddress
    body = h.read_json()
    try:
        ip = str(ipaddress.ip_address(str(body.get("ip", "")).strip()))
    except ValueError:
        return h.json(400, {"error": "enter a valid IPv4 or IPv6 address"})
    raw = body.get("domains")
    if raw is None:
        domains = sorted(tracked_domains())
    else:
        if isinstance(raw, str):
            raw = raw.replace(",", "\n").splitlines()
        domains = sorted({d.strip().lower() for d in raw if isinstance(d, str) and d.strip()})
    if not domains:
        return h.json(400, {"error": "no domains to update. Add a domain first."})
    if get_cf() is None:
        return h.json(400, {"error": "Cloudflare API token is not set"})
    result = sync_domains(domains, ip)
    if "results" in result:
        remember_sync(domains, ip)
    h.json(200, result)


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


SAMPLE_DIFF = ("--- a/nginx.conf\n+++ b/nginx.conf\n@@ -1,3 +1,3 @@\n worker_processes auto;\n"
               "-worker_connections 512;\n+worker_connections 1024;\n")


def post_notify_test(h, q):
    """Send a sample message. kind: note (default), ip (an IP change email) or config (a change report)."""
    kind = h.read_json().get("kind", "note")
    if kind == "ip":
        results = notify.ip_changed("203.0.113.10", "203.0.113.11", "test whoami",
                                    {"test.example.com": "updated", "broken.example.com": "error: sample failure"})
    elif kind == "config":
        results = notify.config_event("✅ Nginx Reloaded Successfully", "This is a sample of a config change report.",
                                      notify.GREEN, "", SAMPLE_DIFF)
    elif kind == "note":
        results = notify.send("test message", "Test from nginx-autohandler. If you can read this, the channel works.")
    else:
        raise ValueError("kind must be note, ip or config")
    if not results:
        return h.json(400, {"error": "Set a Discord webhook or SMTP host and recipients first"})
    h.json(200, {"results": results})


_nginx_version = {}


def nginx_info(run_test):
    """Facts about the nginx process for the overview. The config test only runs when asked."""
    if "text" not in _nginx_version:
        proc = subprocess.run(["nginx", "-v"], capture_output=True, text=True, timeout=10) if shutil.which("nginx") else None
        _nginx_version["text"] = (proc.stderr or proc.stdout).strip().replace("nginx version: ", "") if proc else ""
    info = {"version": _nginx_version["text"], "test": None}
    if run_test:
        ok, output = nginx("-t")
        info["test"] = {"ok": ok, "output": output}
    return info


def get_overview(h, q):
    """Home page data: which configs are live, what they serve, and certificate expiry."""
    dns = {key: ip_sync.status.get(key) for key in ("ip", "last_run", "error", "source")}
    dns.update(configured=get_cf() is not None, ip_sync=settings.get("cloudflare_ip_sync"),
               persistent_ip=ipsync.read_persistent(), tracked=len(tracked_domains()))
    data = overview.build(CONF_ROOT, tracked=tracked_domains() | config_domains(), dns=dns, activity=activity,
                          nginx_info=nginx_info(q.get("test", ["0"])[0] == "1"))
    data["notify"] = notify.configured()
    h.json(200, data)


def post_config_toggle(h, q):
    """Turn a config file off by renaming it to .conf.disabled, or back on. Tested and rolled back like Apply."""
    body = h.read_json()
    enable = bool(body.get("enabled"))
    source = safe_path(field(body, "path"))
    name = source.name
    if enable:
        if not name.endswith(overview.DISABLED_SUFFIX):
            raise ValueError("that file is not disabled")
        target = source.with_name(name[:-len(overview.DISABLED_SUFFIX)])
    else:
        if not name.endswith(".conf") or source == CONF_ROOT / "nginx.conf":
            raise ValueError("only .conf files other than nginx.conf can be turned off")
        target = source.with_name(name + overview.DISABLED_SUFFIX)
    with io_lock:
        if not source.is_file():
            raise FileNotFoundError(f"{rel(source)} does not exist")
        if target.exists():
            raise ValueError(f"{rel(target)} already exists")
        os.replace(source, target)
        ok, output = nginx("-t")
        if not ok:
            os.replace(target, source)
            accept_changes(False)
            report_event("❌ Nginx Config Test Failed", "The configuration test failed, so the change was rolled back.",
                         notify.RED, output, "", [rel(source)], "rejected")
            return h.json(200, {"ok": False, "rolled_back": True, "reloaded": False, "output": output,
                                "path": rel(source)})
        reloaded = False
        if settings.get("auto_reload"):
            reloaded, reload_output = nginx("-s", "reload")
            if not reloaded:
                os.replace(target, source)
                nginx("-s", "reload")
                accept_changes(False)
                report_event("⚠️ Nginx Reload Failed", "Nginx failed to reload, so the change was rolled back.",
                             notify.YELLOW, reload_output, "", [rel(source)], "rejected")
                return h.json(200, {"ok": False, "rolled_back": True, "reloaded": False, "output": reload_output,
                                    "path": rel(source)})
        accept_changes(True)
    verb = "turned on" if enable else "turned off"
    report_event("✅ Config " + ("Enabled" if enable else "Disabled"), f"{rel(source)} was {verb}.", notify.GREEN, "", "",
                 [rel(source), rel(target)], "applied")
    h.json(200, {"ok": True, "rolled_back": False, "reloaded": reloaded, "path": rel(target), "enabled": enable,
                 "output": output})


ZIP_BODY_LIMIT = 30 * 1024 * 1024
ZIP_MAX_FILES = 1000
ZIP_MAX_FILE_BYTES = 5 * 1024 * 1024
ZIP_MAX_TOTAL_BYTES = 30 * 1024 * 1024


def read_zip(raw):
    """Text files from a zip of nginx configs: ({path: text}, [{path, reason}], stripped folder name).

    Paths are made safe (no absolute paths or ..), a single wrapping folder is removed, hidden and
    binary files are skipped, and size limits stop zip bombs. Nothing is written to disk.
    """
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        raise ValueError("that is not a valid zip file")
    entries = [info for info in archive.infolist() if not info.is_dir()]
    if len(entries) > ZIP_MAX_FILES:
        raise ValueError(f"the zip holds more than {ZIP_MAX_FILES} files")
    if sum(info.file_size for info in entries) > ZIP_MAX_TOTAL_BYTES:
        raise ValueError("the zip is too large when unpacked")
    files, skipped = {}, []
    for info in entries:
        name = info.filename.replace("\\", "/").lstrip("/")
        parts = [part for part in name.split("/") if part not in ("", ".")]
        if not parts or ".." in parts or ":" in parts[0]:
            skipped.append({"path": info.filename, "reason": "unsafe path"})
        elif parts[0] == "__MACOSX" or any(part.startswith(".") for part in parts):
            skipped.append({"path": info.filename, "reason": "hidden file"})
        elif info.file_size > ZIP_MAX_FILE_BYTES:
            skipped.append({"path": info.filename, "reason": "file is too large"})
        else:
            try:
                files["/".join(parts)] = archive.read(info).decode("utf-8-sig")
            except UnicodeDecodeError:
                skipped.append({"path": info.filename, "reason": "not a text file"})
    stripped = ""
    tops = {path.split("/", 1)[0] for path in files}
    if len(tops) == 1 and all("/" in path for path in files) and "nginx.conf" not in files:
        stripped = tops.pop()
        files = {path.split("/", 1)[1]: text for path, text in files.items()}
    return files, skipped, stripped


def post_import_zip(h, q):
    """Unpack an uploaded zip of nginx configs for the editor's import. Body: {"data": "<base64 zip>"}."""
    body = h.read_json(limit=ZIP_BODY_LIMIT)
    try:
        raw = base64.b64decode(body.get("data") or "", validate=True)
    except ValueError:
        raise ValueError("the upload was not valid base64")
    files, skipped, stripped = read_zip(raw)
    if not files:
        raise ValueError("the zip has no text files to import")
    h.json(200, {"files": files, "skipped": skipped, "stripped_folder": stripped})


def get_activity(h, q):
    """Recent config events (applied, rejected, and edits made outside the page), newest first."""
    h.json(200, {"events": list(activity), "watching": watch is not None and settings.get("watch_config")})


def get_certs(h, q):
    output = certs.list_certificates()
    listed = certs.inventory() or certs.parse_certificates(output)
    h.json(200, {"certificates": listed, "output": output, "staging": settings.get("acme_staging"),
                 "email": settings.get("acme_email"), "token_set": bool(settings.get("cloudflare_api_token")),
                 "warn_days": settings.get("cert_expiry_warn_days"),
                 "renew_days": settings.get("cert_renew_days")})


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
    result = {"ok": ok, "message": "Certificate issued." if ok else certs.explain(output), "output": output,
              "staging": staging, "domains": names, "dns": None}
    if ok and get_cf() is not None:
        add_domains(names)
        result["dns"] = sync_domains(names)
    notify_safe(
        f"certificate {'issued' if ok else 'failed'} for {', '.join(names)}",
        f"{'Issued' if ok else 'Failed'} ({'staging' if staging else 'production'}).\n\n"
        f"{result['message']}\n\n{output[-1500:]}",
    )
    h.json(200, result)


def post_certs_reissue(h, q):
    body = h.read_json()
    name = str(body.get("name", ""))
    ok, output = certs.reissue(name)
    message = (output if output.startswith("Self-signed") else "Certificate reissued.") if ok else certs.explain(output)
    notify_safe(f"certificate {'reissued' if ok else 'reissue failed'}: {name}", f"{message}\n\n{output[-1500:]}")
    h.json(200, {"ok": ok, "message": message, "output": output, "name": name})


def git_local_files():
    """{relative path: exact text} of the config folder, the files git sync looks at."""
    found = {}
    for path in sorted(CONF_ROOT.rglob("*")):
        try:
            relative = path.relative_to(CONF_ROOT).as_posix()
            if not path.is_file() or path.is_symlink() or any(part.startswith(".") for part in relative.split("/")):
                continue
            if path.stat().st_size > gitsync.MAX_FILE_BYTES or len(found) >= gitsync.MAX_FILES:
                continue
            found[relative] = read_exact(path)
        except (OSError, UnicodeDecodeError, ValueError):
            continue
    return found


def get_git(h, q):
    h.json(200, gitsync.status())


def post_git_sync(h, q):
    """Pull and/or push now. Body (optional): {"direction": "pull|push|both", "prefer": "repo"}."""
    body = h.read_json()
    if not gitsync.configured():
        return h.json(400, {"error": "set the repository URL in Settings > Git sync first"})
    direction = body.get("direction")
    if direction not in (None, "pull", "push", "both"):
        raise ValueError("'direction' must be pull, push or both")
    prefer = "repo" if body.get("prefer") == "repo" else None
    result = gitsync.sync(git_local_files, apply_workspace_files, prefer=prefer, direction=direction)
    pulled = (result.get("pull") or {}).get("pulled")
    pushed = (result.get("push") or {}).get("pushed")
    if pulled or pushed:
        activity.appendleft({"time": now(), "kind": "git", "title": "Git sync",
                             "message": f"pulled {len(pulled or [])}, pushed {len(pushed or [])} file(s)",
                             "files": list(pulled or []) + list(pushed or [])})
    h.json(200, result)


def apply_workspace_files(files):
    """Apply {path: text} from git through the same test-before-reload step the editor uses."""
    return apply_workspace(files)


def get_logs(h, q):
    """The readable log files, grouped: nginx, this app, certbot."""
    h.json(200, {"logs": logs.listing()})


def get_logs_read(h, q):
    log_id = q.get("id", [""])[0]
    try:
        lines = int(q.get("lines", ["300"])[0])
    except ValueError:
        raise ValueError("lines must be a number")
    h.json(200, logs.tail(log_id, lines, q.get("contains", [""])[0]))


def post_certs_selfsigned(h, q):
    body = h.read_json()
    domains = body.get("domains", [])
    if isinstance(domains, str):
        domains = domains.replace(",", "\n").splitlines()
    cert = certs.make_selfsigned(domains, body.get("name") or None, body.get("days", 365))
    h.json(200, {"ok": True, "message": f"Self-signed certificate '{cert['name']}' created.", "certificate": cert})


def post_certs_upload(h, q):
    body = h.read_json()
    cert = certs.store_uploaded(body.get("name") or None, body.get("certificate"), body.get("private_key"))
    h.json(200, {"ok": True, "message": f"Certificate '{cert['name']}' saved.", "certificate": cert})


def post_certs_delete(h, q):
    name = h.read_json().get("name", "")
    certs.delete_certificate(name)
    h.json(200, {"ok": True, "message": f"Certificate '{name}' deleted."})


ROUTES = {
    ("GET", "/api/config"): get_config,
    ("GET", "/api/palette"): get_palette,
    ("GET", "/api/workspace"): get_workspace,
    ("POST", "/api/workspace/apply"): post_workspace_apply,
    ("GET", "/api/prefs"): get_prefs,
    ("PUT", "/api/prefs"): put_prefs,
    ("GET", "/api/backups"): get_backups,
    ("POST", "/api/restore"): post_restore,
    ("POST", "/api/test"): post_test,
    ("POST", "/api/reload"): post_reload,
    ("GET", "/api/git"): get_git,
    ("POST", "/api/git/sync"): post_git_sync,
    ("GET", "/api/dns"): get_dns,
    ("POST", "/api/dns/domains"): post_dns_domains,
    ("POST", "/api/dns/sync"): post_dns_sync,
    ("POST", "/api/dns/set-ip"): post_dns_set_ip,
    ("POST", "/api/dns/verify"): post_dns_verify,
    ("GET", "/api/activity"): get_activity,
    ("GET", "/api/overview"): get_overview,
    ("POST", "/api/import/zip"): post_import_zip,
    ("POST", "/api/config/toggle"): post_config_toggle,
    ("GET", "/api/settings"): get_settings,
    ("PUT", "/api/settings"): put_settings,
    ("POST", "/api/notify/test"): post_notify_test,
    ("GET", "/api/certs"): get_certs,
    ("POST", "/api/certs/issue"): post_certs_issue,
    ("POST", "/api/certs/reissue"): post_certs_reissue,
    ("POST", "/api/certs/selfsigned"): post_certs_selfsigned,
    ("GET", "/api/logs"): get_logs,
    ("GET", "/api/logs/read"): get_logs_read,
    ("POST", "/api/certs/upload"): post_certs_upload,
    ("POST", "/api/certs/delete"): post_certs_delete,
}
for _path in workshop.EDITOR_POSTS:
    ROUTES[("POST", _path)] = editor_route(_path)


class ColorFormatter(logging.Formatter):
    COLORS = {"DEBUG": "\033[36m", "INFO": "\033[32m", "WARNING": "\033[33m", "ERROR": "\033[31m",
              "CRITICAL": "\033[1;31m"}

    def format(self, record):
        text = super().format(record)
        color = self.COLORS.get(record.levelname)
        return f"{color}{text}\033[0m" if color else text


def setup_logging():
    """Console log (coloured unless switched off) plus a rotating file in the data folder."""
    fmt = "%(asctime)s %(levelname)s %(message)s"
    console = logging.StreamHandler()
    console.setFormatter(ColorFormatter(fmt) if settings.get("enable_colored_logging") else logging.Formatter(fmt))
    handlers = [console]
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        file_handler = RotatingFileHandler(DATA_DIR / "log.txt", maxBytes=max(100_000, settings.get("max_log_bytes")),
                                           backupCount=1, encoding="utf-8")
        file_handler.setFormatter(logging.Formatter(fmt))
        handlers.append(file_handler)
    except OSError as exc:
        print(f"log file not available: {exc}")
    logging.basicConfig(level=getattr(logging, settings.get("log_level").upper(), logging.INFO),
                        handlers=handlers, force=True)


def main():
    global watch
    setup_logging()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not UI_PASSWORD:
        log.warning("UI_PASSWORD is empty: the editor has no login. Put an authenticating proxy in front.")
    watch = watcher.Watcher(root=lambda: CONF_ROOT, nginx=lambda *args: nginx(*args), lock=io_lock,
                            store=DATA_DIR / "last-good", report=report_event).start()
    threading.Thread(target=dns_loop, daemon=True).start()
    threading.Thread(target=health_loop, daemon=True).start()
    threading.Thread(target=gitsync.loop, args=(git_local_files, apply_workspace_files, notify_safe), daemon=True).start()
    threading.Thread(target=certs.renew_loop, args=(notify_safe,), daemon=True).start()
    logs.start_rotation(lambda: nginx("-s", "reopen"))
    log.info("nginx-autohandler on :%s, editing %s", UI_PORT, CONF_ROOT)
    class Server(ThreadingHTTPServer):
        request_queue_size = 128  # the default of 5 drops connections when the page fires many requests at once
        daemon_threads = True

    Server((UI_BIND, UI_PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
