"use strict";

// Import: bring a folder, several files or a .zip into the workspace as a draft. A summary comes first
// (what will be added, what was skipped and why, what already exists); nothing reaches disk until Save.

const IMPORT_LIMITS = { files: 2000, totalBytes: 10 * 1024 * 1024, fileBytes: 2 * 1024 * 1024, zipBytes: 30 * 1024 * 1024 };
const SKIP_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "svg", "pdf", "zip", "gz", "tgz", "bz2", "xz", "7z", "tar", "so", "bin", "exe", "dll", "woff", "woff2", "ttf", "mp3", "mp4",
  "md", "markdown", "json", "yml", "yaml", "sh", "py", "js", "css", "html", "htm", "log", "lock", "pem", "key", "crt", "csr",
]);
// `base` holds the files under their paths inside the import; `files` is the same set under the folder the
// user picked ("Put the files in"), which is what is checked against the document and written.
const IMP = { base: {}, files: {}, dest: "", picker: null, skipped: [], source: "", stripped: "", mode: "merge", overwrite: false, busy: false, error: "" };

function importReset() {
  Object.assign(IMP, { base: {}, files: {}, dest: "", picker: null, skipped: [], source: "", stripped: "", mode: "merge", overwrite: false, busy: false, error: "" });
}

// Where the files go unless the user says otherwise: the import's own nginx.conf or folder layout means
// the config root; a dropped conf.d-like folder keeps its name; loose files and plain zips go to conf.d.
function defaultImportDest(files, stripped) {
  const paths = Object.keys(files);
  if (paths.includes("nginx.conf")) return "";
  if (paths.some((path) => path.includes("/") && KNOWN_FOLDERS.includes(path.split("/")[0]))) return "";
  if (stripped && KNOWN_FOLDERS.includes(stripped)) return stripped;
  return DEFAULT_FOLDER;
}

function applyImportDest() {
  const out = {};
  for (const [path, text] of Object.entries(IMP.base)) out[IMP.dest ? IMP.dest + "/" + path : path] = text;
  IMP.files = out;
}

function openImportDialog() {
  if (!state.doc) return Promise.resolve();
  importReset();
  paintImport();
  if (!$("#dlgImport").open) $("#dlgImport").showModal();
  return Promise.resolve();
}

// Why a file would not be imported, or "" when it is fine. `path` has no wrapping folder any more.
function importSkipReason(path, size) {
  const parts = path.split("/");
  if (!parts.length || path.startsWith("/") || parts.some((part) => part === ".." || part === "")) return "unsafe path";
  if (parts.some((part) => part.startsWith("."))) return "hidden file";
  const extension = parts[parts.length - 1].includes(".") ? parts[parts.length - 1].split(".").pop().toLowerCase() : "";
  if (SKIP_EXTENSIONS.has(extension)) return "not an nginx config file";
  if (size > IMPORT_LIMITS.fileBytes) return "file is too large";
  if (!/^[A-Za-z0-9._@+\-/]+$/.test(path)) return "name has unsupported characters";
  return "";
}

function looksBinary(text) {
  const head = text.slice(0, 8000);
  return head.includes("\u0000") || head.includes("�");
}

async function importFromFiles(list, { folder }) {
  const files = {};
  const skipped = [];
  let stripped = "";
  const entries = [...list];
  if (entries.length > IMPORT_LIMITS.files) throw new Error(`Import up to ${IMPORT_LIMITS.files} files at a time.`);
  let total = 0;
  for (const file of entries) {
    let path = file.name;
    if (file.webkitRelativePath && (folder || file.webkitRelativePath.includes("/"))) {
      const parts = file.webkitRelativePath.split("/");
      if (folder) {
        stripped = parts[0];
        path = parts.slice(1).join("/") || file.name;
      } else {
        path = file.webkitRelativePath;
      }
      // The shown name keeps the hidden-folder check honest: .git/config is skipped by its full path.
      if (parts.some((part) => part.startsWith("."))) {
        skipped.push({ path: file.webkitRelativePath, reason: "hidden file" });
        continue;
      }
    }
    const reason = importSkipReason(path, file.size);
    if (reason) {
      skipped.push({ path, reason });
      continue;
    }
    if (Object.hasOwn(files, path)) {
      skipped.push({ path, reason: "duplicate name" });
      continue;
    }
    const text = await file.text();
    if (looksBinary(text)) {
      skipped.push({ path, reason: "not a text file" });
      continue;
    }
    total += text.length;
    if (total > IMPORT_LIMITS.totalBytes) throw new Error("That is more than 10 MB of text. Import a smaller set.");
    files[path] = text;
  }
  return { files, skipped, stripped };
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] || "");
    reader.readAsDataURL(file);
  });
}

