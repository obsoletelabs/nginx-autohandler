"""Structural checks plus an optional, honest nginx -t result."""
from pathlib import Path
import shutil
import subprocess
import tempfile

from .parser import parse, render
from .representation import Document
from .workspace import effective_config, walk, include_targets

# This is an editor palette, not an exhaustive module allowlist.
PALETTE = [
    {"name": "server", "kind": "block", "args": [], "group": "Structure", "contexts": ["http", "stream", "mail"]},
    {"name": "location", "kind": "block", "args": ["/"], "group": "Structure", "contexts": ["server", "location"]},
    {"name": "upstream", "kind": "block", "args": ["backend"], "group": "Structure", "contexts": ["http", "stream"]},
    {"name": "map", "kind": "block", "args": ["$http_upgrade", "$connection_upgrade"], "group": "Structure", "contexts": ["http", "stream"]},
    {"name": "listen", "kind": "directive", "args": ["80"], "group": "Routing", "contexts": ["server"]},
    {"name": "server_name", "kind": "directive", "args": ["example.test"], "group": "Routing", "contexts": ["server"]},
    {"name": "proxy_pass", "kind": "directive", "args": ["http://127.0.0.1:8080"], "group": "Routing", "contexts": ["location"]},
    {"name": "grpc_pass", "kind": "directive", "args": ["grpc://backend"], "group": "Routing", "contexts": ["location"]},
    {"name": "return", "kind": "directive", "args": ["301", "https://$host$request_uri"], "group": "Routing", "contexts": ["server", "location", "if"]},
    {"name": "root", "kind": "directive", "args": ["/var/www/html"], "group": "Routing", "contexts": ["http", "server", "location"]},
    {"name": "try_files", "kind": "directive", "args": ["$uri", "$uri/", "=404"], "group": "Routing", "contexts": ["server", "location"]},
    {"name": "include", "kind": "directive", "args": ["snippets/common.conf"], "group": "Structure", "contexts": ["any"]},
    {"name": "proxy_set_header", "kind": "directive", "args": ["Host", "$host"], "group": "Headers", "contexts": ["http", "server", "location"]},
    {"name": "add_header", "kind": "directive", "args": ["X-Content-Type-Options", '"nosniff"', "always"], "group": "Headers", "contexts": ["http", "server", "location", "if"]},
    {"name": "proxy_buffering", "kind": "directive", "args": ["off"], "group": "Behavior", "contexts": ["http", "server", "location"]},
    {"name": "proxy_read_timeout", "kind": "directive", "args": ["60s"], "group": "Behavior", "contexts": ["http", "server", "location"]},
    {"name": "allow", "kind": "directive", "args": ["127.0.0.1"], "group": "Behavior", "contexts": ["http", "server", "location", "limit_except"]},
    {"name": "deny", "kind": "directive", "args": ["all"], "group": "Behavior", "contexts": ["http", "server", "location", "limit_except"]},
    {"name": "ssl_certificate", "kind": "directive", "args": ["/etc/letsencrypt/live/example.test/fullchain.pem"], "group": "TLS", "contexts": ["http", "server"]},
    {"name": "ssl_certificate_key", "kind": "directive", "args": ["/etc/letsencrypt/live/example.test/privkey.pem"], "group": "TLS", "contexts": ["http", "server"]},
    {"name": "http2", "kind": "directive", "args": ["on"], "group": "TLS", "contexts": ["http", "server"]},
]
KNOWN = {item["name"] for item in PALETTE} | {
    "http", "events", "stream", "mail", "if", "limit_except", "types", "charset_map", "geo", "split_clients",
    "ssl_protocols", "ssl_ciphers", "ssl_prefer_server_ciphers", "ssl_stapling", "ssl_stapling_verify",
    "access_log", "error_log", "error_page", "default_type", "proxy_http_version", "proxy_send_timeout",
    "proxy_connect_timeout", "proxy_request_buffering", "proxy_ssl_server_name", "proxy_ssl_verify",
    "proxy_pass_request_body", "proxy_buffers", "proxy_buffer_size", "proxy_cache", "client_max_body_size",
    "auth_request", "auth_request_set", "auth_basic", "auth_basic_user_file", "expires", "gzip", "set",
    "rewrite", "resolver", "index", "alias", "internal", "stub_status", "limit_req", "limit_req_zone",
    "worker_processes", "worker_connections", "pid", "user", "load_module", "log_format", "keepalive",
    "send_timeout", "client_body_timeout", "client_header_timeout", "client_body_buffer_size",
    "large_client_header_buffers", "real_ip_header", "set_real_ip_from", "proxy_redirect",
    "grpc_read_timeout", "grpc_send_timeout", "grpc_set_header", "grpc_socket_keepalive",
}

# The same rules power snap targets in the demo and structural diagnostics.
# Unknown module directives are intentionally unrestricted and remain custom.
RULES = {item["name"]: {"kind": item["kind"], "contexts": item["contexts"]} for item in PALETTE}
RULES.update({
    "http": {"kind": "block", "contexts": ["main"]},
    "events": {"kind": "block", "contexts": ["main"]},
    "stream": {"kind": "block", "contexts": ["main"]},
    "mail": {"kind": "block", "contexts": ["main"]},
    "if": {"kind": "block", "contexts": ["server", "location"]},
    "limit_except": {"kind": "block", "contexts": ["location"]},
})
TABLE_CONTEXTS = {"map", "geo", "types", "split_clients", "charset_map"}
ARG_COUNTS = {"location": (1, 2), "upstream": (1, 1), "map": (2, 2),
              "listen": (1, None), "server_name": (1, None), "proxy_pass": (1, 1),
              "grpc_pass": (1, 1), "root": (1, 1), "try_files": (2, None),
              "include": (1, 1), "return": (1, 2), "add_header": (2, 3),
              "proxy_set_header": (2, 2), "ssl_certificate": (1, 1),
              "ssl_certificate_key": (1, 1), "http2": (1, 1)}


