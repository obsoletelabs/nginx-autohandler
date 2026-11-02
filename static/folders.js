"use strict";

// Folders: the folder picker shared by New file and Import, the New file dialog, dropping files from the
// desktop onto the window, and the Enable/Disable button in the document bar.

const DEFAULT_FOLDER = "conf.d";
const KNOWN_FOLDERS = ["conf.d", "sites-enabled", "sites-available", "snippets", "conf-enabled", "conf-available", "modules-enabled", "streams-enabled", "http.d", "stream.d"];
const SUBFOLDER_HINT = "nginx's default include conf.d/*.conf does not look inside sub-folders. Add include /etc/nginx/conf.d/*/*.conf; to nginx.conf, or files in this folder are never read.";

// Every folder that holds a file in the document, plus the folders above them.
function documentFolders() {
  const folders = new Set();
  for (const file of state.doc ? state.doc.files : []) {
    const parts = file.path.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }
  return [...folders].sort((a, b) => a.localeCompare(b));
}

function cleanFolder(text) {
  return String(text || "").trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

// "" means the config root. Returns an error message, or "" when the folder name is fine.
function folderProblem(folder) {
  if (!folder) return "";
  for (const part of folder.split("/")) {
    if (part === "." || part === "..") return "A folder name cannot contain . or ..";
    if (!/^[A-Za-z0-9._@+-]+$/.test(part)) return "Use letters, numbers and . _ - @ + in folder names.";
  }
  return "";
}

// A folder dropdown: the folders already in the document, the config root, and a typed new folder.
function folderPicker({ value, onChange }) {
  const NEW = "__new__";
  const select = el("select", { "aria-label": "Folder" });
  const typed = el("input", { class: "folder-new", placeholder: "conf.d/team", autocomplete: "off", spellcheck: "false", "aria-label": "New folder", hidden: "" });
  const hint = el("p", { class: "field-hint folder-hint", hidden: "" });
  const problem = el("p", { class: "field-hint folder-problem", hidden: "" });
  let current = cleanFolder(value);

  const fill = () => {
    const known = documentFolders();
    const list = [...new Set([DEFAULT_FOLDER, ...known])];
    if (current && !list.includes(current)) list.push(current);
    select.replaceChildren(
      ...list.map((folder) => el("option", { value: folder, text: folder + "/" })),
      el("option", { value: "", text: "(config root)" }),
      el("option", { value: NEW, text: "New folder…" }),
    );
    select.value = list.includes(current) || current === "" ? current : DEFAULT_FOLDER;
  };

  const refresh = () => {
    const text = current;
    const bad = folderProblem(text);
    problem.hidden = !bad;
    problem.textContent = bad;
    const nested = /^conf\.d\/./.test(text);
    hint.hidden = !nested;
    hint.textContent = nested ? SUBFOLDER_HINT : "";
  };

  select.addEventListener("change", () => {
    if (select.value === NEW) {
      typed.hidden = false;
      typed.value = current && !documentFolders().includes(current) ? current : (current ? current + "/" : "");
      typed.focus();
      current = cleanFolder(typed.value);
    } else {
      typed.hidden = true;
      current = select.value;
    }
    refresh();
    if (onChange) onChange(current);
  });
  typed.addEventListener("input", () => {
    current = cleanFolder(typed.value);
    refresh();
    if (onChange) onChange(current);
  });

  fill();
  refresh();
  const node = el("div", { class: "folder-picker" }, select, typed, hint, problem);
  return {
    node,
    get: () => current,
    problem: () => folderProblem(current),
    set(next) {
      current = cleanFolder(next);
      typed.hidden = true;
      fill();
      refresh();
    },
  };
}

// ---------------------------------------------------------------- New file

// Builds the file name from what was typed: .conf when there is no extension, and the .disabled
// suffix when the file starts switched off (the convention /api/config/toggle uses).
function newFilePath(folder, typedName, enabled) {
  let name = typedName.trim().replace(/^\/+/, "");
  if (!name) return "";
  name = withExtension(name);
  if (enabled && name.endsWith(".conf.disabled")) name = name.slice(0, -".disabled".length);
  if (!enabled && name.endsWith(".conf")) name += ".disabled";
  return (folder ? folder + "/" : "") + name;
}

function newFileDialog(folder) {
  return new Promise((resolve) => {
    const dialog = $("#dlgNewFile");
    const picker = folderPicker({ value: folder, onChange: () => update() });
    const name = el("input", { id: "newFileName", placeholder: "site.conf", autocomplete: "off", spellcheck: "false", "aria-label": "File name" });
    const enabled = el("input", { type: "checkbox", checked: true, id: "newFileEnabled" });
    const preview = el("p", { class: "field-hint new-file-preview" });
    const error = el("p", { class: "status-panel bad", hidden: "" });
    const create = $("#btnNewFileGo");
    let settled = false;

    const typedName = () => name.value.trim();
    const canSwitch = () => withExtension(typedName() || "x").replace(/\.disabled$/, "").endsWith(".conf");
    function update() {
      enabled.disabled = !canSwitch();
      const path = newFilePath(picker.get(), typedName(), enabled.checked || !canSwitch());
      const bad = picker.problem();
      preview.textContent = path ? `Creates ${path}` + (path.endsWith(".disabled") ? " · nginx ignores it until you enable it" : "") : "Type a file name.";
      create.disabled = !path || !!bad;
      error.hidden = true;
    }
    name.addEventListener("input", update);
    enabled.addEventListener("change", update);

    const finish = (value) => {
      if (settled) return;
      settled = true;
      dialog.removeEventListener("close", onClose);
      create.onclick = null;
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onClose = () => finish(null);
    dialog.addEventListener("close", onClose);

    const submit = () => {
      const path = newFilePath(picker.get(), typedName(), enabled.checked || !canSwitch());
      try {
        if (!path) throw new Error("Type a file name.");
        const bad = picker.problem();
        if (bad) throw new Error(bad);
        checkPath(path);
      } catch (problem) {
        error.textContent = problem.message;
        error.hidden = false;
        return;
      }
      finish({ path, enabled: !path.endsWith(".disabled") });
    };
    create.onclick = submit;
    name.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); submit(); } });

    $("#newFileBody").replaceChildren(
      el("p", { class: "dialog-intro", text: "The new file starts empty. nginx only reads it when an include directive reaches it." }),
      el("label", { class: "field" }, el("span", { text: "Folder" }), picker.node),
      el("label", { class: "field" }, el("span", { text: "File name" }), name),
      el("label", { class: "check" }, enabled, el("span", { text: "Enabled (off creates it as name.conf.disabled, which nginx ignores)" })),
      preview,
      error,
    );
    update();
    dialog.showModal();
    requestAnimationFrame(() => name.focus());
  });
}

