"""Site features: switches for the advanced nginx settings people look up every time.

Each feature is a small form (fields) plus a builder that returns nginx text for the server block and,
where nginx needs it, for the level above it (zones, upstreams, cache paths). Everything a feature adds
is tagged with a marker comment, `# feature:<id> (<n>)`, followed by its n nodes, so it can be detected,
replaced when changed, and removed cleanly later. Values are checked against strict patterns because they
end up inside the config.
"""

import html
import re

import htpasswd
import sites
from nginx_model import parse
from nginx_model.representation import Node

MARK = re.compile(r"^#\s*feature:([a-z_]+)(?::([a-z0-9_]+))?\s*\((\d+)\)\s*$")
SIZE = re.compile(r"^\d{1,6}[kKmMgG]?$")
TIME = re.compile(r"^\d{1,6}(ms|s|m|h|d)?$")
ZONE_SIZE = re.compile(r"^\d{1,4}[kKmMgG]$")
ORIGIN = re.compile(r"^(\*|https?://[A-Za-z0-9._-]+(:\d{1,5})?)$")
HEADERS = re.compile(r"^[A-Za-z0-9,\- ]{1,200}$")
METHODS = re.compile(r"^[A-Z, ]{1,100}$")
IP = re.compile(r"^(\d{1,3}(\.\d{1,3}){3}|[0-9a-fA-F:]+:[0-9a-fA-F:]*)(/\d{1,3})?$")
BACKEND = re.compile(r"^([A-Za-z0-9._-]+|\[[0-9a-fA-F:]+\]):\d{1,5}$")
REALM = re.compile(r"^[A-Za-z0-9 ._-]{1,60}$")


def field(name, label, kind="text", default="", help="", **extra):
    return {"name": name, "label": label, "type": kind, "default": default, "help": help, **extra}


