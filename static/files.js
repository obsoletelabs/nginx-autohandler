"use strict";

// File navigation, remembered views and preferences. Loads after app.js and shell.js.
// It replaces the flat file list with a folder tree, a quick switcher and back/forward
// history, and remembers each file's view (Basic, Blocks, Nginx) and the user's choices.

// ---------------------------------------------------------------- preferences

const PREFS_KEY = "nginx-autohandler-prefs";
const VIEW_MODES = ["basic", "blocks", "raw"];
const PREF_DEFAULTS = {
  defaultMode: "blocks",
  rememberPerFile: true,
  theme: "system",
  compact: false,
  foldersExpanded: true,
  fileModes: {},
  collapsed: {},
  recent: [],
  openTabs: [],
  lastFile: "",
  lastView: "",
  filesHeight: 0,
  updatedAt: 0,
};

function plainObject(value, accept) {
  const out = {};
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) if (accept(item)) out[key] = item;
  }
  return out;
}

function normalizePrefs(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const p = { ...PREF_DEFAULTS, ...source };
  if (!VIEW_MODES.includes(p.defaultMode)) p.defaultMode = "blocks";
  if (!["system", "light", "dark"].includes(p.theme)) p.theme = "system";
  p.rememberPerFile = p.rememberPerFile !== false;
  p.compact = p.compact === true;
  p.foldersExpanded = p.foldersExpanded !== false;
  p.fileModes = plainObject(source.fileModes, (value) => VIEW_MODES.includes(value));
  p.collapsed = plainObject(source.collapsed, (value) => typeof value === "boolean");
  p.recent = Array.isArray(source.recent) ? source.recent.filter((item) => typeof item === "string").slice(0, 8) : [];
  p.openTabs = Array.isArray(source.openTabs) ? [...new Set(source.openTabs.filter((item) => typeof item === "string"))].slice(0, 24) : [];
  p.lastFile = typeof p.lastFile === "string" ? p.lastFile : "";
  p.lastView = typeof p.lastView === "string" ? p.lastView : "";
  p.filesHeight = Number.isFinite(p.filesHeight) ? p.filesHeight : 0;
  p.updatedAt = Number(p.updatedAt) || 0;
  return p;
}

function readLocalPrefs() {
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(PREFS_KEY) || "null");
  } catch (error) {
    raw = null;
  }
  if (!raw) {
    // Someone who only ever used the theme button keeps that choice.
    try {
      const theme = localStorage.getItem(THEME_KEY);
      if (theme === "light" || theme === "dark") raw = { theme };
    } catch (error) {
      raw = null;
    }
  }
  return raw;
}

const prefs = normalizePrefs(readLocalPrefs());
let prefsTimer;

function savePrefs() {
  prefs.updatedAt = Date.now();
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch (error) {
    // Storage is blocked: the server copy still keeps the choices.
  }
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(pushPrefs, 600);
}

async function pushPrefs() {
  try {
    await fetch("/api/prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Requested-With": "nginx-autohandler" },
      body: JSON.stringify({ prefs }),
    });
  } catch (error) {
    // The choices still live in this browser.
  }
}

function applyThemePref() {
  const root = document.documentElement;
  try {
    if (prefs.theme === "system") {
      delete root.dataset.theme;
      localStorage.removeItem(THEME_KEY);
    } else {
      root.dataset.theme = prefs.theme;
      localStorage.setItem(THEME_KEY, prefs.theme);
    }
  } catch (error) {
    if (prefs.theme !== "system") root.dataset.theme = prefs.theme;
  }
  $("#btnTheme").textContent = currentTheme() === "dark" ? "☀ Light" : "☾ Dark";
}

function applyPrefsToPage() {
  applyThemePref();
  document.body.classList.toggle("compact", prefs.compact);
  if (state.doc) renderFileList();
}

// Local choices are ready at once. The server copy is fetched in the background and wins
// only when it is newer, so a second browser picks up what the first one remembered.
const prefsReady = (async () => {
  try {
    const response = await fetch("/api/prefs");
    if (!response.ok) return;
    const remote = (await response.json()).prefs;
    const remoteStamp = Number(remote && remote.updatedAt) || 0;
    if (remoteStamp > prefs.updatedAt) {
      Object.assign(prefs, normalizePrefs(remote));
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
      } catch (error) {
        // ignore
      }
      applyPrefsToPage();
    } else if (prefs.updatedAt > remoteStamp) {
      pushPrefs();
    }
  } catch (error) {
    // The server copy is optional.
  }
})();

function modeFor(path) {
  if (prefs.rememberPerFile && prefs.fileModes[path]) return prefs.fileModes[path];
  return prefs.defaultMode;
}

function rememberMode(path, mode) {
  if (!prefs.rememberPerFile || !path) return;
  prefs.fileModes[path] = mode;
  savePrefs();
}

// ---------------------------------------------------------------- state for files

// state.view is "" while a config file is showing, "home" for the landing page, or "log:<id>" for a log.
Object.assign(state, { deletedFiles: [], deletedDocs: {}, diskFiles: new Set(), baseline: new Map(), fileView: {}, view: "" });
const nav = { back: [], fwd: [], shown: "", rows: [], filter: "", quickIndex: 0, quickItems: [] };

// What is on screen: a file path, "home", or "log:<id>". History and tabs all speak in these keys.
// "home" is the overview dashboard, "files" the file browser, "log:<id>" a log.
const isViewKey = (key) => key === "home" || key === "files" || key.startsWith("log:");
const viewKey = () => state.view || state.file;
const keyExists = (key) => isViewKey(key) || state.doc.files.some((file) => file.path === key);

function openKey(key, options) {
  if (isViewKey(key)) return openView(key, options);
  return openFile(key, options);
}

// Shared by every way of arriving somewhere: remember where we were, so Back works across files, Home and logs.
function pushHistory(history) {
  if (!history) return;
  nav.back.push(viewKey());
  if (nav.back.length > 50) nav.back.shift();
  nav.fwd = [];
}

// Opens the landing page or a log: pending edits are applied first and the file's own view is remembered.
async function openView(key, { history = true } = {}) {
  if (viewKey() === key) return true;
  if (!state.view && !(await applyDraft())) return false;
  captureView();
  pushHistory(history);
  state.view = key;
  if (!prefs.openTabs.includes(key)) prefs.openTabs.push(key);
  render();
  return true;
}
const openHome = (options) => openView("home", options);
const openFileBrowser = (options) => openView("files", options);
const openLog = (id, options) => openView("log:" + id, options);

function signature(file) {
  return JSON.stringify(file.nodes, (key, value) => (key === "id" || key === "line" ? undefined : value));
}

