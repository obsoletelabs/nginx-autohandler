"use strict";

// Basic view: one plain card per site. Every control writes its change into the draft straight away, so there is
// no "apply" step. What the card cannot show stays in the file untouched ("N more settings") and can be edited
// as raw nginx in the Advanced box or in the Blocks view.

const ROUTING = ["proxy_pass", "grpc_pass", "fastcgi_pass", "uwsgi_pass", "scgi_pass", "root", "alias", "try_files", "return", "index"];
const ROUTE_SIMPLE = [...ROUTING, "proxy_http_version", "proxy_set_header"];
const EXPLOIT_MARK = /^#\s*Block common exploits(?:\s*\((\d+) rules?\))?/i;
const CACHE_MARK = /Cache assets/i;
const EXPLOIT_RULES = [
  'location ~ /\\.(?!well-known) { deny all; }',
  'if ($request_method ~* "^(TRACE|TRACK)$") { return 405; }',
  'if ($query_string ~* "(<|%3C)[^>]*script") { return 403; }',
  'if ($query_string ~* "union.*select.*\\(") { return 403; }',
];
const ASSET_PATTERN = "\\.(?:css|js|mjs|map|jpg|jpeg|png|gif|svg|ico|webp|avif|woff2?|ttf)$";
const BASIC_CERTS = { key: "", at: 0, data: null };

// ---------------------------------------------------------------- reading a server block

// Native append() would print the text "null"; skip empty children.
const put = (parent, ...kids) => { parent.append(...kids.filter((kid) => kid !== null && kid !== undefined && kid !== false)); return parent; };
const quoted = (text) => (/[\s;"'#{}]/.test(text) ? JSON.stringify(text) : text);
const mainLocation = (server) => server.children.find((n) => n.kind === "block" && n.name === "location" && n.args.length === 1 && fieldToken(n.args[0]) === "/") || null;
const isRedirectReturn = (node) => node.kind === "directive" && node.name === "return" && /^30[1278]$/.test(node.args[0] || "");

function exploitSpan(server) {
  const index = server.children.findIndex((n) => n.kind === "comment" && !n.inline && EXPLOIT_MARK.test(n.text));
  if (index < 0) return null;
  const count = Number((server.children[index].text.match(EXPLOIT_MARK) || [])[1]) || EXPLOIT_RULES.length;
  return { index, count: Math.min(count, server.children.length - index - 1) };
}

function cacheLocation(server) {
  return server.children.find((n) => n.kind === "block" && n.name === "location" && fieldToken(n.args[0] || "") === "~*" && [headNote(n)].some((c) => c && CACHE_MARK.test(c.text))) || null;
}

const hstsNode = (server) => direct(server, "add_header").find((n) => fieldToken(n.args[0] || "").toLowerCase() === "strict-transport-security");

// proxy_pass "http://host:port/path" in parts, or null when it is something else (a variable, a unix socket).
function parseTarget(value) {
  const match = fieldToken(value || "").match(/^(https?):\/\/(\[[^\]]+\]|[^/:\s$]+)(?::(\d+))?(\/.*)?$/i);
  return match ? { scheme: match[1].toLowerCase(), host: match[2], port: match[3] || "", rest: match[4] || "" } : null;
}

const buildTarget = (parts) => `${parts.scheme}://${parts.host}${parts.port ? ":" + parts.port : ""}${parts.rest || ""}`;

// What the site does for "/": forward to an app, serve a folder, redirect, nothing yet, or something custom.
function routeOf(server) {
  const redirect = direct(server, "return").find(isRedirectReturn);
  if (redirect) return { kind: "redirect", holder: server, code: redirect.args[0], target: fieldToken(redirect.args[1] || ""), node: redirect };
  const loc = mainLocation(server);
  if (!loc) return { kind: "none", holder: null };
  const proxy = direct(loc, "proxy_pass")[0];
  if (proxy) return { kind: "proxy", holder: loc, value: fieldToken(proxy.args[0]), node: proxy };
  const root = direct(loc, "root")[0] || direct(loc, "alias")[0];
  if (root) return { kind: "static", holder: loc, value: fieldToken(root.args[0]), node: root };
  const ret = direct(loc, "return").find(isRedirectReturn);
  if (ret) return { kind: "redirect", holder: loc, code: ret.args[0], target: fieldToken(ret.args[1] || ""), node: ret };
  return { kind: "custom", holder: loc };
}

function locationKind(loc) {
  const proxy = direct(loc, "proxy_pass")[0];
  if (proxy) return { kind: "proxy", value: fieldToken(proxy.args[0]) };
  const root = direct(loc, "root")[0] || direct(loc, "alias")[0];
  if (root) return { kind: "static", value: fieldToken(root.args[0]) };
  const ret = direct(loc, "return")[0];
  if (ret && isRedirectReturn(ret)) return { kind: "redirect", value: fieldToken(ret.args[1] || ""), code: ret.args[0] };
  return { kind: "custom", value: "" };
}

const extraSettings = (loc) => loc.children.filter((n) => n.kind !== "comment" && !(n.kind === "directive" && ROUTE_SIMPLE.includes(n.name))).length;

function managedIds(server) {
  const ids = new Set();
  for (const node of server.children) {
    if (node.kind === "directive" && ["server_name", "listen", "ssl_certificate", "ssl_certificate_key", "http2", "ssl_protocols"].includes(node.name)) ids.add(node.id);
    if (node === hstsNode(server) || (node.kind === "directive" && isRedirectReturn(node))) ids.add(node.id);
    if (node.kind === "block" && node.name === "location") ids.add(node.id);
  }
  const span = exploitSpan(server);
  if (span) for (let i = span.index; i <= span.index + span.count; i++) ids.add(server.children[i].id);
  return ids;
}

// Moving the cursor away from a half-filled field must not lose what was typed: commit on blur and Enter.
function textField(value, { placeholder = "", label = "", width = "", onCommit, mono = false }) {
  const input = el("input", { type: "text", value, placeholder, "aria-label": label, class: mono ? "mono" : "" });
  if (width) input.style.width = width;
  let last = value;
  const commit = () => {
    const next = input.value.trim();
    if (next === last) return;
    last = next;
    onCommit(next);
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); input.blur(); }
    if (event.key === "Escape") { input.value = last; input.blur(); }
  });
  input.addEventListener("change", commit);
  input.addEventListener("blur", commit);
  return input;
}