CATALOG = [
    {"id": "rate_limit", "title": "Rate limit", "group": "Protection", "icon": "⏱",
     "summary": "Slow down visitors who make too many requests (429 Too Many Requests).",
     "fields": [field("rate", "Requests per second, per visitor", "int", 10, min=1, max=10000),
                field("burst", "Allow short bursts of", "int", 20, min=0, max=100000)]},
    {"id": "conn_limit", "title": "Connection limit", "group": "Protection", "icon": "⛓",
     "summary": "Cap how many connections one visitor can hold open at once.",
     "fields": [field("connections", "Connections per visitor", "int", 20, min=1, max=100000)]},
    {"id": "basic_auth", "title": "Password protection", "group": "Protection", "icon": "🔑",
     "summary": "Ask for a user name and password before showing the site.",
     "fields": [field("username", "User name", "text", "admin"),
                field("password", "Password", "password", "", help="Stored as a salted hash in the data folder, never in the config."),
                field("realm", "Prompt text", "text", "Restricted")]},
    {"id": "ip_access", "title": "IP allow list", "group": "Protection", "icon": "🛡",
     "summary": "Only let listed addresses in. Everyone else gets 403.",
     "fields": [field("allow", "Allowed addresses or networks (one per line)", "lines", "192.168.0.0/16",
                      help="For example 203.0.113.7 or 10.0.0.0/8")]},
    {"id": "security_headers", "title": "Security headers", "group": "Protection", "icon": "🧱",
     "summary": "Browser protections: no sniffing, no framing by other sites, tighter referrers.",
     "fields": [field("preset", "Strength", "select", "basic", options=[["basic", "Basic"], ["strict", "Strict (adds CSP and permissions policy)"]])]},
    {"id": "cors", "title": "CORS", "group": "Web", "icon": "🌐",
     "summary": "Let other websites call this one from the browser, including preflight requests.",
     "fields": [field("origin", "Allowed origin", "text", "*", help="* or https://app.example.com"),
                field("methods", "Methods", "text", "GET, POST, PUT, DELETE, OPTIONS"),
                field("headers", "Headers", "text", "Authorization, Content-Type")]},
    {"id": "compression", "title": "Compression", "group": "Web", "icon": "🗜",
     "summary": "Gzip text, JSON, JavaScript and SVG responses to save bandwidth.",
     "fields": [field("level", "Level (1 fast, 9 smallest)", "int", 5, min=1, max=9)]},
    {"id": "cache", "title": "Response cache", "group": "Speed", "icon": "⚡",
     "summary": "Keep copies of the app's answers so repeat visits are served by nginx itself.",
     "fields": [field("valid", "Keep answers for", "text", "10m", help="For example 30s, 10m, 1h"),
                field("size", "Cache size", "text", "1g", help="For example 500m or 2g")]},
    {"id": "ip_block", "title": "IP block list", "group": "Protection", "icon": "🚫",
     "summary": "Turn away listed addresses or networks (403) and let everyone else in.",
     "fields": [field("deny", "Blocked addresses or networks (one per line)", "lines", "203.0.113.0/24")]},
    {"id": "bot_block", "title": "Block unwanted bots", "group": "Protection", "icon": "🤖",
     "summary": "Refuse requests whose browser name matches words you list (uses an nginx map).",
     "fields": [field("agents", "Words in the user agent (one per line)", "lines", "semrushbot\nahrefsbot\nmj12bot\ndotbot", help="Matched without caring about capitals.")]},
    {"id": "real_ip", "title": "Real visitor address", "group": "Web", "icon": "🪪",
     "summary": "Behind Cloudflare or another proxy? Log and limit by the visitor's address, not the proxy's.",
     "fields": [field("preset", "Proxy", "select", "cloudflare", options=[["cloudflare", "Cloudflare"], ["custom", "My own proxy (list below)"]]),
                field("proxies", "Trusted proxy addresses (custom only, one per line)", "lines", ""),
                field("header", "Header carrying the visitor address", "select", "CF-Connecting-IP", options=[["CF-Connecting-IP", "CF-Connecting-IP (Cloudflare)"], ["X-Forwarded-For", "X-Forwarded-For"], ["X-Real-IP", "X-Real-IP"]])]},
    {"id": "limits", "title": "Size and timeouts", "group": "Speed", "icon": "📏",
     "summary": "Largest upload and how long to wait for the app.",
     "fields": [field("max_body", "Largest upload", "text", "100m", help="For example 10m, 1g, 0 for no limit"),
                field("timeout", "Wait for the app up to", "text", "60s", help="For example 30s or 5m")]},
    {"id": "load_balance", "title": "Load balancing", "group": "Speed", "icon": "⚖",
     "summary": "Spread requests over several copies of the app and skip the ones that are down.",
     "fields": [field("servers", "App servers (one per line, host:port)", "lines", "10.0.0.11:8080\n10.0.0.12:8080",
                      help="Add weight=2 after an address to send it more traffic."),
                field("method", "How to choose", "select", "round_robin", options=[
                    ["round_robin", "Take turns"], ["least_conn", "Least busy first"], ["ip_hash", "Same visitor, same server"]]),
                field("max_fails", "Mark a server down after this many failures", "int", 3, min=1, max=100),
                field("fail_timeout", "Try it again after", "text", "30s")]},
    {"id": "error_page", "title": "Friendly error page", "group": "Web", "icon": "🩹",
     "summary": "Show your own message instead of a bare 502 when the app is down.",
     "fields": [field("message", "Message", "text", "We are doing some maintenance. Back in a moment.")]},
    {"id": "access_log", "title": "Own log file", "group": "Web", "icon": "📜",
     "summary": "Write this site's requests to its own log so the Status page can show them separately.",
     "fields": []},
]
BY_ID = {item["id"]: item for item in CATALOG}


def catalog():
    return CATALOG


# ---------------------------------------------------------------- value checks

def number(spec, values):
    name = spec["name"]
    raw = values.get(name, spec["default"])
    try:
        value = int(str(raw).strip())
    except ValueError:
        raise ValueError(f"{spec['label']} must be a whole number")
    if not spec["min"] <= value <= spec["max"]:
        raise ValueError(f"{spec['label']} must be between {spec['min']} and {spec['max']}")
    return value