function fileInfo(file) {
  const issues = (state.lastCheck && state.lastCheck.issues ? state.lastCheck.issues : []).filter(
    (issue) => issue.path === file.path || (issue.path && issue.path.startsWith(file.path + ":")),
  );
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const isNew = !state.diskFiles.has(file.path);
  return {
    domains: fileDomains(file),
    tls: fileCertificates(file).length > 0,
    errors,
    warnings: issues.length - errors,
    isNew,
    changed: !isNew && signature(file) !== state.baseline.get(file.path),
  };
}

function isMainFile(file) {
  return file.nodes.some((node) => node.kind === "block" && ["events", "http", "stream", "mail"].includes(node.name));
}

// ---------------------------------------------------------------- include matching

function includePattern(argument) {
  let pattern = argument.replace(/^["']|["']$/g, "");
  const prefix = (state.doc.prefix || "").replace(/\/+$/, "");
  if (prefix && pattern.startsWith(prefix + "/")) pattern = pattern.slice(prefix.length + 1);
  return pattern;
}

function globToRegExp(pattern) {
  const body = pattern.replace(/[.+^${}()|\\[\]]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp("^" + body + "$");
}

// Include directives, across the whole document, whose pattern reaches `path`.
function includersOf(path) {
  const found = [];
  for (const file of state.doc.files) {
    walkNodes(file.nodes, (node) => {
      if (node.kind !== "directive" || node.name !== "include" || !node.args[0]) return;
      if (globToRegExp(includePattern(node.args[0])).test(path)) found.push({ file: file.path, node });
    });
  }
  return found;
}

// Every include directive (with its file) that the server resolved to `path`.
function resolvedIncluders(path) {
  const found = [];
  const links = state.includeLinks || {};
  for (const [nodeId, info] of Object.entries(links)) {
    if (info && info.targets && info.targets.includes(path)) {
      const hit = locate(nodeId);
      if (hit && hit.file.path !== path) found.push({ file: hit.file.path, nodeId });
    }
  }
  return found;
}

// ---------------------------------------------------------------- views per file

async function refreshRender() {
  const data = await api("/api/render", { document: state.doc });
  state.scopeInfo = data.file_contexts;
  state.includeLinks = data.includes || {};
  state.rendered = data;
}

async function ensureScopes() {
  if (!state.scopeInfo) await refreshRender();
}

// Switches the view of the current file. `user` marks a choice made with the tabs, which is remembered.
async function setMode(mode, user = false) {
  if (user) rememberMode(state.file, mode);
  if (mode === state.mode) return;
  if (!(await applyDraft())) return;
  if (mode === "basic") await refreshRender();
  state.mode = mode;
  if (mode === "raw") state.selected = null;
  render();
}

function captureView() {
  if (!state.file || !state.doc || state.view) return;
  state.fileView[state.file] = { selected: state.selected, scroll: $("#canvas").scrollTop };
}

function restoreView(path) {
  const saved = state.fileView[path];
  const hit = saved && saved.selected ? locate(saved.selected) : null;
  state.selected = hit && hit.file.path === path ? saved.selected : null;
  return saved ? saved.scroll : 0;
}

function noteRecent(path) {
  prefs.recent = [path, ...prefs.recent.filter((item) => item !== path)].slice(0, 8);
}

function revealFile(path) {
  const parts = path.split("/");
  let changed = false;
  for (let i = 1; i < parts.length; i++) {
    const folder = parts.slice(0, i).join("/");
    if (isCollapsed(folder)) {
      prefs.collapsed[folder] = false;
      changed = true;
    }
  }
  if (changed) savePrefs();
}

// Opens a file after flushing pending edits. Returns true when the file is now showing.
async function openFile(path, { history = true, select = null } = {}) {
  if (!state.doc.files.some((file) => file.path === path)) {
    toast(`${path} is not in this document.`);
    return false;
  }
  if (path === state.file && !state.view) {
    if (select && locate(select)) {
      if (state.mode !== "blocks") await setMode("blocks");
      await selectNode(select);
      scrollNodeIntoView(select);
    }
    return true;
  }
  if (!state.view && !(await applyDraft())) return false;
  captureView();
  pushHistory(history);
  state.view = "";
  state.file = path;
  const scroll = restoreView(path);
  if (prefs.rememberPerFile) {
    const mode = modeFor(path);
    if (mode !== state.mode) {
      if (mode === "basic") await refreshRender();
      state.mode = mode;
    }
  }
  if (state.mode === "raw") state.selected = null;
  // A jump to a directive needs the block view, whatever the file normally opens in.
  if (select && locate(select)) {
    state.mode = "blocks";
    state.selected = select;
  }
  revealFile(path);
  render();
  requestAnimationFrame(() => {
    if (select && state.selected === select) scrollNodeIntoView(select);
    else $("#canvas").scrollTop = scroll || 0;
  });
  return true;
}

function scrollNodeIntoView(id) {
  const node = $(`[data-node="${CSS.escape(id)}"]`);
  if (node) node.scrollIntoView({ block: "center", behavior: "smooth" });
}

async function navGo(delta) {
  const stack = delta < 0 ? nav.back : nav.fwd;
  const other = delta < 0 ? nav.fwd : nav.back;
  while (stack.length) {
    const key = stack.pop();
    if (!keyExists(key)) continue;
    const from = viewKey();
    if (await openKey(key, { history: false })) other.push(from);
    else stack.push(key);
    renderFileHeader();
    return;
  }
  toast(delta < 0 ? "Nothing earlier." : "Nothing later.");
}

// ---------------------------------------------------------------- loading and applying

// Called from setDocument(): picks the file and view to show and resets per-load bookkeeping.
function chooseStartFile(doc) {
  const previous = state.file;
  const exists = (path) => doc.files.some((file) => file.path === path);
  state.file = exists(previous) ? previous : exists(prefs.lastFile) ? prefs.lastFile : doc.entrypoint;
  prefs.openTabs = prefs.openTabs.filter((key) => exists(key) || isViewKey(key));
  if (!previous) {
    // First load of the page: the overview, unless a file or log was open last time.
    const last = prefs.lastView;
    state.view = last && isViewKey(last) ? last : exists(prefs.lastFile) ? "" : "home";
  }
  const shown = state.view || state.file;
  if (!prefs.openTabs.includes(shown)) prefs.openTabs.push(shown);
  if (!previous || prefs.rememberPerFile) state.mode = modeFor(state.file);
  nav.back = [];
  nav.fwd = [];
  nav.shown = "";
  state.fileView = {};
  state.deletedFiles = [];
  state.deletedDocs = {};
  state.diskFiles = new Set(doc.files.map((file) => file.path));
  state.baseline = new Map(doc.files.map((file) => [file.path, signature(file)]));
}

function afterDocumentLoad() {
  if (state.mode === "basic") ensureScopes().then(() => render()).catch(() => {});
}

function filesApplied() {
  state.deletedFiles = [];
  state.deletedDocs = {};
  state.diskFiles = new Set(state.doc.files.map((file) => file.path));
  state.baseline = new Map(state.doc.files.map((file) => [file.path, signature(file)]));
  renderFileList();
}

// ---------------------------------------------------------------- navigator

function buildTree(files) {
  const root = { name: "", path: "", folders: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.folders.has(parts[i])) {
        node.folders.set(parts[i], { name: parts[i], path: parts.slice(0, i + 1).join("/"), folders: new Map(), files: [] });
      }
      node = node.folders.get(parts[i]);
    }
    node.files.push(file);
  }
  return root;
}

function isCollapsed(folder) {
  return folder in prefs.collapsed ? prefs.collapsed[folder] : !prefs.foldersExpanded;
}

function countFiles(folder) {
  let total = folder.files.length;
  for (const sub of folder.folders.values()) total += countFiles(sub);
  return total;
}

function folderHasChange(folder, infos) {
  for (const file of folder.files) {
    const info = infos.get(file.path);
    if (info.changed || info.isNew) return true;
  }
  for (const sub of folder.folders.values()) if (folderHasChange(sub, infos)) return true;
  return false;
}

function badge(kind, text, title) {
  return el("span", { class: `nav-badge ${kind}`, title: title || text, text });
}

function navButton(label, title, handler) {
  return el("button", {
    class: "nav-act",
    type: "button",
    title,
    "aria-label": title,
    tabindex: "-1",
    onclick: (event) => {
      event.stopPropagation();
      handler();
    },
    text: label,
  });
}

function folderRow(folder, depth, open, infos, tokens) {
  const row = el(
    "div",
    { class: "nav-row folder", role: "treeitem", "aria-expanded": String(open), tabindex: "-1", "data-folder": folder.path, "data-parent": folder.path.includes("/") ? folder.path.slice(0, folder.path.lastIndexOf("/")) : "" },
    el("div", { class: "nav-line" },
      el("span", { class: "nav-twist", text: open ? "▾" : "▸" }),
      el("span", { class: "nav-name folder-name", text: folder.name + "/" }),
      !open && folderHasChange(folder, infos) ? el("span", { class: "nav-dot", title: "Contains unsaved changes" }) : null,
      el("span", { class: "nav-count", text: String(countFiles(folder)) }),
      el("span", { class: "nav-actions" }, navButton("＋", `New file in ${folder.path}`, () => addFileFlow(folder.path).catch(report))),
    ),
  );
  row.style.setProperty("--depth", depth);
  row.addEventListener("click", () => toggleFolder(folder.path, tokens.length > 0));
  return row;
}

function toggleFolder(path, filtering) {
  if (filtering) return;
  prefs.collapsed[path] = !isCollapsed(path);
  savePrefs();
  renderFileList();
}

function fileRow(file, info, depth, tokens) {
  const active = file.path === state.file && !state.view;
  const name = file.path.split("/").pop();
  const entry = file.path === state.doc.entrypoint;
  const parent = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
  const shown = tokens.length ? info.domains.filter((domain) => tokens.some((token) => domain.toLowerCase().includes(token))) : [];
  const ordered = [...shown, ...info.domains.filter((domain) => !shown.includes(domain))];
  const chips = ordered.slice(0, 3).map((domain) => el("span", { class: "nav-domain" + (shown.includes(domain) ? " hit" : ""), text: domain }));
  if (ordered.length > 3) chips.push(el("span", { class: "nav-more", title: ordered.slice(3).join(", "), text: `+${ordered.length - 3}` }));
  const row = el(
    "div",
    { class: "nav-row file" + (active ? " active" : ""), role: "treeitem", "aria-selected": String(active), tabindex: "-1", "data-path": file.path, "data-parent": parent, title: file.path },
    el("div", { class: "nav-line" },
      el("span", { class: "file-icon", text: "▤" }),
      el("span", { class: "nav-name", text: name }),
      entry ? badge("entry", "ENTRY", "Entry file: nginx loads this first") : null,
      info.tls ? badge("tls", "TLS", "Serves TLS certificates") : null,
      info.errors ? badge("err", String(info.errors), `${info.errors} problem(s) found by the checks`) : null,
      !info.errors && info.warnings ? badge("warn", String(info.warnings), `${info.warnings} suggestion(s)`) : null,
      info.isNew ? badge("new", "NEW", "Not on disk yet. Apply writes it.") : null,
      info.changed ? el("span", { class: "nav-dot", title: "Unsaved changes" }) : null,
      el("span", { class: "nav-actions" },
        navButton("⧉", "Clone this file", () => cloneFile(file).catch(report)),
        entry || !file.path.endsWith(".conf") ? null : navButton("⏻", "Disable (kept as name.conf.disabled, listed on the Overview)", () => toggleConfig(file.path, false).catch(report)),
        entry ? null : navButton("✎", "Rename (F2)", () => renameFile(file).catch(report)),
        entry ? null : navButton("✕", "Delete (Del)", () => deleteFile(file).catch(report)),
      ),
    ),
    el("div", { class: "nav-meta" },
      chips.length ? chips : el("span", { class: "nav-none", text: entry ? "entry · main settings" : isMainFile(file) ? "main settings" : "no server_name" }),
    ),
  );
  row.style.setProperty("--depth", depth);
  row.addEventListener("click", () => openFile(file.path).catch(report));
  return row;
}

function renderFileList() {
  const box = $("#fileList");
  if (!box || !state.doc) return;
  const focused = document.activeElement && box.contains(document.activeElement) ? document.activeElement.closest(".nav-row") : null;
  const focusKey = focused ? focused.dataset.path || "folder:" + focused.dataset.folder : "";
  const tokens = nav.filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const infos = new Map(state.doc.files.map((file) => [file.path, fileInfo(file)]));
  const files = state.doc.files.filter((file) => {
    if (!tokens.length) return true;
    const haystack = (file.path + " " + infos.get(file.path).domains.join(" ")).toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
  const byName = (a, b) => (a.name || a.path).localeCompare(b.name || b.path, undefined, { numeric: true });
  const rows = [];
  const walk = (folder, depth) => {
    const subs = [...folder.folders.values()].sort(byName);
    let leaves = [...folder.files].sort(byName);
    if (depth === 0) leaves = [...leaves.filter((f) => f.path === state.doc.entrypoint), ...leaves.filter((f) => f.path !== state.doc.entrypoint)];
    const emitFiles = () => leaves.forEach((file) => rows.push(fileRow(file, infos.get(file.path), depth, tokens)));
    if (depth === 0) emitFiles();
    for (const sub of subs) {
      const open = tokens.length > 0 || !isCollapsed(sub.path);
      rows.push(folderRow(sub, depth, open, infos, tokens));
      if (open) walk(sub, depth + 1);
    }
    if (depth !== 0) emitFiles();
  };
  walk(buildTree(files), 0);
  if (!rows.length) {
    rows.push(el("div", { class: "nav-empty" },
      el("p", { text: tokens.length ? `Nothing matches "${nav.filter.trim()}".` : "No files yet." }),
      tokens.length
        ? el("button", { class: "tiny", type: "button", text: "Clear filter", onclick: () => showFiles() })
        : el("button", { class: "tiny", type: "button", text: "＋ New file", onclick: () => addFileFlow().catch(report) }),
    ));
  }
  if (state.deletedFiles.length) {
    rows.push(el("div", { class: "nav-pending" },
      el("div", { class: "nav-pending-title", text: "REMOVED WHEN YOU APPLY" }),
      ...state.deletedFiles.map((path) => {
        const stash = state.deletedDocs[path];
        return el("div", { class: "nav-pending-row" },
          el("span", { class: "nav-pending-path", title: path, text: stash && stash.renamedTo ? `${path} → ${stash.renamedTo}` : path }),
          stash && !stash.renamedTo ? el("button", { class: "tiny", type: "button", text: "Restore", onclick: () => restoreDeleted(path).catch(report) }) : null,
        );
      }),
    ));
  }
  box.replaceChildren(...rows);
  nav.rows = $$(".nav-row", box);
  const tabbable = nav.rows.find((row) => row.classList.contains("active")) || nav.rows[0];
  nav.rows.forEach((row) => row.setAttribute("tabindex", row === tabbable ? "0" : "-1"));
  if (focusKey) {
    const same = nav.rows.find((row) => (row.dataset.path || "folder:" + row.dataset.folder) === focusKey);
    if (same) same.focus();
  }
  const pending = state.doc.files.filter((file) => {
    const info = infos.get(file.path);
    return info.isNew || info.changed;
  }).length + state.deletedFiles.length;
  const summary = $("#fileSummary");
  summary.textContent = pending ? `${pending} changed` : "";
  summary.hidden = !pending;
  if (prefs.filesHeight) box.style.height = prefs.filesHeight + "px";
  // Keep the open file in view when it changes (a jump, back/forward, a new file), not on every refresh.
  if (nav.revealed !== state.file) {
    const active = box.querySelector(".nav-row.active");
    if (active) {
      nav.revealed = state.file;
      box.scrollTop = Math.max(0, active.offsetTop - box.clientHeight / 2 + active.offsetHeight / 2);
    }
  }
}

function onNavKey(event) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const row = event.target.closest(".nav-row");
  if (!row) return;
  const rows = nav.rows;
  const index = rows.indexOf(row);
  const focusAt = (i) => rows[Math.max(0, Math.min(rows.length - 1, i))].focus();
  const isFolder = row.classList.contains("folder");
  const open = row.getAttribute("aria-expanded") === "true";
  let handled = true;
  switch (event.key) {
    case "ArrowDown": focusAt(index + 1); break;
    case "ArrowUp":
      if (index === 0) $("#fileFilter").focus();
      else focusAt(index - 1);
      break;
    case "Home": focusAt(0); break;
    case "End": focusAt(rows.length - 1); break;
    case "ArrowRight":
      if (isFolder && !open) toggleFolder(row.dataset.folder, false);
      else focusAt(index + 1);
      break;
    case "ArrowLeft":
      if (isFolder && open) toggleFolder(row.dataset.folder, false);
      else if (row.dataset.parent) rows.find((r) => r.dataset.folder === row.dataset.parent)?.focus();
      break;
    case "Enter":
    case " ":
      if (isFolder) toggleFolder(row.dataset.folder, false);
      else openFile(row.dataset.path).catch(report);
      break;
    case "F2": {
      const file = state.doc.files.find((f) => f.path === row.dataset.path);
      if (file) renameFile(file).catch(report);
      break;
    }
    case "Delete": {
      const file = state.doc.files.find((f) => f.path === row.dataset.path);
      if (file) deleteFile(file).catch(report);
      break;
    }
    default: handled = false;
  }
  if (handled) event.preventDefault();
}

// ---------------------------------------------------------------- header and breadcrumb

function renderFileHeader() {
  const target = $("#activeFile");
  if (!target || !state.doc) return;
  const parts = state.file.split("/");
  const name = parts.pop();
  const root = el("button", { class: "crumb-link crumb-root", type: "button", title: "Browse all files, logs and certificates (Ctrl+P to search)", onclick: () => openFileBrowser().catch(report), text: "⌂ Files" });
  const dirs = parts.map((part, i) => {
    const folder = parts.slice(0, i + 1).join("/");
    return el("button", { class: "crumb-link crumb-dir", type: "button", title: `Show ${folder}/ in the file list`, onclick: () => showFiles(folder), text: part });
  });
  const trail = [root];
  for (const dir of dirs) trail.push(el("span", { class: "crumb-sep", text: "/" }), dir);
  trail.push(el("span", { class: "crumb-sep", text: "/" }), el("strong", { class: "crumb-name", text: name }));
  target.replaceChildren(...trail);
  const file = currentFile();
  const flags = $("#fileFlags");
  flags.replaceChildren();
  if (file) {
    const info = fileInfo(file);
    if (file.path === state.doc.entrypoint) flags.append(badge("entry", "ENTRY", "Entry file: nginx loads this first"));
    if (info.isNew) flags.append(badge("new", "NEW", "Not on disk yet. Apply writes it."));
    else if (info.changed) flags.append(badge("changed", "UNSAVED", "Changed since it was loaded or applied"));
  }
  for (const id of ["navBack", "tbBack"]) $("#" + id).disabled = !nav.back.length;
  for (const id of ["navFwd", "tbFwd"]) $("#" + id).disabled = !nav.fwd.length;
  renderTopBar(file);
  renderIncludedBy();
  const shown = viewKey();
  if (nav.shown !== shown) {
    nav.shown = shown;
    if (!state.view) {
      noteRecent(state.file);
      prefs.lastFile = state.file;
    }
    prefs.lastView = state.view;
    savePrefs();
  }
  if (typeof renderViewPane === "function") renderViewPane();
}

// The way back to the list: clears the filter, opens the folders above the current file (or the
// folder that was clicked) and puts keyboard focus on that row.
function showFiles(folder) {
  if (nav.filter) {
    nav.filter = "";
    $("#fileFilter").value = "";
  }
  let target = typeof folder === "string" ? folder : "";
  if (target) {
    const parts = target.split("/");
    for (let i = 1; i <= parts.length; i++) prefs.collapsed[parts.slice(0, i).join("/")] = false;
  } else {
    revealFile(state.file);
  }
  savePrefs();
  nav.revealed = "";
  renderFileList();
  const row = target
    ? nav.rows.find((r) => r.dataset.folder === target)
    : nav.rows.find((r) => r.classList.contains("active"));
  if (row) {
    row.focus();
    row.scrollIntoView({ block: "nearest" });
  } else {
    $("#fileFilter").focus();
  }
}

// The ⌂ button: the file browser (files, logs, certificates). The brand opens the overview instead.
async function goHome() {
  if (nav.filter) {
    nav.filter = "";
    $("#fileFilter").value = "";
  }
  await openFileBrowser();
}

// ---------------------------------------------------------------- top bar: current file and tabs

function pathLabel(path) {
  const parts = path.split("/");
  const name = parts.pop();
  return el("span", {}, parts.length ? el("span", { class: "tb-dir", text: parts.join("/") + "/" }) : null, el("strong", { text: name }));
}

const VIEW_TITLES = { home: "Overview", files: "Files" };
function keyLabel(key) {
  if (key in VIEW_TITLES) return VIEW_TITLES[key];
  if (key.startsWith("log:")) return key.slice(4).split("/").pop();
  return key.split("/").pop();
}
function keyIcon(key) {
  return key === "home" ? "◎" : key === "files" ? "⌂" : key.startsWith("log:") ? "☰" : "▤";
}

function renderTopBar(file) {
  const info = file && !state.view ? fileInfo(file) : null;
  const dirty = info && (info.changed || info.isNew);
  const path = $("#tbPath");
  const key = viewKey();
  if (state.view) {
    path.replaceChildren(el("strong", { text: state.view.startsWith("log:") ? "Log · " + state.view.slice(4) : VIEW_TITLES[state.view] }));
    path.title = path.textContent;
  } else {
    path.replaceChildren(pathLabel(state.file));
    path.title = state.file;
  }
  $("#tbDot").hidden = !dirty;
  $("#tbSwitch").title = `${path.title}${dirty ? " (unsaved changes)" : ""}. Switch file (Ctrl+P)`;
  $("#tbSwitch .file-icon").textContent = keyIcon(key);
  renderTabs();
}

const PINNED_TABS = ["home", "files"];
let suppressTabClick = false;

// Drag a tab sideways to reorder it. The tab swaps places with a neighbour once the pointer passes
// that neighbour's middle; the order is saved when the pointer is released.
function beginTabDrag(event, tab, bar) {
  if (event.button !== 0 || event.target.closest(".tab-close")) return;
  const startX = event.clientX;
  let dragging = false;
  const middle = (item) => { const box = item.getBoundingClientRect(); return box.left + box.width / 2; };
  const move = (e) => {
    if (e.buttons === 0) { finish(); return; }  // the button was released somewhere we did not see
    if (!dragging) {
      if (Math.abs(e.clientX - startX) < 6) return;
      dragging = true;
      tab.classList.add("dragging");
      bar.classList.add("reordering");
    }
    const siblings = [...bar.querySelectorAll(".file-tab")];
    const index = siblings.indexOf(tab);
    const before = siblings[index - 1];
    const after = siblings[index + 1];
    if (before && e.clientX < middle(before)) bar.insertBefore(tab, before);
    else if (after && e.clientX > middle(after)) bar.insertBefore(after, tab);
    const box = bar.getBoundingClientRect();
    if (e.clientX < box.left + 28) bar.scrollLeft -= 14;
    else if (e.clientX > box.right - 28) bar.scrollLeft += 14;
  };
  const finish = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    if (!dragging) return;
    tab.classList.remove("dragging");
    bar.classList.remove("reordering");
    suppressTabClick = true;
    setTimeout(() => { suppressTabClick = false; }, 0);
    prefs.openTabs = [...PINNED_TABS, ...[...bar.querySelectorAll(".file-tab")].map((item) => item.dataset.tab)];
    savePrefs();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", finish);
}

// Keyboard reordering (Ctrl+Shift+Left/Right on a focused tab).
function moveTab(path, delta) {
  const rest = prefs.openTabs.filter((key) => !PINNED_TABS.includes(key));
  const index = rest.indexOf(path);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= rest.length) return;
  rest.splice(target, 0, rest.splice(index, 1)[0]);
  prefs.openTabs = [...PINNED_TABS, ...rest];
  savePrefs();
  renderTabs();
  $$(".file-tab", $("#fileBar")).find((item) => item.dataset.tab === path)?.focus();
}

function renderTabs() {
  if (!state.doc) return;
  const shown = viewKey();
  // Overview and Files are pinned to the left, in that order; the rest keep the order the user gave them.
  const ordered = [...PINNED_TABS, ...prefs.openTabs.filter((key) => !PINNED_TABS.includes(key))];
  if (!ordered.includes(shown)) ordered.push(shown);
  if (ordered.length !== prefs.openTabs.length || ordered.some((key, i) => key !== prefs.openTabs[i])) {
    prefs.openTabs = ordered;
    savePrefs();
  }
  const bar = $("#fileTabs");
  const pinnedBar = $("#pinnedTabs");
  if (!bar.dataset.wheel) {
    bar.dataset.wheel = "1";
    // A mouse wheel scrolls the tabs sideways when they overflow.
    bar.addEventListener("wheel", (event) => {
      if (bar.scrollWidth <= bar.clientWidth || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      bar.scrollLeft += event.deltaY;
      event.preventDefault();
    }, { passive: false });
  }
  const names = prefs.openTabs.map((path) => keyLabel(path));
  const tabs = prefs.openTabs.map((path) => {
    const view = isViewKey(path);
    const file = view ? null : state.doc.files.find((f) => f.path === path);
    if (!view && !file) return null;
    const info = file ? fileInfo(file) : { changed: false, isNew: false };
    const active = path === shown;
    const pinned = PINNED_TABS.includes(path);
    const name = keyLabel(path);
    const dir = !view && path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const duplicate = names.filter((other) => other === name).length > 1;
    const tab = el("div", {
      class: "file-tab" + (active ? " active" : "") + (pinned ? " pinned" : ""), role: "tab", tabindex: active ? "0" : "-1", "aria-selected": String(active),
      "data-tab": path, title: path + (info.changed || info.isNew ? " (unsaved changes)" : ""),
    },
      view ? el("span", { class: "tab-icon", text: keyIcon(path) }) : null,
      el("span", { class: "tab-name" }, duplicate && dir ? el("span", { class: "tab-dir", text: dir.split("/").pop() + "/" }) : null, name),
      info.changed || info.isNew ? el("span", { class: "nav-dot", title: "Unsaved changes" }) : null,
      pinned ? null : el("button", { class: "tab-close", type: "button", tabindex: "-1", title: "Close tab (middle-click)", "aria-label": `Close ${path}`, text: "×",
        onclick: (event) => { event.stopPropagation(); closeTab(path).catch(report); } }),
    );
    if (!pinned) tab.addEventListener("pointerdown", (event) => beginTabDrag(event, tab, bar));
    tab.addEventListener("click", () => { if (!suppressTabClick) openKey(path).catch(report); });
    tab.addEventListener("mousedown", (event) => { if (event.button === 1) event.preventDefault(); });
    tab.addEventListener("auxclick", (event) => { if (event.button === 1 && !pinned) { event.preventDefault(); closeTab(path).catch(report); } });
    tab.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openKey(path).catch(report); }
      else if ((event.key === "Delete" || event.key === "Backspace") && !pinned) { event.preventDefault(); closeTab(path).catch(report); }
      else if ((event.key === "ArrowRight" || event.key === "ArrowLeft") && event.ctrlKey && event.shiftKey) {
        event.preventDefault();
        moveTab(path, event.key === "ArrowRight" ? 1 : -1);
      }
      else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        const all = $$(".file-tab", $("#fileBar"));
        const next = all[all.indexOf(tab) + (event.key === "ArrowRight" ? 1 : -1)];
        if (next) { event.preventDefault(); next.focus(); }
      }
    });
    return tab;
  }).filter(Boolean);
  const isPinned = (tab) => PINNED_TABS.includes(tab.dataset.tab);
  pinnedBar.replaceChildren(...tabs.filter(isPinned));
  bar.replaceChildren(...tabs.filter((tab) => !isPinned(tab)));
  const active = bar.querySelector(".file-tab.active");
  if (active) {
    const left = active.offsetLeft - bar.offsetLeft;
    if (left < bar.scrollLeft) bar.scrollLeft = left - 8;
    else if (left + active.offsetWidth > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = left + active.offsetWidth - bar.clientWidth + 8;
  }
}

