"""File bundles, include expansion and explicit exports. Never deploys or reloads."""
from copy import deepcopy
from fnmatch import fnmatchcase
import os
from pathlib import Path
import posixpath
import tempfile

from .representation import ConfigFile, Document, ModelError, config_path
from .parser import parse, render


def import_files(files: dict[str, str], *, name="Imported configuration", entrypoint=None,
                 context="http", prefix="/etc/nginx", enabled=False) -> Document:
    if not isinstance(files, dict) or not files or len(files) > 2000:
        raise ModelError("Import between 1 and 2000 text files")
    if any(not isinstance(text, str) for text in files.values()):
        raise ModelError("Imported files must contain text")
    if sum(len(text.encode("utf-8")) for text in files.values()) > 10 * 1024 * 1024:
        raise ModelError("Imports are limited to 10 MiB")
    parsed, paths = [], set()
    for raw_path, text in files.items():
        path = config_path(raw_path)
        if path in paths:
            raise ModelError(f"Duplicate normalized path: {path}")
        paths.add(path)
        parsed.append(ConfigFile(path, parse(text, path)))
    doc = Document(name=name, files=parsed, entrypoint=entrypoint or parsed[0].path,
                   context=context, prefix=prefix, enabled=enabled)
    return Document.from_dict(doc.to_dict())


def import_directory(directory, *, entrypoint=None, context="http", prefix="/etc/nginx"):
    """Read .conf files plus referenced snippet files confined to the given root.

    For a conf.d directory, synthesize an entrypoint including every .conf file.
    For a full tree containing nginx.conf, use that as the entrypoint by default.
    Absolute external includes stay unresolved and are never silently omitted.
    """
    root = Path(directory).resolve(strict=True)
    files = {}

    def read_file(path):
        resolved = path.resolve(strict=True)
        if not resolved.is_relative_to(root):
            raise ModelError(f"Include or symlink escapes the import directory: {path}")
        key = path.relative_to(root).as_posix()
        if key not in files:
            if resolved.stat().st_size > 10 * 1024 * 1024:
                raise ModelError(f"File exceeds 10 MiB: {path}")
            files[key] = resolved.read_text(encoding="utf-8-sig")
        return key

    for path in sorted(root.rglob("*.conf")):
        read_file(path)
    if not files:
        raise ModelError("No .conf files found")
    # Discover extensionless/snippet includes without reading outside root.
    inspected = set()
    while set(files) - inspected:
        key = next(iter(set(files) - inspected))
        inspected.add(key)
        for node in walk(parse(files[key], key)):
            if node.name != "include" or node.kind != "directive" or len(node.args) != 1:
                continue
            pattern = unquote(node.args[0])
            if "$" in pattern or ".." in Path(pattern).parts:
                continue
            if pattern.startswith(prefix.rstrip("/") + "/"):
                pattern = pattern[len(prefix.rstrip("/")) + 1:]
            if pattern.startswith("/"):
                continue
            for match in sorted(root.glob(pattern)):
                if match.is_file():
                    read_file(match)
    entrypoint = entrypoint or ("nginx.conf" if "nginx.conf" in files else None)
    if not entrypoint:
        entrypoint = "__workspace__.conf"
        if entrypoint in files:
            raise ModelError("Reserved synthetic entrypoint already exists; select an entrypoint")
        active = [path for path in sorted(files) if "/" not in path and path.endswith(".conf")]
        if not active:
            active = [path for path in sorted(files) if path.startswith("conf.d/") and path.count("/") == 1 and path.endswith(".conf")]
        if not active:
            raise ModelError("Select an entrypoint; no root-level or conf.d/*.conf files found")
        files[entrypoint] = "".join("include " + quote(path) + ";\n" for path in active)
    return import_files(files, name=root.name, entrypoint=entrypoint, context=context, prefix=prefix)


def walk(nodes):
    for node in nodes:
        yield node
        yield from walk(node.children)


