"""Nginx lexer/parser. Arguments retain their Nginx spelling, quotes and escapes.

Whitespace is formatted on export. Comments, duplicates, order, unknown directives,
and arbitrary nested blocks survive. This parses the Nginx language, not the set of
modules installed on a host; only that host's nginx -t can validate those modules.
"""
from dataclasses import dataclass


class ParseError(ValueError):
    def __init__(self, message: str, line: int = 1, path: str = "config"):
        self.line, self.path = line, path
        super().__init__(f"{path}:{line}: {message}")


@dataclass
class Token:
    kind: str
    text: str
    line: int


def lex(text: str, path: str = "config") -> list[Token]:
    tokens = []
    i, line = 0, 1
    while i < len(text):
        ch = text[i]
        if ch.isspace():
            line += ch == "\n"
            i += 1
            continue
        if ch == "#":
            start = i
            while i < len(text) and text[i] != "\n":
                i += 1
            tokens.append(Token("comment", text[start:i].rstrip("\r"), line))  # CRLF files end comments with CR
            continue
        if ch in "{};":
            tokens.append(Token(ch, ch, line))
            i += 1
            continue
        start, start_line, quote = i, line, None
        while i < len(text):
            ch = text[i]
            if ch == "\\":
                if i + 1 == len(text):
                    raise ParseError("unfinished escape", line, path)
                line += text[i + 1] == "\n"
                i += 2
                continue
            if quote:
                if ch == quote:
                    quote = None
                line += ch == "\n"
                i += 1
                continue
            if ch in "\"'":
                quote = ch
                i += 1
                continue
            # ${variable} braces belong to a word, not to the block grammar.
            if ch == "$" and text[i:i + 2] == "${":
                end = text.find("}", i + 2)
                if end < 0 or not text[i + 2:end] or any(c.isspace() for c in text[i + 2:end]):
                    raise ParseError("unfinished variable", line, path)
                i = end + 1
                continue
            if ch.isspace() or ch in "{};":
                break
            # '#' starts a comment at token boundaries. Inside a word it is data.
            i += 1
        if quote:
            raise ParseError("unterminated quoted argument", start_line, path)
        tokens.append(Token("word", text[start:i], start_line))
    return tokens


def parse(text: str, path: str = "config") -> list:
    from .representation import Node
    if not isinstance(text, str):
        raise ParseError("configuration must be text", path=path)
    tokens = lex(text.lstrip("\ufeff"), path)
    index = 0

    closing = 0  # line of the last '}' read

    def body(nested=False, depth=0, open_line=None):
        nonlocal index, closing
        if depth > 100:
            raise ParseError("blocks nested more than 100 levels", path=path)
        nodes, words, start_line = [], [], 1
        while index < len(tokens):
            token = tokens[index]
            index += 1
            if token.kind == "comment":
                # Comments between arguments are legal. Keep them before the directive.
                before = nodes[-1] if nodes else None
                inline = not words and (
                    (before is None and open_line == token.line)
                    or (before is not None and before.kind != "comment" and before.end_line == token.line))
                nodes.append(Node(kind="comment", text=token.text, line=token.line, inline=inline))
            elif token.kind == "word":
                if not words:
                    start_line = token.line
                words.append(token.text)
            elif token.kind in (";", "{"):
                if not words:
                    raise ParseError(f"unexpected '{token.text}'", token.line, path)
                children = body(True, depth + 1, token.line) if token.kind == "{" else []
                nodes.append(Node(kind="block" if token.kind == "{" else "directive",
                                  name=words[0], args=words[1:], children=children, line=start_line,
                                  end_line=closing if token.kind == "{" else token.line))
                words = []
            elif token.kind == "}":
                if words:
                    raise ParseError("missing ';' or '{' before '}'", token.line, path)
                if not nested:
                    raise ParseError("unexpected '}'", token.line, path)
                closing = token.line
                return nodes
        if words:
            raise ParseError("missing ';' or '{' at end of file", start_line, path)
        if nested:
            raise ParseError("missing closing '}'", tokens[-1].line if tokens else 1, path)
        return nodes

    return body()


def render(nodes: list, depth: int = 0) -> str:
    lines = []
    trailing = False  # the last line written can take a comment that was on the same line in the source
    for node in nodes:
        indent = "    " * depth
        if node.kind == "comment":
            if node.inline and trailing:
                lines[-1] += "  " + node.text
            else:
                lines.append(indent + node.text)
            trailing = False
            continue
        header = " ".join([node.name, *node.args])
        if node.kind == "block":
            children = node.children
            opening = indent + header + " {"
            if children and children[0].kind == "comment" and children[0].inline:
                opening += "  " + children[0].text  # server {  # comment
                children = children[1:]
            lines.extend([opening, render(children, depth + 1).rstrip("\n"), indent + "}"])
        else:
            lines.append(indent + header + ";")
        trailing = True
    return "\n".join(line for line in lines if line != "") + ("\n" if lines else "")