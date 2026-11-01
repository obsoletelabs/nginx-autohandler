"""The overview behind the home page: which configs are live, which sites and domains they serve,
and when their certificates expire.

A config file is *enabled* when nginx would load it: it is nginx.conf itself, or it is pulled in
by an `include` from an enabled file. A `.conf` nobody includes, or a file renamed to
`.conf.disabled`, is *disabled*. The picture is built from the files on disk, not from the
editor's unsaved text.
"""

import fnmatch
import logging
import time
from pathlib import Path

import certs
import settings
from nginx_model import parse
from nginx_model.workspace import unquote, walk

log = logging.getLogger("nginx-autohandler.overview")

HOST_PREFIX = "/etc/nginx"
DISABLED_SUFFIX = ".disabled"
MAX_FILE_BYTES = 2 * 1024 * 1024


def _read(path):
    try:
        if path.stat().st_size > MAX_FILE_BYTES:
            return None, "file is too large to inspect"
        return path.read_text(encoding="utf-8-sig"), None
    except (OSError, UnicodeDecodeError) as exc:
        return None, f"could not read: {exc}"


def config_files(root):
    """{relative path: absolute path} for every .conf and .conf.disabled file under root."""
    found = {}
    for pattern in ("*.conf", "*.conf" + DISABLED_SUFFIX):
        for path in sorted(root.rglob(pattern)):
            if path.is_file():
                found[path.relative_to(root).as_posix()] = path
    return found


def _include_matches(pattern, root, known):
    """Relative paths in `known` that an include pattern selects."""
    pattern = unquote(pattern)
    if "$" in pattern:
        return []
    if pattern.startswith(HOST_PREFIX + "/"):
        pattern = pattern[len(HOST_PREFIX) + 1:]
    elif pattern.startswith("/"):
        return []
    parts = pattern.split("/")
    return [name for name in known if len(name.split("/")) == len(parts)
            and all(fnmatch.fnmatchcase(part, glob) for part, glob in zip(name.split("/"), parts))]


def enabled_graph(root, parsed):
    """{path: [files that include it]} for every file nginx would load, starting at nginx.conf."""
    if "nginx.conf" not in parsed:  # a conf.d style folder: everything that is not renamed is live
        return {name: [] for name in parsed if not name.endswith(DISABLED_SUFFIX)}
    live = {"nginx.conf": []}
    visited = set()
    queue = ["nginx.conf"]
    candidates = [name for name in parsed if not name.endswith(DISABLED_SUFFIX)]
    while queue:
        current = queue.pop()
        if current in visited:  # include cycles end here
            continue
        visited.add(current)
        for node in walk(parsed[current] or []):
            if node.kind != "directive" or node.name != "include" or len(node.args) != 1:
                continue
            for match in _include_matches(node.args[0], root, candidates):
                if match == current:
                    continue
                includers = live.setdefault(match, [])
                if current not in includers:
                    includers.append(current)
                if match not in visited:
                    queue.append(match)
    return live


def _directive_args(block, name):
    return [node.args for node in block.children if node.kind == "directive" and node.name == name]


def _server_summary(block, inventory, warn_days):
    names = [arg.strip("'\"") for args in _directive_args(block, "server_name") for arg in args]
    listens = [" ".join(args) for args in _directive_args(block, "listen")]
    locations = [node for node in walk(block.children) if node.kind == "block" and node.name == "location"]
    proxies = sorted({args[0] for node in [block, *locations]
                      for args in _directive_args(node, "proxy_pass") if args})
    returns = [" ".join(args) for node in [block, *locations] for args in _directive_args(node, "return")][:2]
    roots = [args[0] for args in _directive_args(block, "root") if args]
    cert_paths = [args[0].strip("'\"") for args in _directive_args(block, "ssl_certificate") if args]
    summary = {"names": names, "listen": listens, "ssl": bool(cert_paths) or any("ssl" in item.split() for item in listens),
               "proxy": proxies, "root": roots[:1], "returns": returns, "locations": len(locations), "cert": None}
    if cert_paths:
        summary["cert"] = describe_certificate_path(cert_paths[0], inventory, warn_days)
    return summary