async function addFileFlow(folder = "") {
  if (!(await applyDraft())) return;
  const choice = await newFileDialog(folder || DEFAULT_FOLDER);
  if (!choice) return;
  const { path } = choice;
  const candidate = clone(state.doc);
  candidate.files.push({ path, nodes: [] });
  const valid = await api("/api/document", { document: candidate });
  forgetDeletion(path);
  mutate(() => { state.doc = valid; }, `Added ${path}`);
  await openFile(path);
  if (path.endsWith(".disabled")) toast(`${path} is switched off: nginx ignores it until you enable it.`);
  else if (!includersOf(path).length) toast(`${path} is not included by any file yet. Add an include directive, or it will not be loaded.`);
}

// ---------------------------------------------------------------- Dropping files on the window

const DROP = { depth: 0 };

function dropHasFiles(event) {
  return !!event.dataTransfer && [...(event.dataTransfer.types || [])].includes("Files");
}

function readEntries(reader) {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function entryFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

// Walks a dropped file or folder. Hidden entries and node_modules are never opened, so dropping a
// repository does not read .git.
async function collectEntry(entry, prefix, out, budget) {
  if (budget.left <= 0) return;
  if (entry.isFile) {
    budget.left--;
    const file = await entryFile(entry);
    out.push({ file, rel: prefix + entry.name });
    return;
  }
  if (!entry.isDirectory || entry.name.startsWith(".") || entry.name === "node_modules") return;
  const reader = entry.createReader();
  for (;;) {
    const batch = await readEntries(reader);
    if (!batch.length) break;
    for (const child of batch) await collectEntry(child, prefix + entry.name + "/", out, budget);
  }
}

// Tags a File with the folder-relative path the import code reads, as a folder picker would.
function withRelativePath(file, rel) {
  try {
    Object.defineProperty(file, "webkitRelativePath", { value: rel, configurable: true });
  } catch (error) {
    // The import falls back to the plain file name.
  }
  return file;
}

async function filesFromDrop(transfer) {
  const items = [...(transfer.items || [])].filter((item) => item.kind === "file");
  // The entries must be read in the event itself: the list is emptied after the handler returns.
  const entries = items.map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null));
  const plain = [...(transfer.files || [])];
  if (!entries.length || entries.some((entry) => !entry)) return { kind: plain.length === 1 && /\.zip$/i.test(plain[0].name) ? "zip" : "files", list: plain };
  return { entries };
}