def allowed_in(node, context):
    if node.kind == "comment" or context in TABLE_CONTEXTS:
        return True
    if context not in {"main", "http", "stream", "mail", "server", "location", "upstream", "if", "limit_except", "events"}:
        return True  # Unknown module blocks define their own child language.
    if node.name == "server" and node.kind == "directive":
        return context == "upstream"
    rule = RULES.get(node.name)
    if not rule:
        return True
    return node.kind == rule["kind"] and ("any" in rule["contexts"] or context in rule["contexts"])


def scope_information(document):
    """Infer snippet entry contexts by following include edges without flattening."""
    file_contexts = {file.path: set() for file in document.files}
    placements = []

    def visit_file(path, context, stack):
        if path in stack or context in file_contexts[path]:
            return
        file_contexts[path].add(context)
        visit_nodes(document.file(path).nodes, context, path, [*stack, path])

    def visit_nodes(nodes, context, path, stack):
        for node in nodes:
            placements.append((node, context, path))
            if node.kind == "block":
                visit_nodes(node.children, node.name, path, stack)
            elif node.kind == "directive" and node.name == "include":
                for target in include_targets(document, node):
                    visit_file(target, context, stack)

    visit_file(document.entrypoint, document.context, [])
    # Unreferenced files still need an editing context; expose this as a fallback.
    unreferenced = [path for path, contexts in file_contexts.items() if not contexts]
    for path in unreferenced:
        visit_file(path, document.context, [])
    return {"file_contexts": {path: sorted(contexts) for path, contexts in file_contexts.items()},
            "unreferenced": unreferenced}, placements


def validate(document: Document, *, nginx=False, executable=None):
    document = Document.from_dict(document.to_dict())
    issues = []
    for file in document.files:
        parse(render(file.nodes), file.path)
        for node in walk(file.nodes):
            if node.name in {"listen", "server_name", "proxy_pass", "include", "add_header", "proxy_set_header"} and not node.args:
                issues.append({"severity": "error", "path": file.path, "node_id": node.id,
                               "message": f"{node.name} requires arguments"})
    _, placements = scope_information(document)
    checked = set()
    for node, context, path in placements:
        if not allowed_in(node, context) and (node.id, context) not in checked:
            checked.add((node.id, context))
            issues.append({"severity": "error", "path": path, "node_id": node.id,
                           "message": f"{node.name} is not allowed in {context}; move it to a supported scope"})
        if context in TABLE_CONTEXTS or node.kind == "comment":
            continue
        bounds = ARG_COUNTS.get(node.name)
        if node.kind == "block" and node.name in {"server", "http", "events", "stream", "mail"}:
            bounds = (0, 0)
        if bounds and (len(node.args) < bounds[0] or (bounds[1] is not None and len(node.args) > bounds[1])):
            message = f"{node.name} has {len(node.args)} arguments; expected " + (str(bounds[0]) if bounds[0] == bounds[1] else f"at least {bounds[0]}" if bounds[1] is None else f"{bounds[0]}–{bounds[1]}")
            if not any(i.get("node_id") == node.id and "requires arguments" in i["message"] for i in issues):
                issues.append({"severity": "error", "path": path, "node_id": node.id, "message": message})
        if node.name == "listen" and "http2" in node.args:
            issues.append({"severity": "warning", "path": path, "node_id": node.id,
                           "message": "Legacy listen http2 option. Use the HTTP/2 conversion action for Nginx 1.25.1+."})
    effective, includes = effective_config(document, strict=False)
    issues.extend(includes)
    result = {"structural_ok": not any(i["severity"] == "error" for i in issues), "issues": issues,
              "nginx": {"status": "not_run", "message": "Structural checks only. Validate with the target host's Nginx build before deployment."}}
    if not nginx:
        return result
    if includes:
        result["nginx"] = {"status": "blocked", "message": "Import missing includes and resolve cycles before running nginx -t."}
        return result
    binary = executable or shutil.which("nginx")
    if not binary:
        result["nginx"] = {"status": "unavailable", "message": "Nginx is not installed here. No nginx -t check was performed."}
        return result
    context = document.context
    if context == "http":
        effective = "events {}\nhttp {\n" + effective + "}\n"
    elif context in {"stream", "mail"}:
        effective = "events {}\n" + context + " {\n" + effective + "}\n"
    elif context in {"server", "location"}:
        effective = "events {}\nhttp { server {\n" + ("location / {\n" if context == "location" else "") + effective + ("}\n" if context == "location" else "") + "} }\n"
    try:
        with tempfile.TemporaryDirectory(prefix="nginx-editor-") as directory:
            Path(directory, "logs").mkdir()
            config = Path(directory, "nginx.conf")
            config.write_text(effective, encoding="utf-8")
            run = subprocess.run([binary, "-t", "-p", directory + "/", "-c", str(config)],
                                 capture_output=True, text=True, timeout=15, shell=False)
            result["nginx"] = {"status": "passed" if run.returncode == 0 else "failed",
                               "message": (run.stdout + run.stderr).strip(), "exit_code": run.returncode}
    except (OSError, subprocess.TimeoutExpired) as error:
        result["nginx"] = {"status": "failed", "message": str(error)}
    return result