def quote(value):
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def unquote(token):
    if len(token) >= 2 and token[0] == token[-1] and token[0] in "\"'":
        token = token[1:-1]
    # Include paths use Nginx escapes, not Python unicode_escape.
    out, i = [], 0
    while i < len(token):
        if token[i] == "\\" and i + 1 < len(token):
            i += 1
        out.append(token[i])
        i += 1
    return "".join(out)


def _absolute(path, prefix):
    return posixpath.normpath(path if path.startswith("/") else posixpath.join(prefix, path))


def include_targets(document, node):
    if len(node.args) != 1:
        return []
    pattern = _absolute(unquote(node.args[0]), document.prefix)
    if "$" in pattern:
        return []
    # Nginx globs do not match '/' with '*' or '?'.
    pattern_parts = pattern.split("/")
    matches = []
    for file in document.files:
        parts = _absolute(file.path, document.prefix).split("/")
        if len(parts) == len(pattern_parts) and all(fnmatchcase(p, g) for p, g in zip(parts, pattern_parts)):
            matches.append(file.path)
    return sorted(matches)


def effective_config(document: Document, *, strict=True) -> tuple[str, list[dict]]:
    issues = []
    expanded_count = 0

    def expand(path, stack):
        if path in stack:
            issues.append({"severity": "error", "message": "Include cycle: " + " → ".join([*stack, path]), "path": path})
            return []
        return expand_nodes(document.file(path).nodes, [*stack, path])

    def expand_nodes(nodes, stack):
        nonlocal expanded_count
        result = []
        for source in nodes:
            expanded_count += 1
            if expanded_count > 100000:
                if not any(i["message"] == "Include expansion exceeds 100,000 nodes" for i in issues):
                    issues.append({"severity": "error", "message": "Include expansion exceeds 100,000 nodes", "path": stack[-1]})
                return result
            node = deepcopy(source)
            if node.kind == "directive" and node.name == "include":
                targets = include_targets(document, node)
                if not targets:
                    issues.append({"severity": "error", "message": "Unresolved include: " + " ".join(node.args),
                                   "path": stack[-1], "node_id": node.id})
                    result.append(node)
                else:
                    for target in targets:
                        result.extend(expand(target, stack))
            else:
                if node.kind == "block":
                    node.children = expand_nodes(node.children, stack)
                result.append(node)
        return result

    nodes = expand(document.entrypoint, [])
    if strict and issues:
        raise ModelError("Cannot flatten configuration: " + "; ".join(issue["message"] for issue in issues))
    return render(nodes), issues


def generate_files(document: Document) -> dict[str, str]:
    """enabled is metadata, not a generation filter."""
    return {file.path: render(file.nodes) for file in document.files}


def write_files(document: Document, destination, *, overwrite=False, flatten=False):
    """Explicit export. Refuse traversal, symlink escape, collisions, and overwrites.

    Absolute Nginx paths are placed below the destination (etc/nginx/...). No
    export function writes back to an imported live location implicitly.
    """
    root = Path(destination).resolve()
    root.mkdir(parents=True, exist_ok=True)
    content = {"effective.conf": effective_config(document)[0]} if flatten else generate_files(document)
    plan, seen = [], set()
    for path, text in content.items():
        relative = config_path(path).lstrip("/")
        # Reject names interpreted as devices or NTFS streams on Windows.
        for part in relative.split("/"):
            if part.rstrip(" .") != part or part.split(".")[0].upper() in {"CON", "PRN", "AUX", "NUL", *{f"COM{i}" for i in range(1, 10)}, *{f"LPT{i}" for i in range(1, 10)}}:
                raise ModelError(f"Unsafe export filename: {path}")
        target = (root / relative).resolve()
        if not target.is_relative_to(root) or target == root:
            raise ModelError(f"Export path escapes destination: {path}")
        identity = os.path.normcase(str(target))
        if identity in seen:
            raise ModelError(f"Export path collision: {path}")
        seen.add(identity)
        if target.exists() and not overwrite:
            raise FileExistsError(f"Refusing to overwrite {target}")
        plan.append((target, text))
    for target, text in plan:
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n", dir=target.parent, delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(text)
        try:
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
    return [str(target) for target, _ in plan]
