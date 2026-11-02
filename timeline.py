"""A durable record of config events (applied, rejected, edited outside, git sync), newest last on disk.

The Activity list in memory is lost when the app restarts; this keeps the last few hundred events in the data folder
so the Lab page can show a timeline that survives restarts.
"""

import json
import os
import threading

import settings

KEEP = 500
_lock = threading.Lock()


def file():
    return settings.DATA_DIR / "timeline.jsonl"


def record(event):
    """Append one event (a dict). Never raises: losing a history line must not break a save."""
    try:
        line = json.dumps(event, ensure_ascii=False)
        with _lock:
            path = file()
            path.parent.mkdir(parents=True, exist_ok=True)
            with open(path, "a", encoding="utf-8") as handle:
                handle.write(line + "\n")
            if path.stat().st_size > KEEP * 2000:
                rows = path.read_text(encoding="utf-8").splitlines()[-KEEP:]
                tmp = path.with_name(path.name + ".tmp")
                tmp.write_text("\n".join(rows) + "\n", encoding="utf-8")
                os.replace(tmp, path)
    except OSError:
        pass


def recent(limit=200):
    """The latest events, newest first."""
    try:
        rows = file().read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    events = []
    for row in rows[-max(1, min(limit, KEEP)):]:
        try:
            item = json.loads(row)
        except ValueError:
            continue
        if isinstance(item, dict):
            events.append(item)
    return events[::-1]
