"""Versioned JSON representation. No implicit Nginx defaults are introduced."""
from dataclasses import dataclass, field, asdict
import json
from pathlib import PurePosixPath
from uuid import uuid4

SCHEMA_VERSION = 1
CONTEXTS = {"main", "http", "stream", "mail", "server", "location"}


class ModelError(ValueError):
    pass


def new_id():
    return str(uuid4())


@dataclass
class Node:
    kind: str
    name: str = ""
    args: list[str] = field(default_factory=list)
    children: list["Node"] = field(default_factory=list)
    text: str = ""
    id: str = field(default_factory=new_id)
    line: int | None = None
    inline: bool = False  # a comment written on the same line as the directive or block before it
    end_line: int | None = None  # line of the closing ; or }, so a comment after it stays there

    @classmethod
    def from_dict(cls, value, depth=0, seen=None):
        from .parser import lex
        if depth > 100:
            raise ModelError("Blocks are nested too deeply")
        if not isinstance(value, dict):
            raise ModelError("Each node must be an object")
        allowed = {"kind", "name", "args", "children", "text", "id", "line", "end_line", "inline"}
        if set(value) - allowed:
            raise ModelError(f"Unknown node fields: {sorted(set(value) - allowed)}")
        kind = value.get("kind")
        if kind not in {"block", "directive", "comment"}:
            raise ModelError("Node kind must be block, directive or comment")
        node_id = value.get("id", new_id())
        if not isinstance(node_id, str) or not node_id or len(node_id) > 200:
            raise ModelError("Node id must be a nonempty string")
        if seen is None:
            seen = set()
        if node_id in seen:
            raise ModelError(f"Duplicate node id: {node_id}")
        seen.add(node_id)
        name, args, text = value.get("name", ""), value.get("args", []), value.get("text", "")
        children = value.get("children", [])
        if not isinstance(args, list) or not isinstance(children, list) or not isinstance(text, str):
            raise ModelError("args and children must be arrays; text must be a string")
        if kind == "comment":
            if not text.startswith("#") or "\n" in text or "\r" in text:
                raise ModelError("Comments must be one line beginning with #")
            if name or args or children:
                raise ModelError("Comments cannot contain directives or children")
        else:
            if not isinstance(name, str) or not name or text:
                raise ModelError("Directives need a name and cannot contain comment text")
            for word in [name, *args]:
                if not isinstance(word, str) or not word:
                    raise ModelError("Arguments are nonempty Nginx token strings; use '\"\"' for an empty value")
                tokens = lex(word)
                if len(tokens) != 1 or tokens[0].kind != "word" or tokens[0].text != word:
                    raise ModelError(f"Not a single Nginx token: {word!r}. Quote values containing spaces.")
            if kind != "block" and children:
                raise ModelError("Only blocks can contain children")
        line = value.get("line")
        if line is not None and (type(line) is not int or line < 1):
            raise ModelError("Source line must be a positive integer")
        if not isinstance(value.get("inline", False), bool):
            raise ModelError("Comment placement must be true or false")
        end_line = value.get("end_line")
        if end_line is not None and (type(end_line) is not int or end_line < 1):
            raise ModelError("Source end line must be a positive integer")
        return cls(kind=kind, name=name, args=args, text=text, id=node_id, line=line, end_line=end_line, inline=value.get("inline", False),
                   children=[cls.from_dict(child, depth + 1, seen) for child in children])


@dataclass
class ConfigFile:
    path: str
    nodes: list[Node] = field(default_factory=list)


def config_path(path):
    if not isinstance(path, str) or not path or "\x00" in path or "\\" in path or ":" in path:
        raise ModelError("File paths must use POSIX Nginx paths (no drive letters or backslashes)")
    if ".." in PurePosixPath(path).parts or path.endswith("/") or path == "/":
        raise ModelError("File paths cannot contain '..' or refer to a directory")
    return str(PurePosixPath(path))


@dataclass
class Document:
    name: str = "Untitled configuration"
    files: list[ConfigFile] = field(default_factory=list)
    entrypoint: str = "site.conf"
    context: str = "http"
    prefix: str = "/etc/nginx"
    enabled: bool = False  # Deployment intent only. Generation never depends on this.
    id: str = field(default_factory=new_id)
    schema_version: int = SCHEMA_VERSION
    revision: int = 0

    def to_dict(self):
        return asdict(self)

    def to_json(self):
        return json.dumps(self.to_dict(), indent=2, ensure_ascii=False)

    @classmethod
    def from_json(cls, text):
        return cls.from_dict(json.loads(text))

    @classmethod
    def from_dict(cls, value):
        if not isinstance(value, dict):
            raise ModelError("A document must be a JSON object")
        allowed = set(cls.__dataclass_fields__)
        if set(value) - allowed:
            raise ModelError(f"Unknown document fields: {sorted(set(value) - allowed)}")
        if type(value.get("schema_version")) is not int or value["schema_version"] != SCHEMA_VERSION:
            raise ModelError(f"Expected schema_version {SCHEMA_VERSION}; migrate other schemas explicitly")
        doc_id = value.get("id", new_id())
        try:
            from uuid import UUID
            UUID(doc_id)
        except (ValueError, TypeError, AttributeError):
            raise ModelError("Document id must be a UUID") from None
        if type(value.get("enabled", False)) is not bool:
            raise ModelError("enabled must be a boolean")
        revision = value.get("revision", 0)
        if type(revision) is not int or revision < 0:
            raise ModelError("revision must be a nonnegative integer")
        if value.get("context", "http") not in CONTEXTS:
            raise ModelError(f"context must be one of {sorted(CONTEXTS)}")
        prefix = value.get("prefix", "/etc/nginx")
        if not isinstance(prefix, str) or not prefix.startswith("/"):
            raise ModelError("prefix must be an absolute POSIX directory")
        config_path(prefix.rstrip("/") + "/placeholder")
        name = value.get("name", "Untitled configuration")
        if not isinstance(name, str) or not name.strip():
            raise ModelError("Document name must not be empty")
        files, seen, paths, absolute_paths = [], set(), set(), set()
        raw_files = value.get("files")
        if not isinstance(raw_files, list) or not raw_files:
            raise ModelError("A document needs at least one file")
        for raw_file in raw_files:
            if not isinstance(raw_file, dict) or set(raw_file) != {"path", "nodes"} or not isinstance(raw_file["nodes"], list):
                raise ModelError("Each file needs exactly path and nodes")
            path = config_path(raw_file["path"])
            if path in paths:
                raise ModelError(f"Duplicate file path: {path}")
            import posixpath
            absolute = posixpath.normpath(path if path.startswith("/") else posixpath.join(prefix, path))
            if absolute in absolute_paths:
                raise ModelError(f"Two file paths refer to the same Nginx file: {path}")
            absolute_paths.add(absolute)
            paths.add(path)
            files.append(ConfigFile(path, [Node.from_dict(n, seen=seen) for n in raw_file["nodes"]]))
        entry = config_path(value.get("entrypoint", files[0].path))
        if entry not in paths:
            raise ModelError("entrypoint must refer to a file in this document")
        return cls(name=name, files=files, entrypoint=entry, context=value.get("context", "http"),
                   prefix=prefix, enabled=value.get("enabled", False), id=doc_id, revision=revision)

    def file(self, path):
        return next(f for f in self.files if f.path == path)
