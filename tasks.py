"""A small list of long-running jobs (issuing a certificate, a git sync, a DNS update), for the Tasks panel.

Jobs register themselves with `track()`. The list lives in memory only: it shows what is running now and
the last few finished jobs since the app started.
"""

import collections
import contextlib
import itertools
import threading
import time

_lock = threading.Lock()
_ids = itertools.count(1)
_tasks = collections.deque(maxlen=40)
STAMP = "%Y-%m-%d %H:%M:%S"


def _now():
    return time.strftime(STAMP)


class Task:
    def __init__(self, kind, title, detail=""):
        self.data = {"id": next(_ids), "kind": kind, "title": title, "state": "running", "started": _now(),
                     "finished": None, "detail": detail, "error": "", "seconds": 0}
        self._began = time.monotonic()

    def note(self, detail):
        with _lock:
            self.data["detail"] = detail

    def fail(self, message):
        """Mark the job failed without raising (for results that report ok: false)."""
        with _lock:
            self.data["state"] = "failed"
            self.data["error"] = str(message)[:2000]


@contextlib.contextmanager
def track(kind, title, detail=""):
    """Register a job for the duration of the with block. An exception marks it failed and propagates."""
    task = Task(kind, title, detail)
    with _lock:
        _tasks.appendleft(task)
    try:
        yield task
    except BaseException as exc:
        with _lock:
            task.data["state"] = "failed"
            task.data["error"] = str(exc)[:2000] or exc.__class__.__name__
        raise
    finally:
        with _lock:
            task.data["finished"] = _now()
            task.data["seconds"] = round(time.monotonic() - task._began, 1)
            if task.data["state"] == "running":
                task.data["state"] = "done"


def snapshot():
    with _lock:
        items = []
        for task in _tasks:
            data = dict(task.data)
            if data["state"] == "running":
                data["seconds"] = round(time.monotonic() - task._began, 1)
            items.append(data)
    return {"running": sum(1 for item in items if item["state"] == "running"), "tasks": items}