// Closing a tab only hides it: the file stays in the document with its edits.
async function closeTab(path) {
  if (PINNED_TABS.includes(path)) return;
  const index = prefs.openTabs.indexOf(path);
  if (index < 0) return;
  const remaining = prefs.openTabs.filter((item) => item !== path);
  if (path === viewKey()) {
    // With nothing left open, land on the overview.
    const next = remaining[index] || remaining[index - 1] || "home";
    if (!(await openKey(next))) return;
  }
  prefs.openTabs = remaining.filter(keyExists);
  const shown = viewKey();
  if (!prefs.openTabs.includes(shown)) prefs.openTabs.push(shown);
  savePrefs();
  renderTabs();
}

function renderIncludedBy() {
  const box = $("#includedBy");
  if (!box || !state.doc) return;
  box.replaceChildren();
  const from = resolvedIncluders(state.file);
  if (!from.length) return;
  box.append(el("span", { class: "included-label", text: "Included by" }));
  const seen = new Set();
  for (const item of from) {
    if (seen.has(item.file)) continue;
    seen.add(item.file);
    box.append(el("button", {
      class: "chip", type: "button", title: `Open ${item.file} at the include`,
      onclick: () => openFile(item.file, { select: item.nodeId }).catch(report), text: "↰ " + item.file,
    }));
  }
}

