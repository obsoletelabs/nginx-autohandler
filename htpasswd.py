"""Password files for nginx basic auth, kept in the data folder (never in the config folder or git).

Passwords are stored as Apache apr1 (salted MD5, 1000 rounds) hashes, which nginx reads natively.
The plain password is never written anywhere.
"""

import hashlib
import os
import re
import secrets
import threading

import settings

USER_RE = re.compile(r"^[A-Za-z0-9._@-]{1,64}$")
SLUG_RE = re.compile(r"^[a-z0-9_]{1,60}$")
ITOA64 = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
_lock = threading.Lock()


def folder():
    return settings.DATA_DIR / "htpasswd"


def path_for(slug):
    if not SLUG_RE.match(slug or ""):
        raise ValueError("invalid site name for a password file")
    return folder() / slug


def _to64(value, count):
    out = ""
    for _ in range(count):
        out += ITOA64[value & 0x3F]
        value >>= 6
    return out


def apr1(password, salt=None):
    """The $apr1$ hash of `password` (text). `salt` is 8 characters from ./0-9A-Za-z, random by default."""
    pw = password.encode("utf-8")
    salt = salt or "".join(secrets.choice(ITOA64) for _ in range(8))
    sl = salt.encode("ascii")
    final = hashlib.md5(pw + sl + pw).digest()
    ctx = pw + b"$apr1$" + sl
    length = len(pw)
    while length > 0:
        ctx += final[:min(16, length)]
        length -= 16
    length = len(pw)
    while length:
        ctx += b"\0" if length & 1 else pw[:1]
        length >>= 1
    final = hashlib.md5(ctx).digest()
    for i in range(1000):
        part = pw if i & 1 else final
        if i % 3:
            part += sl
        if i % 7:
            part += pw
        part += final if i & 1 else pw
        final = hashlib.md5(part).digest()
    encoded = (_to64(final[0] << 16 | final[6] << 8 | final[12], 4) + _to64(final[1] << 16 | final[7] << 8 | final[13], 4)
               + _to64(final[2] << 16 | final[8] << 8 | final[14], 4) + _to64(final[3] << 16 | final[9] << 8 | final[15], 4)
               + _to64(final[4] << 16 | final[10] << 8 | final[5], 4) + _to64(final[11], 2))
    return f"$apr1${salt}${encoded}"


def users(slug):
    try:
        lines = path_for(slug).read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    return [line.split(":", 1)[0] for line in lines if ":" in line]


def set_user(slug, user, password):
    """Add the user, or change their password."""
    if not USER_RE.match(user or ""):
        raise ValueError("user names may use letters, digits and . _ @ - (up to 64 characters)")
    if not password or len(password) > 200 or "\n" in password or "\r" in password:
        raise ValueError("enter a password of up to 200 characters")
    target = path_for(slug)
    with _lock:
        try:
            lines = [line for line in target.read_text(encoding="utf-8").splitlines() if line and not line.startswith(user + ":")]
        except OSError:
            lines = []
        lines.append(f"{user}:{apr1(password)}")
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(target.name + ".tmp")
        tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
        os.chmod(tmp, 0o644)
        os.replace(tmp, target)
    return str(target)


def remove_user(slug, user):
    target = path_for(slug)
    with _lock:
        try:
            lines = target.read_text(encoding="utf-8").splitlines()
        except OSError:
            raise FileNotFoundError("no users for this site")
        kept = [line for line in lines if line and not line.startswith(user + ":")]
        if len(kept) == len([line for line in lines if line]):
            raise FileNotFoundError(f"no user named {user}")
        target.write_text("\n".join(kept) + ("\n" if kept else ""), encoding="utf-8")
