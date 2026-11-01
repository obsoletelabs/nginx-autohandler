"""Lossless parser and renderer for nginx configuration files.

Every node keeps the exact source it came from: `text` is the statement itself
and `lead` is the whitespace and comments before it. An unedited document
renders back byte-for-byte. A node with `dirty` set is regenerated from `name`
and `args`, so unsupported or hand-written syntax survives a round trip through
the block editor.

Documents are plain dicts so they can be sent to the browser as JSON:

    {"children": [node, ...], "trail": "<text after the last node>"}
    node = {"name", "args", "block", "lead", "text", "closing", "dirty", "children"}

`children` is only meaningful for blocks; for directives it is an empty list.
`closing` is the text between a block's last child and its closing brace.
"""

import re

TOKEN_RE = re.compile(r"""
    (?P<ws>\s+)
  | (?P<comment>\#[^\n]*)
  | (?P<dq>"(?:\\.|[^"\\])*")
  | (?P<sq>'(?:\\.|[^'\\])*')
  | (?P<semi>;)
  | (?P<open>\{)
  | (?P<close>\})
  | (?P<word>[^\s;{}"'\#]+)
  | (?P<bad>.)
""", re.VERBOSE | re.DOTALL)

HOSTNAME_RE = re.compile(r"^[a-z0-9-]+(\.[a-z0-9-]+)+$")


class ParseError(ValueError):
    pass


def _tokenize(src):
    tokens = []
    pos = 0
    while pos < len(src):
        match = TOKEN_RE.match(src, pos)
        kind = match.lastgroup
        if kind == "bad":
            raise ParseError(f"unexpected or unterminated input near: {src[pos:pos + 20]!r}")
        if kind not in ("ws", "comment"):
            tokens.append((kind, match.group(), match.start(), match.end()))
        pos = match.end()
    return tokens


class _Parser:
    def __init__(self, src):
        self.src = src
        self.tokens = _tokenize(src)
        self.i = 0
        self.prev_end = 0

    def body(self, top):
        children = []
        while self.i < len(self.tokens):
            kind, text, start, _ = self.tokens[self.i]
            if kind == "close":
                if top:
                    raise ParseError(f"unexpected '}}' at character {start}")
                break
            children.append(self.statement())
        if not top and self.i >= len(self.tokens):
            raise ParseError("missing '}' at end of file")
        return children

    def statement(self):
        first_kind, first_text, first_start, _ = self.tokens[self.i]
        lead = self.src[self.prev_end:first_start]
        words = []
        while self.i < len(self.tokens) and self.tokens[self.i][0] in ("word", "dq", "sq"):
            words.append(self.tokens[self.i][1])
            self.i += 1
        if not words:
            raise ParseError(f"unexpected '{first_text}' at character {first_start}")

        node = {"name": words[0], "args": words[1:], "lead": lead, "dirty": False, "children": []}
        if self.i >= len(self.tokens):
            raise ParseError(f"missing ';' after '{words[0]}'")

        kind, text, start, end = self.tokens[self.i]
        if kind == "semi":
            node.update(block=False, text=self.src[first_start:end], closing="")
            self.prev_end = end
            self.i += 1
            return node

        if kind == "open":
            self.prev_end = end
            self.i += 1
            node["children"] = self.body(top=False)
            close_kind, _, close_start, close_end = self.tokens[self.i]
            node.update(
                block=True,
                text=self.src[first_start:end],
                closing=self.src[self.prev_end:close_start],
            )
            self.prev_end = close_end
            self.i += 1
            return node

        raise ParseError(f"expected ';' or '{{' after '{words[0]}' at character {start}")


def parse(src):
    """Parse nginx config text into a document dict."""
    parser = _Parser(src)
    children = parser.body(top=True)
    return {"children": children, "trail": src[parser.prev_end:]}


def _format_words(node):
    return " ".join([node["name"], *node["args"]])


def _render_node(node):
    if node["block"]:
        head = (_format_words(node) + " {") if node["dirty"] else node["text"]
        inner = "".join(_render_node(child) for child in node["children"])
        return node["lead"] + head + inner + node["closing"] + "}"
    body = (_format_words(node) + ";") if node["dirty"] else node["text"]
    return node["lead"] + body


def render(doc):
    """Render a document dict back to nginx config text."""
    return "".join(_render_node(node) for node in doc["children"]) + doc["trail"]


def walk(nodes):
    for node in nodes:
        yield node
        if node["block"]:
            yield from walk(node["children"])


def server_names(src):
    """Hostnames declared with server_name in `src`, lowercased and sorted.

    Skips regex names, wildcards, `_` placeholders and bare IP addresses.
    """
    try:
        doc = parse(src)
    except ParseError:
        return []
    names = set()
    for node in walk(doc["children"]):
        if node["name"] != "server_name":
            continue
        for arg in node["args"]:
            host = arg.strip("'\"").lower()
            if HOSTNAME_RE.match(host) and not host.split(".")[-1].isdigit():
                names.add(host)
    return sorted(names)
