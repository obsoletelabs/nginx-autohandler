"""Watches the nginx config folder for edits made outside this page.

This is the job of obsoletelabs/nginx-reloading, folded in: when a file changes (over an
SMB share, in openvscode, with nano in the container) the whole config is tested first
and nginx is reloaded only if the test passes. Every outcome is reported with a diff
against the last known good copy:

  test failed        nothing is reloaded; the running config keeps serving
  back to last good  the files match the last known good copy, so no reload is needed
  reloaded           the new config is live; it becomes the last known good copy
  reload failed      the test passed but nginx would not reload

Changes are found by polling, which works on bind mounts and network shares where
inotify does not. Edits are batched: the watcher waits until the files stop changing.
Writes made by this page's own Apply call accept() so they are not reported twice.
"""

import difflib
import logging
import os
import threading
import time
from pathlib import Path

import settings

log = logging.getLogger("nginx-autohandler.watcher")

IGNORED_SUFFIXES = (".swp", ".swx", ".tmp", ".bak", ".orig", ".part", "~")
MAX_FILE_BYTES = 1024 * 1024
MAX_SETTLE_ROUNDS = 30


class Watcher:
    def __init__(self, root, nginx, lock, store, report, poll=1.0, settle=1.0):
        """root: callable returning the config folder. nginx: callable running the nginx binary
        (returns (ok, output)). lock: the lock Apply holds while it writes. store: folder that
        keeps the last known good copies. report: callable(title, message, color, detail, diff, files, kind)."""
        self.root = root
        self.nginx = nginx
        self.lock = lock
        self.store = Path(store)
        self.report = report
        self.poll = poll
        self.settle = settle
        self.known = {}
        self.good = {}
        self._cache = {}  # path -> ((mtime_ns, size, inode), bytes): unchanged files are not read again
        self._thread = None

    # ------------------------------------------------------------ reading the folder

    def scan(self):
        """{relative path: bytes} for every config-like file under the root."""
        root = Path(self.root())
        found, seen = {}, set()
        for folder, dirs, names in os.walk(root):  # symlinked folders (nginx's modules) are not entered
            dirs[:] = [name for name in dirs if not name.startswith(".")]
            for name in names:
                if name.startswith(".") or name.endswith(IGNORED_SUFFIXES):
                    continue
                path = Path(folder) / name
                try:
                    stat = path.stat()
                    if not path.is_file() or stat.st_size > MAX_FILE_BYTES:
                        continue
                    signature = (stat.st_mtime_ns, stat.st_size, stat.st_ino)
                    cached = self._cache.get(path)
                    if cached is None or cached[0] != signature:
                        cached = (signature, path.read_bytes())
                        self._cache[path] = cached
                    seen.add(path)
                    found[path.relative_to(root).as_posix()] = cached[1]
                except OSError:
                    continue
        for stale in set(self._cache) - seen:
            del self._cache[stale]
        return found

    def _load_good(self):
        self.good = {}
        if self.store.is_dir():
            for path in self.store.rglob("*"):
                if path.is_file():
                    self.good[path.relative_to(self.store).as_posix()] = path.read_bytes()

    def _save_good(self, rel, content):
        target = self.store / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        self.good[rel] = content

    def _drop_good(self, rel):
        self.good.pop(rel, None)
        try:
            (self.store / rel).unlink()
        except OSError:
            pass

    # ------------------------------------------------------------ the cycle

    def start(self):
        """Take the starting picture and begin watching in the background."""
        with self.lock:
            self.known = self.scan()
            self._load_good()
            if any(rel not in self.good for rel in self.known):
                ok, _ = self.nginx("-t")
                if ok:  # a config that passes today is the baseline to compare edits with
                    for rel, content in self.known.items():
                        if rel not in self.good:
                            self._save_good(rel, content)
        self._thread = threading.Thread(target=self._loop, name="config-watcher", daemon=True)
        self._thread.start()
        return self

    def _loop(self):
        while True:
            time.sleep(self.poll)
            try:
                if not settings.get("watch_config"):
                    self.known = self.scan()  # keep up silently while switched off
                    continue
                current = self.scan()
                if current == self.known:
                    continue
                for _ in range(MAX_SETTLE_ROUNDS):  # wait for the writer to finish
                    time.sleep(self.settle)
                    again = self.scan()
                    if again == current:
                        break
                    current = again
                self.process()
            except Exception:  # the watcher must outlive any single bad cycle
                log.exception("config watcher cycle failed")

    def process(self):
        """Handle whatever differs from what has already been reported. Returns the event kind or None."""
        with self.lock:
            current = self.scan()
            changed = sorted(rel for rel in set(current) | set(self.known) if current.get(rel) != self.known.get(rel))
            if not changed:
                return None
            self.known = current
            log.info("config change detected: %s", ", ".join(changed))
            diff = self._diff(changed, current)

            ok, output = self.nginx("-t")
            if not ok:
                self.report("❌ Nginx Config Test Failed", "The configuration test failed.", 16711680,
                            output, diff, changed, "test_failed")
                return "test_failed"

            if all(current.get(rel) == self.good.get(rel) for rel in changed):
                self.report("ℹ️ Nginx Change Reverted",
                            "Configuration reverted to the last-known-good state. No reload was performed.",
                            8421504, "", "", changed, "reverted")
                return "reverted"

            if not settings.get("auto_reload"):
                self.report("ℹ️ Nginx Config Valid, Not Reloaded",
                            "The change passes the test, but automatic reloading is turned off.",
                            8421504, "", diff, changed, "not_reloaded")
                return "not_reloaded"

            reloaded, reload_output = self.nginx("-s", "reload")
            if not reloaded:
                self.report("⚠️ Nginx Reload Failed", "Nginx failed to reload.", 16776960,
                            reload_output, diff, changed, "reload_failed")
                return "reload_failed"
            for rel in changed:
                if rel in current:
                    self._save_good(rel, current[rel])
                else:
                    self._drop_good(rel)
            self.report("✅ Nginx Reloaded Successfully", "Nginx reloaded without errors.", 65280,
                        "", diff, changed, "reloaded")
            return "reloaded"

    def accept(self, good=True):
        """Treat the folder as it is now as already reported. Apply calls this after its own writes
        (good=True once nginx accepted them) so the watcher does not announce them a second time."""
        with self.lock:
            current = self.scan()
            if good:
                for rel, content in current.items():
                    if self.good.get(rel) != content:
                        self._save_good(rel, content)
                for rel in [rel for rel in self.good if rel not in current]:
                    self._drop_good(rel)
            self.known = current

    def _diff(self, changed, current):
        """A unified diff of each changed file against its last known good copy."""
        if not settings.get("send_diff"):
            return ""
        context = settings.get("diff_context")
        return "".join(
            diff_text(rel, self.good.get(rel, b"").decode("utf-8", "replace") if rel in self.good else None,
                      current[rel].decode("utf-8", "replace") if rel in current else None, context)
            for rel in changed)


def diff_text(rel, before, after, context=3):
    """Unified diff of one file. `before` or `after` is None when the file did not exist or was deleted."""
    lines = lambda text: (text or "").splitlines(keepends=True)  # noqa: E731
    parts = difflib.unified_diff(lines(before), lines(after), fromfile="/dev/null" if before is None else f"a/{rel}",
                                 tofile="/dev/null" if after is None else f"b/{rel}", n=max(0, context))
    return "".join(line if line.endswith("\n") else line + "\n" for line in parts)