def text(values, name, pattern, label, default):
    value = str(values.get(name, default)).strip()
    if not pattern.match(value):
        raise ValueError(f"{label} has characters nginx cannot take here")
    return value


def clean(feature, values):
    """The checked values for a feature's fields."""
    values = values or {}
    out = {}
    for spec in feature["fields"]:
        name = spec["name"]
        if spec["type"] == "int":
            out[name] = number(spec, values)
        elif spec["type"] == "select":
            value = str(values.get(name, spec["default"]))
            if value not in [option[0] for option in spec["options"]]:
                raise ValueError(f"choose one of the options for {spec['label']}")
            out[name] = value
        elif spec["type"] == "lines":
            raw = values.get(name, spec["default"])
            raw = raw if isinstance(raw, list) else str(raw).splitlines()
            out[name] = [line.strip() for line in raw if line.strip()]
        else:
            out[name] = str(values.get(name, spec["default"]))
    return out


# ---------------------------------------------------------------- builders: each returns (top, server) nginx text

def build_rate_limit(v, ctx):
    zone = "rl_" + ctx["slug"]
    return (f"limit_req_zone $binary_remote_addr zone={zone}:10m rate={v['rate']}r/s;",
            f"limit_req zone={zone} burst={v['burst']} nodelay;\nlimit_req_status 429;")


def build_conn_limit(v, ctx):
    zone = "cl_" + ctx["slug"]
    return (f"limit_conn_zone $binary_remote_addr zone={zone}:10m;",
            f"limit_conn {zone} {v['connections']};\nlimit_conn_status 429;")


def build_basic_auth(v, ctx):
    if not REALM.match(v["realm"]):
        raise ValueError("the prompt text may use letters, digits, spaces and . _ -")
    return "", f'auth_basic "{v["realm"]}";\nauth_basic_user_file {htpasswd.path_for(ctx["slug"]).as_posix()};'


def build_ip_access(v, ctx):
    lines = []
    for item in v["allow"]:
        if not IP.match(item):
            raise ValueError(f"not an IP address or network: {item}")
        lines.append(f"allow {item};")
    if not lines:
        raise ValueError("list at least one allowed address")
    return "", "\n".join(lines) + "\ndeny all;"


CLOUDFLARE_RANGES = ["173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
                     "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
                     "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22", "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32",
                     "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"]
AGENT = re.compile(r"^[A-Za-z0-9 ._-]{2,40}$")


def build_ip_block(v, ctx):
    lines = []
    for item in v["deny"]:
        if not IP.match(item):
            raise ValueError(f"not an IP address or network: {item}")
        lines.append(f"deny {item};")
    if not lines:
        raise ValueError("list at least one address to block")
    return "", "\n".join(lines) + "\nallow all;"


def build_bot_block(v, ctx):
    words = []
    for item in v["agents"]:
        if not AGENT.match(item):
            raise ValueError(f"use letters, digits, spaces, dots and dashes only: {item}")
        words.append(item.lower().replace(".", "[.]"))
    if not words:
        raise ValueError("list at least one word")
    name = "bot_" + ctx["slug"]
    return (f'map $http_user_agent ${name} {{\n    default 0;\n    "~*({"|".join(words)})" 1;\n}}', f"if (${name}) {{ return 403; }}")


def build_real_ip(v, ctx):
    proxies = CLOUDFLARE_RANGES if v["preset"] == "cloudflare" else v["proxies"]
    if not proxies:
        raise ValueError("list at least one trusted proxy address")
    for item in proxies:
        if not IP.match(item):
            raise ValueError(f"not an IP address or network: {item}")
    return "", "\n".join([f"set_real_ip_from {item};" for item in proxies] + [f"real_ip_header {v['header']};", "real_ip_recursive on;"])


