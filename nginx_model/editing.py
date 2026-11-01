"""Explicit editor operations. Only user-requested fields are changed.

These helpers operate on the ordered tree so visual editing retains custom code,
comments, unrelated directives, and the positions of existing directives.
"""
from copy import deepcopy

from .parser import parse
from .representation import Document, ModelError, Node
from .workspace import quote


def find_node(document, node_id):
    def find(nodes):
        for node in nodes:
            if node.id == node_id:
                return node
            found = find(node.children)
            if found:
                return found
        return None
    for file in document.files:
        found = find(file.nodes)
        if found:
            return found
    raise ModelError("The selected block no longer exists")


def directives(block, name):
    return [n for n in block.children if n.kind == "directive" and n.name == name]


def one(block, name):
    nodes = directives(block, name)
    if len(nodes) > 1:
        raise ModelError(f"Multiple {name} directives: edit them in Blocks or Nginx")
    return nodes[0] if nodes else None


def set_single(block, name, args):
    old = one(block, name)
    if old:
        old.args = args
    else:
        block.children.append(Node(kind="directive", name=name, args=args))


def parse_arguments(name, text):
    nodes = parse(name + " " + text + ";")
    if len(nodes) != 1 or nodes[0].kind != "directive" or nodes[0].name != name or not nodes[0].args:
        raise ModelError(f"Enter only arguments for {name}")
    return nodes[0].args


def modernize_http2(server, enabled=True):
    if server.kind != "block" or server.name != "server":
        raise ModelError("Select an HTTP server block")
    for listener in directives(server, "listen"):
        listener.args = [arg for arg in listener.args if arg != "http2"]
    set_single(server, "http2", ["on" if enabled else "off"])


def set_tls_pair(server, certificate, key):
    one(server, "ssl_certificate")
    one(server, "ssl_certificate_key")
    if certificate == "" and key == "":
        server.children = [n for n in server.children if n.kind != "directive" or n.name not in {"ssl_certificate", "ssl_certificate_key"}]
        return
    if not certificate or not key:
        raise ModelError("A TLS certificate and its private key must be provided together")
    # Keep repeated RSA/ECDSA pairs in advanced mode instead of collapsing them.
    set_single(server, "ssl_certificate", [argument(certificate)])
    set_single(server, "ssl_certificate_key", [argument(key)])


def argument(text):
    from .parser import lex
    try:
        tokens = lex(text)
        if len(tokens) == 1 and tokens[0].kind == "word" and tokens[0].text == text:
            return text
    except ValueError:
        pass
    return quote(text)


def set_websockets(location, enabled):
    if location.kind != "block" or location.name != "location":
        raise ModelError("WebSocket controls require an HTTP location")
    for name, value in [("Upgrade", "$http_upgrade" if enabled else '""'),
                        ("Connection", '"upgrade"' if enabled else '"close"')]:
        existing = [n for n in directives(location, "proxy_set_header") if n.args and n.args[0].lower() == name.lower()]
        if existing:
            existing[0].args = [name, value]
            for duplicate in existing[1:]:
                location.children.remove(duplicate)
        else:
            location.children.append(Node(kind="directive", name="proxy_set_header", args=[name, value]))
    if enabled:
        set_single(location, "proxy_http_version", ["1.1"])


def listen_address(address, port):
    if type(port) is not int or not 1 <= port <= 65535:
        raise ModelError("Listener port must be between 1 and 65535")
    address = address.strip()
    if not address or address == "*":
        return str(port)
    if any(c.isspace() for c in address) or any(c in address for c in ';{}"\''):
        raise ModelError("Enter a hostname or IP address, without a port")
    if ":" in address:
        return f"[{address.strip('[]')}]:{port}"
    return f"{address}:{port}"


