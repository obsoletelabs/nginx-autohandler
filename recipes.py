"""Block library: ready-made sections the user saves and edits, kept in the data folder.

The built-in recipes ship with the editor (nginx_model.editing.RECIPES). Anything saved here is added to them
in the palette and can be changed or deleted; a built-in is changed by saving a copy.
"""

import json
import os
import re
import secrets
import threading

import settings
from nginx_model import parse as parse_nginx

FILE = lambda: settings.DATA_DIR / "recipes.json"  # noqa: E731
SCOPES = ("main", "http", "server", "location", "events", "upstream", "stream", "any")
MAX_RECIPES = 200
MAX_SOURCE = 20_000
_lock = threading.Lock()


def _read():
    try:
        data = json.loads(FILE().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    items = data.get("recipes") if isinstance(data, dict) else None
    return [item for item in items if isinstance(item, dict)] if isinstance(items, list) else []


def _write(items):
    path = FILE()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps({"recipes": items}, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def listing():
    """Saved recipes, in the shape the palette uses (custom: true marks them as editable)."""
    return [{**item, "custom": True} for item in _read()]


def save(body):
    """Create a recipe, or replace the one with the same id. Returns the stored recipe."""
    title = str(body.get("title", "")).strip()
    source = str(body.get("source", body.get("text", ""))).strip()
    hint = str(body.get("hint", "")).strip()
    scope = str(body.get("scope", "server")).strip().lower()
    if not title or len(title) > 60:
        raise ValueError("give the block a name of up to 60 characters")
    if len(hint) > 200:
        raise ValueError("the description can be at most 200 characters")
    if scope not in SCOPES:
        raise ValueError("scope must be one of: " + ", ".join(SCOPES))
    if not source:
        raise ValueError("the block has no nginx code")
    if len(source) > MAX_SOURCE:
        raise ValueError("the block is too large")
    try:
        if not parse_nginx(source):
            raise ValueError("the block has no nginx code")
    except ValueError as exc:
        raise ValueError(f"this is not valid nginx syntax: {exc}")
    rid = str(body.get("id", "")).strip()
    if rid and not re.fullmatch(r"[a-z0-9_-]{1,40}", rid):
        raise ValueError("invalid block id")
    with _lock:
        items = _read()
        if not rid:
            rid = "my_" + secrets.token_hex(4)
        entry = {"id": rid, "title": title, "hint": hint, "scope": scope, "source": source}
        for index, item in enumerate(items):
            if item.get("id") == rid:
                items[index] = entry
                break
        else:
            if len(items) >= MAX_RECIPES:
                raise ValueError("too many saved blocks, delete some first")
            items.append(entry)
        _write(items)
    return {**entry, "custom": True}


def delete(rid):
    with _lock:
        items = _read()
        kept = [item for item in items if item.get("id") != rid]
        if len(kept) == len(items):
            raise FileNotFoundError("no saved block with that id")
        _write(kept)
