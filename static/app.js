"use strict";

const $ = (id) => document.getElementById(id);
const INDENT = "    ";

const S = {
  config: null,
  root: "",
  dir: "",
  file: null,   // open file, relative to root
  content: "",  // last loaded or saved raw text
  nodes: null,  // parsed tree while in Blocks mode
  mode: "raw",  // "raw" | "blocks"
  dirty: false,
};

// ---------------------------------------------------------------- helpers

function log(msg) {
  const out = $("output");
  const stamp = new Date().toLocaleTimeString();
  out.textContent += `[${stamp}] ${msg}\n`;
  out.scrollTop = out.scrollHeight;
}

const report = (e) => log("Error: " + e.message);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function api(method, url, body) {
  const opts = { method, headers: { "X-Requested-With": "nginx-autohandler" } };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function fmtSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

function splitArgs(text) {
  return text.match(/"[^"]*"|'[^']*'|\S+/g) || [];
}

function setDirty(value) {
  S.dirty = value;
  $("dirtyDot").classList.toggle("hidden", !value);
}

function showPane(name) {
  $("empty").classList.toggle("hidden", name !== "empty");
  $("editorPane").classList.toggle("hidden", name !== "editor");
}

// ---------------------------------------------------------------- file tree

async function loadDir(dir) {
  const data = await api("GET", "/api/tree?path=" + encodeURIComponent(dir));
  S.root = data.root;
  S.dir = data.path;
  $("crumbs").textContent = data.root + (data.path ? "/" + data.path : "");

  const tree = $("tree");
  tree.textContent = "";
  if (S.dir) tree.append(entryRow({ name: "..", path: parentOf(S.dir), dir: true, size: null }));
  for (const entry of data.entries) tree.append(entryRow(entry));
  if (!data.entries.length && !S.dir) tree.append(el("div", "hint", "No files yet. Use + to add one."));
}

function parentOf(dir) {
  return dir.split("/").slice(0, -1).join("/");
}

function entryRow(entry) {
  const row = el("div", "entry" + (entry.dir ? " dir" : ""));
  if (!entry.dir && entry.path === S.file) row.classList.add("active");
  row.append(el("span", "", entry.dir ? entry.name + "/" : entry.name));
  if (!entry.dir && entry.size !== null) row.append(el("span", "size", fmtSize(entry.size)));
  row.onclick = () => (entry.dir ? loadDir(entry.path) : openFile(entry.path)).catch(report);
  return row;
}

// ---------------------------------------------------------------- open, save, apply

function confirmDiscard() {
  return !S.dirty || confirm("Discard unsaved changes?");
}

async function openFile(path) {
  if (!confirmDiscard()) return;
  const data = await api("GET", "/api/file?path=" + encodeURIComponent(path));
  S.file = data.path;
  S.content = data.content;
  S.nodes = null;
  S.mode = "raw";
  setModeButtons();
  $("editor").value = data.content;
  $("fileName").textContent = data.path;
  setDirty(false);
  showPane("editor");
  await loadDir(S.dir);
}

async function currentContent() {
  if (S.mode === "raw") return $("editor").value;
  const data = await api("POST", "/api/blocks/render", { nodes: S.nodes });
  return data.content;
}

function describeApply(result, path) {
  if (!result.ok) {
    log(`Not saved: nginx rejected ${path}. The previous version is back in place.`);
  } else if (result.saved) {
    log(`Saved ${path}` + (result.reloaded ? " and reloaded nginx." : "."));
  } else {
    log("No changes to save.");
  }
  if (result.output) log(result.output);
  if (result.dns) {
    if (result.dns.error) log("DNS: " + result.dns.error);
    else for (const [domain, outcome] of Object.entries(result.dns.results)) log(`DNS ${domain}: ${outcome}`);
  }
  return result.ok;
}

async function save() {
  if (!S.file) return;
  const content = await currentContent();
  const result = await api("PUT", "/api/file", { path: S.file, content });
  if (describeApply(result, S.file)) {
    S.content = content;
    if (S.mode === "raw") $("editor").value = content;
    setDirty(false);
  }
}

async function newFile() {
  if (!confirmDiscard()) return;
  const base = S.dir ? S.root + "/" + S.dir : S.root;
  const name = prompt(`New file, relative to ${base}\n(e.g. conf.d/example.conf)`);
  if (!name || !name.trim()) return;
  const path = S.dir ? S.dir + "/" + name.trim() : name.trim();
  const result = await api("POST", "/api/file", { path, content: "" });
  describeApply(result, path);
  await loadDir(S.dir);
  await openFile(path);
}

async function removeFile() {
  if (!S.file || !confirm(`Delete ${S.file}? A backup is kept.`)) return;
  const result = await api("DELETE", "/api/file", { path: S.file });
  describeApply(result, S.file);
  if (result.ok) {
    S.file = null;
    setDirty(false);
    showPane("empty");
  }
  await loadDir(S.dir);
}

// ---------------------------------------------------------------- raw / blocks modes

function setModeButtons() {
  const raw = S.mode === "raw";
  $("modeRaw").classList.toggle("active", raw);
  $("modeBlocks").classList.toggle("active", !raw);
  $("modeRaw").setAttribute("aria-selected", raw);
  $("modeBlocks").setAttribute("aria-selected", !raw);
  $("editor").classList.toggle("hidden", !raw);
  $("blocks").classList.toggle("hidden", raw);
}

async function setMode(mode) {
  if (mode === S.mode) return;
  if (mode === "blocks") {
    const data = await api("POST", "/api/blocks/parse", { content: $("editor").value });
    S.nodes = data.nodes;
    S.mode = "blocks";
    renderBlocks();
  } else {
    $("editor").value = await currentContent();
    S.nodes = null;
    S.mode = "raw";
  }
  setModeButtons();
}

function markDirty() {
  setDirty(true);
}

function newNode(kind, name, args, depth) {
  return {
    kind,
    name: kind === "comment" ? "" : name,
    args: kind === "comment" ? [] : args,
    children: [],
    text: kind === "comment" ? name : "",
    line: null,
  };
}

function renderBlocks() {
  const root = $("blocks");
  root.textContent = "";
  const wrap = el("div", "block-root");
  wrap.append(nodeList(S.nodes, 0));
  wrap.append(addRow(S.nodes, 0, true));
  root.append(wrap);
}

function nodeList(list, depth) {
  const container = el("div", "node-list");
  list.forEach((node, index) => container.append(nodeView(list, index, depth)));
  return container;
}

function nodeView(list, index, depth) {
  const node = list[index];

  if (node.kind === "comment") {
    const row = el("div", "node-row comment-row");
    const text = el("input", "cell comment");
    text.value = node.text;
    text.setAttribute("aria-label", "Comment");
    text.oninput = () => { node.text = text.value; markDirty(); };
    row.append(text, nodeActions(list, index, depth));
    return row;
  }

  const wrap = el("div", "node" + (node.kind === "block" ? " block" : ""));
  const row = el("div", "node-row");

  const name = el("input", "cell name");
  name.value = node.name;
  name.setAttribute("aria-label", "Directive name");
  name.oninput = () => { node.name = name.value.trim(); markDirty(); };

  const args = el("input", "cell");
  args.value = node.args.join(" ");
  args.placeholder = node.kind === "block" ? "arguments, e.g. ~ ^/api/" : "arguments, e.g. 127.0.0.1:3000";
  args.setAttribute("aria-label", "Arguments");
  args.oninput = () => { node.args = splitArgs(args.value); markDirty(); };

  row.append(name, args, nodeActions(list, index, depth));
  wrap.append(row);

  if (node.kind === "block") {
    const kids = el("div", "node-children");
    kids.append(nodeList(node.children, depth + 1));
    kids.append(addRow(node.children, depth + 1, false));
    wrap.append(kids);
  }
  return wrap;
}

function nodeActions(list, index, depth) {
  const actions = el("div", "node-actions");
  actions.append(
    actionButton("Up", "Move up", () => move(list, index, -1)),
    actionButton("Down", "Move down", () => move(list, index, 1)),
    actionButton("Remove", "Remove", () => {
      list.splice(index, 1);
      markDirty();
      renderBlocks();
    }, "danger"),
  );
  return actions;
}

function actionButton(label, title, onClick, extra) {
  const btn = el("button", extra || "", label);
  btn.title = title;
  btn.onclick = onClick;
  return btn;
}

function move(list, index, delta) {
  const target = index + delta;
  if (target < 0 || target >= list.length) return;
  [list[index], list[target]] = [list[target], list[index]];
  markDirty();
  renderBlocks();
}

function addRow(list, depth, isRoot) {
  const row = el("div", "add-row" + (isRoot ? " root" : ""));
  row.append(
    actionButton("+ Directive", "Add a directive", () => {
      const text = prompt("Directive, e.g.:  listen 80");
      if (!text || !text.trim()) return;
      const [name, ...args] = splitArgs(text.trim().replace(/;$/, ""));
      if (!name) return;
      list.push(newNode("directive", name, args, depth));
      markDirty();
      renderBlocks();
    }),
    actionButton("+ Block", "Add a block, e.g. location /", () => {
      const text = prompt("Block header, e.g.:  location /api/");
      if (!text || !text.trim()) return;
      const [name, ...args] = splitArgs(text.trim());
      if (!name) return;
      list.push(newNode("block", name, args, depth));
      markDirty();
      renderBlocks();
    }),
    actionButton("+ Comment", "Add a comment line", () => {
      list.push(newNode("comment", "# ", [], depth));
      markDirty();
      renderBlocks();
    }),
  );
  return row;
}

// ---------------------------------------------------------------- nginx actions

async function testConfig() {
  const r = await api("POST", "/api/test");
  log((r.ok ? "Config test passed." : "Config test FAILED.") + (r.output ? "\n" + r.output : ""));
}

async function reloadNginx() {
  const r = await api("POST", "/api/reload");
  log((r.ok ? "Reloaded nginx." : "Reload refused: the config test failed.") + (r.output ? "\n" + r.output : ""));
}

// ---------------------------------------------------------------- history

async function openHistory() {
  if (!S.file) return;
  $("historyFile").textContent = S.file;
  const list = $("historyList");
  list.textContent = "";
  const data = await api("GET", "/api/backups?path=" + encodeURIComponent(S.file));
  if (!data.backups.length) list.append(el("li", "muted", "No backups yet."));
  for (const backup of data.backups) {
    const item = el("li");
    item.append(el("span", "", backup.time));
    item.append(actionButton("Restore", "Restore this version", async () => {
      if (!confirm(`Restore ${S.file} from ${backup.time}? The current version is backed up first.`)) return;
      const result = await api("POST", "/api/restore", { path: S.file, backup: backup.name });
      describeApply(result, S.file);
      if (result.ok) await openFile(S.file);
      $("dlgHistory").close();
    }));
    list.append(item);
  }
  $("dlgHistory").showModal();
}

// ---------------------------------------------------------------- DNS

async function openDns() {
  const data = await api("GET", "/api/dns");
  if (!data.configured) {
    $("dnsSummary").textContent = "Cloudflare is off. Add an API token in Settings to enable it.";
  } else {
    const results = Object.entries(data.results || {}).map(([d, r]) => `${d}: ${r}`).join("\n");
    $("dnsSummary").textContent = data.last_run
      ? `Last sync ${data.last_run} to ${data.ip}.${data.error ? " Error: " + data.error : ""}\n${results}`
      : "Not synced yet this session.";
  }
  $("dnsDomains").value = (data.domains || []).join("\n");
  $("dnsDomains").disabled = !data.configured;
  $("btnSyncDns").disabled = !data.configured;
  $("btnSaveDomains").disabled = !data.configured;
  $("dlgDns").showModal();
}

// ---------------------------------------------------------------- settings

const SETTING_INPUTS = new Map(); // key -> { read(), changed(), kind }

function sourceLabel(item) {
  if (item.source === "env") return `from environment (${item.env})`;
  if (item.source === "ui") return "saved in the UI";
  return "default";
}

function settingRow(item) {
  const row = el("div", "setting");
  const head = el("div", "setting-head");
  head.append(el("span", "setting-label", item.label), el("span", "badge" + (item.source === "env" ? " locked" : ""), sourceLabel(item)));
  row.append(head);

  const control = el("div", "setting-control");
  let input;
  let initial;
  if (item.kind === "bool") {
    input = el("input");
    input.type = "checkbox";
    input.checked = item.value;
    initial = item.value;
    input.onchange = () => markChanged(item.key);
    control.append(input);
    SETTING_INPUTS.set(item.key, { read: () => input.checked, changed: () => input.checked !== initial });
  } else if (item.kind === "choice") {
    input = el("select", "cell");
    for (const choice of item.choices) {
      const opt = el("option", "", choice);
      opt.value = choice;
      input.append(opt);
    }
    input.value = item.value;
    initial = item.value;
    input.onchange = () => markChanged(item.key);
    control.append(input);
    SETTING_INPUTS.set(item.key, { read: () => input.value, changed: () => input.value !== initial });
  } else if (item.kind === "secret") {
    input = el("input", "cell");
    input.type = "password";
    input.autocomplete = "new-password";
    input.placeholder = item.is_set ? "set. type to replace" : "not set";
    input.oninput = () => markChanged(item.key);
    const clear = actionButton("Clear", "Remove the saved value", () => {
      input.value = "";
      SETTING_INPUTS.get(item.key).clear = true;
      input.placeholder = "will be cleared on save";
      markChanged(item.key);
    });
    control.append(input, clear);
    SETTING_INPUTS.set(item.key, {
      read: () => (SETTING_INPUTS.get(item.key).clear ? "" : input.value),
      changed: () => SETTING_INPUTS.get(item.key).clear || input.value !== "",
    });
  } else {
    input = el("input", "cell");
    input.type = item.kind === "int" ? "number" : "text";
    input.value = item.value;
    initial = String(item.value);
    input.oninput = () => markChanged(item.key);
    control.append(input);
    SETTING_INPUTS.set(item.key, { read: () => input.value, changed: () => input.value !== initial });
  }
  input.disabled = item.locked;
  for (const btn of control.querySelectorAll("button")) btn.disabled = item.locked;
  row.append(control);
  return row;
}

function markChanged(key) {
  const entry = SETTING_INPUTS.get(key);
  entry.dirtyFlag = true;
}

function renderSettings(data) {
  SETTING_INPUTS.clear();
  const groups = $("settingsGroups");
  groups.textContent = "";
  const byGroup = new Map();
  for (const item of data.settings) {
    if (!byGroup.has(item.group)) byGroup.set(item.group, []);
    byGroup.get(item.group).push(item);
  }
  for (const [group, items] of byGroup) {
    const section = el("section", "setting-group");
    section.append(el("h3", "sub", group));
    for (const item of items) section.append(settingRow(item));
    groups.append(section);
  }
}

async function openSettings() {
  const data = await api("GET", "/api/settings");
  renderSettings(data);
  $("dlgSettings").showModal();
}

async function saveSettings() {
  const values = {};
  for (const [key, entry] of SETTING_INPUTS) {
    if (entry.changed()) values[key] = entry.read();
  }
  if (!Object.keys(values).length) return log("Nothing changed in Settings.");
  const data = await api("PUT", "/api/settings", { values });
  renderSettings(data);
  const status = await api("GET", "/api/config");
  S.config = status;
  setBadges(status);
  log(`Saved ${Object.keys(values).length} setting(s).`);
}

async function testNotify() {
  const data = await api("POST", "/api/notify/test");
  for (const [channel, outcome] of Object.entries(data.results)) log(`Test ${channel}: ${outcome}`);
}

// ---------------------------------------------------------------- certificates

async function openCerts() {
  const data = await api("GET", "/api/certs");
  $("certStaging").checked = data.staging;
  $("certList").textContent = data.output || "No certificates yet.";
  $("dlgCerts").showModal();
}

async function issueCert() {
  const domains = $("certDomains").value;
  if (!domains.trim()) return log("Enter at least one domain.");
  log("Requesting a certificate. DNS-01 can take a few minutes...");
  const data = await api("POST", "/api/certs/issue", { domains, staging: $("certStaging").checked });
  log((data.ok ? "Certificate issued" : "Certificate request failed") + (data.staging ? " (staging)." : "."));
  log(data.output);
  if (data.dns) {
    if (data.dns.error) log("DNS: " + data.dns.error);
    else for (const [domain, outcome] of Object.entries(data.dns.results)) log(`DNS ${domain}: ${outcome}`);
  }
  const list = await api("GET", "/api/certs");
  $("certList").textContent = list.output || "No certificates yet.";
}

// ---------------------------------------------------------------- startup

function setBadges(config) {
  const authBadge = $("authBadge");
  authBadge.textContent = config.auth ? "login on" : "login off";
  authBadge.classList.toggle("on", config.auth);
  const reloadBadge = $("reloadBadge");
  reloadBadge.textContent = config.auto_reload ? "auto-reload on" : "auto-reload off";
  reloadBadge.classList.toggle("on", config.auto_reload);
  $("btnDns").hidden = !config.cloudflare;
}

function bindEvents() {
  $("btnSave").onclick = () => save().catch(report);
  $("btnNewFile").onclick = () => newFile().catch(report);
  $("btnDelete").onclick = () => removeFile().catch(report);
  $("btnHistory").onclick = () => openHistory().catch(report);
  $("btnTest").onclick = () => testConfig().catch(report);
  $("btnReload").onclick = () => reloadNginx().catch(report);
  $("btnDns").onclick = () => openDns().catch(report);
  $("btnSettings").onclick = () => openSettings().catch(report);
  $("btnSaveSettings").onclick = () => saveSettings().catch(report);
  $("btnTestNotify").onclick = () => testNotify().catch(report);
  $("btnCerts").onclick = () => openCerts().catch(report);
  $("btnIssue").onclick = () => issueCert().catch(report);
  $("btnClearLog").onclick = () => { $("output").textContent = ""; };
  $("modeRaw").onclick = () => setMode("raw").catch(report);
  $("modeBlocks").onclick = () => setMode("blocks").catch(report);
  $("editor").addEventListener("input", () => {
    S.content = $("editor").value;
    markDirty();
  });
  $("btnSaveDomains").onclick = async () => {
    const data = await api("POST", "/api/dns/domains", { domains: $("dnsDomains").value });
    log(`Saved ${data.domains.length} DNS domain(s).`);
    $("dnsDomains").value = data.domains.join("\n");
  };
  $("btnSyncDns").onclick = async () => {
    const data = await api("POST", "/api/dns/sync");
    if (data.error) return log("DNS: " + data.error);
    log(`DNS sync at ${data.last_run} (public IP ${data.ip}).`);
    for (const [domain, outcome] of Object.entries(data.results)) log(`  ${domain}: ${outcome}`);
    $("dlgDns").close();
  };
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save().catch(report);
    }
  });
  window.addEventListener("beforeunload", (e) => {
    if (S.dirty) e.preventDefault();
  });
}

async function start() {
  bindEvents();
  S.config = await api("GET", "/api/config");
  setBadges(S.config);
  await loadDir("");
  log(`Editing ${S.config.root}. Pick a file to begin.`);
}

start().catch(report);