// ---------------------------------------------------------------- file operations

function checkPath(path, ignore) {
  if (path.startsWith("/") || path.split("/").some((part) => part === "" || part === "..")) {
    throw new Error("Use a relative path such as conf.d/site.conf.");
  }
  if (!/^[A-Za-z0-9._@+\-/]+$/.test(path)) throw new Error("Use letters, numbers and . _ - @ + / in file names.");
  if (state.doc.files.some((file) => file.path === path && file.path !== ignore)) throw new Error(`${path} already exists.`);
}

function withExtension(path) {
  return path.split("/").pop().includes(".") ? path : path + ".conf";
}

function forgetDeletion(path) {
  state.deletedFiles = state.deletedFiles.filter((item) => item !== path);
  delete state.deletedDocs[path];
}

async function addFileFlow(folder = "") {
  if (!(await applyDraft())) return;
  const answer = await ask({
    title: "New file",
    message: "Path relative to the nginx config root. The file is only used when an include directive reaches it.",
    input: true,
    value: folder ? folder + "/" : "",
    placeholder: "conf.d/site.conf",
    ok: "Create",
  });
  if (!answer) return;
  const path = withExtension(answer);
  checkPath(path);
  const candidate = clone(state.doc);
  candidate.files.push({ path, nodes: [] });
  const valid = await api("/api/document", { document: candidate });
  forgetDeletion(path);
  mutate(() => { state.doc = valid; }, `Added ${path}`);
  await openFile(path);
  if (!includersOf(path).length) toast(`${path} is not included by any file yet. Add an include directive, or it will not be loaded.`);
}

