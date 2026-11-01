"""Endpoints behind the Workshop editor, ported from nginx_attempt2/demo.py.

The editor works on the whole config tree as one Document. These functions only
parse, render, validate and edit that document; writing to disk is server.py's job
(apply_workspace), so nothing here touches the nginx config until Apply.
"""

from dataclasses import asdict
from pathlib import Path

from nginx_model import Document, effective_config, generate_files, import_directory, parse
from nginx_model.editing import HINTS, RECIPES, find_node, modernize_http2, update_basic
from nginx_model.validation import KNOWN, PALETTE, RULES, TABLE_CONTEXTS, scope_information, validate
from nginx_model.workspace import include_targets, walk


# A certificate whose files are named after the server's first server_name. The editor
# fills in the name; applying issues the certificate if it is not on disk yet.
AUTO_CERT = {
    **next(recipe for recipe in RECIPES if recipe["id"] == "tls_pair"),
    "id": "auto_cert",
    "title": "Auto certificate",
    "hint": "Points this server at a Let's Encrypt certificate for its server_name. Apply issues it.",
    "source": ("ssl_certificate /etc/letsencrypt/live/__LINEAGE__/fullchain.pem;\n"
               "ssl_certificate_key /etc/letsencrypt/live/__LINEAGE__/privkey.pem;\n"),
}


def palette():
    return {
        "palette": PALETTE,
        "known": sorted(KNOWN),
        "rules": RULES,
        "table_contexts": sorted(TABLE_CONTEXTS),
        "recipes": RECIPES + [AUTO_CERT],
        "hints": HINTS,
    }


HOST_PREFIX = "/etc/nginx"  # where these files live on the nginx host, used for absolute include paths


def load(root: Path) -> dict:
    """The whole config tree under `root`, as the editor's Document."""
    root = Path(root)
    has_main = (root / "nginx.conf").is_file()
    document = import_directory(
        root,
        entrypoint="nginx.conf" if has_main else None,
        context="main" if has_main else "http",
        prefix=HOST_PREFIX,
    )
    return document.to_dict()


def document_from(payload):
    return Document.from_dict(payload.get("document"))


def render(payload):
    doc = document_from(payload)
    effective, issues = effective_config(doc, strict=False)
    scopes, _ = scope_information(doc)
    includes = {
        n.id: {"targets": include_targets(doc, n), "path": f.path}
        for f in doc.files for n in walk(f.nodes)
        if n.kind == "directive" and n.name == "include"
    }
    return {"files": generate_files(doc), "effective": effective, "include_issues": issues, "includes": includes, **scopes}


def post(path, payload, root):
    """Handle one editor POST. Returns the JSON body; raises ValueError for bad input."""
    if path == "/api/parse":
        return {"nodes": [asdict(n) for n in parse(payload.get("text"), payload.get("path", "config"))]}
    if path == "/api/render":
        return render(payload)
    if path == "/api/validate":
        doc = document_from(payload)
        if "source" in payload:
            doc.file(payload.get("path", doc.entrypoint)).nodes = parse(payload["source"], payload.get("path", doc.entrypoint))
        return validate(doc, nginx=payload.get("nginx") is True)
    if path == "/api/document":
        return document_from(payload).to_dict()
    if path == "/api/basic":
        return update_basic(document_from(payload), payload.get("node_id"), payload.get("patch")).to_dict()
    if path == "/api/modernize-http2":
        doc = document_from(payload)
        modernize_http2(find_node(doc, payload.get("node_id")))
        return Document.from_dict(doc.to_dict()).to_dict()
    raise ValueError(f"unknown editor endpoint: {path}")


EDITOR_POSTS = (
    "/api/parse",
    "/api/render",
    "/api/validate",
    "/api/document",
    "/api/basic",
    "/api/modernize-http2",
)