def build_security_headers(v, ctx):
    lines = ['add_header X-Content-Type-Options "nosniff" always;', 'add_header X-Frame-Options "SAMEORIGIN" always;',
             'add_header Referrer-Policy "strict-origin-when-cross-origin" always;']
    if v["preset"] == "strict":
        lines += ["add_header Permissions-Policy \"camera=(), microphone=(), geolocation=()\" always;",
                  "add_header Content-Security-Policy \"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'\" always;"]
    return "", "\n".join(lines)


def build_cors(v, ctx):
    origin = text(v, "origin", ORIGIN, "The origin", "*")
    methods = text(v, "methods", METHODS, "Methods", "GET")
    headers = text(v, "headers", HEADERS, "Headers", "")
    return "", (f'add_header Access-Control-Allow-Origin "{origin}" always;\n'
                f'add_header Access-Control-Allow-Methods "{methods}" always;\n'
                f'add_header Access-Control-Allow-Headers "{headers}" always;\n'
                'if ($request_method = OPTIONS) { return 204; }')


def build_compression(v, ctx):
    return "", ("gzip on;\ngzip_vary on;\ngzip_proxied any;\ngzip_min_length 1024;\n"
                f"gzip_comp_level {v['level']};\n"
                "gzip_types text/plain text/css text/xml application/json application/javascript application/xml image/svg+xml;")


def build_cache(v, ctx):
    valid = text(v, "valid", TIME, "Keep answers for", "10m")
    size = text(v, "size", ZONE_SIZE, "Cache size", "1g")
    zone = "cache_" + ctx["slug"]
    return (f"proxy_cache_path /var/cache/nginx/{ctx['slug']} levels=1:2 keys_zone={zone}:10m max_size={size} inactive=60m use_temp_path=off;",
            f"proxy_cache {zone};\nproxy_cache_valid 200 301 302 {valid};\nproxy_cache_lock on;\n"
            "proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;\n"
            "add_header X-Cache-Status $upstream_cache_status always;")


def build_limits(v, ctx):
    body = text(v, "max_body", SIZE, "Largest upload", "100m")
    wait = text(v, "timeout", TIME, "The timeout", "60s")
    return "", (f"client_max_body_size {body};\nproxy_connect_timeout {wait};\nproxy_send_timeout {wait};\n"
                f"proxy_read_timeout {wait};")


def build_load_balance(v, ctx):
    name = "pool_" + ctx["slug"]
    if not v["servers"]:
        raise ValueError("list at least one app server")
    lines = []
    for raw in v["servers"]:
        parts = raw.split()
        if not BACKEND.match(parts[0]) or any(not re.match(r"^(weight|max_fails|backup|down)(=\d+)?$", p) for p in parts[1:]):
            raise ValueError(f"not a valid server (use host:port): {raw}")
        extra = "" if any(p.startswith(("max_fails", "backup", "down")) for p in parts[1:]) else f" max_fails={v['max_fails']} fail_timeout={text(v, 'fail_timeout', TIME, 'Retry time', '30s')}"
        lines.append(f"    server {' '.join(parts)}{extra};")
    method = "" if v["method"] == "round_robin" else f"    {v['method']};\n"
    return f"upstream {name} {{\n{method}" + "\n".join(lines) + "\n}", ""


def build_error_page(v, ctx):
    message = html.escape(v["message"].strip()[:200], quote=True).replace("$", "&#36;").replace("\\", "&#92;").replace('"', "&quot;")
    if not message:
        raise ValueError("write a message")
    body = f"<!doctype html><meta charset=utf-8><title>Back soon</title><body style=font-family:sans-serif;text-align:center;margin-top:20vh><h1>{message}</h1>"
    return "", f'error_page 502 503 504 @down;\nlocation @down {{ default_type text/html; return 503 "{body}"; }}'


def build_access_log(v, ctx):
    return "", f"access_log /var/log/nginx/{ctx['slug']}.access.log;\nerror_log /var/log/nginx/{ctx['slug']}.error.log warn;"


BUILDERS = {
    "rate_limit": build_rate_limit, "conn_limit": build_conn_limit, "basic_auth": build_basic_auth,
    "ip_access": build_ip_access, "security_headers": build_security_headers, "cors": build_cors,
    "compression": build_compression, "cache": build_cache, "limits": build_limits,
    "ip_block": build_ip_block, "bot_block": build_bot_block, "real_ip": build_real_ip, "load_balance": build_load_balance, "error_page": build_error_page, "access_log": build_access_log,
}