async function cloneFile(file) {
  if (!(await applyDraft())) return;
  if (isMainFile(file)) {
    return toast(`${file.path} holds the main settings. Clone a file of server blocks, or clone one server inside it.`);
  }
  const answer = await ask({
    title: `Clone ${file.path}`,
    message: "The copy gets every block in this file. Change its server_name before applying, or nginx will see two servers for the same names.",
    input: true,
    value: copyName(file.path),
    ok: "Clone",
  });
  if (!answer) return;
  const name = withExtension(answer);
  checkPath(name);
  const candidate = clone(state.doc);
  candidate.files.push({ path: name, nodes: cloneNodes(file.nodes) });
  const valid = await api("/api/document", { document: candidate });
  forgetDeletion(name);
  mutate(() => { state.doc = valid; }, `Cloned ${file.path} to ${name}`);
  await openFile(name);
}

// Rewrites include directives that name `oldPath` outright. Returns how many were changed.
function retargetIncludes(doc, oldPath, newPath) {
  const prefix = (doc.prefix || "").replace(/\/+$/, "");
  let count = 0;
  for (const file of doc.files) {
    walkNodes(file.nodes, (node) => {
      if (node.kind !== "directive" || node.name !== "include" || !node.args[0]) return;
      const raw = node.args[0];
      const quote = /^["']/.test(raw) ? raw[0] : "";
      const bare = raw.replace(/^["']|["']$/g, "");
      if (bare === oldPath) node.args[0] = quote + newPath + quote;
      else if (prefix && bare === prefix + "/" + oldPath) node.args[0] = quote + prefix + "/" + newPath + quote;
      else return;
      count++;
    });
  }
  return count;
}

function moveFileMemory(oldPath, newPath) {
  if (oldPath in prefs.fileModes) {
    prefs.fileModes[newPath] = prefs.fileModes[oldPath];
    delete prefs.fileModes[oldPath];
  }
  prefs.recent = prefs.recent.map((item) => (item === oldPath ? newPath : item));
  prefs.openTabs = prefs.openTabs.map((item) => (item === oldPath ? newPath : item));
  if (prefs.lastFile === oldPath) prefs.lastFile = newPath;
  const swap = (list) => list.map((item) => (item === oldPath ? newPath : item));
  nav.back = swap(nav.back);
  nav.fwd = swap(nav.fwd);
  if (state.fileView[oldPath]) {
    state.fileView[newPath] = state.fileView[oldPath];
    delete state.fileView[oldPath];
  }
  savePrefs();
}

async function renameFile(file) {
  if (file.path === state.doc.entrypoint) return toast("The entry file cannot be renamed.");
  if (!(await applyDraft())) return;
  const answer = await ask({
    title: `Rename ${file.path}`,
    message: "Include directives that name this file exactly are updated. Wildcard includes are checked afterwards.",
    input: true,
    value: file.path,
    ok: "Rename",
  });
  if (!answer) return;
  const newPath = withExtension(answer);
  if (newPath === file.path) return;
  checkPath(newPath, file.path);
  const globs = includersOf(file.path).filter((item) => /[*?]/.test(item.node.args[0]));
  const candidate = clone(state.doc);
  candidate.files.find((f) => f.path === file.path).path = newPath;
  const updated = retargetIncludes(candidate, file.path, newPath);
  const valid = await api("/api/document", { document: candidate });
  const onDisk = state.diskFiles.has(file.path);
  const stash = clone(file);
  const wasActive = state.file === file.path;
  mutate(() => {
    state.doc = valid;
    if (wasActive) state.file = newPath;
    if (onDisk && !state.deletedFiles.includes(file.path)) {
      state.deletedFiles.push(file.path);
      state.deletedDocs[file.path] = { file: stash, renamedTo: newPath };
    }
    forgetDeletion(newPath);
  }, `Renamed to ${newPath}` + (updated ? ` · ${updated} include${updated === 1 ? "" : "s"} updated` : ""));
  moveFileMemory(file.path, newPath);
  const lost = globs.filter((item) => !globToRegExp(includePattern(item.node.args[0])).test(newPath));
  if (lost.length) {
    toast(`${newPath} is no longer matched by ${[...new Set(lost.map((item) => item.node.args[0]))].join(", ")} in ${[...new Set(lost.map((item) => item.file))].join(", ")}. Add an include for it.`);
  }
}

async function deleteFile(file) {
  if (file.path === state.doc.entrypoint) return toast("The entry file cannot be deleted.");
  if (!(await applyDraft())) return;
  const users = [...new Set(includersOf(file.path).filter((item) => !/[*?]/.test(item.node.args[0])).map((item) => item.file))];
  const answer = await ask({
    title: `Delete ${file.path}?`,
    message: (users.length ? `${users.join(", ")} include${users.length === 1 ? "s" : ""} it by name and will fail the checks. ` : "") +
      "The file is removed from disk when you apply. Until then you can restore it from the list.",
    ok: "Delete",
    danger: true,
  });
  if (answer !== true) return;
  const onDisk = state.diskFiles.has(file.path);
  const stash = clone(file);
  const wasActive = state.file === file.path;
  const fallback = nav.back.slice().reverse().find((path) => path !== file.path && state.doc.files.some((f) => f.path === path)) || state.doc.entrypoint;
  mutate(() => {
    state.doc.files = state.doc.files.filter((f) => f.path !== file.path);
    if (onDisk && !state.deletedFiles.includes(file.path)) {
      state.deletedFiles.push(file.path);
      state.deletedDocs[file.path] = { file: stash };
    }
    if (wasActive) {
      state.file = fallback;
      state.selected = null;
    }
  }, `Deleted ${file.path}${onDisk ? " · removed on apply" : ""}`);
  delete prefs.fileModes[file.path];
  prefs.recent = prefs.recent.filter((item) => item !== file.path);
  prefs.openTabs = prefs.openTabs.filter((item) => item !== file.path);
  nav.back = nav.back.filter((item) => item !== file.path);
  nav.fwd = nav.fwd.filter((item) => item !== file.path);
  savePrefs();
}

async function restoreDeleted(path) {
  const stash = state.deletedDocs[path];
  if (!stash || stash.renamedTo) return;
  if (state.doc.files.some((file) => file.path === path)) return toast(`${path} already exists.`);
  mutate(() => {
    state.doc.files.push(stash.file);
    forgetDeletion(path);
  }, `Restored ${path}`);
  await openFile(path);
}

// ---------------------------------------------------------------- quick switcher

function fuzzy(query, text) {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let last = -2;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      score += i === last + 1 ? 5 : 1;
      if (i === 0 || "/.-_ ".includes(t[i - 1])) score += 3;
      last = i;
      qi++;
    }
  }
  if (qi < q.length) return -1;
  if (t.includes(q)) score += 20;
  return score - t.length * 0.01;
}

function quickMatches(query) {
  const entries = [];
  for (const file of state.doc.files) {
    const domains = fileDomains(file);
    let best = fuzzy(query, file.path);
    let via = "";
    for (const domain of domains) {
      const score = fuzzy(query, domain);
      if (score > best) {
        best = score;
        via = domain;
      }
    }
    if (best >= 0) entries.push({ file, domains, score: best, via });
  }
  const views = [{ key: "home", label: "Overview", hint: "what is running, sites, domains, certificates" }, { key: "files", label: "Files", hint: "browse files, logs and certificates" }];
  for (const log of typeof knownLogs === "function" ? knownLogs() : []) views.push({ key: "log:" + log.id, label: "Log · " + log.id, hint: `${log.group} log` });
  for (const view of views) {
    const score = fuzzy(query, view.label);
    if (score >= 0) entries.push({ file: { path: view.label }, key: view.key, domains: [view.hint], score: score - 0.5, via: "" });
  }
  if (!query) {
    const rank = (path) => {
      const i = prefs.recent.indexOf(path);
      return i < 0 ? 99 : i;
    };
    entries.sort((a, b) => (a.key ? -1 : 0) - (b.key ? -1 : 0) || rank(a.file.path) - rank(b.file.path) || a.file.path.localeCompare(b.file.path));
  } else {
    entries.sort((a, b) => b.score - a.score);
  }
  return entries.slice(0, 14);
}

function renderQuick() {
  const list = $("#quickList");
  nav.quickItems = quickMatches($("#quickInput").value.trim());
  nav.quickIndex = Math.min(nav.quickIndex, Math.max(0, nav.quickItems.length - 1));
  list.replaceChildren();
  if (!nav.quickItems.length) list.append(el("li", { class: "quick-empty", text: "No file or domain matches." }));
  nav.quickItems.forEach((item, index) => {
    const li = el("li", {
      class: "quick-item" + (index === nav.quickIndex ? " active" : ""), role: "option", "aria-selected": String(index === nav.quickIndex),
      onclick: () => chooseQuick(index),
    },
      el("span", { class: "quick-path", text: item.file.path }),
      (item.key || item.file.path) === viewKey() ? el("span", { class: "quick-here", text: "open" }) : null,
      el("span", { class: "quick-domains", text: item.via ? `matches ${item.via}` : item.domains.slice(0, 3).join(" · ") }),
    );
    list.append(li);
  });
  list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
}

function chooseQuick(index) {
  const item = nav.quickItems[index];
  if (!item) return;
  $("#dlgQuick").close();
  openKey(item.key || item.file.path).catch(report);
}

function openQuick() {
  if (!state.doc || $("#dlgAsk").open) return;
  $("#quickInput").value = "";
  nav.quickIndex = 0;
  renderQuick();
  if (!$("#dlgQuick").open) $("#dlgQuick").showModal();
  $("#quickInput").focus();
}

// ---------------------------------------------------------------- preferences dialog

function openPrefs() {
  $("#prefMode").value = prefs.defaultMode;
  $("#prefRemember").checked = prefs.rememberPerFile;
  $("#prefTheme").value = prefs.theme;
  $("#prefCompact").checked = prefs.compact;
  $("#prefExpanded").checked = prefs.foldersExpanded;
  $("#dlgPrefs").showModal();
}

function readPrefsForm() {
  prefs.defaultMode = $("#prefMode").value;
  prefs.rememberPerFile = $("#prefRemember").checked;
  prefs.theme = $("#prefTheme").value;
  prefs.compact = $("#prefCompact").checked;
  const expanded = $("#prefExpanded").checked;
  if (expanded !== prefs.foldersExpanded) prefs.collapsed = {};
  prefs.foldersExpanded = expanded;
  savePrefs();
  applyPrefsToPage();
}

// ---------------------------------------------------------------- wiring

function bindFiles() {
  $("#fileFilter").addEventListener("input", () => {
    nav.filter = $("#fileFilter").value;
    renderFileList();
  });
  $("#fileFilter").addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      (nav.rows.find((row) => row.classList.contains("file")) || nav.rows[0])?.focus();
    } else if (event.key === "Enter") {
      const first = nav.rows.find((row) => row.classList.contains("file"));
      if (first) openFile(first.dataset.path).catch(report);
    } else if (event.key === "Escape" && $("#fileFilter").value) {
      event.preventDefault();
      $("#fileFilter").value = "";
      nav.filter = "";
      renderFileList();
    }
  });
  $("#fileList").addEventListener("keydown", onNavKey);
  $("#addFileBtn").addEventListener("click", () => addFileFlow().catch(report));
  $("#btnQuick").addEventListener("click", openQuick);
  $("#tbBack").addEventListener("click", () => navGo(-1).catch(report));
  $("#tbFwd").addEventListener("click", () => navGo(1).catch(report));
  $("#tbHome").addEventListener("click", () => goHome().catch(report));
  $("#tbSwitch").addEventListener("click", openQuick);
  $("#tbNew").addEventListener("click", () => addFileFlow().catch(report));
  const brand = $(".brand");
  brand.setAttribute("role", "link");
  brand.setAttribute("tabindex", "0");
  brand.setAttribute("title", "Overview: what is running, sites, domains and certificates");
  brand.addEventListener("click", () => openHome().catch(report));
  brand.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openHome().catch(report);
    }
  });
  $("#navBack").addEventListener("click", () => navGo(-1).catch(report));
  $("#navFwd").addEventListener("click", () => navGo(1).catch(report));

  $("#quickInput").addEventListener("input", () => {
    nav.quickIndex = 0;
    renderQuick();
  });
  $("#quickInput").addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") nav.quickIndex = Math.min(nav.quickItems.length - 1, nav.quickIndex + 1);
    else if (event.key === "ArrowUp") nav.quickIndex = Math.max(0, nav.quickIndex - 1);
    else if (event.key === "Enter") {
      event.preventDefault();
      chooseQuick(nav.quickIndex);
      return;
    } else return;
    event.preventDefault();
    renderQuick();
  });
  $("#dlgQuick").addEventListener("click", (event) => {
    if (event.target === $("#dlgQuick")) $("#dlgQuick").close();
  });

  $("#btnPrefs").addEventListener("click", openPrefs);
  for (const id of ["prefMode", "prefRemember", "prefTheme", "prefCompact", "prefExpanded"]) $("#" + id).addEventListener("change", readPrefsForm);
  $("#btnForgetViews").addEventListener("click", () => {
    prefs.fileModes = {};
    prefs.recent = [];
    prefs.lastFile = "";
    prefs.collapsed = {};
    savePrefs();
    renderFileList();
    toast("Remembered views and recent files cleared.");
  });

  const split = $("#fileSplit");
  split.addEventListener("pointerdown", (event) => {
    const list = $("#fileList");
    const startY = event.clientY;
    const startHeight = list.getBoundingClientRect().height;
    const limit = $(".left-panel").clientHeight - 240;
    split.setPointerCapture(event.pointerId);
    split.classList.add("dragging");
    const move = (e) => {
      prefs.filesHeight = Math.round(Math.max(96, Math.min(limit, startHeight + e.clientY - startY)));
      list.style.height = prefs.filesHeight + "px";
    };
    const up = () => {
      split.classList.remove("dragging");
      split.removeEventListener("pointermove", move);
      split.removeEventListener("pointerup", up);
      savePrefs();
    };
    split.addEventListener("pointermove", move);
    split.addEventListener("pointerup", up);
  });

  document.addEventListener("keydown", (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "p") {
      event.preventDefault();
      openQuick();
    } else if (event.altKey && !mod && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      navGo(event.key === "ArrowLeft" ? -1 : 1).catch(report);
    }
  });

  // Keep the list and header current when the checks and include links refresh.
  const baseShowCheck = showCheckSummary;
  showCheckSummary = function (...args) {
    const out = baseShowCheck.apply(this, args);
    renderFileList();
    renderFileHeader();
    return out;
  };
  const baseRefreshIncludes = refreshIncludeInfo;
  refreshIncludeInfo = function (...args) {
    const out = baseRefreshIncludes.apply(this, args);
    renderIncludedBy();
    return out;
  };
  applyPrefsToPage();
}

bindFiles();
