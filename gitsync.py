"""Keep the nginx config in step with a git repository (GitHub or any HTTPS git host).

Pull: files in the repository are written into the config through the editor's own apply step, so
every change is tested with `nginx -t` first, reloaded only if it passes, and rolled back if not.
A file that was edited here since the last sync and also changed in the repository is a conflict:
by default the local copy is kept and the conflict is reported.

Push: changed local files are committed to the branch. A push never forces, never deletes files from
the repository, and refuses when the repository has commits that have not been pulled yet.

Nothing here deletes anything from the config folder. Keys and certificates (*.key, *.pem, ...) and
files that contain a private key are never pushed.

The repository is cloned into this app's own data folder; the config folder is never a git checkout.
"""

import base64
import hashlib
import json
import logging
import re
import subprocess
import threading
import time
from pathlib import Path

import settings

log = logging.getLogger("nginx-autohandler.git")

REPO_DIR = settings.DATA_DIR / "git-repo"
STATE_FILE = settings.DATA_DIR / "git-sync.json"
BRANCH_RE = re.compile(r"^[A-Za-z0-9._/-]{1,100}$")
MAX_FILES = 1000
MAX_FILE_BYTES = 512 * 1024
NEVER_PUSH_SUFFIXES = (".key", ".pem", ".crt", ".cer", ".p12", ".pfx", ".jks", ".htpasswd", ".env")
lock = threading.Lock()


class GitSyncError(ValueError):
    pass


# ---------------------------------------------------------------- settings

def configured():
    return bool(settings.get("git_repo_url").strip())


def mode():
    return settings.get("git_mode")


def _url():
    url = settings.get("git_repo_url").strip()
    if not url.startswith("https://"):
        raise GitSyncError("the repository URL must start with https:// (for example https://github.com/you/nginx-config.git)")
    return url


def _branch():
    branch = settings.get("git_branch").strip() or "main"
    if not BRANCH_RE.match(branch) or ".." in branch or branch.startswith("-"):
        raise GitSyncError("the branch name is not valid")
    return branch


def _subdir():
    sub = settings.get("git_subdir").strip().strip("/")
    parts = [part for part in sub.split("/") if part]
    if any(part in (".", "..") or part.startswith(".") for part in parts):
        raise GitSyncError("the folder inside the repository must be a plain relative path")
    return "/".join(parts)


def _scrub(text):
    """Remove anything that looks like a credential from output shown to people or written to logs."""
    token = settings.get("git_token")
    if token:
        text = text.replace(token, "***")
    return re.sub(r"(https://)[^/@\s]+@", r"\1***@", text)


# ---------------------------------------------------------------- git

def _git(args, cwd=None, timeout=180, authenticated=False):
    command = ["git", "-c", "core.autocrlf=false", "-c", "core.quotepath=off", "-c", "gc.auto=0"]
    token = settings.get("git_token")
    if authenticated and token:
        basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
        command += ["-c", f"http.extraheader=Authorization: Basic {basic}"]
    env = {"GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "true", "PATH": "/usr/local/bin:/usr/bin:/bin:/sbin",
           "HOME": str(settings.DATA_DIR), "LANG": "C.UTF-8"}
    try:
        proc = subprocess.run(command + list(args), cwd=cwd or REPO_DIR, capture_output=True, text=True,
                              timeout=timeout, env=env, encoding="utf-8", errors="replace")
    except FileNotFoundError:
        raise GitSyncError("git is not installed in this image")
    except subprocess.TimeoutExpired:
        raise GitSyncError("git took too long. Check the network connection.")
    return proc.returncode == 0, _scrub((proc.stdout + proc.stderr).strip())


EXPLANATIONS = [
    ("could not read username", "The repository needs a token. Set one in Settings > Git sync."),
    ("authentication failed", "The repository rejected the token. Check it in Settings > Git sync."),
    ("invalid username or password", "The repository rejected the token. Check it in Settings > Git sync."),
    ("repository not found", "The repository was not found, or the token cannot see it."),
    ("not found", "The repository was not found, or the token cannot see it."),
    ("couldn't find remote ref", "That branch does not exist in the repository."),
    ("could not resolve host", "The container could not reach the git host. Check its network."),
    ("non-fast-forward", "The repository has newer commits. Pull first."),
    ("rejected", "The repository refused the push. Check the token can write to it and the branch is not protected."),
]