# ---------------------------------------------------------------- finding and removing what a feature added

def marked(children, feature_id=None, slug=None):
    """[(position, id, slug, count)] of the feature markers directly inside a list of nodes."""
    found = []
    for position, node in enumerate(children):
        match = MARK.match(node.text) if node.kind == "comment" else None
        if match and (feature_id is None or match.group(1) == feature_id) and (slug is None or match.group(2) == slug):
            found.append((position, match.group(1), match.group(2), int(match.group(3))))
    return found


def detect(block):
    """Feature ids switched on inside a server block."""
    return sorted({item[1] for item in marked(block.children)})


def drop(children, feature_id, slug=None):
    """Remove every marked group of `feature_id` (and `slug`) from a node list. Returns how many groups went."""
    count = 0
    for position, _, _, size in reversed(marked(children, feature_id, slug)):
        del children[position:position + 1 + size]
        count += 1
    return count


def upstream_servers(siblings, name):
    for node in siblings:
        if node.kind == "block" and node.name == "upstream" and node.args == [name]:
            return [child.args[0] for child in node.children if child.kind == "directive" and child.name == "server" and child.args]
    return []


def tag(feature_id, snippet, slug=None):
    nodes = parse(snippet) if snippet.strip() else []
    label = feature_id if slug is None else f"{feature_id}:{slug}"
    return [Node(kind="comment", text=f"# feature:{label} ({len(nodes)})"), *nodes]


def apply(text_in, index, feature_id, values):
    """Switch a feature on (or change its settings) for one site. Returns the new file text."""
    feature = BY_ID.get(feature_id)
    if feature is None:
        raise ValueError("unknown feature")
    checked = clean(feature, values)

    def change(siblings, position, block):
        ctx = {"slug": sites.slug_for(block, index)}
        top, server = BUILDERS[feature_id](checked, ctx)
        remove(siblings, block, feature_id, ctx["slug"])
        position = siblings.index(block)
        if top:
            group = tag(feature_id, top, ctx["slug"])
            siblings[position:position] = group
        if feature_id == "load_balance":
            proxy = sites.first_proxy(block)
            if proxy is None:
                raise ValueError("load balancing needs a site that forwards to an app")
            scheme = proxy.args[0].split("://", 1)[0] if "://" in proxy.args[0] else "http"
            rest = proxy.args[0].split("://", 1)[-1]
            path = rest[rest.index("/"):] if "/" in rest else ""
            proxy.args = [f"{scheme}://pool_{ctx['slug']}{path}"] + proxy.args[1:]
        group = tag(feature_id, server)
        if feature_id == "load_balance":
            group = [Node(kind="comment", text="# feature:load_balance (0)")]
        block.children.extend(group)
    return sites.edit(text_in, index, change)


def remove(siblings, block, feature_id, slug):
    """Take a feature's nodes out of the server block and the list around it (no re-render)."""
    if feature_id == "load_balance":
        name = f"pool_{slug}"
        servers = upstream_servers(siblings, name)
        proxy = sites.first_proxy(block)
        if proxy is not None and proxy.args[0].split("://", 1)[-1].startswith(name) and servers:
            scheme = proxy.args[0].split("://", 1)[0] if "://" in proxy.args[0] else "http"
            rest = proxy.args[0].split("://", 1)[-1]
            path = rest[rest.index("/"):] if "/" in rest else ""
            proxy.args = [f"{scheme}://{servers[0]}{path}"] + proxy.args[1:]
    drop(block.children, feature_id)
    drop(siblings, feature_id, slug)


def disable(text_in, index, feature_id):
    if feature_id not in BY_ID:
        raise ValueError("unknown feature")

    def change(siblings, position, block):
        remove(siblings, block, feature_id, sites.slug_for(block, index))
    return sites.edit(text_in, index, change)
