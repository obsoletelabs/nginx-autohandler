"""Sites as data: list the server blocks of a config, edit their domain and target, and turn on HTTPS.

Everything here works on config text (parse, change, render) and never touches the disk, so the phone
view, the Lab page and the editor all go through the same test-before-reload apply step in server.py.
A site is addressed by "<file>#<n>", the n-th server block of that file (stream servers do not count).
"""

import re

from nginx_model import parse
from nginx_model.representation import Node
from nginx_model.parser import render

CERT_PATH = re.compile(r"^/[A-Za-z0-9._/@+-]+$")
HOST_TOKEN = re.compile(r"^(\*\.)?[A-Za-z0-9_.-]+$|^~.+$")
TARGET = re.compile(r"^(https?)://([A-Za-z0-9._-]+|\[[0-9a-fA-F:]+\])(:\d{1,5})?(/[^\s;{}'\"$]*)?$")


def server_blocks(nodes):
    """[(siblings, index, node)] for every http-level server block in document order. stream blocks are skipped."""
    found = []

    def visit(siblings):
        for index, node in enumerate(siblings):
            if node.kind != "block":
                continue
            if node.name == "server":
                found.append((siblings, index, node))
            elif node.name != "stream":
                visit(node.children)

    visit(nodes)
    return found


def directives(block, name):
    return [child for child in block.children if child.kind == "directive" and child.name == name]


def subtree(block):
    """The block and everything inside it, parents first."""
    yield block
    for child in block.children:
        if child.kind == "block":
            yield from subtree(child)
        else:
            yield child


def first_proxy(block):
    for node in subtree(block):
        if node.kind == "directive" and node.name == "proxy_pass" and node.args:
            return node
    return None


def slug_for(block, index):
    for node in directives(block, "server_name"):
        for arg in node.args:
            name = arg.strip("'\"").lower()
            if name not in ("_", "") and not name.startswith("~"):
                return re.sub(r"[^a-z0-9]+", "_", name).strip("_")[:40] or f"site{index}"
    return f"site{index}"


def describe(block, path, index):
    names = [arg.strip("'\"") for node in directives(block, "server_name") for arg in node.args]
    listens = [" ".join(node.args) for node in directives(block, "listen")]
    proxy = first_proxy(block)
    roots = [node.args[0] for node in subtree(block) if node.kind == "directive" and node.name == "root" and node.args]
    returns = [" ".join(node.args) for node in directives(block, "return")]
    cert = directives(block, "ssl_certificate")
    from features import detect  # late: features imports this module
    return {
        "id": f"{path}#{index}", "file": path, "index": index, "slug": slug_for(block, index),
        "names": names, "listen": listens,
        "ssl": bool(cert) or any("ssl" in item.split() for item in listens),
        "certificate": cert[0].args[0].strip("'\"") if cert and cert[0].args else "",
        "forward": proxy.args[0] if proxy else "", "root": roots[0] if roots else "",
        "redirect": returns[0] if returns and returns[0].split()[0] in ("301", "302", "303", "307", "308") else "",
        "locations": sum(1 for child in block.children if child.kind == "block" and child.name == "location"),
        "features": detect(block),
    }


def list_sites(files):
    """Every site in {path: text}. Files that do not parse are skipped."""
    found = []
    for path in sorted(files):
        try:
            nodes = parse(files[path], path)
        except ValueError:
            continue
        for index, (_, _, block) in enumerate(server_blocks(nodes)):
            found.append(describe(block, path, index))
    return found


def split_id(site_id):
    path, _, number = str(site_id).rpartition("#")
    if not path or not number.isdigit():
        raise ValueError("unknown site")
    return path, int(number)


def edit(text, index, change):
    """Parse `text`, call change(siblings, position, block) on the index-th server block, render the result."""
    nodes = parse(text)
    blocks = server_blocks(nodes)
    if index >= len(blocks):
        raise ValueError("that site no longer exists; reload the page")
    siblings, position, block = blocks[index]
    change(siblings, position, block)
    return render(nodes)


