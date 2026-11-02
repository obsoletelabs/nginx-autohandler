"""Site templates: one form, one new config file. Used by the Lab page's Templates gallery and the phone view.

build() returns {"files": {path: text}, "note": str}; server.py writes the files through the normal
test-before-reload step, so a template can never leave nginx broken.
"""

import html
import re

import features
import sites
from nginx_model import parse
from nginx_model.parser import render
from nginx_model.representation import Node

ROOT_RE = re.compile(r"^/[A-Za-z0-9._/@+-]{0,200}$")
URL_RE = re.compile(r"^https?://[A-Za-z0-9._:\[\]-]+(/[^\s;{}'\"]*)?$")
STREAM_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,40}$")
BACKEND = re.compile(r"^([A-Za-z0-9._-]+|\[[0-9a-fA-F:]+\]):\d{1,5}$")
STREAM_INCLUDE = "/etc/nginx/stream.d/*.conf"


def f(name, label, kind="text", default="", help="", **extra):
    return {"name": name, "label": label, "type": kind, "default": default, "help": help, **extra}


DOMAIN = f("domain", "Domain name", "text", "app.example.com")
TEMPLATES = [
    {"id": "reverse_proxy", "title": "Reverse proxy", "icon": "🔀", "summary": "Put a domain in front of an app on your network.",
     "fields": [DOMAIN, f("target", "Forward to", "text", "http://127.0.0.1:8080", help="http://host:port"),
                f("websocket", "WebSocket support", "bool", True)]},
    {"id": "static_site", "title": "Static website", "icon": "📄", "summary": "Serve a folder of files.",
     "fields": [DOMAIN, f("root", "Folder", "text", "/usr/share/nginx/html")]},
    {"id": "spa", "title": "Single-page app", "icon": "🧩", "summary": "Serve a built front end; unknown paths fall back to index.html.",
     "fields": [DOMAIN, f("root", "Folder", "text", "/usr/share/nginx/html")]},
    {"id": "redirect", "title": "Redirect", "icon": "↪", "summary": "Send a whole domain somewhere else.",
     "fields": [DOMAIN, f("target", "Send visitors to", "text", "https://new.example.com"),
                f("code", "Type", "select", "301", options=[["301", "Permanent (301)"], ["302", "Temporary (302)"]])]},
    {"id": "php", "title": "PHP site", "icon": "🐘", "summary": "Serve PHP through php-fpm.",
     "fields": [DOMAIN, f("root", "Folder", "text", "/var/www/html"), f("backend", "php-fpm address", "text", "127.0.0.1:9000")]},
    {"id": "load_balanced", "title": "Load-balanced app", "icon": "⚖", "summary": "One domain, several copies of the app.",
     "fields": [DOMAIN, f("servers", "App servers (host:port per line)", "lines", "10.0.0.11:8080\n10.0.0.12:8080"),
                f("method", "How to choose", "select", "least_conn", options=[["round_robin", "Take turns"], ["least_conn", "Least busy first"], ["ip_hash", "Same visitor, same server"]])]},
    {"id": "api_gateway", "title": "Protected API", "icon": "🛡", "summary": "A proxy with rate limiting, CORS, security headers and compression already on.",
     "fields": [DOMAIN, f("target", "Forward to", "text", "http://127.0.0.1:3000"),
                f("origin", "Allowed website (CORS)", "text", "*"), f("rate", "Requests per second per visitor", "int", 20, min=1, max=10000)]},
    {"id": "maintenance", "title": "Maintenance page", "icon": "🚧", "summary": "Answer a domain with a friendly 503 message.",
     "fields": [DOMAIN, f("message", "Message", "text", "Back soon. We are upgrading things.")]},
    {"id": "catch_all", "title": "Catch-all (drop unknown hosts)", "icon": "🕳", "summary": "Close the connection for requests to names you do not serve.",
     "fields": []},
    {"id": "tcp_proxy", "title": "TCP / UDP proxy", "icon": "🔌", "summary": "Forward a raw port, for example a database or DNS (nginx stream).",
     "fields": [f("name", "Name", "text", "database"), f("port", "Listen on port", "int", 5432, min=1, max=65535),
                f("target", "Forward to (host:port)", "text", "10.0.0.5:5432"),
                f("udp", "UDP instead of TCP", "bool", False)]},
]
BY_ID = {item["id"]: item for item in TEMPLATES}


def catalog():
    return TEMPLATES


def file_name(domain):
    return re.sub(r"[^a-z0-9.-]+", "_", domain.lower().replace("*", "wildcard")).strip("._") or "site"


def quoted(text):
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"').replace("$", "").replace("\n", " ") + '"'


def need_domain(values):
    return sites.clean_names(values.get("domain", ""))


def server_text(names, body):
    return f"server {{\n    listen 80;\n    listen [::]:80;\n    server_name {' '.join(names)};\n{body}}}\n"