// ---------------------------------------------------------------- editing

// Run an edit on a fresh copy of the server block from the draft, as one undo step.
async function editSite(serverId, message, fn) {
  if (!(await applyDraft())) return;
  mutate(() => {
    const hit = locate(serverId);
    if (hit) fn(hit.node, hit);
  }, message);
}

function setDir(block, name, args, afterNames = []) {
  const found = direct(block, name)[0];
  if (found) { found.args = args; return found; }
  const node = newNode(name, args);
  let at = block.children.length;
  let last = -1;
  block.children.forEach((child, index) => { if (child.kind === "directive" && afterNames.includes(child.name)) last = index; });
  if (last >= 0) { at = last + 1; if (isInlineNote(block.children, at, true)) at++; }
  block.children.splice(at, 0, node);
  return node;
}

function dropDirs(block, names, only) {
  for (let i = block.children.length - 1; i >= 0; i--) {
    const child = block.children[i];
    if (child.kind === "directive" && names.includes(child.name) && (!only || only(child))) removeSpan(block.children, i);
  }
}

function insertBeforeLocations(server, nodes) {
  // Before the first location, and before a "Block common exploits" group so its rules stay together.
  let at = server.children.findIndex((n) => (n.kind === "block" && n.name === "location") || (n.kind === "comment" && !n.inline && EXPLOIT_MARK.test(n.text)));
  if (at < 0) at = server.children.length;
  server.children.splice(at, 0, ...nodes);
}

const PROXY_HEADERS = [["Host", "$host"], ["X-Real-IP", "$remote_addr"], ["X-Forwarded-For", "$proxy_add_x_forwarded_for"], ["X-Forwarded-Proto", "$scheme"]];

function addProxyHeaders(loc) {
  const have = new Set(direct(loc, "proxy_set_header").map((n) => fieldToken(n.args[0] || "").toLowerCase()));
  for (const [name, value] of PROXY_HEADERS) if (!have.has(name.toLowerCase())) loc.children.push(newNode("proxy_set_header", [name, value]));
}

// Make `holder` (a location) forward, serve a folder or redirect; only its routing lines are replaced.
function routeHolder(holder, kind, value, code) {
  dropDirs(holder, ROUTING);
  if (kind !== "proxy") dropDirs(holder, ["proxy_http_version", "proxy_set_header"]);
  if (kind === "proxy") {
    holder.children.unshift(newNode("proxy_pass", [quoted(value || "http://127.0.0.1:8080")]));
    addProxyHeaders(holder);
  } else if (kind === "static") {
    holder.children.unshift(newNode("root", [quoted(value || "/var/www/html")]), newNode("index", ["index.html", "index.htm"]), newNode("try_files", ["$uri", "$uri/", "=404"]));
  } else if (kind === "redirect") {
    holder.children.unshift(newNode("return", [code || "301", quoted(value || "https://example.com$request_uri")]));
  }
}

function switchRoute(serverId, kind) {
  return editSite(serverId, "Site type changed", (server) => {
    const current = routeOf(server);
    if (current.kind === kind) return;
    let loc = mainLocation(server);
    if (current.kind === "redirect" && current.holder === server) dropDirs(server, ["return"], isRedirectReturn);
    if (kind === "redirect") {
      if (loc) {
        dropDirs(loc, ROUTING);
        dropDirs(loc, ["proxy_http_version", "proxy_set_header"]);
        if (!loc.children.some((n) => n.kind !== "comment")) server.children.splice(server.children.indexOf(loc), 1);
      }
      insertBeforeLocations(server, [newNode("return", ["301", "https://example.com$request_uri"])]);
      return;
    }
    if (!loc) {
      loc = newNode("location", ["/"], "block");
      server.children.push(loc);
    }
    routeHolder(loc, kind);
  });
}