async function importFromZip(file) {
  if (file.size > IMPORT_LIMITS.zipBytes) throw new Error(`That zip is ${fmtBytes(file.size)}. The limit is 30 MB.`);
  const data = await readAsBase64(file);
  const result = await call("POST", "/api/import/zip", { data });
  const files = {};
  const skipped = [...(result.skipped || [])];
  for (const [path, text] of Object.entries(result.files || {})) {
    const reason = importSkipReason(path, text.length);
    if (reason) skipped.push({ path, reason });
    else files[path] = text;
  }
  return { files, skipped, stripped: result.stripped_folder || "" };
}

// `forcedDest` is the folder the files were dropped on ("" is the config root); without it the best guess is used.
async function chooseImport(kind, list, forcedDest) {
  if (!list || !list.length) return;
  IMP.error = "";
  IMP.busy = true;
  paintImport();
  try {
    const picked = kind === "zip" ? await importFromZip(list[0]) : await importFromFiles(list, { folder: kind === "folder" });
    IMP.base = picked.files;
    IMP.skipped = picked.skipped;
    IMP.stripped = picked.stripped;
    IMP.dest = typeof forcedDest === "string" ? forcedDest : defaultImportDest(picked.files, picked.stripped);
    IMP.picker = folderPicker({ value: IMP.dest, onChange: (folder) => { IMP.dest = folder; applyImportDest(); paintImportSummary(); } });
    applyImportDest();
    IMP.source = kind === "zip" ? list[0].name : kind === "folder" ? (picked.stripped || "folder") + "/" : `${list.length} file${list.length === 1 ? "" : "s"}`;
    if (!Object.keys(IMP.base).length) IMP.error = "Nothing in there looks like an nginx config. Skipped files are listed below.";
  } catch (error) {
    IMP.error = describeError(error).summary;
    IMP.base = {};
    IMP.files = {};
    IMP.picker = null;
  } finally {
    IMP.busy = false;
  }
  paintImport();
}

function pickerButton(title, hint, kind, attrs) {
  const input = el("input", { type: "file", hidden: "" });
  for (const [key, value] of Object.entries(attrs)) input.setAttribute(key, value);
  input.addEventListener("change", () => { chooseImport(kind, input.files).catch(report); input.value = ""; });
  return el("button", { type: "button", class: "import-source", onclick: () => input.click() }, el("strong", { text: title }), el("span", { text: hint }), input);
}

function importConflicts() {
  return Object.keys(IMP.files).filter((path) => state.doc.files.some((file) => file.path === path));
}

function paintImport() {
  const body = $("#importBody");
  const parts = [];
  parts.push(el("div", { class: "import-sources" },
    pickerButton("Folder", "Keeps sub-folders. Hidden files like .git are skipped.", "folder", { webkitdirectory: "", directory: "", multiple: "" }),
    pickerButton("Files", "Pick one or more .conf files.", "files", { multiple: "" }),
    pickerButton("Zip archive", "A .zip of your nginx folder (up to 30 MB).", "zip", { accept: ".zip,application/zip" })));
  parts.push(el("p", { class: "field-hint", text: "You can also drop files, a folder or a .zip anywhere on the window." }));
  if (IMP.busy) parts.push(el("div", { class: "status-panel" }, el("span", { class: "spinner" }), "Reading…"));
  if (IMP.error) parts.push(el("div", { class: "status-panel bad" }, el("div", { class: "status-title", text: "Could not import" }), el("div", { class: "status-sub", text: IMP.error })));
  if (IMP.picker && Object.keys(IMP.base).length) {
    parts.push(el("div", { class: "field import-dest" }, el("span", { text: "Put the files in:" }), IMP.picker.node));
  }
  parts.push(el("div", { id: "importSummary", class: "import-summary" }));
  if (IMP.skipped.length) {
    parts.push(el("details", { class: "import-skipped", open: !Object.keys(IMP.base).length },
      el("summary", { text: `${IMP.skipped.length} skipped` }),
      el("ul", { class: "result-list" }, ...IMP.skipped.map((item) => el("li", {}, el("span", { class: "mono", title: item.path, text: item.path }), badge2("test", item.reason))))));
  }
  body.replaceChildren(...parts);
  paintImportSummary();
}

