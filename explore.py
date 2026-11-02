"""Looking across the whole config: search every file, and draw how domains reach apps (the topology)."""

import re
from pathlib import Path

import overview
import sites
from nginx_model import parse

MAX_MATCHES = 300
MAX_FILE = 1024 * 1024


def read_all(root):
    """{relative path: text} for every config file (enabled or not) under root."""
    files = {}
    for name, path in overview.config_files(Path(root)).items():
        try:
            if path.stat().st_size <= MAX_FILE:
                files[name] = path.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeDecodeError):
            continue
    return files


def search(files, query, regex=False, case=False):
    """Matching lines across files: [{file, line, text, start, end}], at most MAX_MATCHES."""
    query = str(query or "")
    if not query.strip():
        return {"matches": [], "truncated": False, "files": len(files)}
    if len(query) > 200:
        raise ValueError("the search text is too long")
    flags = 0 if case else re.IGNORECASE
    try:
        pattern = re.compile(query if regex else re.escape(query), flags)
    except re.error as exc:
        raise ValueError(f"that is not a valid regular expression: {exc}")
    matches, truncated = [], False
    for name in sorted(files):
        for number, line in enumerate(files[name].splitlines(), 1):
            if len(line) > 2000:
                line = line[:2000]
            found = pattern.search(line)
            if found:
                if len(matches) >= MAX_MATCHES:
                    truncated = True
                    break
                matches.append({"file": name, "line": number, "text": line.strip()[:300], "start": found.start() - (len(line) - len(line.lstrip())),
                                "end": found.end() - (len(line) - len(line.lstrip()))})
        if truncated:
            break
    return {"matches": matches, "truncated": truncated, "files": len(files)}


def upstream_pools(parsed):
    pools = {}
    for nodes in parsed.values():
        for node in sites_walk(nodes):
            if node.kind == "block" and node.name == "upstream" and node.args:
                pools[node.args[0]] = [child.args[0] for child in node.children
                                       if child.kind == "directive" and child.name == "server" and child.args]
    return pools


def sites_walk(nodes):
    for node in nodes:
        yield node
        if node.kind == "block":
            yield from sites_walk(node.children)


def host_of(target):
    rest = target.split("://", 1)[-1]
    return rest.split("/", 1)[0]


def topology(files, enabled):
    """Nodes and edges: domain -> site -> (pool ->) app. `enabled` is the set of live file paths."""
    parsed = {}
    for name, text in files.items():
        try:
            parsed[name] = parse(text, name)
        except ValueError:
            continue
    pools = upstream_pools(parsed)
    nodes, edges, seen = {}, set(), set()

    def node(node_id, kind, label, sub="", state="ok"):
        nodes.setdefault(node_id, {"id": node_id, "kind": kind, "label": label, "sub": sub, "state": state})
        return node_id

    for name in sorted(parsed):
        for index, (_, _, block) in enumerate(sites.server_blocks(parsed[name])):
            info = sites.describe(block, name, index)
            live = name in enabled
            site_id = node(f"site:{info['id']}", "site", info["names"][0] if info["names"] else name,
                           ("HTTPS" if info["ssl"] else "HTTP") + (" · " + name), "ok" if live else "off")
            for domain in info["names"] or []:
                if domain in ("_", "") or domain.startswith("~"):
                    continue
                edges.add((node(f"domain:{domain}", "domain", domain, "", "ok" if live else "off"), site_id))
            seen.add(site_id)
            for proxy in sorted({n.args[0] for n in sites.subtree(block) if n.kind == "directive" and n.name == "proxy_pass" and n.args}):
                host = host_of(proxy)
                if host in pools:
                    pool = node(f"pool:{host}", "pool", host, f"{len(pools[host])} servers", "ok")
                    edges.add((site_id, pool))
                    for backend in pools[host]:
                        edges.add((pool, node(f"app:{backend}", "app", backend)))
                else:
                    edges.add((site_id, node(f"app:{host}", "app", host)))
            if info["root"]:
                edges.add((site_id, node(f"folder:{info['root']}", "folder", info["root"])))
            if info["redirect"]:
                edges.add((site_id, node(f"redirect:{info['redirect']}", "redirect", info["redirect"].split(" ", 1)[-1][:40])))
    return {"nodes": list(nodes.values()), "edges": [[a, b] for a, b in sorted(edges)]}