function editRoute(serverId, field, value) {
  return editSite(serverId, "Site updated", (server) => {
    const route = routeOf(server);
    if (route.kind === "proxy") setDir(route.holder, "proxy_pass", [quoted(value)]);
    else if (route.kind === "static") {
      const name = direct(route.holder, "alias").length ? "alias" : "root";
      setDir(route.holder, name, [quoted(value)]);
    } else if (route.kind === "redirect") {
      if (field === "code") route.node.args = [value, ...route.node.args.slice(1)];
      else route.node.args = [route.node.args[0], quoted(value)];
    }
  });
}

function setNames(serverId, names) {
  return editSite(serverId, "Domain names updated", (server) => {
    const clean = [...new Set(names.filter(Boolean))];
    if (!clean.length) { dropDirs(server, ["server_name"]); return; }
    setDir(server, "server_name", clean, ["listen"]);
  });
}

const goodName = (name) => !/[\s;{}"'\\]/.test(name) && name.length < 254;

function setWebsocket(serverId, on) {
  return editSite(serverId, on ? "WebSocket support on" : "WebSocket support off", (server) => {
    const loc = mainLocation(server);
    if (!loc) return;
    for (let i = loc.children.length - 1; i >= 0; i--) {
      const child = loc.children[i];
      if (isWebsocketHeader(child) || (child.kind === "directive" && child.name === "proxy_http_version")) removeSpan(loc.children, i);
    }
    if (on) {
      const at = Math.max(0, loc.children.findIndex((n) => n.name === "proxy_pass") + 1);
      loc.children.splice(at, 0, newNode("proxy_http_version", ["1.1"]), newNode("proxy_set_header", ["Upgrade", "$http_upgrade"]), newNode("proxy_set_header", ["Connection", '"upgrade"']));
    }
  });
}

async function setHttp2(serverId, on) {
  if (!(await applyDraft())) return;
  const doc = await api("/api/basic", { document: state.doc, node_id: serverId, patch: { http2: on } });
  mutate(() => { state.doc = doc; }, on ? "HTTP/2 on" : "HTTP/2 off");
}

function setHsts(serverId, on) {
  return editSite(serverId, on ? "HSTS on" : "HSTS off", (server) => {
    dropDirs(server, ["add_header"], (n) => fieldToken(n.args[0] || "").toLowerCase() === "strict-transport-security");
    if (on) insertBeforeLocations(server, [newNode("add_header", ["Strict-Transport-Security", '"max-age=63072000; includeSubDomains"', "always"])]);
  });
}

async function parseSnippet(text) {
  const parsed = await api("/api/parse", { text, path: state.file });
  return parsed.nodes;
}

async function setExploits(serverId, on) {
  const nodes = on ? await parseSnippet(`# Block common exploits (${EXPLOIT_RULES.length} rules)\n${EXPLOIT_RULES.join("\n")}\n`) : [];
  return editSite(serverId, on ? "Exploit blocking on" : "Exploit blocking off", (server) => {
    const span = exploitSpan(server);
    if (span) server.children.splice(span.index, span.count + 1);
    if (on) insertBeforeLocations(server, nodes);
  });
}

async function setCache(serverId, on) {
  let nodes = [];
  if (on) {
    const route = routeOf(locate(serverId).node);
    const body = route.kind === "proxy"
      ? `proxy_pass ${quoted((() => { const p = parseTarget(route.value); return p ? buildTarget({ ...p, rest: "" }) : route.value; })())};\n    proxy_set_header Host $host;`
      : `root ${quoted(route.value)};`;
    nodes = await parseSnippet(`location ~* ${ASSET_PATTERN} {  # Cache assets (30 days)\n    ${body}\n    expires 30d;\n    add_header Cache-Control "public";\n}\n`);
  }
  return editSite(serverId, on ? "Asset caching on" : "Asset caching off", (server) => {
    const old = cacheLocation(server);
    if (old) server.children.splice(server.children.indexOf(old), 1);
    if (on) server.children.push(...nodes);
  });
}

function setForceHttps(serverId, on) {
  return editSite(serverId, on ? "Force HTTPS on" : "Force HTTPS off", (server, hit) => {
    const sibling = redirectSibling(hit);
    if (!on) {
      if (sibling) removeSpan(hit.nodes, hit.nodes.indexOf(sibling));
      const before = listensOf(server);
      if (!before.some((item) => item.port === 80)) {
        const nodes = [newNode("listen", ["80"])];
        if (before.some((item) => item.v6)) nodes.push(newNode("listen", ["[::]:80"]));
        insertAfterListens(server, nodes);
      }
      return;
    }
    if (sibling) return;
    const plain = listensOf(server).filter((item) => item.port === 80 && !item.ssl);
    const fresh = [newNode("listen", ["80"])];
    if (listensOf(server).some((item) => item.v6)) fresh.push(newNode("listen", ["[::]:80"]));
    const nameNode = direct(server, "server_name")[0];
    const redirect = newNode("server", [], "block", [
      ...(plain.length ? plain.map((item) => newNode("listen", [...item.node.args])) : fresh),
      newNode("server_name", nameNode ? [...nameNode.args] : ["_"]),
      newNode("return", ["301", "https://$host$request_uri"]),
    ]);
    for (const item of plain) removeSpan(server.children, server.children.indexOf(item.node));
    const at = hit.nodes.indexOf(server);
    hit.nodes.splice(at + spanLength(hit.nodes, at), 0, redirect);
  });
}

// ---------------------------------------------------------------- small pieces

function sw(label, on, sub, onToggle, { disabled = false } = {}) {
  const button = el("button", { type: "button", class: "sw" + (on ? " on" : ""), role: "switch", "aria-checked": String(on), "aria-label": label, disabled }, el("span", { class: "sw-track" }, el("span", { class: "sw-knob" })));
  button.addEventListener("click", () => { if (!button.disabled) Promise.resolve(onToggle(!on)).catch(report); });
  return el("div", { class: "sw-row" + (disabled ? " off" : "") }, button, el("div", { class: "sw-text" }, el("strong", { text: label }), sub ? el("small", { text: sub }) : null));
}

function nameChips(server) {
  const names = direct(server, "server_name").flatMap((n) => n.args.map(fieldToken));
  const box = el("div", { class: "chip-field" });
  for (const name of names) {
    box.append(el("span", { class: "chip" }, el("span", { text: name === "_" ? "any domain (_)" : name }),
      el("button", { type: "button", class: "chip-x", title: "Remove " + name, "aria-label": "Remove " + name, text: "×", onclick: () => setNames(server.id, names.filter((x) => x !== name)).catch(report) })));
  }
  const input = el("input", { type: "text", class: "chip-input", placeholder: names.length ? "Add another domain" : "example.com", "aria-label": "Add a domain name" });
  const add = () => {
    const fresh = input.value.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
    if (!fresh.length) return;
    const bad = fresh.find((x) => !goodName(x));
    if (bad) { toast(`“${bad}” is not a valid domain name.`, "warn"); return; }
    input.value = "";
    setNames(server.id, [...names.filter((x) => x !== "_"), ...fresh]).catch(report);
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === "," || event.key === " ") { event.preventDefault(); add(); }
    if (event.key === "Backspace" && !input.value && names.length) setNames(server.id, names.slice(0, -1)).catch(report);
  });
  input.addEventListener("blur", add);
  input.addEventListener("paste", () => setTimeout(add, 0));
  box.append(input);
  box.addEventListener("click", () => input.focus());
  return box;
}

