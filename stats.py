"""Request statistics from nginx's access log (the default combined / "main" format).

Reads the end of the file only (a few megabytes), so it stays quick on busy servers.
"""

import calendar
import re
import time
from collections import Counter

import logs

LINE = re.compile(r'^(\S+) \S+ \S+ \[([^\]]+)\] "([^"]*)" (\d{3}) (\d+|-) "([^"]*)" "([^"]*)"')
MONTHS = {name: number for number, name in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}
READ_BYTES = 6 * 1024 * 1024
BOT = re.compile(r"bot|crawl|spider|slurp|curl|wget|python-requests|go-http|monitor|uptime", re.I)


def when(stamp):
    """Epoch seconds for a $time_local value like 02/Nov/2026:12:44:35 +0100, or None."""
    try:
        day, month, rest = stamp[0:2], stamp[3:6], stamp[7:]
        year, hour, minute, second = int(rest[0:4]), int(rest[5:7]), int(rest[8:10]), int(rest[11:13])
        offset = rest[14:19]
        seconds = calendar.timegm((year, MONTHS[month], int(day), hour, minute, second))
        sign = -1 if offset[0] == "-" else 1
        return seconds - sign * (int(offset[1:3]) * 3600 + int(offset[3:5]) * 60)
    except (ValueError, KeyError, IndexError):
        return None


def parse_line(line):
    match = LINE.match(line)
    if not match:
        return None
    ip, stamp, request, status, size, referer, agent = match.groups()
    parts = request.split(" ")
    method = parts[0] if parts else ""
    path = parts[1].split("?", 1)[0] if len(parts) > 1 else request
    return {"ip": ip, "time": when(stamp), "method": method, "path": path, "status": int(status),
            "bytes": 0 if size == "-" else int(size), "agent": agent}


def summarize(lines, now=None, hours=24):
    """Aggregate access-log lines. Lines outside the last `hours` hours are ignored."""
    now = now or time.time()
    hours = max(1, min(int(hours), 24 * 14))
    start = now - hours * 3600
    status, methods, paths, ips, bots = Counter(), Counter(), Counter(), Counter(), Counter()
    per_hour = Counter()
    errors_per_hour = Counter()
    recent_errors, total, size, recent_minute, skipped = [], 0, 0, 0, 0
    for line in lines:
        entry = parse_line(line)
        if entry is None:
            skipped += 1
            continue
        if entry["time"] is None or entry["time"] < start or entry["time"] > now + 300:
            continue
        total += 1
        size += entry["bytes"]
        klass = f"{entry['status'] // 100}xx"
        status[klass] += 1
        methods[entry["method"]] += 1
        paths[entry["path"]] += 1
        ips[entry["ip"]] += 1
        if BOT.search(entry["agent"]):
            bots["bots and tools"] += 1
        bucket = int(entry["time"] // 3600)
        per_hour[bucket] += 1
        if entry["status"] >= 500:
            errors_per_hour[bucket] += 1
            recent_errors.append({"time": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(entry["time"])), "ip": entry["ip"],
                                  "path": entry["path"], "status": entry["status"]})
        if entry["time"] >= now - 300:
            recent_minute += 1
    last_bucket = int(now // 3600)
    series = [{"hour": time.strftime("%H:00", time.localtime(bucket * 3600)), "start": bucket * 3600,
               "requests": per_hour.get(bucket, 0), "errors": errors_per_hour.get(bucket, 0)}
              for bucket in range(last_bucket - hours + 1, last_bucket + 1)]
    return {"window_hours": hours, "total": total, "bytes": size, "skipped_lines": skipped,
            "status": dict(sorted(status.items())), "methods": dict(methods.most_common(8)),
            "top_paths": paths.most_common(10), "top_ips": ips.most_common(10),
            "bots": bots.get("bots and tools", 0), "series": series,
            "last_five_minutes": recent_minute, "recent_errors": recent_errors[-10:][::-1]}


def read_lines(log_id):
    path = logs.resolve(log_id)
    size = path.stat().st_size
    with open(path, "rb") as handle:
        handle.seek(max(0, size - READ_BYTES))
        raw = handle.read()
    rows = raw.decode("utf-8", "replace").splitlines()
    return rows[1:] if size > READ_BYTES and rows else rows


def error_summary(log_id="nginx/error.log", limit=6):
    """Counts of each severity and the latest few messages from nginx's error log."""
    try:
        rows = read_lines(log_id)
    except (OSError, ValueError):
        return {"counts": {}, "latest": []}
    counts, latest = Counter(), []
    for row in rows:
        match = re.search(r"\[(warn|error|crit|alert|emerg)\]", row)
        if match:
            counts[match.group(1)] += 1
            latest.append(row[:300])
    return {"counts": dict(counts), "latest": latest[-limit:][::-1]}


def access_logs():
    return [item["id"] for item in logs.listing() if item["group"] == "nginx" and "access" in item["name"] and item["name"].endswith(".log")]


def report(log_id="nginx/access.log", hours=24):
    if log_id not in access_logs() and log_id != "nginx/access.log":
        raise ValueError("unknown access log")
    try:
        lines = read_lines(log_id)
    except FileNotFoundError:
        lines = []
    data = summarize(lines, hours=hours)
    data["log"] = log_id
    data["logs"] = access_logs() or ["nginx/access.log"]
    data["error_log"] = error_summary()
    return data
