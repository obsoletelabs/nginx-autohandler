"""Reading the logs: nginx's access and error logs, this app's own log, and certbot's.

The Docker image writes nginx's logs to real files (and copies them to the container's
output, so `docker logs` still shows them), which lets the editor show and search them.
Only the files listed here can be read. A log id such as `nginx/access.log` maps to a path
inside a known folder, never to a path the browser chose.
"""

import logging
import os
import re
import threading
import time
from pathlib import Path

import settings

log = logging.getLogger("nginx-autohandler.logs")

NGINX_LOG_DIR = Path(os.environ.get("NGINX_LOG_DIR", "/var/log/nginx"))
ROTATE_BYTES = int(os.environ.get("NGINX_LOG_ROTATE_BYTES") or 20 * 1024 * 1024)
MAX_LINES = 5000
MAX_READ_BYTES = 4 * 1024 * 1024
LOG_NAME = re.compile(r"^[A-Za-z0-9._-]+\.(log|txt)(\.1)?$")


def _sources():
    """{group: folder}. Folders are looked at on every call so new files show up."""
    return {
        "nginx": NGINX_LOG_DIR,
        "app": settings.DATA_DIR,
        "certbot": settings.DATA_DIR / "certbot" / "logs",
    }


def listing():
    """Readable log files: id, group, name, size in bytes, modified time."""
    found = []
    for group, folder in _sources().items():
        try:
            entries = sorted(folder.iterdir())
        except OSError:
            continue
        for path in entries:
            if not LOG_NAME.match(path.name):
                continue
            try:
                if not path.is_file():
                    continue
                stat = path.stat()
            except OSError:
                continue
            found.append({"id": f"{group}/{path.name}", "group": group, "name": path.name, "size": stat.st_size,
                          "modified": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(stat.st_mtime))})
    return found


def resolve(log_id):
    """The path for a log id, or a ValueError for anything that is not a listed log."""
    group, _, name = (log_id or "").partition("/")
    folder = _sources().get(group)
    if folder is None or not LOG_NAME.match(name):
        raise ValueError("unknown log")
    path = folder / name
    if not path.is_file():
        raise FileNotFoundError(f"{log_id} does not exist yet")
    return path


def tail(log_id, lines=300, contains=""):
    """The last `lines` lines of a log (after an optional case-insensitive text filter).

    Returns {"id", "size", "lines": [...], "truncated": bool}. Reads only the end of big files.
    """
    path = resolve(log_id)
    lines = max(1, min(int(lines), MAX_LINES))
    size = path.stat().st_size
    with open(path, "rb") as handle:
        handle.seek(max(0, size - MAX_READ_BYTES))
        raw = handle.read()
    text = raw.decode("utf-8", "replace")
    rows = text.splitlines()
    cut = size > MAX_READ_BYTES
    if cut and rows:
        rows = rows[1:]  # the first line is probably cut in half
    needle = (contains or "").strip().lower()
    if needle:
        rows = [row for row in rows if needle in row.lower()]
    return {"id": log_id, "size": size, "lines": rows[-lines:], "truncated": cut or len(rows) > lines}


def rotate_once(reopen):
    """Move any nginx log over the size limit aside (keeping one old copy) and ask nginx to reopen its files."""
    moved = False
    if ROTATE_BYTES <= 0:  # NGINX_LOG_ROTATE_BYTES=0 leaves the logs alone
        return False
    try:
        entries = list(NGINX_LOG_DIR.iterdir())
    except OSError:
        return False
    for path in entries:
        if path.suffix != ".log" or not path.is_file():
            continue
        try:
            if path.stat().st_size > ROTATE_BYTES:
                os.replace(path, path.with_name(path.name + ".1"))
                moved = True
                log.info("rotated %s", path.name)
        except OSError as exc:
            log.warning("could not rotate %s: %s", path, exc)
    if moved:
        reopen()
    return moved


def rotate_loop(reopen):
    while True:
        time.sleep(600)
        try:
            rotate_once(reopen)
        except Exception:
            log.exception("log rotation failed")


def start_rotation(reopen):
    threading.Thread(target=rotate_loop, args=(reopen,), daemon=True, name="log-rotation").start()