const SITE_KINDS = [["proxy", "Forward to an app", "Send visitors to another server or port"], ["static", "Serve a folder", "Show the files in a folder"], ["redirect", "Redirect", "Send visitors to another address"]];

function routeEditor(server) {
  const route = routeOf(server);
  const wrap = el("div", { class: "site-route" });
  const seg = el("div", { class: "seg", role: "tablist" });
  for (const [kind, label, hint] of SITE_KINDS) {
    seg.append(el("button", { type: "button", class: "seg-btn" + (route.kind === kind ? " on" : ""), role: "tab", "aria-selected": String(route.kind === kind), title: hint, text: label, onclick: () => { if (route.kind !== kind) switchRoute(server.id, kind).catch(report); } }));
  }
  wrap.append(seg);
  if (route.kind === "proxy") {
    const parts = parseTarget(route.value);
    if (parts) {
      const scheme = el("select", { "aria-label": "Forward scheme" }, ["http", "https"].map((value) => el("option", { value, text: value })));
      scheme.value = parts.scheme;
      scheme.addEventListener("change", () => editRoute(server.id, "target", buildTarget({ ...parts, scheme: scheme.value })).catch(report));
      const host = textField(parts.host, { placeholder: "192.168.1.10 or app", label: "Forward host", onCommit: (v) => v && editRoute(server.id, "target", buildTarget({ ...parts, host: v })).catch(report), width: "100%" });
      const port = textField(parts.port, { placeholder: "port", label: "Forward port", width: "90px", onCommit: (v) => (/^\d{0,5}$/.test(v) ? editRoute(server.id, "target", buildTarget({ ...parts, port: v })).catch(report) : toast("A port is a number, like 8080.", "warn")) });
      put(wrap, el("div", { class: "field" }, el("span", { class: "field-label", text: "Forward to" }),
        el("div", { class: "target-row" }, scheme, host, el("span", { class: "colon", text: ":" }), port)),
      parts.rest && parts.rest !== "/" ? el("small", { class: "field-hint", text: `Requests are sent to ${parts.rest} on that server.` }) : null);
    } else {
      wrap.append(el("div", { class: "field" }, el("span", { class: "field-label", text: "Forward to" }),
        textField(route.value, { label: "Forward to", mono: true, onCommit: (v) => v && editRoute(server.id, "target", v).catch(report) })));
    }
  } else if (route.kind === "static") {
    wrap.append(el("div", { class: "field" }, el("span", { class: "field-label", text: "Folder to serve" }),
      textField(route.value, { label: "Folder", placeholder: "/var/www/site", mono: true, onCommit: (v) => v && editRoute(server.id, "root", v).catch(report) }),
      el("small", { class: "field-hint", text: "A path on the nginx machine." })));
  } else if (route.kind === "redirect") {
    const code = el("select", { "aria-label": "Redirect type" }, [["301", "Permanent (301)"], ["302", "Temporary (302)"], ["307", "Temporary, keep method (307)"], ["308", "Permanent, keep method (308)"]].map(([value, text]) => el("option", { value, text })));
    code.value = route.code;
    if (code.value !== route.code) code.append(el("option", { value: route.code, text: route.code, selected: true }));
    code.addEventListener("change", () => editRoute(server.id, "code", code.value).catch(report));
    wrap.append(el("div", { class: "field" }, el("span", { class: "field-label", text: "Redirect to" }),
      el("div", { class: "target-row" }, code, textField(route.target, { label: "Redirect address", placeholder: "https://example.com$request_uri", mono: true, width: "100%", onCommit: (v) => v && editRoute(server.id, "target", v).catch(report) })),
      el("small", { class: "field-hint", text: "$request_uri keeps the path the visitor asked for." })));
  } else if (route.kind === "custom") {
    wrap.append(el("p", { class: "notice-soft", text: "This site's main page is set up with custom settings. Use the Blocks view to change it." }));
  } else {
    wrap.append(el("p", { class: "notice-soft", text: "Choose what this site should do." }));
  }
  return wrap;
}