def build(template_id, values, existing=None):
    """Make the files for a template. `existing` is {path: text} of files the template may extend (nginx.conf)."""
    template = BY_ID.get(template_id)
    if template is None:
        raise ValueError("unknown template")
    values = values or {}
    if template_id == "tcp_proxy":
        return build_stream(values, existing or {})
    if template_id == "catch_all":
        text = ("server {\n    listen 80 default_server;\n    listen [::]:80 default_server;\n    server_name _;\n"
                "    return 444;\n}\n")
        return {"files": {"conf.d/00-catch-all.conf": text}, "note": "Requests for unknown host names now get no answer."}
    names = need_domain(values)
    path = f"conf.d/{file_name(names[0])}.conf"
    if template_id == "reverse_proxy":
        target = sites.clean_target(values.get("target", ""))
        extra = ""
        if values.get("websocket", True):
            extra = ('        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n'
                     '        proxy_set_header Connection "upgrade";\n')
        text = server_text(names, "    location / {\n        proxy_pass " + target + ";\n        proxy_set_header Host $host;\n"
                           "        proxy_set_header X-Real-IP $remote_addr;\n"
                           "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n"
                           "        proxy_set_header X-Forwarded-Proto $scheme;\n" + extra + "    }\n")
    elif template_id in ("static_site", "spa"):
        root = str(values.get("root", "")).strip()
        if not ROOT_RE.match(root) or ".." in root:
            raise ValueError("the folder must be an absolute path such as /var/www/site")
        fallback = "/index.html" if template_id == "spa" else "=404"
        text = server_text(names, f"    root {root};\n    index index.html;\n    location / {{\n        try_files $uri $uri/ {fallback};\n    }}\n")
    elif template_id == "redirect":
        target = str(values.get("target", "")).strip()
        if not URL_RE.match(target):
            raise ValueError("the redirect target looks like https://example.com")
        code = str(values.get("code", "301"))
        if code not in ("301", "302"):
            raise ValueError("choose a redirect type")
        text = server_text(names, f"    return {code} {target.rstrip('/')}$request_uri;\n")
    elif template_id == "php":
        root = str(values.get("root", "")).strip()
        backend = str(values.get("backend", "")).strip()
        if not ROOT_RE.match(root) or ".." in root:
            raise ValueError("the folder must be an absolute path such as /var/www/html")
        if not BACKEND.match(backend):
            raise ValueError("the php-fpm address looks like 127.0.0.1:9000")
        text = server_text(names, f"    root {root};\n    index index.php index.html;\n    location / {{\n        try_files $uri $uri/ /index.php?$args;\n    }}\n"
                           f"    location ~ \\.php$ {{\n        include fastcgi_params;\n        fastcgi_pass {backend};\n"
                           "        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;\n    }\n")
    elif template_id == "maintenance":
        message = html.escape(str(values.get("message", "")).strip()[:200], quote=True).replace("$", "&#36;").replace("\\", "&#92;")
        if not message:
            raise ValueError("write a message")
        body = f"<!doctype html><meta charset=utf-8><title>Back soon</title><body style=font-family:sans-serif;text-align:center;margin-top:20vh><h1>{message}</h1>"
        text = server_text(names, f'    default_type text/html;\n    return 503 "{body}";\n')
    elif template_id == "load_balanced":
        text = server_text(names, "    location / {\n        proxy_pass http://127.0.0.1:1;\n        proxy_set_header Host $host;\n    }\n")
        text = features.apply(text, 0, "load_balance", {"servers": values.get("servers", []), "method": values.get("method", "least_conn")})
    elif template_id == "api_gateway":
        target = sites.clean_target(values.get("target", ""))
        text = server_text(names, "    location / {\n        proxy_pass " + target + ";\n        proxy_set_header Host $host;\n"
                           "        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n    }\n")
        text = features.apply(text, 0, "rate_limit", {"rate": values.get("rate", 20), "burst": 40})
        text = features.apply(text, 0, "cors", {"origin": values.get("origin", "*")})
        text = features.apply(text, 0, "security_headers", {"preset": "basic"})
        text = features.apply(text, 0, "compression", {})
    else:
        raise ValueError("unknown template")
    return {"files": {path: render(parse(text))}, "note": f"Created {path}. Turn on HTTPS from the site's page when a certificate is ready."}


def build_stream(values, existing):
    name = str(values.get("name", "")).strip().lower()
    if not STREAM_NAME.match(name):
        raise ValueError("the name may use lowercase letters, digits, - and _")
    target = str(values.get("target", "")).strip()
    if not BACKEND.match(target):
        raise ValueError("the target looks like 10.0.0.5:5432")
    try:
        port = int(values.get("port"))
    except (TypeError, ValueError):
        raise ValueError("the port must be a number")
    if not 1 <= port <= 65535:
        raise ValueError("the port must be between 1 and 65535")
    listen = f"{port} udp" if values.get("udp") else str(port)
    text = f"stream {{\n    server {{\n        listen {listen};\n        proxy_pass {target};\n    }}\n}}\n"
    files = {f"stream.d/{name}.conf": render(parse(text))}
    main = existing.get("nginx.conf")
    if main is not None:
        nodes = parse(main)
        if not any(node.kind == "directive" and node.name == "include" and node.args and node.args[0].strip("'\"") == STREAM_INCLUDE
                   for node in nodes):
            nodes.append(Node(kind="directive", name="include", args=[STREAM_INCLUDE]))
            files["nginx.conf"] = render(nodes)
    return {"files": files, "note": f"Created stream.d/{name}.conf. Publish port {port} on the container to use it."}