async function readDropped(entries) {
  const out = [];
  const budget = { left: IMPORT_LIMITS.files + 500 };
  for (const entry of entries) await collectEntry(entry, "", out, budget);
  const tops = new Set(out.map((item) => item.rel.split("/")[0]));
  const onlyFolder = entries.length === 1 && entries[0].isDirectory;
  if (!onlyFolder && out.length === 1 && /\.zip$/i.test(out[0].file.name)) return { kind: "zip", list: [out[0].file] };
  const list = out.map((item) => withRelativePath(item.file, item.rel));
  return { kind: onlyFolder && tops.size === 1 ? "folder" : "files", list };
}

async function handleDrop(transfer, dest) {
  if (!state.doc) return;
  const first = await filesFromDrop(transfer);
  const picked = first.entries ? await readDropped(first.entries) : first;
  if (!picked.list.length) return toast("Nothing to import in what was dropped.");
  await openImportDialog();
  await chooseImport(picked.kind, picked.list, dest);
}

function bindDrop() {
  const overlay = $("#dropOverlay");
  const hide = () => { DROP.depth = 0; overlay.hidden = true; };
  // The folder under the pointer when files are dropped on the tree (a file row means its folder), or undefined.
  const folderAt = (event) => {
    const row = event.target && event.target.closest ? event.target.closest("#fileList .nav-row") : null;
    if (!row) return undefined;
    return row.dataset.folder !== undefined ? row.dataset.folder : row.dataset.parent || "";
  };
  const mark = (event) => {
    const folder = folderAt(event);
    for (const item of $$("#fileList .nav-row.drop-target")) item.classList.remove("drop-target");
    if (folder !== undefined) {
      const target = $$("#fileList .nav-row").find((item) => item.dataset.folder === folder);
      if (target) target.classList.add("drop-target");
    }
    const hint = $("#dropOverlay span");
    if (hint) hint.textContent = folder === undefined ? "Files, a folder or a .zip. You see a summary before anything is added." : `They will be added to ${folder ? folder + "/" : "the config folder"}. You see a summary first.`;
  };
  window.addEventListener("dragenter", (event) => {
    if (!dropHasFiles(event)) return;
    event.preventDefault();
    DROP.depth++;
    overlay.hidden = false;
    mark(event);
  });
  window.addEventListener("dragover", (event) => {
    if (!dropHasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    mark(event);
  });
  window.addEventListener("dragleave", (event) => {
    if (!dropHasFiles(event)) return;
    DROP.depth = Math.max(0, DROP.depth - 1);
    if (!DROP.depth) overlay.hidden = true;
  });
  window.addEventListener("drop", (event) => {
    if (!dropHasFiles(event)) return;
    event.preventDefault();
    const dest = folderAt(event);
    hide();
    for (const item of $$("#fileList .nav-row.drop-target")) item.classList.remove("drop-target");
    handleDrop(event.dataTransfer, dest).catch(report);
  });
  window.addEventListener("blur", hide);
}

// ---------------------------------------------------------------- Enable / Disable the open file

// Shows or hides the Enabled switch and the notice for the file that is open. Only a .conf file that
// is on disk (not nginx.conf) can be switched; everything else (logs, Overview, other files) hides it.
function renderToggle() {
  const button = $("#toggleBtn");
  const note = $("#disabledNote");
  if (!button || !note || !state.doc) return;
  const path = state.view ? "" : state.file;
  const off = !!path && isDisabledPath(path);
  const switchable = !!path && (off || (isConfPath(path) && path !== state.doc.entrypoint));
  const onDisk = !!path && state.diskFiles && state.diskFiles.has(path);
  button.hidden = !switchable || !onDisk;
  button.classList.toggle("on", !off);
  button.setAttribute("aria-checked", String(!off));
  $("#toggleLabel").textContent = off ? "Disabled" : "Enabled";
  button.title = off ? "Turn it on: renamed back to .conf so nginx uses it again (tested first, rolled back if nginx refuses)" : "Turn it off: renamed to .conf.disabled so nginx ignores it (tested first, rolled back if nginx refuses)";
  note.hidden = !off;
}

function bindToggle() {
  $("#toggleBtn").addEventListener("click", () => toggleConfig(state.file, isDisabledPath(state.file)).catch(report));
  $("#disabledEnable").addEventListener("click", () => toggleConfig(state.file, true).catch(report));
}

bindDrop();
bindToggle();