def update_basic(document, node_id, patch):
    doc = deepcopy(document)
    block = find_node(doc, node_id)
    if block.kind != "block" or block.name not in {"server", "location"}:
        raise ModelError("Basic settings apply to HTTP server or location blocks")
    if not isinstance(patch, dict):
        raise ModelError("Basic settings must be an object")
    allowed = {"names", "listeners", "tls", "http2"} if block.name == "server" else {"websockets", "buffering", "path", "type", "target", "root", "try_files", "redirect"}
    if set(patch) - allowed:
        raise ModelError(f"Unknown basic fields: {sorted(set(patch) - allowed)}")
    if block.name == "server":
        if "names" in patch:
            if not patch["names"].strip():
                old = one(block, "server_name")
                if old:
                    block.children.remove(old)
            else:
                set_single(block, "server_name", parse_arguments("server_name", patch["names"]))
        if "listeners" in patch:
            supplied = patch["listeners"]
            if not isinstance(supplied, list):
                raise ModelError("listeners must be an array")
            original = directives(block, "listen")
            remaining, replacements = {n.id for n in original}, []
            seen_ids = set()
            for listener in supplied:
                old = next((n for n in original if n.id == listener.get("id")), None)
                if listener.get("id") and (old is None or old.id in seen_ids):
                    raise ModelError("Unknown or duplicate listener id")
                if old:
                    seen_ids.add(old.id)
                args = list(old.args) if old else ["80"]
                if "port" in listener or "address" in listener:
                    args[0] = listen_address(listener.get("address", "*"), listener.get("port", 80))
                for field, flag in [("ssl", "ssl"), ("default", "default_server")]:
                    if field in listener:
                        if type(listener[field]) is not bool:
                            raise ModelError(f"{field} must be a boolean")
                        args = [a for a in args if a != flag and not (field == "default" and a == "default")]
                        if listener[field]:
                            args.append(flag)
                if old:
                    old.args = args
                    remaining.discard(old.id)
                else:
                    old = Node(kind="directive", name="listen", args=args)
                    block.children.append(old)
                replacements.append(old)
            block.children = [n for n in block.children if n.id not in remaining]
            # Existing listener positions stay unchanged; new listeners are appended.
        if "tls" in patch:
            set_tls_pair(block, patch["tls"].get("certificate"), patch["tls"].get("key"))
        if "http2" in patch:
            if type(patch["http2"]) is not bool:
                raise ModelError("http2 must be a boolean")
            modernize_http2(block, patch["http2"])
    else:
        if "websockets" in patch:
            if type(patch["websockets"]) is not bool:
                raise ModelError("websockets must be a boolean")
            set_websockets(block, patch["websockets"])
        if "buffering" in patch:
            if type(patch["buffering"]) is not bool:
                raise ModelError("buffering must be a boolean")
            set_single(block, "proxy_buffering", ["on" if patch["buffering"] else "off"])
        if "path" in patch:
            block.args = parse_arguments("location", patch["path"])
        if "type" in patch:
            kind = patch["type"]
            if kind not in {"proxy", "static", "redirect"}:
                raise ModelError("Choose proxy, static, or redirect")
            # An explicit content-type change replaces its routing directives only.
            routing = {"proxy_pass", "grpc_pass", "fastcgi_pass", "root", "alias", "try_files", "return"}
            block.children = [n for n in block.children if n.name not in routing or n.kind != "directive"]
        if "target" in patch:
            args = parse_arguments("proxy_pass", patch["target"])
            if len(args) != 1:
                raise ModelError("Enter one proxy destination URL")
            set_single(block, "proxy_pass", args)
        if "root" in patch:
            set_single(block, "root", [argument(patch["root"])])
        if "try_files" in patch:
            set_single(block, "try_files", parse_arguments("try_files", patch["try_files"]))
        if "redirect" in patch:
            code = str(patch["redirect"].get("code", "302"))
            if code not in {"301", "302", "303", "307", "308"}:
                raise ModelError("Choose an HTTP redirect status")
            set_single(block, "return", [code, argument(patch["redirect"]["target"])])
    return Document.from_dict(doc.to_dict())


RECIPES = [
    {"id":"proxy_host", "title":"Proxy host", "scope":"http", "hint":"A domain and listener forwarding requests to an application.", "source":"server { listen 80; server_name example.test; location / { proxy_pass http://127.0.0.1:8080; } }"},
    {"id":"static_host", "title":"Static website", "scope":"http", "hint":"Serve files from a directory, with a fallback for missing files.", "source":"server { listen 80; server_name example.test; location / { root /var/www/html; index index.html; try_files $uri $uri/ =404; } }"},
    {"id":"redirect_host", "title":"Redirect host", "scope":"http", "hint":"Send visitors to another URL with a permanent redirect.", "source":"server { listen 80; server_name old.example.test; return 301 https://new.example.test$request_uri; }"},
    {"id":"proxy_location", "title":"Proxy route", "scope":"server", "hint":"Forward one URL prefix to an application.", "source":"location /api/ { proxy_pass http://127.0.0.1:8080; }"},
    {"id":"tls_pair", "title":"Certificate + key", "scope":"server", "hint":"Add both TLS files together. Enable SSL on a listener too.", "source":"ssl_certificate /etc/letsencrypt/live/example.test/fullchain.pem; ssl_certificate_key /etc/letsencrypt/live/example.test/privkey.pem;"},
    {"id":"websockets", "title":"WebSocket support", "scope":"location", "hint":"Use HTTP/1.1 and forward the connection upgrade headers.", "source":"proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection \"upgrade\";"},
    {"id":"access", "title":"IP access rules", "scope":"location", "hint":"Rules are checked in order. Allow a network, then deny others.", "source":"allow 192.168.0.0/16; deny all;"},
]

HINTS = {
    "server":"A virtual host: listeners, domain names, and routes that belong together.",
    "location":"A route selected by a URL prefix, exact path, regular expression, or a named internal destination.",
    "listen":"The network address and port accepted by this server. SSL is a listener option; HTTP/2 is a server setting on modern Nginx.",
    "server_name":"Domain names matched by this virtual host. Multiple names share its settings.",
    "proxy_pass":"Forward requests to an application. A trailing slash changes URI forwarding, so keep it deliberately.",
    "add_header":"Add a response header. The optional always flag also applies it to error responses; header inheritance depends on its scope.",
    "proxy_set_header":"Set a header sent to the upstream application. Defining headers here changes which parent headers are inherited.",
    "include":"Insert another file at this exact position and scope. Import that file to preview or flatten it.",
    "ssl_certificate":"The public certificate chain used for TLS. Its private key is configured alongside it.",
    "ssl_certificate_key":"The matching private key file on the target host. The editor stores the path, not the key contents.",
    "http2":"Enable HTTP/2 for the server. The separate http2 directive requires Nginx 1.25.1 or newer.",
    "proxy_buffering":"Buffer an upstream response before forwarding it. Streaming applications often need this off.",
    "upstream":"A named pool of application servers that proxy_pass or grpc_pass can reference.",
    "map":"Create a variable from another value. Entry order and regular expressions can affect the result.",
    "return":"Finish processing with a response status, body, or redirect URL.",
    "root":"Directory used to look up local files for a request URI.",
    "try_files":"Try files in order, then use the final fallback URI or status.",
}