def clean_names(names):
    if isinstance(names, str):
        names = names.replace(",", " ").split()
    clean = []
    for name in names:
        name = str(name).strip().strip("'\"")
        if not name:
            continue
        if not HOST_TOKEN.match(name) or len(name) > 253:
            raise ValueError(f"not a valid domain name: {name}")
        clean.append(name)
    if not clean:
        raise ValueError("enter at least one domain name")
    return clean


def clean_target(target):
    target = str(target).strip()
    match = TARGET.match(target)
    if not match:
        raise ValueError("the forward target looks like http://host:port (letters, digits, dots and dashes only)")
    if match.group(3) and not 0 < int(match.group(3)[1:]) < 65536:
        raise ValueError("the port must be between 1 and 65535")
    return target


def set_directive(block, name, args):
    """Set the first `name` directive of `block` to `args`, adding it at the top if it is missing."""
    existing = directives(block, name)
    if existing:
        existing[0].args = list(args)
        return existing[0]
    node = Node(kind="directive", name=name, args=list(args))
    block.children.insert(0, node)
    return node


def update(text, index, names=None, forward=None):
    """Change a site's domain names and/or forward target."""
    def change(siblings, position, block):
        if names is not None:
            set_directive(block, "server_name", clean_names(names))
        if forward is not None:
            proxy = first_proxy(block)
            if proxy is None:
                raise ValueError("this site does not forward to an app, so there is no target to change")
            proxy.args = [clean_target(forward)] + proxy.args[1:]
    return edit(text, index, change)


def enable_https(text, index, cert, key, redirect=True):
    """Serve the site on 443 with the given certificate files. With `redirect`, port 80 sends visitors to https."""
    for path in (cert, key):
        if not CERT_PATH.match(path or "") or ".." in path:
            raise ValueError("certificate paths must be absolute file paths")

    def change(siblings, position, block):
        listens = directives(block, "listen")
        already = any("ssl" in item.args for item in listens)
        for old in directives(block, "ssl_certificate") + directives(block, "ssl_certificate_key"):
            block.children.remove(old)
        if not already:
            moved = False
            for item in listens:
                head, _, port = (item.args[0] if item.args else "80").rpartition(":")
                if port == "80" or (not head and item.args and item.args[0] == "80"):
                    item.args = [(head + ":443") if head else "443", "ssl", *item.args[1:]]
                    moved = True
            if not moved:
                block.children.insert(0, Node(kind="directive", name="listen", args=["443", "ssl"]))
                block.children.insert(1, Node(kind="directive", name="listen", args=["[::]:443", "ssl"]))
        if not directives(block, "http2"):
            at = max((block.children.index(item) for item in directives(block, "listen")), default=-1) + 1
            block.children.insert(at, Node(kind="directive", name="http2", args=["on"]))
        at = max((block.children.index(item) for item in directives(block, "listen")), default=-1) + 1
        block.children.insert(at, Node(kind="directive", name="ssl_certificate", args=[cert]))
        block.children.insert(at + 1, Node(kind="directive", name="ssl_certificate_key", args=[key]))
        if redirect and not already:
            names = directives(block, "server_name")
            twin = Node(kind="block", name="server", children=[
                Node(kind="directive", name="listen", args=["80"]),
                Node(kind="directive", name="listen", args=["[::]:80"]),
                *([Node(kind="directive", name="server_name", args=list(names[0].args))] if names else []),
                Node(kind="directive", name="return", args=["301", "https://$host$request_uri"]),
            ])
            siblings.insert(position + 1, twin)
    return edit(text, index, change)


def disable_https(text, index):
    """Back to plain http on port 80 (the certificate lines are removed, the certificate itself is kept)."""
    def change(siblings, position, block):
        for old in directives(block, "ssl_certificate") + directives(block, "ssl_certificate_key"):
            block.children.remove(old)
        for item in directives(block, "listen"):
            if "ssl" in item.args:
                item.args = [arg for arg in item.args if arg not in ("ssl", "http2")]
                item.args[0] = "[::]:80" if item.args[0].startswith("[") else "80"
        for item in directives(block, "http2"):
            block.children.remove(item)
    return edit(text, index, change)


def insert_after(siblings, position, snippet):
    """Insert the nodes of an nginx snippet after siblings[position]. Returns how many were added."""
    nodes = parse(snippet)
    siblings[position + 1:position + 1] = nodes
    return len(nodes)