// ---------------------------------------------------------------- certificates

async function certificateReport(names) {
  const key = names.join(",");
  if (BASIC_CERTS.key === key && Date.now() - BASIC_CERTS.at < 15000) return BASIC_CERTS.data;
  await loadHttpsMatch(names);
  BASIC_CERTS.key = key;
  BASIC_CERTS.at = Date.now();
  BASIC_CERTS.data = { certs: (HTTPS.match && HTTPS.match.certificates) || [], all: (HTTPS.certs && HTTPS.certs.certificates) || [] };
  return BASIC_CERTS.data;
}

function lineageOf(path) {
  const match = String(path || "").match(/\/live\/([^/]+)\//);
  return match ? match[1] : "";
}

function certificateVerdict(server, data) {
  const names = serverNames(server);
  const tls = tlsState(server);
  if (!names.length) return { tone: "test", title: "Add a domain name", sub: "Certificates are matched to the domain names above.", action: null };
  if (tls.ssl && tls.certificate) {
    const name = lineageOf(tls.certificate);
    const cert = data.all.find((c) => c.name === name) || data.certs.find((c) => c.name === name);
    if (!cert) return { tone: "bad", title: "Certificate files not found here", sub: `This site uses ${tls.certificate}, which is not a certificate this app manages. Make sure it exists on the nginx machine, or pick another.`, action: "Change certificate" };
    const covered = data.certs.find((c) => c.name === cert.name) || cert;
    const missing = covered.missing || [];
    const days = Number(cert.days_left);
    if (cert.valid === false || days < 0) return { tone: "bad", title: "Certificate expired", sub: `${cert.name} ${certExpiryText(cert)}. Renew it or choose another.`, action: "Change certificate" };
    if (missing.length) return { tone: "warn", title: "Certificate does not cover every name", sub: `${cert.name} is missing ${missing.join(", ")}.`, action: "Change certificate" };
    if (days <= 21) return { tone: "warn", title: "Certificate expires soon", sub: `${cert.name} ${certExpiryText(cert)}.${cert.kind === "acme" || cert.kind === "letsencrypt" ? " It renews itself automatically." : " Replace it before then."}`, action: "Change certificate" };
    return { tone: "good", title: "Certificate is good", sub: `${cert.name} · ${certKindText(cert)} · ${certExpiryText(cert)}`, action: "Change certificate" };
  }
  const best = [...data.certs].sort((a, b) => certRank(b) - certRank(a))[0];
  if (best && isGood(best) && (best.covers || []).length === names.length && !(best.missing || []).length) {
    return { tone: "info", title: "A certificate is ready for these names", sub: `${best.name} covers them. Turn on SSL to use it.`, action: "Turn on SSL" };
  }
  return { tone: "warn", title: "No certificate for these names yet", sub: "Turn on SSL to get one from Let's Encrypt, make a self-signed one, or use your own.", action: "Get a certificate" };
}

function certificateBlock(server) {
  const box = el("div", { class: "cert-state" }, el("span", { class: "spinner" }), el("span", { class: "muted", text: "Checking certificates…" }));
  const names = serverNames(server);
  certificateReport(names).then((data) => {
    if (!box.isConnected && !box.parentNode) return;
    const verdict = certificateVerdict(server, data);
    box.className = "cert-state tone-" + verdict.tone;
    box.replaceChildren(...[el("div", { class: "cert-text" }, el("strong", { text: verdict.title }), el("small", { text: verdict.sub })),
      verdict.action ? el("button", { type: "button", class: "tiny", text: verdict.action, onclick: () => openHttps(server.id).catch(report) }) : null].filter(Boolean));
  }).catch((error) => {
    box.className = "cert-state tone-test";
    box.replaceChildren(el("small", { class: "muted", text: "Certificates could not be checked: " + describeError(error).summary }));
  });
  return box;
}

// ---------------------------------------------------------------- custom locations

function locationRow(server, loc) {
  const info = locationKind(loc);
  const extras = extraSettings(loc);
  const row = el("div", { class: "loc-row" });
  const path = textField(loc.args.join(" "), { label: "Address starts with", mono: true, width: "150px", onCommit: (v) => v && editSite(server.id, "Location updated", (s) => { const l = s.children.find((n) => n.id === loc.id); if (l) l.args = v.split(/\s+/); }).catch(report) });
  const kind = el("select", { "aria-label": "What this address does" }, [["proxy", "Forward to"], ["static", "Serve folder"], ["redirect", "Redirect to"], ["custom", "Custom"]].map(([value, text]) => el("option", { value, text })));
  kind.value = info.kind;
  kind.addEventListener("change", () => { if (kind.value === "custom") { kind.value = info.kind; return; } editSite(server.id, "Location updated", (s) => { const l = s.children.find((n) => n.id === loc.id); if (l) routeHolder(l, kind.value); }).catch(report); });
  const target = info.kind === "custom"
    ? el("span", { class: "muted tiny", text: "custom settings" })
    : textField(info.value, { label: "Target", mono: true, width: "100%", onCommit: (v) => v && editSite(server.id, "Location updated", (s) => {
      const l = s.children.find((n) => n.id === loc.id);
      if (!l) return;
      if (info.kind === "proxy") setDir(l, "proxy_pass", [quoted(v)]);
      else if (info.kind === "static") setDir(l, direct(l, "alias").length ? "alias" : "root", [quoted(v)]);
      else { const r = direct(l, "return")[0]; if (r) r.args = [r.args[0], quoted(v)]; }
    }).catch(report) });
  put(row, path, kind, target,
    extras ? el("button", { type: "button", class: "link-btn", title: "Open this site in the Blocks view", text: `${extras} more setting${extras === 1 ? "" : "s"}`, onclick: () => openInBlocks(loc.id) }) : null,
    el("button", { type: "button", class: "tiny danger", title: "Remove this location", "aria-label": "Remove location " + loc.args.join(" "), text: "×", onclick: () => editSite(server.id, "Location removed", (s) => { const i = s.children.findIndex((n) => n.id === loc.id); if (i >= 0) removeSpan(s.children, i); }).catch(report) }));
  return row;
}

async function openInBlocks(id) {
  if (!(await applyDraft())) return;
  state.mode = "blocks";
  state.selected = id;
  render();
}

function customLocations(server) {
  const main = mainLocation(server);
  const cache = cacheLocation(server);
  const exploitIds = new Set();
  const span = exploitSpan(server);
  if (span) for (let i = span.index; i <= span.index + span.count; i++) exploitIds.add(server.children[i].id);
  return server.children.filter((n) => n.kind === "block" && n.name === "location" && n !== main && n !== cache && !exploitIds.has(n.id));
}

// ---------------------------------------------------------------- the stock "welcome" site

// The default.conf of the nginx image: localhost on port 80, the welcome page and the 50x error page.
function isStockDefault(server) {
  const names = serverNames(server);
  if (names.length && !(names.length === 1 && names[0] === "localhost")) return false;
  const body = server.children.filter((n) => n.kind !== "comment");
  const allowed = new Set(["listen", "server_name", "location", "error_page", "access_log"]);
  if (body.some((n) => !allowed.has(n.name))) return false;
  if (listensOf(server).some((item) => item.port !== 80)) return false;
  const roots = server.children.filter((n) => n.kind === "block" && n.name === "location");
  if (!roots.length || roots.length > 2) return false;
  return roots.every((loc) => direct(loc, "root").some((r) => fieldToken(r.args[0]) === "/usr/share/nginx/html")) && roots.some((loc) => fieldToken(loc.args[0] || "") === "/");
}

async function replaceStockDefault(serverId) {
  const domain = await ask({ title: "Replace the welcome site", message: "What domain name should your first site answer to?", input: true, value: "app.example.com", ok: "Next" });
  if (typeof domain !== "string" || !domain.trim()) return;
  const target = await ask({ title: "Where should it go?", message: "The app this domain forwards to (address and port).", input: true, value: "http://127.0.0.1:8080", ok: "Replace welcome site" });
  if (typeof target !== "string" || !target.trim()) return;
  if (!goodName(domain.trim())) { toast("That is not a valid domain name.", "warn"); return; }
  const nodes = await parseSnippet(`server {\n    listen 80;\n    listen [::]:80;\n    server_name ${domain.trim()};\n    location / {\n        proxy_pass ${quoted(target.trim())};\n    }\n}\n`);
  const loc = nodes[0].children.find((n) => n.name === "location");
  addProxyHeaders(loc);
  await editSite(serverId, "Welcome site replaced", (server, hit) => { hit.nodes.splice(hit.index, spanLength(hit.nodes, hit.index), ...nodes); state.selected = nodes[0].id; });
}

function welcomeCard(server) {
  return el("section", { class: "site-card welcome" },
    el("div", { class: "site-head" }, el("div", {}, el("small", { class: "eyebrow", text: "STARTER" }), el("h3", { text: "Default welcome site" })),
      el("span", { class: "site-actions" }, el("button", { type: "button", class: "tiny", text: "Blocks ↗", onclick: () => openInBlocks(server.id) }))),
    el("p", { class: "notice-soft", text: "This is the nginx test page that ships with a new install. It answers on localhost only and does not forward anywhere." }),
    el("div", { class: "welcome-actions" }, el("button", { type: "button", class: "primary", text: "Replace with my first site", onclick: () => replaceStockDefault(server.id).catch(report) })));
}

// ---------------------------------------------------------------- the card

function siteTitle(server) {
  const names = serverNames(server);
  if (!names.length) return direct(server, "server_name")[0] ? "Any domain (catch-all)" : "Unnamed site";
  return names.length > 2 ? `${names[0]} +${names.length - 1}` : names.join(", ");
}

function siteCard(server) {
  const hit = locate(server.id);
  const tls = tlsState(server);
  const route = routeOf(server);
  const forced = !!redirectSibling(hit);
  const http2 = tls.listens.some((item) => item.node.args.includes("http2")) || direct(server, "http2").some((n) => n.args[0] === "on");
  const websocket = route.kind === "proxy" && websocketOn(route.holder);
  const cacheable = route.kind === "proxy" || route.kind === "static";
  const card = el("section", { class: "site-card", "data-node": server.id });
  card.append(el("div", { class: "site-head" },
    el("div", {}, el("small", { class: "eyebrow", text: "SITE" }), el("h3", { text: siteTitle(server) }),
      el("span", { class: "site-badges" }, badge2(tls.ssl ? "good" : "test", tls.ssl ? "HTTPS" : "HTTP ONLY"), forced ? badge2("good", "HTTP → HTTPS") : null)),
    el("span", { class: "site-actions" },
      el("button", { type: "button", class: "tiny", title: "Duplicate this site", text: "⧉ Duplicate", onclick: () => duplicateSite(server.id).catch(report) }),
      el("button", { type: "button", class: "tiny", title: "See this site as blocks", text: "Blocks ↗", onclick: () => openInBlocks(server.id) }),
      el("button", { type: "button", class: "tiny danger", title: "Delete this site", text: "Delete", onclick: () => deleteSite(server.id).catch(report) }))));
  card.append(el("div", { class: "field" }, el("span", { class: "field-label", text: "Domain names" }), nameChips(server)), routeEditor(server));

  const switches = el("div", { class: "switches" });
  switches.append(
    sw("SSL certificate", tls.ssl, tls.ssl ? "Visitors connect securely (HTTPS)." : "Turn on to serve this site over HTTPS.", (on) => (on ? openHttps(server.id) : disableHttps(server.id))),
    certificateBlock(server),
    sw("Force HTTPS", forced, tls.ssl ? "Send plain http visitors to the secure address." : "Turn on SSL first.", (on) => setForceHttps(server.id, on), { disabled: !tls.ssl }),
    sw("HTTP/2", tls.ssl && http2, tls.ssl ? "Faster page loads for modern browsers." : "Turn on SSL first.", (on) => setHttp2(server.id, on), { disabled: !tls.ssl }),
    sw("WebSocket support", websocket, route.kind === "proxy" ? "For apps that keep a live connection open (chat, dashboards)." : "Available for sites that forward to an app.", (on) => setWebsocket(server.id, on), { disabled: route.kind !== "proxy" }),
    sw("Block common exploits", !!exploitSpan(server), "Refuses hidden files and a few typical attack patterns.", (on) => setExploits(server.id, on)),
    sw("Cache assets", !!cacheLocation(server), cacheable ? "Browsers keep images, scripts and styles for 30 days." : "Available for forwarding and folder sites.", (on) => setCache(server.id, on), { disabled: !cacheable && !cacheLocation(server) }),
    sw("HSTS", !!hstsNode(server), tls.ssl ? "Tell browsers to only ever use HTTPS for this site." : "Turn on SSL first.", (on) => setHsts(server.id, on), { disabled: !tls.ssl && !hstsNode(server) }));
  card.append(switches);

  const locations = customLocations(server);
  const locBox = el("div", { class: "loc-box" }, el("div", { class: "field-label", text: "Custom locations" }));
  if (!locations.length) locBox.append(el("small", { class: "field-hint", text: "Send a specific address, such as /api/, somewhere else." }));
  for (const loc of locations) locBox.append(locationRow(server, loc));
  locBox.append(el("button", { type: "button", class: "tiny", text: "＋ Add a location", onclick: () => editSite(server.id, "Location added", (s) => {
    const loc = newNode("location", ["/api/"], "block");
    routeHolder(loc, "proxy", "http://127.0.0.1:8080");
    s.children.push(loc);
  }).catch(report) }));
  card.append(locBox);

  const advanced = advancedArea(server, managedIds(server));
  const summary = advanced.details.querySelector("summary");
  const code = advanced.ids.map((id) => locate(id)).filter((h) => h && h.node.kind !== "comment").length;
  summary.textContent = "Advanced: custom nginx directives" + (code ? ` · ${code}` : "");
  const hint = advanced.details.querySelector("p.hint");
  if (hint) hint.textContent = "Anything this card does not cover. It is plain nginx text; it stays attached to this site.";
  advanced.details.querySelector("textarea").addEventListener("change", () => applyBasicDraft().catch(report));
  card.append(advanced.details);
  state.basicForms.push({ nodeId: server.id, advanced, patch: () => ({}) });
  const more = locations.reduce((sum, loc) => sum + extraSettings(loc), 0);
  if (more) card.append(el("p", { class: "more-settings" }, `${more} more setting${more === 1 ? "" : "s"} inside locations are kept as they are. `, el("button", { type: "button", class: "link-btn", text: "See Blocks view", onclick: () => openInBlocks(server.id) })));
  return card;
}

async function duplicateSite(serverId) {
  await editSite(serverId, "Site duplicated", (server, hit) => {
    const copy = clone(server);
    reidentify(copy);
    const name = direct(copy, "server_name")[0];
    if (name) name.args = name.args.map((arg) => (arg === "_" ? arg : "copy-of-" + arg));
    hit.nodes.splice(hit.index + spanLength(hit.nodes, hit.index), 0, copy);
    state.selected = copy.id;
  });
}

async function deleteSite(serverId) {
  const server = serverNode(serverId);
  if (!server) return;
  const answer = await ask({ title: `Delete ${siteTitle(server)}?`, message: "The site is removed from the draft. Nothing changes on the server until you Save, and Undo brings it back.", ok: "Delete site", danger: true });
  if (answer !== true) return;
  await editSite(serverId, "Site deleted", (s, hit) => { const sibling = redirectSibling(hit); removeSpan(hit.nodes, hit.index); if (sibling) removeSpan(hit.nodes, hit.nodes.indexOf(sibling)); state.selected = null; });
}

function hostTitle(names) {
  const shown = names.filter(Boolean);
  if (!shown.length) return "Unnamed host";
  if (shown.length === 1 && shown[0] === "_") return "Catch-all host (_)";
  return shown.join(" ");
}

// ---------------------------------------------------------------- the whole Basic view

function addSiteBar() {
  const bar = el("div", { class: "add-site" }, el("strong", { text: "Add a site" }));
  const kinds = [["proxy_host", "Forward to an app"], ["static_host", "Serve a folder"], ["redirect_host", "Redirect"]];
  for (const [id, label] of kinds) {
    bar.append(el("button", { type: "button", class: "tiny", text: "＋ " + label, onclick: () => {
      const recipe = (state.recipes || []).find((r) => r.id === id);
      if (recipe) addRecipe(recipe).catch(report);
    } }));
  }
  return bar;
}

function renderBasicV2(canvas) {
  state.basicForms = [];
  state.basicRootAreas = [];
  const rootContexts = contextsFor(null);
  canvas.append(el("div", { class: "basic-intro" }, el("div", { class: "eyebrow", text: "YOUR SITES" }), el("h2", { text: "Sites in this file" }),
    el("p", { text: "Changes are added to the draft as you make them. Press Save when you are ready to put them live." })));
  if ((state.rendered?.unreferenced || []).includes(state.file)) {
    const folder = state.file.includes("/") ? "/etc/nginx/" + state.file.split("/").slice(0, -1).join("/") : "";
    canvas.append(el("p", { class: "hint warn", text: "nginx does not load this file yet: no include in nginx.conf reaches it." +
      (folder ? ` Add  include ${folder}/*.conf;  inside the http block (for a whole tree of folders, include /etc/nginx/conf.d/*/*.conf;).` : "") }));
  }
  if (!rootContexts.some((c) => ["http", "main"].includes(c))) {
    canvas.append(el("p", { class: "hint", text: "Basic shows websites. This file holds other kinds of settings, so use the Blocks view." }));
    return;
  }
  const servers = [];
  (function collect(nodes, context) {
    for (const n of nodes) if (n.kind === "block") { if (n.name === "server" && context === "http") servers.push(n); else collect(n.children, n.name); }
  })(currentFile().nodes, rootContexts.includes("http") ? "http" : "main");
  // A server that only sends http to https belongs to the site it redirects for: it is the "Force HTTPS" switch.
  const hidden = new Set();
  for (const server of servers) { const hit = locate(server.id); const sibling = hit && redirectSibling(hit); if (sibling) hidden.add(sibling.id); }
  const shown = servers.filter((s) => !hidden.has(s.id));
  for (const server of shown) canvas.append(isStockDefault(server) ? welcomeCard(server) : siteCard(server));
  if (!shown.length) canvas.append(el("p", { class: "hint", text: "There are no sites in this file yet. Add one below." }));
  canvas.append(addSiteBar());

  const root = { id: "__file__", name: "file", args: [], children: currentFile().nodes };
  const managed = new Set(servers.map((n) => n.id));
  for (const block of root.children.filter((n) => n.kind === "block" && n.name === "http")) {
    managed.add(block.id);
    const area = advancedArea(block, new Set(servers.map((n) => n.id)));
    area.details.querySelector("summary").textContent = "Advanced: settings shared by every site in this file";
    state.basicRootAreas.push(area);
    area.details.querySelector("textarea").addEventListener("change", () => applyBasicDraft().catch(report));
    canvas.append(area.details);
  }
  if (root.children.some((n) => !managed.has(n.id))) {
    const area = advancedArea(root, managed);
    area.details.querySelector("summary").textContent = "Advanced: everything else in this file";
    state.basicRootAreas.push(area);
    area.details.querySelector("textarea").addEventListener("change", () => applyBasicDraft().catch(report));
    canvas.append(area.details);
  }
}