def explain(output):
    lowered = (output or "").lower()
    for needle, message in EXPLANATIONS:
        if needle in lowered:
            return message
    lines = [line.strip() for line in (output or "").splitlines() if line.strip()]
    errors = [line for line in lines if line.startswith(("fatal:", "error:"))]
    return (errors or lines or ["git failed"])[-1][:300]


def _prepare():
    """The local clone, pointed at the configured repository. Returns the remote branch's commit."""
    settings.DATA_DIR.mkdir(parents=True, exist_ok=True)
    url, branch = _url(), _branch()
    REPO_DIR.mkdir(parents=True, exist_ok=True)
    if not (REPO_DIR / ".git").exists():
        ok, output = _git(["init", "-q"])
        if not ok:
            raise GitSyncError(explain(output))
        _git(["remote", "add", "origin", url])
    _git(["remote", "set-url", "origin", url])
    ok, output = _git(["fetch", "-q", "--depth", "50", "origin", f"+refs/heads/{branch}:refs/remotes/origin/{branch}"],
                      authenticated=True)
    if not ok:
        raise GitSyncError(explain(output))
    ok, head = _git(["rev-parse", f"refs/remotes/origin/{branch}"])
    if not ok:
        raise GitSyncError("the branch could not be read after fetching")
    ok, output = _git(["checkout", "-q", "-f", "-B", "autohandler-sync", f"refs/remotes/origin/{branch}"])
    if not ok:
        raise GitSyncError(explain(output))
    return head.strip()


def _is_text_name(name):
    parts = name.split("/")
    return not any(part.startswith(".") for part in parts)


def repo_files():
    """{relative path: text} for the text files in the repository folder that is synced."""
    base = REPO_DIR / _subdir() if _subdir() else REPO_DIR
    found, skipped = {}, []
    if not base.is_dir():
        return found, skipped
    for path in sorted(base.rglob("*")):
        if not path.is_file():
            continue
        name = path.relative_to(base).as_posix()
        if not _is_text_name(name):
            continue
        if len(found) >= MAX_FILES:
            skipped.append({"path": name, "reason": "too many files"})
            continue
        try:
            if path.stat().st_size > MAX_FILE_BYTES:
                skipped.append({"path": name, "reason": "file is too large"})
                continue
            found[name] = path.read_bytes().decode("utf-8-sig")
        except (OSError, UnicodeDecodeError):
            skipped.append({"path": name, "reason": "not a text file"})
    return found, skipped


def _sha(text):
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- state