function paintImportSummary() {
  const box = $("#importSummary");
  const go = $("#btnImportGo");
  const status = $("#importStatus");
  if (!box) return;
  const paths = Object.keys(IMP.files);
  const conflicts = importConflicts();
  const bad = IMP.picker ? IMP.picker.problem() : "";
  const parts = [];
  if (paths.length) {
    const replacing = IMP.mode === "replace";
    parts.push(el("div", { class: "status-panel ok" },
      el("div", { class: "status-title", text: `${paths.length} file${paths.length === 1 ? "" : "s"} from ${IMP.source}` }),
      el("div", { class: "status-sub", text: `${paths.length - conflicts.length} new${conflicts.length ? ` · ${conflicts.length} already exist` : ""}${IMP.stripped && IMP.source !== IMP.stripped + "/" ? ` · folder “${IMP.stripped}” removed from the paths` : ""}` })));
    parts.push(el("div", { class: "import-mode" },
      el("label", { class: "check" }, el("input", { type: "radio", name: "importMode", checked: !replacing, onchange: () => { IMP.mode = "merge"; paintImportSummary(); } }), el("span", { text: "Add to the current files" })),
      el("label", { class: "check" }, el("input", { type: "radio", name: "importMode", checked: replacing, onchange: () => { IMP.mode = "replace"; paintImportSummary(); } }), el("span", { text: "Replace the current files (nginx.conf is kept unless the import has its own)" }))));
    if (conflicts.length && !replacing) {
      parts.push(el("label", { class: "check" }, el("input", { type: "checkbox", checked: IMP.overwrite, onchange: (event) => { IMP.overwrite = event.target.checked; paintImportSummary(); } }),
        el("span", { text: `Overwrite the ${conflicts.length} file${conflicts.length === 1 ? "" : "s"} that already exist${conflicts.length === 1 ? "s" : ""} (otherwise they are left as they are)` })));
    }
    if (replacing) {
      const removed = state.doc.files.filter((file) => !(file.path in IMP.files) && file.path !== state.doc.entrypoint).length;
      parts.push(el("p", { class: "notice", text: `${removed} current file${removed === 1 ? "" : "s"} not in the import will be removed when you save.` }));
    }
    parts.push(el("ul", { class: "result-list import-list" }, ...paths.sort().map((path) => {
      const exists = conflicts.includes(path);
      return el("li", {}, el("span", { class: "mono", title: path, text: path }),
        exists ? badge2(replacing || IMP.overwrite ? "warn" : "test", replacing || IMP.overwrite ? "OVERWRITES" : "EXISTS · KEPT") : badge2("good", "NEW"));
    })));
  }
  box.replaceChildren(...parts);
  go.disabled = IMP.busy || !paths.length || !!bad;
  go.textContent = paths.length ? `Add ${paths.length} file${paths.length === 1 ? "" : "s"} to draft` : "Add to draft";
  status.textContent = "";
}

async function parseImported(path, text) {
  const data = await api("/api/parse", { text, path });
  return data.nodes;
}

async function runImport() {
  if (IMP.busy) return;
  const replacing = IMP.mode === "replace";
  const paths = Object.keys(IMP.files).filter((path) => replacing || IMP.overwrite || !state.doc.files.some((file) => file.path === path));
  if (!paths.length) return toast("Every file already exists. Tick Overwrite to replace them.");
  if (!(await applyDraft())) return;
  IMP.busy = true;
  $("#btnImportGo").disabled = true;
  $("#importStatus").textContent = "Parsing…";
  try {
    const parsed = new Map();
    const failed = [];
    for (let i = 0; i < paths.length; i += 6) {
      await Promise.all(paths.slice(i, i + 6).map(async (path) => {
        try {
          parsed.set(path, await parseImported(path, IMP.files[path]));
        } catch (error) {
          failed.push({ path, reason: "could not be parsed: " + describeError(error).summary });
        }
      }));
    }
    if (!parsed.size) throw new Error("None of the files could be parsed as nginx configuration.");
    const candidate = clone(state.doc);
    let added = 0;
    let replaced = 0;
    for (const [path, nodes] of parsed) {
      const existing = candidate.files.find((file) => file.path === path);
      if (existing) {
        existing.nodes = nodes;
        replaced++;
      } else {
        candidate.files.push({ path, nodes });
        added++;
      }
    }
    const removed = [];
    if (replacing) {
      for (const file of [...candidate.files]) {
        if (!parsed.has(file.path) && file.path !== candidate.entrypoint) removed.push(file.path);
      }
      candidate.files = candidate.files.filter((file) => !removed.includes(file.path));
    }
    const valid = await api("/api/document", { document: candidate });
    const stashes = new Map(removed.map((path) => [path, clone(state.doc.files.find((file) => file.path === path))]));
    mutate(() => {
      state.doc = valid;
      for (const path of removed) {
        if (state.diskFiles.has(path) && !state.deletedFiles.includes(path)) {
          state.deletedFiles.push(path);
          state.deletedDocs[path] = { file: stashes.get(path) };
        }
      }
      for (const path of parsed.keys()) forgetDeletion(path);
    }, `Imported ${parsed.size} file${parsed.size === 1 ? "" : "s"} into the draft`);
    $("#dlgImport").close();
    const first = [...parsed.keys()].sort()[0];
    await openFile(first).catch(() => {});
    const bits = [`${added} added`];
    if (replaced) bits.push(`${replaced} overwritten`);
    if (removed.length) bits.push(`${removed.length} marked for removal`);
    if (failed.length) bits.push(`${failed.length} could not be parsed`);
    toast(`Import is a draft: ${bits.join(", ")}. Press Save to write it.`);
    if (failed.length) showProblem("Some files were not imported", "IMPORT", `${failed.length} file${failed.length === 1 ? "" : "s"} could not be read as nginx configuration.`, failed.map((item) => `${item.path}: ${item.reason}`).join("\n"));
  } finally {
    IMP.busy = false;
    $("#importStatus").textContent = "";
  }
}

$("#btnImportGo").addEventListener("click", () => runImport().catch(report));