def describe_certificate_path(path, inventory, warn_days):
    """What the overview shows for an ssl_certificate path: kind, expiry and a state word."""
    for item in inventory:
        if item["path"] == path:
            return _cert_view(path, item, warn_days)
    target = Path(path)
    try:
        exists = target.is_file() and target.stat().st_size < certs.MAX_PEM
    except OSError:
        exists = False
    if not exists:
        return {"path": path, "state": "missing", "name": target.parent.name, "kind": None, "expires": "", "days_left": None}
    try:
        info = certs.describe_certificate(target.read_text(encoding="utf-8"))
    except OSError:
        info = None
    if info is None:
        return {"path": path, "state": "unknown", "name": target.parent.name, "kind": None, "expires": "", "days_left": None}
    return _cert_view(path, {"name": target.parent.name, "kind": "uploaded", **info}, warn_days)


def _cert_view(path, item, warn_days):
    days = item.get("days_left")
    if days is None:
        state = "unknown"
    elif days <= 0:
        state = "expired"
    elif warn_days > 0 and days <= warn_days:
        state = "soon"
    else:
        state = "ok"
    return {"path": path, "name": item.get("name", ""), "kind": item.get("kind"), "expires": item.get("expires", ""),
            "days_left": days, "state": state, "issuer": item.get("issuer", ""), "staging": item.get("staging", False)}


def build(root, tracked=(), dns=None, activity=(), nginx_info=None):
    """The whole overview as a dict the home page renders."""
    root = Path(root)
    warn_days = settings.get("cert_expiry_warn_days")
    inventory = certs.inventory()
    paths = config_files(root)
    parsed, errors = {}, {}
    for name, path in paths.items():
        text, problem = _read(path)
        if text is None:
            parsed[name], errors[name] = None, problem
            continue
        try:
            parsed[name] = parse(text, name)
        except ValueError as exc:
            parsed[name], errors[name] = None, f"syntax problem: {exc}"
    live = enabled_graph(root, parsed)

    files, domains = [], {}
    for name in sorted(paths):
        enabled = name in live
        if name.endswith(DISABLED_SUFFIX):
            reason = "renamed to .disabled"
        elif name == "nginx.conf":
            reason = "entry point"
        elif enabled:
            reason = "included by " + ", ".join(live[name]) if live[name] else "loaded"
        else:
            reason = "not included by any enabled file"
        servers = []
        for node in walk(parsed[name] or []):
            if node.kind == "block" and node.name == "server":
                servers.append(_server_summary(node, inventory, warn_days))
        try:
            modified = time.strftime("%Y-%m-%d %H:%M", time.localtime(paths[name].stat().st_mtime))
        except OSError:
            modified = ""
        role = "main" if name == "nginx.conf" else "site" if servers else "snippet"
        entry = {"path": name, "enabled": enabled, "role": role, "reason": reason, "error": errors.get(name), "servers": servers,
                 "modified": modified, "can_toggle": name != "nginx.conf" and (name.endswith(".conf") or name.endswith(".conf" + DISABLED_SUFFIX))}
        files.append(entry)
        for server in servers:
            for host in server["names"]:
                if host in ("_", "") or host.startswith("~"):
                    continue
                item = domains.setdefault(host, {"name": host, "files": [], "enabled": False, "cert": None,
                                                 "dns": host in set(tracked)})
                if name not in item["files"]:
                    item["files"].append(name)
                item["enabled"] = item["enabled"] or enabled
                if server["cert"] and (item["cert"] is None or enabled):
                    item["cert"] = server["cert"]

    cert_states = [view["cert"] for view in domains.values() if view["cert"]]
    dated = [item for item in inventory if item["days_left"] is not None]
    soonest = min(dated, key=lambda item: item["days_left"], default=None)
    return {
        "generated": time.strftime("%Y-%m-%d %H:%M:%S"),
        "nginx": nginx_info or {},
        "files": files,
        "domains": sorted(domains.values(), key=lambda item: item["name"]),
        "counts": {"files": len(files), "enabled": sum(1 for item in files if item["enabled"]),
                   "disabled": sum(1 for item in files if not item["enabled"]),
                   "servers": sum(len(item["servers"]) for item in files if item["enabled"]),
                   "domains": len(domains),
                   "certs_attention": sum(1 for item in cert_states if item["state"] in ("soon", "expired", "missing"))},
        "certificates": {"total": len(inventory), "warn_days": warn_days,
                         "soonest": None if soonest is None else {"name": soonest["name"], "days_left": soonest["days_left"],
                                                                  "expires": soonest["expires"], "kind": soonest["kind"]},
                         "items": inventory},
        "dns": dns or {},
        "activity": list(activity)[:8],
        "settings": {"auto_reload": settings.get("auto_reload"), "watch_config": settings.get("watch_config"),
                     "acme_provider": settings.get("acme_provider"), "acme_staging": settings.get("acme_staging")},
    }
