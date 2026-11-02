"use strict";

// HTTPS for a server block. The Enable HTTPS dialog (pick, issue or create a certificate, or point at one),
// Disable HTTPS, and the "what should this certificate contain?" dialog that Save shows when a config names
// a Let's Encrypt folder that does not exist yet. Every change here is a draft edit: nothing is written
// until Save. Loads after basic-editor.js, files.js and shell.js (it uses their helpers when it runs).

const HTTPS_KEPT_FLAGS = ["default_server", "default", "reuseport", "proxy_protocol", "ipv6only=on", "ipv6only=off"];

// ---------------------------------------------------------------- reading a server block

function serverNode(id) {
  const hit = locate(id);
  return hit && hit.node.kind === "block" && hit.node.name === "server" ? hit.node : null;
}

// Real names only: "_" (catch-all) and regular expressions cannot be on a certificate.
function serverNames(server) {
  const out = [];
  for (const node of direct(server, "server_name")) {
    for (const arg of node.args) {
      const name = fieldToken(arg).trim();
      if (name && name !== "_" && !name.startsWith("~") && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

function listenInfo(node) {
  const parts = listenerParts(node);
  if (!parts) return null;
  const raw = fieldToken(node.args[0] || "80");
  return { node, raw, address: parts.address, port: parts.port, v6: raw.startsWith("["), ssl: node.args.includes("ssl") };
}

const listensOf = (server) => direct(server, "listen").map(listenInfo).filter(Boolean);

function withPort(info, port) {
  if (/^\d+$/.test(info.raw)) return String(port);
  return info.v6 ? `[${info.address}]:${port}` : `${info.address}:${port}`;
}

function tlsState(server) {
  const certs = direct(server, "ssl_certificate");
  const keys = direct(server, "ssl_certificate_key");
  const listens = listensOf(server);
  return {
    certificate: certs[0] ? fieldToken(certs[0].args[0]) : "",
    key: keys[0] ? fieldToken(keys[0].args[0]) : "",
    ssl: listens.some((item) => item.ssl) || certs.length > 0,
    listens,
  };
}

// A neighbouring server block that already sends plain http for the same names to https.
function redirectSibling(hit) {
  const names = new Set(serverNames(hit.node));
  for (const other of hit.nodes) {
    if (other === hit.node || other.kind !== "block" || other.name !== "server") continue;
    if (!listensOf(other).some((item) => item.port === 80)) continue;
    const sends = direct(other, "return").find((node) => /^30[1278]$/.test(node.args[0] || "") && /^["']?https:\/\//.test(node.args[1] || ""));
    if (!sends) continue;
    const there = serverNames(other);
    if (there.some((name) => names.has(name)) || (!names.size && !there.length)) return other;
  }
  return null;
}

// ---------------------------------------------------------------- editing a server block

// The nginx host is Linux: a backend that reports Windows separators (a dev machine) is still given plain slashes.
const unixPath = (path) => String(path || "").replace(/\\/g, "/");
const quotePath = (path) => (/[\s;"'#{}$]/.test(path) ? JSON.stringify(path) : path);

function insertAfterListens(server, nodes) {
  let at = 0;
  server.children.forEach((child, index) => {
    if (child.kind === "directive" && child.name === "listen") at = index + 1;
  });
  if (!at) {
    server.children.forEach((child, index) => {
      if (child.kind === "directive" && child.name === "server_name") at = index + 1;
    });
  }
  if (isInlineNote(server.children, at, true)) at++;
  server.children.splice(at, 0, ...nodes);
}

function setCertificatePaths(server, certPath, keyPath) {
  const fresh = [];
  const certs = direct(server, "ssl_certificate");
  const keys = direct(server, "ssl_certificate_key");
  if (certs.length) certs[0].args = [quotePath(certPath)];
  else fresh.push(newNode("ssl_certificate", [quotePath(certPath)]));
  if (keys.length) keys[0].args = [quotePath(keyPath)];
  else fresh.push(newNode("ssl_certificate_key", [quotePath(keyPath)]));
  return fresh;
}

// `plain` is what happens to port 80: "redirect" (a new server block sends it to https), "keep" or "replace".
function enableHttpsOn(serverId, { certPath, keyPath, plain, change }) {
  const hit = locate(serverId);
  const server = hit.node;
  const fresh = setCertificatePaths(server, certPath, keyPath);
  if (change) {
    if (fresh.length) insertAfterListens(server, fresh);
    return;
  }
  const listens = listensOf(server);
  const sources = listens.filter((item) => item.port === 80 && !item.ssl);
  const hasV6 = listens.some((item) => item.v6);
  const wanted = [];
  if (sources.length) {
    for (const source of sources) wanted.push({ raw: withPort(source, 443), flags: source.node.args.slice(1).filter((arg) => HTTPS_KEPT_FLAGS.includes(arg)) });
  } else if (!listens.length) {
    wanted.push({ raw: "443", flags: [] });
  } else if (!listens.some((item) => item.port === 443)) {
    wanted.push({ raw: "443", flags: [] });
    if (hasV6) wanted.push({ raw: "[::]:443", flags: [] });
  }
  const added = [];
  for (const want of wanted) {
    const same = listens.find((item) => item.port === 443 && item.raw === want.raw);
    if (!same) added.push(newNode("listen", [want.raw, "ssl", ...want.flags]));
  }
  for (const item of listens) if (item.port === 443 && !item.ssl) item.node.args.splice(1, 0, "ssl");
  // A server with no listen at all answers on 80; adding a 443 listen would silence 80 unless it stays.
  if (!listens.length && plain !== "replace") added.unshift(newNode("listen", ["80"]));

  const extra = [];
  if (!direct(server, "http2").length && !listens.some((item) => item.node.args.includes("http2"))) extra.push(newNode("http2", ["on"]));
  extra.push(...fresh);
  if (!direct(server, "ssl_protocols").length) extra.push(newNode("ssl_protocols", ["TLSv1.2", "TLSv1.3"]));
  insertAfterListens(server, [...added, ...extra]);

  if (plain === "replace" || plain === "redirect") {
    for (const source of sources) {
      const index = server.children.indexOf(source.node);
      if (index >= 0) removeSpan(server.children, index);
    }
  }
  if (plain === "redirect" && sources.length) {
    const nameDirective = direct(server, "server_name")[0];
    const redirect = newNode("server", [], "block", [
      ...sources.map((source) => newNode("listen", [...source.node.args])),
      newNode("server_name", nameDirective ? [...nameDirective.args] : ["_"]),
      newNode("return", ["301", "https://$host$request_uri"]),
    ]);
    const at = hit.nodes.indexOf(server);
    hit.nodes.splice(at + spanLength(hit.nodes, at), 0, redirect);
  }
}

function disableHttpsOn(serverId, { removeRedirect }) {
  const hit = locate(serverId);
  const server = hit.node;
  const sibling = removeRedirect ? redirectSibling(hit) : null;
  const before = listensOf(server);
  const hadV6 = before.some((item) => item.v6);
  for (let i = server.children.length - 1; i >= 0; i--) {
    const child = server.children[i];
    if (child.kind === "directive" && (child.name === "ssl_certificate" || child.name === "ssl_certificate_key")) removeSpan(server.children, i);
  }
  for (const item of before) {
    if (item.port === 443) removeSpan(server.children, server.children.indexOf(item.node));
    else if (item.ssl) item.node.args = item.node.args.filter((arg) => arg !== "ssl");
  }
  const after = listensOf(server);
  if (!after.length || (!after.some((item) => item.port === 80) && before.some((item) => item.port === 443))) {
    const nodes = [newNode("listen", ["80"])];
    if (hadV6) nodes.push(newNode("listen", ["[::]:80"]));
    insertAfterListens(server, nodes);
  }
  if (sibling) removeSpan(hit.nodes, hit.nodes.indexOf(sibling));
}

// ---------------------------------------------------------------- certificate list helpers

const HTTPS = { id: "", names: [], mode: "enable", match: null, certs: null, choice: "", folder: null, busy: false, token: false, email: "", plain: "redirect", hadPlain: false, sibling: false };

const isGood = (cert) => cert.valid !== false && !(Number(cert.days_left) < 0);

function certRank(cert) {
  const covers = (cert.covers || []).length;
  const all = covers > 0 && !(cert.missing || []).length;
  return (isGood(cert) ? 1000 : 0) + (all ? 500 : 0) + covers * 10 + (cert.staging ? -50 : 0) + Math.min(Math.max(Number(cert.days_left) || 0, 0), 90) / 100;
}

function certKindText(cert) {
  return { acme: "Let's Encrypt", letsencrypt: "Let's Encrypt", selfsigned: "self-signed", uploaded: "uploaded", external: "external" }[cert.kind] || cert.kind || "certificate";
}

function certExpiryText(cert) {
  const days = Number(cert.days_left);
  if (!Number.isFinite(days)) return "expiry unknown";
  if (days < 0) return `expired ${-days} day${days === -1 ? "" : "s"} ago`;
  return `expires in ${days} day${days === 1 ? "" : "s"}`;
}

function certCoverText(cert, names) {
  if (!names.length) return (cert.domains || []).slice(0, 3).join(", ") + ((cert.domains || []).length > 3 ? ` +${cert.domains.length - 3}` : "");
  const covers = (cert.covers || []).length;
  const missing = cert.missing || [];
  if (covers === names.length && !missing.length) return names.length === 1 ? "covers this name" : `covers all ${names.length} names`;
  if (!covers) return "covers none of these names";
  return `covers ${covers} of ${names.length} (missing ${missing.join(", ")})`;
}

async function loadHttpsMatch(names) {
  const certs = await call("GET", "/api/certs");
  HTTPS.certs = certs;
  HTTPS.token = certs.token_set !== false;
  HTTPS.email = certs.email || "";
  if (names.length) {
    try {
      const match = await call("GET", "/api/certs/match?names=" + encodeURIComponent(names.join(",")));
      HTTPS.match = match;
      HTTPS.token = match.token_set !== undefined ? !!match.token_set : HTTPS.token;
      HTTPS.email = match.email !== undefined ? match.email || "" : HTTPS.email;
      return;
    } catch (error) {
      // Fall back to the plain list below: the choice still works, only without the "covers" hints.
    }
  }
  HTTPS.match = { certificates: (certs.certificates || []).map((cert) => ({ ...cert, covers: [], missing: [] })) };
}

const canIssue = () => HTTPS.token && !!HTTPS.email;

// ---------------------------------------------------------------- the dialog

function choiceCard(value, title, sub, body, { disabled = false, badges = [], note = null } = {}) {
  const input = el("input", { type: "radio", name: "httpsChoice", value });
  input.disabled = disabled;
  const card = el("div", { class: "choice" + (disabled ? " off" : ""), "data-choice": value },
    el("label", { class: "choice-head" }, input,
      el("span", { class: "choice-title" }, title),
      ...badges),
    sub ? el("div", { class: "choice-sub", text: sub }) : null,
    note,
    body ? el("div", { class: "choice-body", hidden: "" }, body) : null);
  input.addEventListener("change", () => selectHttpsChoice(value));
  return card;
}

function selectHttpsChoice(value) {
  HTTPS.choice = value;
  for (const card of $$("#httpsBody .choice")) {
    const on = card.dataset.choice === value;
    card.classList.toggle("selected", on);
    const radio = card.querySelector("input[type=radio]");
    if (radio) radio.checked = on;
    const body = card.querySelector(".choice-body");
    if (body) body.hidden = !on;
  }
  updateHttpsGo();
}

function updateHttpsGo() {
  const go = $("#btnHttpsGo");
  const choice = HTTPS.choice;
  const change = HTTPS.mode === "change";
  go.textContent = HTTPS.busy ? (choice === "issue" ? "Issuing…" : "Working…") : choice === "issue" ? "Issue certificate" : choice === "selfsigned" ? "Create certificate" : change ? "Use this certificate" : "Enable HTTPS";
  let ready = !!choice && !HTTPS.busy;
  if (choice === "folder") ready = ready && !!(HTTPS.folder && HTTPS.folder.found);
  if (choice === "paths") ready = ready && !!($("#httpsCertPath")?.value.trim() && $("#httpsKeyPath")?.value.trim());
  go.disabled = !ready;
}

function certChoice(cert, names) {
  const badges = [];
  if (!isGood(cert)) badges.push(badge2("bad", "EXPIRED"));
  else if (Number(cert.days_left) <= 14) badges.push(badge2("warn", "EXPIRES SOON"));
  if (cert.staging) badges.push(badge2("test", "STAGING", "A test certificate. Browsers do not trust it."));
  const missing = (cert.missing || []).length > 0;
  const subtitle = `${certKindText(cert)} · ${certExpiryText(cert)} · ${certCoverText(cert, names)}`;
  const note = (missing && names.length) || cert.staging || !isGood(cert)
    ? el("div", { class: "choice-warn", text: !isGood(cert) ? "This certificate has expired: browsers will refuse it." : cert.staging ? "Staging certificate: browsers will not trust it." : `It does not cover ${cert.missing.join(", ")}: browsers will show a name mismatch for those.` })
    : null;
  return choiceCard("cert:" + cert.name, el("span", { class: "mono", text: cert.name }), subtitle, null, { badges, note });
}

function folderBody() {
  const input = el("input", { id: "httpsFolderPath", placeholder: "/etc/letsencrypt/live/example.com", autocomplete: "off", spellcheck: "false", "aria-label": "Certificate folder" });
  const result = el("div", { id: "httpsFolderResult", class: "folder-result" });
  const inspect = async () => {
    const path = input.value.trim();
    if (!path) return;
    result.replaceChildren(el("span", { class: "spinner" }), "Looking inside…");
    HTTPS.folder = null;
    updateHttpsGo();
    try {
      const data = await call("GET", "/api/certs/folder?path=" + encodeURIComponent(path));
      HTTPS.folder = data;
      if (!data.found) {
        result.replaceChildren(el("p", { class: "choice-warn", text: data.error || "No certificate and key were found in that folder." }));
      } else {
        const good = data.valid !== false && !(Number(data.days_left) < 0);
        result.replaceChildren(
          el("p", { class: "field-hint" }, el("strong", { text: good ? "Found a certificate. " : "Found an expired certificate. " }), `${(data.domains || []).join(", ") || "no names listed"} · ${certExpiryText(data)}${data.issuer ? " · " + data.issuer : ""}`),
          el("p", { class: "field-hint mono", text: `${data.cert_path}\n${data.key_path}` }),
          (data.others || []).length ? el("p", { class: "field-hint", text: "Other certificates in there: " + data.others.map((item) => (typeof item === "string" ? item : item.name || item.path || "")).filter(Boolean).join(", ") }) : null);
      }
    } catch (error) {
      result.replaceChildren(el("p", { class: "choice-warn", text: describeError(error).summary }));
    }
    updateHttpsGo();
  };
  input.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); inspect(); } });
  const known = ((HTTPS.certs && HTTPS.certs.certificates) || []).filter((cert) => cert.kind === "external" && cert.path)
    .map((cert) => cert.path.replace(/\/[^/]*$/, ""));
  const chips = [...new Set(known)].map((folder) => el("button", { class: "chip", type: "button", text: folder, title: "Use this folder", onclick: () => { input.value = folder; inspect(); } }));
  return el("div", { class: "choice-fields" },
    el("div", { class: "inline-form" }, input, el("button", { type: "button", text: "Look inside", onclick: inspect })),
    chips.length ? el("div", { class: "chip-row" }, el("span", { class: "field-hint", text: "Mounted folders:" }), ...chips) : null,
    el("p", { class: "field-hint", text: "A folder with a certificate (fullchain.pem or .crt) and its key. It can be under the mounted certificate folders, /etc/letsencrypt, /etc/nginx, /certs or /etc/ssl." }),
    result);
}

function namesBody(id, text, hint) {
  return el("div", { class: "choice-fields" },
    el("label", { class: "field" }, el("span", { text: "Names, one per line" }), el("textarea", { id, rows: 3, spellcheck: "false", placeholder: "example.com\n*.example.com", value: text })),
    hint ? el("p", { class: "field-hint", text: hint }) : null);
}

function settingsNote() {
  const missing = [];
  if (!HTTPS.email) missing.push("a contact email");
  if (!HTTPS.token) missing.push("a Cloudflare API token");
  return el("div", { class: "choice-warn" }, `Issuing needs ${missing.join(" and ")}. `,
    el("button", { class: "link-button", type: "button", text: "Open Settings", onclick: () => { $("#dlgHttps").close(); openSettings().catch(report); } }));
}

function plainChoices(server) {
  const hit = locate(HTTPS.id);
  const sibling = redirectSibling(hit);
  const listens = listensOf(server);
  const hasPlain = listens.some((item) => item.port === 80 && !item.ssl);
  HTTPS.hadPlain = hasPlain;
  HTTPS.sibling = !!sibling;
  if (!hasPlain) return null;
  HTTPS.plain = sibling ? "replace" : "redirect";
  const option = (value, title, sub, disabled = false) => el("label", { class: "check plain-option" + (disabled ? " off" : "") },
    (() => { const input = el("input", { type: "radio", name: "httpsPlain", value }); input.checked = HTTPS.plain === value; input.disabled = disabled; input.addEventListener("change", () => { HTTPS.plain = value; }); return input; })(),
    el("span", {}, el("strong", { text: title }), el("small", { text: sub })));
  return el("section", { class: "https-plain" },
    el("h3", { class: "sub", text: "Plain http (port 80)" }),
    option("redirect", "Redirect to https", sibling ? "A redirect for these names already exists in this file." : "A new server block moves the port 80 listeners and sends everyone to https.", !!sibling),
    option("keep", "Keep serving plain http as well", "Port 80 stays as it is and the site answers on both."),
    option("replace", "Turn plain http off", "Port 80 is no longer listened on by this server."));
}

async function openHttps(serverId) {
  if (!(await applyDraft())) return;
  const server = serverNode(serverId);
  if (!server) return toast("That server block is no longer there.");
  const tls = tlsState(server);
  Object.assign(HTTPS, { id: serverId, names: serverNames(server), mode: tls.certificate ? "change" : "enable", match: null, certs: null, choice: "", folder: null, busy: false });
  const dialog = $("#dlgHttps");
  $("#httpsTitle").textContent = HTTPS.mode === "change" ? "Change certificate" : "Enable HTTPS";
  $("#httpsEyebrow").textContent = HTTPS.mode === "change" ? "TLS · THIS SERVER" : "TLS";
  $("#httpsBody").replaceChildren(el("div", { class: "status-panel" }, el("span", { class: "spinner" }), "Looking for certificates…"));
  $("#btnHttpsGo").disabled = true;
  if (!dialog.open) dialog.showModal();
  try {
    await loadHttpsMatch(HTTPS.names);
  } catch (error) {
    dialog.close();
    throw error;
  }
  paintHttps(server);
}

function paintHttps(server) {
  const names = HTTPS.names;
  const tls = tlsState(server);
  const certs = [...((HTTPS.match && HTTPS.match.certificates) || [])].sort((a, b) => certRank(b) - certRank(a));
  const parts = [];
  parts.push(el("p", { class: "dialog-intro" }, names.length
    ? el("span", {}, "For ", ...names.flatMap((name, i) => [i ? ", " : "", el("strong", { class: "mono", text: name })]), ".")
    : "This server has no server_name of its own (it is a catch-all), so no certificate can be matched to it by name."));
  if (HTTPS.mode === "change") parts.push(el("p", { class: "field-hint" }, "Now using ", el("span", { class: "mono", text: tls.certificate }), ". Changing it only swaps the certificate and key; the listeners stay as they are."));
  const cards = [];
  for (const cert of certs) cards.push(certChoice(cert, names));
  if (!certs.length) cards.push(el("p", { class: "field-hint", text: "No certificates yet. Issue one for this server, create a self-signed one, or point at files you already have." }));
  parts.push(el("section", { class: "https-choices" },
    el("h3", { class: "sub", text: certs.length ? "Use a certificate you have" : "Certificate" }), ...cards));

  const alternatives = [];
  const issuable = names.length > 0 && canIssue();
  alternatives.push(choiceCard("issue", "Issue a new certificate for these names",
    names.length ? "Let's Encrypt through Cloudflare DNS. Wildcards work; it can take a few minutes." : "Add the names this certificate should cover.",
    namesBody("httpsIssueNames", names.join("\n"), "Use *.example.com for a wildcard. A wildcard covers the subdomains, not example.com itself."),
    { disabled: !canIssue(), note: canIssue() ? null : settingsNote() }));
  alternatives.push(choiceCard("selfsigned", "Make a self-signed certificate",
    "Signed by this app, so browsers warn about it. Good for internal hosts and testing.",
    el("div", { class: "choice-fields" },
      namesBody("httpsSelfNames", names.join("\n"), ""),
      el("label", { class: "field days" }, el("span", { text: "Valid for (days)" }), el("input", { id: "httpsSelfDays", type: "number", min: "1", max: "3650", value: "365" })))));
  alternatives.push(choiceCard("folder", "Use a certificate folder", "A folder that holds a certificate and its key, for example one mounted into the container.", folderBody()));
  const certInput = el("input", { id: "httpsCertPath", placeholder: "/etc/ssl/certs/example.pem", autocomplete: "off", spellcheck: "false", value: tls.certificate });
  const keyInput = el("input", { id: "httpsKeyPath", placeholder: "/etc/ssl/private/example.key", autocomplete: "off", spellcheck: "false", value: tls.key });
  for (const input of [certInput, keyInput]) input.addEventListener("input", updateHttpsGo);
  alternatives.push(choiceCard("paths", "Type the paths myself", "Paths on the nginx host. nginx checks them when you save.",
    el("div", { class: "choice-fields" },
      el("label", { class: "field" }, el("span", { text: "ssl_certificate" }), certInput),
      el("label", { class: "field" }, el("span", { text: "ssl_certificate_key" }), keyInput))));
  parts.push(el("section", { class: "https-choices" }, el("h3", { class: "sub", text: certs.length ? "Or" : "Or another way" }), ...alternatives));

  if (HTTPS.mode === "enable") {
    const plain = plainChoices(server);
    if (plain) parts.push(plain);
  }
  parts.push(el("div", { id: "httpsStatus", class: "status-panel", hidden: "" }));
  $("#httpsBody").replaceChildren(...parts);

  const best = certs[0];
  const bestAll = best && !(best.missing || []).length && (best.covers || []).length > 0 && isGood(best);
  let first = "";
  if (bestAll) first = "cert:" + best.name;
  else if (issuable) first = "issue";
  else if (best && (best.covers || []).length && isGood(best)) first = "cert:" + best.name;
  else if (tls.certificate) first = "paths";
  else first = "selfsigned";
  selectHttpsChoice(first);
}

function httpsStatus(kind, title, sub) {
  const box = $("#httpsStatus");
  if (!box) return;
  box.hidden = false;
  box.className = "status-panel " + kind;
  box.replaceChildren(el("div", { class: "status-title" }, kind === "busy" ? el("span", { class: "spinner" }) : null, title), sub ? el("div", { class: "status-sub", text: sub }) : null);
  box.scrollIntoView({ block: "nearest" });
}

const nameLines = (text) => text.split(/[\s,]+/).map((name) => name.trim()).filter(Boolean);

async function makeHttpsCertificate(kind) {
  const names = nameLines($(kind === "issue" ? "#httpsIssueNames" : "#httpsSelfNames").value);
  if (!names.length) return httpsStatus("bad", "Enter at least one name.");
  HTTPS.busy = true;
  updateHttpsGo();
  try {
    let data;
    if (kind === "issue") {
      httpsStatus("busy", "Requesting a certificate…", "DNS-01 adds a TXT record at Cloudflare and waits for it to spread. This can take a few minutes.");
      data = await callAny("POST", "/api/certs/issue", { domains: names.join("\n"), staging: !!(HTTPS.certs && HTTPS.certs.staging) });
    } else {
      httpsStatus("busy", "Creating a self-signed certificate…");
      data = await callAny("POST", "/api/certs/selfsigned", { domains: names.join("\n"), days: Number($("#httpsSelfDays").value) || 365 });
    }
    if (data.ok === false || data.http_status >= 400) {
      $("#httpsStatus").hidden = true;
      showProblem(kind === "issue" ? "Could not issue the certificate" : "Could not create the certificate", "CERTIFICATE",
        data.message || describeError(data.error || data.output).summary, data.output || (data.error ? errorText(data.error) : ""));
      return;
    }
    await loadHttpsMatch(HTTPS.names);
    const server = serverNode(HTTPS.id);
    if (!server) return;
    const wasPlain = HTTPS.plain;
    paintHttps(server);
    HTTPS.plain = wasPlain;
    for (const radio of $$("input[name=httpsPlain]")) radio.checked = radio.value === wasPlain;
    const list = (HTTPS.match.certificates || []);
    const made = list.find((cert) => cert.name === data.name) || [...list].sort((a, b) => certRank(b) - certRank(a))[0];
    if (made) selectHttpsChoice("cert:" + made.name);
    httpsStatus("ok", data.message || (kind === "issue" ? "Certificate issued." : "Self-signed certificate created."), "It is selected below. Press the button to use it.");
  } finally {
    HTTPS.busy = false;
    updateHttpsGo();
  }
}

async function goHttps() {
  const choice = HTTPS.choice;
  if (choice === "issue" || choice === "selfsigned") return makeHttpsCertificate(choice);
  let certPath = "";
  let keyPath = "";
  if (choice.startsWith("cert:")) {
    const cert = ((HTTPS.match && HTTPS.match.certificates) || []).find((item) => "cert:" + item.name === choice);
    if (!cert) return;
    certPath = unixPath(cert.path) || `/etc/letsencrypt/live/${cert.name}/fullchain.pem`;
    keyPath = unixPath(cert.key_path) || `/etc/letsencrypt/live/${cert.name}/privkey.pem`;
  } else if (choice === "folder") {
    if (!HTTPS.folder || !HTTPS.folder.found) return;
    certPath = unixPath(HTTPS.folder.cert_path);
    keyPath = unixPath(HTTPS.folder.key_path);
  } else if (choice === "paths") {
    certPath = $("#httpsCertPath").value.trim();
    keyPath = $("#httpsKeyPath").value.trim();
    if (!certPath || !keyPath) return;
  }
  const server = serverNode(HTTPS.id);
  if (!server) return;
  const change = HTTPS.mode === "change";
  const plain = HTTPS.hadPlain ? HTTPS.plain : "keep";
  const id = HTTPS.id;
  $("#dlgHttps").close();
  mutate(() => enableHttpsOn(id, { certPath, keyPath, plain, change }),
    change ? "Certificate changed" : "HTTPS enabled");
  const bits = [];
  if (!change && plain === "redirect") bits.push("plain http now redirects to https");
  toast((change ? "Certificate changed in the draft" : "HTTPS is on in the draft") + (bits.length ? ` · ${bits.join(", ")}` : "") + ". Press Save to apply it.");
}

async function disableHttps(serverId) {
  if (!(await applyDraft())) return;
  const server = serverNode(serverId);
  if (!server) return;
  const hit = locate(serverId);
  const sibling = redirectSibling(hit);
  const answer = await ask({
    title: "Disable HTTPS for this server?",
    message: "The certificate and key lines and the 443 listener are removed from this server, and it answers on plain http (port 80) again. The certificate files themselves are kept."
      + (sibling ? " A neighbouring server block redirects http to https for these names; it is removed too, because it would send visitors to a port that no longer answers." : ""),
    ok: "Disable HTTPS",
    danger: true,
  });
  if (answer !== true) return;
  mutate(() => disableHttpsOn(serverId, { removeRedirect: true }), "HTTPS disabled");
  toast("HTTPS is off in the draft. Press Save to apply it.");
}

// ---------------------------------------------------------------- the row in the Basic view and the Blocks button

function httpsRow(server) {
  const tls = tlsState(server);
  const on = tls.ssl;
  const state = el("span", { class: "https-state" },
    el("strong", { text: "HTTPS" }),
    badge2(on ? "good" : "test", on ? "ON" : "OFF"),
    on && tls.certificate ? el("span", { class: "mono https-cert", title: tls.certificate, text: tls.certificate }) : on ? el("span", { class: "muted", text: "certificate set elsewhere" }) : el("span", { class: "muted", text: "this host answers on plain http only" }));
  return el("div", { class: "https-row" + (on ? " on" : "") }, state,
    el("span", { class: "https-actions" },
      on
        ? [el("button", { class: "tiny", type: "button", text: tls.certificate ? "Change certificate" : "Choose certificate", onclick: () => openHttps(server.id).catch(report) }),
          el("button", { class: "tiny danger-text", type: "button", text: "Disable HTTPS", onclick: () => disableHttps(server.id).catch(report) })]
        : el("button", { class: "tiny primary", type: "button", text: "Enable HTTPS", onclick: () => openHttps(server.id).catch(report) })));
}

const baseInlineActions = inlineActions;
inlineActions = function (node) {
  const out = baseInlineActions(node);
  if (node.kind === "block" && node.name === "server" && out && out.prepend) {
    const on = tlsState(node).ssl;
    out.prepend(el("button", {
      class: "tiny https-action" + (on ? " on" : ""), type: "button", "aria-label": on ? "Change certificate or disable HTTPS" : "Enable HTTPS",
      title: on ? "HTTPS is on. Change the certificate…" : "Enable HTTPS for this server…",
      onclick: (event) => { event.stopPropagation(); openHttps(node.id).catch(report); }, text: on ? "HTTPS ✓" : "HTTPS",
    }));
  }
  return out;
};

// ---------------------------------------------------------------- Save: what should this certificate contain?

// `items` is needs_certificates from the apply call. Resolves to { lineage: [names] } (merged with `before`),
// or null when cancelled.
function certificateNamesDialog(items, before) {
  return new Promise((resolve) => {
    const dialog = $("#dlgNames");
    const sections = [];
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      dialog.removeEventListener("close", onClose);
      $("#btnNamesGo").onclick = null;
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onClose = () => finish(null);
    dialog.addEventListener("close", onClose);
    const go = $("#btnNamesGo");
    const update = () => { go.disabled = !items.every((item) => item.can_issue) || sections.some((section) => !section.read().length); };

    for (const item of items) {
      const chosen = new Set(item.default_names || (before && before[item.lineage]) || []);
      const boxes = [];
      const extra = el("input", { placeholder: "another.example.com, *.example.com", autocomplete: "off", spellcheck: "false", "aria-label": "More names" });
      const chips = (item.suggestions || []).map((name) => {
        const box = el("input", { type: "checkbox", value: name });
        box.checked = chosen.has(name);
        box.addEventListener("change", update);
        boxes.push(box);
        return el("label", { class: "name-chip" }, box, el("span", { class: "mono", text: name }));
      });
      extra.addEventListener("input", update);
      const read = () => [...new Set([...boxes.filter((box) => box.checked).map((box) => box.value), ...nameLines(extra.value)])];
      sections.push({ item, read });
      const issueNote = item.can_issue ? null : el("div", { class: "choice-warn" },
        `Issuing needs ${[!item.email ? "a contact email" : "", !item.token_set ? "a Cloudflare API token" : ""].filter(Boolean).join(" and ") || "certificate settings"}. `,
        el("button", { class: "link-button", type: "button", text: "Open Settings", onclick: () => { finish(null); openSettings().catch(report); } }),
        " Or cancel and pick a certificate that already exists.");
      sections.at(-1).node = el("section", { class: "names-section" },
        el("h3", { class: "sub" }, "What should the certificate ", el("span", { class: "mono", text: `'${item.lineage}'` }), " contain?"),
        el("p", { class: "field-hint", text: `A server in your config uses /etc/letsencrypt/live/${item.lineage}/, which does not exist yet.` }),
        el("div", { class: "name-chips" }, ...chips),
        el("label", { class: "field" }, el("span", { text: "Add more names" }), extra),
        el("p", { class: "field-hint", text: "A wildcard such as *.example.com covers the subdomains but not example.com itself, so list both when you want both." }),
        issueNote);
    }
    $("#namesBody").replaceChildren(
      el("p", { class: "dialog-intro", text: "Nothing has been written yet. The certificate is requested from Let's Encrypt through Cloudflare DNS (up to a minute), then your files are saved and nginx reloads." }),
      ...sections.map((section) => section.node));
    go.onclick = () => {
      const out = { ...(before || {}) };
      for (const section of sections) out[section.item.lineage] = section.read();
      finish(out);
    };
    update();
    dialog.showModal();
  });
}

$("#btnHttpsGo").addEventListener("click", () => goHttps().catch((error) => { HTTPS.busy = false; updateHttpsGo(); report(error); }));