def load_state():
    try:
        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        return state if isinstance(state, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(state):
    settings.DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_name(STATE_FILE.name + ".tmp")
    tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
    tmp.replace(STATE_FILE)


def status():
    state = load_state()
    return {"configured": configured(), "mode": mode(), "branch": settings.get("git_branch") or "main",
            "subdir": settings.get("git_subdir"), "interval_minutes": settings.get("git_interval_minutes"),
            "conflicts": settings.get("git_conflicts"), "token_set": bool(settings.get("git_token")),
            "url": _scrub(settings.get("git_repo_url")), "commit": state.get("commit"),
            "last_run": state.get("last_run"), "last_result": state.get("last_result"),
            "error": state.get("error")}


# ---------------------------------------------------------------- pull

def pull(local_files, apply_files, prefer=None):
    """Bring repository changes into the config.

    local_files()  -> {relative path: exact text} of the config folder
    apply_files(d) -> the editor's apply result for {path: text} (tests, reloads, rolls back)
    prefer         -> "repo" to let the repository win conflicts this once, else the git_conflicts setting
    """
    prefer = prefer or settings.get("git_conflicts")
    head = _prepare()
    remote, skipped = repo_files()
    state = load_state()
    hashes = dict(state.get("hashes", {}))
    local = local_files()
    to_write, conflicts, unchanged = {}, [], 0
    for path, text in remote.items():
        current = local.get(path)
        if current == text:
            hashes[path] = _sha(text)
            unchanged += 1
            continue
        known = hashes.get(path)
        edited_here = current is not None and (known is None or _sha(current) != known)
        repo_changed = known is None or _sha(text) != known
        if edited_here and repo_changed and prefer != "repo":
            conflicts.append(path)
        elif edited_here and not repo_changed:
            continue  # only changed here: that is for a push, not a pull
        else:
            to_write[path] = text
    result = {"pulled": [], "conflicts": conflicts, "skipped": skipped, "unchanged": unchanged, "commit": head,
              "applied": None}
    if to_write:
        applied = apply_files(to_write)
        result["applied"] = {key: applied.get(key) for key in ("ok", "saved", "reloaded", "rolled_back", "output")}
        if not applied.get("ok"):
            raise GitSyncError("nginx did not accept the repository's files, so nothing was changed. "
                               + _scrub(str(applied.get("output", "")))[-400:])
        result["pulled"] = sorted(to_write)
        for path, text in to_write.items():
            hashes[path] = _sha(text)
    state.update({"commit": head, "hashes": hashes})
    save_state(state)
    return result


# ---------------------------------------------------------------- push

def _pushable(path, text):
    if path.lower().endswith(NEVER_PUSH_SUFFIXES) or "PRIVATE KEY" in text:
        return False
    return _is_text_name(path)


def push(local_files, message=None):
    """Commit changed local files to the branch. Never forces, never deletes repository files."""
    branch = _branch()
    head = _prepare()
    state = load_state()
    if state.get("commit") and state["commit"] != head:
        raise GitSyncError("The repository has newer commits than the last pull. Pull first, then push.")
    base = REPO_DIR / _subdir() if _subdir() else REPO_DIR
    remote, _ = repo_files()
    changed, held_back = [], []
    for path, text in sorted(local_files().items()):
        if not _pushable(path, text):
            held_back.append(path)
            continue
        if remote.get(path) == text:
            continue
        target = base / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(text.encode("utf-8"))
        changed.append(path)
    result = {"pushed": [], "held_back": held_back, "commit": head}
    if not changed:
        return result
    name = settings.get("git_author_name").strip() or "nginx-autohandler"
    email = settings.get("git_author_email").strip() or "nginx-autohandler@users.noreply.github.com"
    ok, output = _git(["add", "-A", "--", _subdir() or "."])
    if not ok:
        raise GitSyncError(explain(output))
    subject = message or f"Update nginx config ({len(changed)} file{'s' if len(changed) != 1 else ''})"
    ok, output = _git(["-c", f"user.name={name}", "-c", f"user.email={email}", "commit", "-q", "-m", subject,
                       "-m", "Files:\n" + "\n".join(changed[:50])])
    if not ok:
        raise GitSyncError(explain(output))
    ok, output = _git(["push", "origin", f"HEAD:refs/heads/{branch}"], authenticated=True)
    if not ok:
        raise GitSyncError(explain(output))
    ok, new_head = _git(["rev-parse", "HEAD"])
    state = load_state()
    hashes = dict(state.get("hashes", {}))
    local = local_files()
    for path in changed:
        hashes[path] = _sha(local[path])
    state.update({"commit": new_head.strip() if ok else head, "hashes": hashes})
    save_state(state)
    result.update({"pushed": changed, "commit": state["commit"]})
    return result


# ---------------------------------------------------------------- the whole cycle

def sync(local_files, apply_files, prefer=None, direction=None):
    """Pull and/or push per the Mode setting (or `direction`: pull, push, both). Returns the result and records it."""
    direction = direction or mode()
    with lock:
        result, error = {}, None
        try:
            if direction in ("pull", "both"):
                result["pull"] = pull(local_files, apply_files, prefer)
            if direction in ("push", "both"):
                result["push"] = push(local_files)
        except GitSyncError as exc:
            error = str(exc)
        except Exception as exc:  # keep the loop alive and show the cause
            log.exception("git sync failed")
            error = f"unexpected error: {exc}"
        state = load_state()
        state.update({"last_run": time.strftime("%Y-%m-%d %H:%M:%S"), "last_result": result, "error": error})
        save_state(state)
        if error:
            log.warning("git sync: %s", error)
        return {"ok": error is None, "error": error, **result}


def loop(local_files, apply_files, notify):
    """Sync every GIT_INTERVAL_MINUTES (0 = only when asked). Tells people about conflicts and failures once."""
    time.sleep(60)
    last_error = None
    while True:
        minutes = settings.get("git_interval_minutes")
        if minutes > 0 and configured():
            outcome = sync(local_files, apply_files)
            problem = outcome.get("error")
            conflicts = (outcome.get("pull") or {}).get("conflicts") or []
            if problem and problem != last_error:
                notify("git sync failed", problem)
            elif conflicts:
                notify("git sync found conflicts",
                       "These files changed here and in the repository, so the local copy was kept:\n"
                       + "\n".join(conflicts))
            pulled = (outcome.get("pull") or {}).get("pulled")
            if pulled:
                notify("git sync pulled changes", "Updated from the repository:\n" + "\n".join(pulled))
            last_error = problem
        time.sleep(max(60, minutes * 60) if minutes > 0 else 60)
