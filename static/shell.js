"use strict";

// The shell around the Workshop editor: save (write, test, reload), history, settings, certificates,
// DNS, and the nginx test and reload buttons. Uses the editor's own toast, api and document
// functions from app.js. Everything here is in-app; no browser dialogs.

const SHELL = {
  askResult: null,
  askDone: null,
  setting: new Map(), // key -> { read(), changed() }
};

// ---------------------------------------------------------------- requests

// Requests that become background tasks: the Tasks button checks again at once.
const TASK_URLS = /^\/api\/(certs\/(issue|reissue|delete|selfsigned)|git\/sync|dns\/(sync|set-ip)|workspace\/apply)/;
function nudgeTasksFor(url) {
  if (TASK_URLS.test(String(url).split("?")[0]) && typeof nudgeTasks === "function") nudgeTasks();
}

// The editor's api() only POSTs; these calls need GET, PUT and the CSRF header on writes.
async function call(method, url, body) {
  nudgeTasksFor(url);
  const options = { method, headers: { "X-Requested-With": "nginx-autohandler" } };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetchRetry(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(errorText(data.error) || `The server answered ${response.status}.`);
  return data;
}

// Like call(), but a refusal (4xx) is returned instead of thrown, so the caller can read its fields.
async function callAny(method, url, body) {
  nudgeTasksFor(url);
  const options = { method, headers: { "X-Requested-With": "nginx-autohandler" } };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetchRetry(url, options);
  const data = await response.json().catch(() => ({}));
  data.http_status = response.status;
  return data;
}

const report = (error) => reportError(error);

// ---------------------------------------------------------------- native dialogs

// Shows the app's own dialog instead of window.confirm/prompt. Resolves to true, a
// trimmed string (when `input` is set), or null when cancelled.
function ask({ title, message = "", input = false, value = "", placeholder = "", ok = "OK", danger = false }) {
  const field = $("#askInput");
  const okBtn = $("#btnAskOk");
  $("#askTitle").textContent = title;
  $("#askMessage").textContent = message;
  $("#askMessage").hidden = !message;
  field.hidden = !input;
  field.value = value;
  field.placeholder = placeholder;
  field.classList.remove("invalid");
  okBtn.textContent = ok;
  okBtn.classList.toggle("danger-solid", danger);
  SHELL.askResult = null;
  return new Promise((resolve) => {
    SHELL.askDone = resolve;
    $("#dlgAsk").showModal();
    (input ? field : okBtn).focus();
  });
}

function askOk() {
  const field = $("#askInput");
  if (field.hidden) {
    SHELL.askResult = true;
  } else {
    const text = field.value.trim();
    if (!text) {
      field.classList.add("invalid");
      field.focus();
      return;
    }
    SHELL.askResult = text;
  }
  $("#dlgAsk").close();
}

// Settles the pending ask() however the dialog closes: button, Escape, or backdrop.
function settleAsk() {
  const done = SHELL.askDone;
  const result = SHELL.askResult;
  SHELL.askDone = null;
  SHELL.askResult = null;
  if (done) done(result);
}

function showResult(title, eyebrow, lines) {
  $("#resultTitle").textContent = title;
  $("#resultEyebrow").textContent = eyebrow;
  const body = $("#resultBody");
  body.textContent = "";
  for (const line of lines) body.append(el("p", { class: "result-message", text: line }));
  $("#resultDialog").showModal();
}

// ---------------------------------------------------------------- save

const SAVE = { busy: false };

function setSaving(busy, label) {
  SAVE.busy = busy;
  const button = $("#saveBtn");
  button.disabled = busy;
  button.textContent = busy ? label || "Saving…" : "Save";
}

function clearSaveNotice() {
  const box = $("#saveNotice");
  if (box) box.hidden = true;
}

// Saved, but nginx was not reloaded: amber, with the reason and the files that stopped the reload.
function showSaveNotice(result, files) {
  const box = $("#saveNotice");
  const blocked = result.blocked_by_other_files || [];
  const root = (state.doc && state.doc.prefix ? state.doc.prefix : "").replace(/\/+$/, "");
  const relative = (path) => (root && path.startsWith(root + "/") ? path.slice(root.length + 1) : path);
  const inDocument = (path) => state.doc.files.some((file) => file.path === relative(path));
  box.replaceChildren(
    el("span", { class: "notice-mark", "aria-hidden": "true", text: "!" }),
    el("div", { class: "notice-text" },
      el("strong", { text: `Saved ${files}, but nginx was not reloaded.` }),
      el("p", { text: result.warning || "nginx is still running the previous configuration." }),
      blocked.length
        ? el("div", { class: "notice-files" },
          el("span", { text: blocked.length === 1 ? "The problem is in a file you did not change:" : "The problems are in files you did not change:" }),
          ...blocked.map((path) => {
            const here = inDocument(path);
            return here
              ? el("button", { class: "tiny", type: "button", title: `Open ${relative(path)}`, onclick: () => openFile(relative(path)).catch(report), text: relative(path) })
              : el("code", { title: "Outside the files this editor shows", text: path });
          }))
        : null,
    ),
    el("button", { class: "tiny", type: "button", "aria-label": "Dismiss", title: "Dismiss", onclick: clearSaveNotice, text: "✕" }),
  );
  box.hidden = false;
}

async function applyWorkspace(certificateNames) {
  if (SAVE.busy) return false;
  if (!(await applyDraft())) return false;
  const body = { document: state.doc, delete: state.deletedFiles };
  if (certificateNames) body.certificate_names = certificateNames;
  setSaving(true, certificateNames ? "Issuing certificate…" : "Saving…");
  let result;
  try {
    result = await callAny("POST", "/api/workspace/apply", body);
  } finally {
    setSaving(false);
  }
  if (result.needs_certificates && result.needs_certificates.length) {
    const names = await certificateNamesDialog(result.needs_certificates, certificateNames);
    if (!names) return false;
    return applyWorkspace(names);
  }
  if (result.error && result.ok === undefined) throw new Error(errorText(result.error) || `The server answered ${result.http_status}.`);
  const removed = result.deleted || [];
  const files = [...(result.changed || []), ...removed.map((path) => path + " (removed)")].join(", ") || "nothing";

  if (!result.ok) {
    clearSaveNotice();
    $("#validationStatus").textContent = "nginx rejected the change";
    showProblem("Not saved", "NGINX TEST FAILED", `nginx rejected the change to ${files}. Every file is back as it was.`, result.output || "No output from nginx.");
    return false;
  }
  if (!result.saved) {
    toast("Nothing to save. The files already match.");
    filesApplied();
    renderFileHeader();
    return true;
  }

  state.dirty = false;
  filesApplied();
  renderFileHeader();
  const reloaded = result.reloaded !== false;
  state.savedLabel = reloaded ? "SAVED" : "SAVED, NOT RELOADED";
  state.savedStatus = reloaded ? "Saved and reloaded" : "Saved, not reloaded";
  $("#savedLabel").textContent = state.savedLabel;
  $("#changeStatus").textContent = state.savedStatus;
  if (reloaded) {
    clearSaveNotice();
    toast(`Saved ${(result.changed || []).length} file(s)` + (removed.length ? `, removed ${removed.length}` : "") + " and reloaded nginx.");
  } else {
    showSaveNotice(result, files);
    toast("Saved, but nginx was not reloaded. See the notice above the editor.", "warn");
  }
  if (result.dns) {
    const lines = [`Wrote ${files}.`];
    if (result.dns.error) lines.push("DNS: " + result.dns.error);
    else for (const [domain, outcome] of Object.entries(result.dns.results || {})) lines.push(`DNS ${domain}: ${outcome}`);
    showResult("Saved", result.dns.error ? "DNS NOT UPDATED" : "DNS UPDATED", lines);
  }
  if (VIEWS.built === "home") refreshOverview({ quiet: true });
  return true;
}

// ---------------------------------------------------------------- history

async function openHistory() {
  if (!state.file) return toast("Open a file first.");
  $("#historyFile").textContent = state.file;
  const list = $("#historyList");
  list.textContent = "";
  const data = await call("GET", "/api/backups?path=" + encodeURIComponent(state.file));
  if (!data.backups.length) list.append(el("li", { class: "muted", text: "No snapshots yet." }));
  for (const backup of data.backups) {
    const item = el("li");
    item.append(el("span", { text: backup.time }));
    const restore = el("button", { class: "tiny", text: "Restore", type: "button" });
    restore.onclick = () => restoreBackup(backup).catch(report);
    item.append(restore);
    list.append(item);
  }
  $("#historyDialog").showModal();
}

async function restoreBackup(backup) {
  const ok = await ask({
    title: "Restore this version?",
    message: `${state.file} goes back to ${backup.time}. Unapplied edits in the editor are lost; the current file is snapshotted first.`,
    ok: "Restore",
    danger: true,
  });
  if (ok !== true) return;
  const result = await call("POST", "/api/restore", { path: state.file, backup: backup.name });
  $("#historyDialog").close();
  if (!result.ok) return showProblem("Not restored", "NGINX TEST FAILED", "nginx rejected the restored file, so nothing changed.", result.output);
  toast(`Restored ${state.file}` + (result.reloaded ? " and reloaded nginx." : "."));
  setDocument(await call("GET", "/api/workspace"));
}

// ---------------------------------------------------------------- nginx actions

async function testConfig() {
  const r = await call("POST", "/api/test");
  if (r.ok) showResult("Config test passed", "NGINX -T", ["The configuration is valid."]);
  else showProblem("Config test failed", "NGINX -T", "nginx rejected the current configuration.", r.output || "No output from nginx.");
}

async function reloadNginx() {
  const r = await call("POST", "/api/reload");
  if (r.ok) toast("Reloaded nginx.");
  else showProblem("Reload refused", "NGINX TEST FAILED", "nginx will not reload because the config test failed.", r.output);
}

// ---------------------------------------------------------------- settings

function sourceLabel(item) {
  if (item.source === "env") return `from environment (${item.env})`;
  if (item.source === "ui") return "saved in the UI";
  return "default";
}

function settingRow(item) {
  const row = el("div", { class: "setting" });
  const head = el("div", { class: "setting-head" });
  head.append(el("span", { class: "setting-label", text: item.label }), el("span", { class: "pill" + (item.source === "env" ? " locked" : ""), text: sourceLabel(item) }));
  row.append(head);

  const control = el("div", { class: "setting-control" });
  let input;
  let initial;
  if (item.kind === "bool") {
    input = el("input");
    input.type = "checkbox";
    input.checked = item.value;
    initial = item.value;
    SHELL.setting.set(item.key, { read: () => input.checked, changed: () => input.checked !== initial });
    control.append(input);
  } else if (item.kind === "choice") {
    input = el("select", { class: "cell" });
    for (const choice of item.choices) input.append(el("option", { value: choice, text: choice }));
    input.value = item.value;
    initial = item.value;
    SHELL.setting.set(item.key, { read: () => input.value, changed: () => input.value !== initial });
    control.append(input);
  } else if (item.kind === "secret") {
    input = el("input", { class: "cell" });
    input.type = "password";
    input.autocomplete = "new-password";
    input.placeholder = item.is_set ? "set. type to replace" : "not set";
    const entry = { cleared: false };
    SHELL.setting.set(item.key, {
      read: () => (entry.cleared ? "" : input.value),
      changed: () => entry.cleared || input.value !== "",
    });
    const clear = el("button", { class: "tiny", type: "button", text: "Clear", title: "Remove the saved value" });
    clear.onclick = () => {
      input.value = "";
      entry.cleared = true;
      input.placeholder = "will be cleared on save";
    };
    control.append(input, clear);
  } else {
    input = el("input", { class: "cell" });
    input.type = item.kind === "int" ? "number" : "text";
    input.value = item.value;
    initial = String(item.value);
    SHELL.setting.set(item.key, { read: () => input.value, changed: () => input.value !== initial });
    control.append(input);
  }
  input.disabled = item.locked;
  for (const btn of control.querySelectorAll("button")) btn.disabled = item.locked;
  row.append(control);
  return row;
}

function renderSettingsForm(data) {
  SHELL.setting.clear();
  const groups = $("#settingsGroups");
  groups.textContent = "";
  const byGroup = new Map();
  for (const item of data.settings) {
    if (!byGroup.has(item.group)) byGroup.set(item.group, []);
    byGroup.get(item.group).push(item);
  }
  const jump = $("#settingsJump");
  jump.textContent = "";
  for (const [group, items] of byGroup) {
    const section = el("section", { class: "setting-group" });
    const heading = el("h3", { class: "sub", text: group });
    section.append(heading);
    for (const item of items) section.append(settingRow(item));
    groups.append(section);
    jump.append(el("button", { type: "button", text: group, onclick: () => heading.scrollIntoView({ block: "start", behavior: "smooth" }) }));
  }
  jump.hidden = byGroup.size < 2;
}

// `group` scrolls the dialog to that settings group (for example "Git sync").
async function openSettings(group) {
  renderSettingsForm(await call("GET", "/api/settings"));
  if (!$("#dlgSettings").open) $("#dlgSettings").showModal();
  if (group) {
    const heading = [...$$("#settingsGroups .sub")].find((item) => item.textContent === group);
    if (heading) heading.scrollIntoView({ block: "start" });
  }
}

async function saveSettings() {
  const values = {};
  for (const [key, entry] of SHELL.setting) {
    if (entry.changed()) values[key] = entry.read();
  }
  if (!Object.keys(values).length) return toast("Nothing changed in Settings.");
  renderSettingsForm(await call("PUT", "/api/settings", { values }));
  setBadges(await call("GET", "/api/config"));
  toast(`Saved ${Object.keys(values).length} setting(s).`);
}

async function testNotify() {
  const data = await call("POST", "/api/notify/test", { kind: $("#notifyKind").value });
  const entries = Object.entries(data.results || {});
  const failed = entries.filter(([, outcome]) => String(outcome).startsWith("error"));
  if (!entries.length) return showResult("Test notification", "NOTIFICATIONS", ["No channel is set up. Add a Discord webhook or SMTP details in Settings."]);
  const names = (list) => list.map(([channel]) => channel).join(" and ");
  if (!failed.length) return showResult("Test notification sent", "NOTIFICATIONS", [`Delivered through ${names(entries)}.`]);
  showProblem("Test notification", "NOTIFICATIONS",
    `${names(failed)} did not deliver.` + (failed.length < entries.length ? ` ${names(entries.filter((entry) => !failed.includes(entry)))} did.` : ""),
    failed.map(([channel, outcome]) => `${channel}: ${outcome}`).join("\n"));
}

// ---------------------------------------------------------------- certificates

const CERT = { data: null, mode: "letsencrypt", keyFile: "" };

function badge2(kind, text, title) {
  return el("span", { class: `badge ${kind}`, text, title: title || text });
}

function formatDate(text) {
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? String(text || "") : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    // Plain http outside localhost has no clipboard API; fall back to a hidden selection.
    const area = el("textarea", { style: { position: "fixed", opacity: "0" } });
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  toast("Copied.");
}

function certKindBadge(cert) {
  if (cert.kind === "external") return badge2("self", "EXTERNAL", "Provided by a folder mounted into the container. This app does not manage it.");
  if (cert.kind === "acme") return badge2("good", "ACME", `Issued through ACME${cert.issuer ? " by " + cert.issuer : ""}${cert.staging ? " (staging)" : ""}`);
  if (cert.kind === "selfsigned") return badge2("self", "SELF-SIGNED", "Signed by this app. Browsers will warn about it.");
  if (cert.kind === "uploaded") return badge2("upload", "UPLOADED", "A certificate you uploaded");
  if (cert.staging) return badge2("test", "STAGING", "A Let's Encrypt test certificate. Browsers do not trust it.");
  return badge2("good", "LET'S ENCRYPT", "Issued by Let's Encrypt");
}

function certPathRow(label, path) {
  return el("div", { class: "cert-path" },
    el("span", { class: "cert-path-label", text: label }),
    el("code", { text: path, title: path }),
    el("button", { class: "tiny", type: "button", text: "Copy", title: `Copy ${path}`, onclick: () => copyText(path) }),
  );
}

function certCard(cert, warnDays) {
  const days = Number(cert.days_left);
  let state = ["good", "VALID"];
  if (cert.valid === false || days < 0) state = ["bad", "EXPIRED"];
  else if (days <= warnDays) state = ["warn", "EXPIRES SOON"];
  const expiry = cert.expires
    ? `Expires ${formatDate(cert.expires)}` + (Number.isFinite(days) ? (days >= 0 ? ` · ${days} day${days === 1 ? "" : "s"} left` : ` · expired ${-days} day${days === -1 ? "" : "s"} ago`) : "")
    : "Expiry unknown";
  const live = `/etc/letsencrypt/live/${cert.name}`;
  const external = cert.kind === "external";
  const reissuable = !cert.kind || cert.kind === "acme" || cert.kind === "letsencrypt" || cert.kind === "selfsigned";
  const certPath = external && cert.path ? cert.path : `${live}/fullchain.pem`;
  const keyPath = external && cert.key_path ? cert.key_path : `${live}/privkey.pem`;
  return el("article", { class: "cert-card " + (state[0] === "good" ? "" : "cert-" + state[0]) },
    el("div", { class: "cert-name", title: cert.path || cert.name, text: cert.name }),
    el("div", { class: "cert-badges" }, certKindBadge(cert), cert.kind === "acme" && cert.staging ? badge2("test", "STAGING", "A test certificate. Browsers do not trust it.") : null, cert.kind === "acme" && cert.issuer ? badge2("test", cert.issuer.toUpperCase().slice(0, 28), `Issuer: ${cert.issuer}`) : null, badge2(...state)),
    el("div", { class: "cert-domains" }, ...(cert.domains || []).map((domain) => el("span", { text: domain }))),
    el("div", { class: "cert-expiry" + (state[0] === "good" ? "" : " " + state[0]), text: expiry + (cert.issuer ? ` · issuer ${cert.issuer}` : "") }),
    el("div", { class: "cert-paths" }, certPathRow("ssl_certificate", certPath), certPathRow("ssl_certificate_key", keyPath)),
    el("div", { class: "cert-actions" },
      external
        ? el("span", { class: "muted tiny", text: "Managed outside this app. Replace the files on the host to renew it." })
        : el("button", { class: "tiny danger-text", type: "button", text: "Delete", onclick: () => deleteCert(cert).catch(report) }),
      reissuable ? el("button", { class: "tiny", type: "button", text: "Reissue", title: cert.kind === "selfsigned" ? "Generate a new self-signed certificate now" : "Ask the certificate authority for a new certificate now", onclick: (event) => reissueCert(cert, event.currentTarget).catch(report) }) : null),
  );
}

async function reissueCert(cert, button) {
  const answer = await ask({
    title: `Reissue ${cert.name}?`,
    message: cert.kind === "selfsigned"
      ? "This generates a new self-signed certificate and key with the same names and lifetime, and reloads nginx. The old files are replaced."
      : "This asks the certificate authority for a new certificate now, even though the current one is still valid. Authorities rate-limit this, so avoid doing it repeatedly.",
    ok: "Reissue",
  });
  if (answer !== true) return;
  button.disabled = true;
  button.textContent = "Reissuing…";
  try {
    const data = await call("POST", "/api/certs/reissue", { name: cert.name });
    if (data.ok === false) showProblem(`Could not reissue ${cert.name}`, "CERTIFICATE", data.message || "The certificate authority refused the request.", data.output);
    else toast(data.message || `Reissued ${cert.name}.`);
  } finally {
    await refreshCerts().catch(() => {});
  }
}

// Files in the editor whose ssl_certificate points at this certificate.
function certUsers(cert) {
  const users = new Set();
  const marks = [`/live/${cert.name}/`, cert.path, cert.key_path].filter(Boolean);
  for (const file of state.doc ? state.doc.files : []) {
    walkNodes(file.nodes, (node) => {
      if (node.kind === "directive" && (node.name === "ssl_certificate" || node.name === "ssl_certificate_key") && marks.some((mark) => (node.args[0] || "").includes(mark))) users.add(file.path);
    });
  }
  return [...users];
}

async function deleteCert(cert) {
  const users = certUsers(cert);
  const answer = await ask({
    title: `Delete ${cert.name}?`,
    message: "The certificate and its key are removed from this host." + (users.length
      ? ` Still used by ${users.join(", ")}: those servers will fail the nginx test until you point them at another certificate.`
      : " No config in the editor uses it."),
    ok: "Delete",
    danger: true,
  });
  if (answer !== true) return;
  const data = await call("POST", "/api/certs/delete", { name: cert.name });
  toast(data.message || `Deleted ${cert.name}.`);
  await refreshCerts();
}

function renderCerts(data) {
  CERT.data = data;
  const list = data.certificates || [];
  const warnDays = Number(data.warn_days) || 14;
  $("#certCount").textContent = list.length ? `(${list.length})` : "";
  $("#certCards").replaceChildren(...(list.length
    ? list.map((cert) => certCard(cert, warnDays))
    : [el("div", { class: "cert-empty", text: "No certificates yet. Issue one above, create a self-signed one, or upload your own." })]));
  const renew = $("#certRenew");
  const renewDays = Number(data.renew_days);
  renew.hidden = !(renewDays > 0);
  renew.textContent = renewDays > 0 ? `Renews automatically ${renewDays} days before expiry (checked every 12 hours).` : "";
  $("#certList").textContent = data.output || "No output.";
  $("#certStaging").checked = data.staging;
  updateCertNotice();
}

// Missing settings only matter for Let's Encrypt, so the notice follows the selected mode.
function updateCertNotice() {
  const data = CERT.data || {};
  const missing = [];
  if (!data.email) missing.push("a contact email");
  if (data.token_set === false) missing.push("a Cloudflare API token");
  const notice = $("#certNotice");
  const show = CERT.mode === "letsencrypt" && missing.length > 0;
  notice.hidden = !show;
  notice.replaceChildren();
  if (show) {
    notice.append(`Let's Encrypt needs ${missing.join(" and ")}. `,
      el("button", { class: "tiny", type: "button", text: "Open Settings", onclick: () => { $("#dlgCerts").close(); openSettings().catch(report); } }));
  }
}

const CERT_MODES = {
  letsencrypt: { button: "Issue certificate", hint: "Works through Cloudflare, so wildcards are supported. Staging certificates are not trusted by browsers." },
  selfsigned: { button: "Create self-signed", hint: "Signed by this app, so browsers warn about it. Good for internal hosts and testing." },
  upload: { button: "Upload certificate", hint: "Paste or pick a PEM certificate (with any chain) and its private key. The key is sent once and never shown again." },
};

function setCertMode(mode) {
  CERT.mode = mode;
  for (const tab of $$("#certMode button")) {
    const active = tab.dataset.certMode === mode;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  }
  for (const form of $$(".cert-form")) form.hidden = form.dataset.for !== mode;
  $("#btnIssue").textContent = CERT_MODES[mode].button;
  $("#certModeHint").textContent = CERT_MODES[mode].hint;
  updateCertNotice();
}

const CA_NAMES = { letsencrypt: "Let's Encrypt", zerossl: "ZeroSSL", google: "Google Trust Services", custom: "a custom ACME server" };

// One line saying which certificate authority new certificates come from, with a way to change it.
async function paintCertCA() {
  const line = $("#certCA");
  try {
    const data = await call("GET", "/api/settings");
    const find = (key) => (data.settings || []).find((item) => item.key === key);
    const provider = (find("acme_provider") || {}).value || "letsencrypt";
    const staging = (find("acme_staging") || {}).value;
    const staged = staging === true || staging === "true" || staging === "1";
    line.replaceChildren(`Certificates are issued by ${CA_NAMES[provider] || provider}${staged ? " (staging)" : ""}. `,
      el("button", { class: "link-button", type: "button", text: "Open Settings", onclick: () => { $("#dlgCerts").close(); openSettings().catch(report); } }));
  } catch (error) {
    line.textContent = "";
  }
}

async function refreshCerts() {
  renderCerts(await call("GET", "/api/certs"));
}

async function openCerts() {
  $("#certStatus").hidden = true;
  renderCerts(await call("GET", "/api/certs"));
  paintCertCA();
  $("#dlgCerts").showModal();
}

function statusPanel(kind, title, sub, details) {
  const panel = $("#certStatus");
  panel.hidden = false;
  panel.className = `status-panel ${kind}`;
  panel.replaceChildren(...[
    el("div", { class: "status-title" }, kind === "busy" ? el("span", { class: "spinner" }) : null, title),
    sub ? el("div", { class: "status-sub", text: sub }) : null,
    details ? detailsBlock(details) : null,
  ].filter(Boolean));
  panel.scrollIntoView({ block: "nearest" });
}

function dnsLine(dns) {
  if (!dns) return "";
  if (dns.error) return "DNS: " + describeError(dns.error).summary;
  return Object.entries(dns.results || {}).map(([domain, outcome]) => `${domain}: ${outcome}`).join(" · ");
}

// Runs one certificate action behind the shared progress panel and the primary button.
async function runCertAction(busyTitle, busySub, work) {
  const button = $("#btnIssue");
  button.disabled = true;
  statusPanel("busy", busyTitle, busySub);
  try {
    await work();
    await refreshCerts().catch(() => {});
  } catch (error) {
    const { summary, details } = describeError(error);
    statusPanel("bad", summary, "", details);
  } finally {
    button.disabled = false;
  }
}

async function issueLetsEncrypt() {
  const domains = $("#certDomains").value;
  if (!domains.trim()) return statusPanel("bad", "Enter at least one domain.");
  await runCertAction("Requesting a certificate…",
    "DNS-01 adds a TXT record at Cloudflare and waits for it to spread. This can take a few minutes; you can close this window.",
    async () => {
      const data = await call("POST", "/api/certs/issue", { domains, staging: $("#certStaging").checked });
      if (data.ok) {
        statusPanel("ok", data.message || "Certificate issued.", [data.staging ? "Staging certificate: browsers will not trust it." : "", dnsLine(data.dns)].filter(Boolean).join(" "), data.output);
      } else {
        statusPanel("bad", data.message || describeError(data.output).summary, "", data.output);
      }
    });
}

async function createSelfSigned() {
  const domains = $("#ssDomains").value;
  if (!domains.trim()) return statusPanel("bad", "Enter at least one domain or IP address.");
  const days = Number($("#ssDays").value) || 365;
  const body = { domains, days };
  const name = $("#ssName").value.trim();
  if (name) body.name = name;
  await runCertAction("Creating a self-signed certificate…", "", async () => {
    const data = await call("POST", "/api/certs/selfsigned", body);
    statusPanel(data.ok === false ? "bad" : "ok", data.message || "Self-signed certificate created.", "Browsers will warn about it until you trust it.");
  });
}

async function uploadCertificate() {
  const certificate = $("#upCert").value.trim();
  const privateKey = $("#upKey").value.trim() || CERT.keyFile;
  if (!certificate) return statusPanel("bad", "Paste the certificate, or choose a .pem or .crt file.");
  if (!privateKey) return statusPanel("bad", "Paste the private key, or choose its file.");
  const body = { certificate, private_key: privateKey };
  const name = $("#upName").value.trim();
  if (name) body.name = name;
  await runCertAction("Uploading the certificate…", "", async () => {
    const data = await call("POST", "/api/certs/upload", body);
    statusPanel(data.ok === false ? "bad" : "ok", data.message || "Certificate uploaded.");
    if (data.ok !== false) clearUploadForm();
  });
}

function clearUploadForm() {
  $("#upCert").value = "";
  $("#upKey").value = "";
  $("#upName").value = "";
  CERT.keyFile = "";
  $("#upKeyNote").textContent = "";
}

async function pickPem(input, apply) {
  const file = input.files && input.files[0];
  input.value = "";
  if (!file) return;
  if (file.size > 256 * 1024) throw new Error(`${file.name} is too large for a certificate or key.`);
  apply(await file.text(), file.name);
}

function issueCert() {
  const submit = { letsencrypt: issueLetsEncrypt, selfsigned: createSelfSigned, upload: uploadCertificate }[CERT.mode];
  return submit();
}

function bindCerts() {
  for (const tab of $$("#certMode button")) tab.addEventListener("click", () => setCertMode(tab.dataset.certMode));
  $("#btnPickCert").addEventListener("click", () => $("#upCertFile").click());
  $("#btnPickKey").addEventListener("click", () => $("#upKeyFile").click());
  $("#upCertFile").addEventListener("change", () => pickPem($("#upCertFile"), (text) => { $("#upCert").value = text; }).catch(report));
  $("#upKeyFile").addEventListener("change", () => pickPem($("#upKeyFile"), (text, name) => {
    CERT.keyFile = text;
    $("#upKey").value = "";
    $("#upKeyNote").textContent = `Key loaded from ${name}. It is kept hidden.`;
  }).catch(report));
  $("#upKey").addEventListener("input", () => {
    if ($("#upKey").value) {
      CERT.keyFile = "";
      $("#upKeyNote").textContent = "";
    }
  });
  // A private key never outlives the dialog.
  $("#dlgCerts").addEventListener("close", () => {
    $("#upKey").value = "";
    CERT.keyFile = "";
    $("#upKeyNote").textContent = "";
  });
  setCertMode("letsencrypt");
}

// ---------------------------------------------------------------- DNS

function outcomeBadge(outcome) {
  const text = String(outcome);
  if (text.startsWith("error")) return badge2("bad", "ERROR", text);
  if (text === "updated" || text === "created") return badge2("good", text.toUpperCase());
  return badge2("test", text.toUpperCase());
}

function renderDns(data) {
  const summary = $("#dnsSummary");
  summary.className = "status-panel";
  summary.replaceChildren();
  if (!data.configured) {
    summary.append(el("div", { class: "status-title", text: "Cloudflare is off" }),
      el("div", { class: "status-sub", text: "Add an API token in Settings and your domains are kept pointing at this host." }),
      el("button", { class: "tiny", type: "button", text: "Open Settings", onclick: () => { $("#dlgDns").close(); openSettings().catch(report); } }));
  } else if (data.error) {
    summary.classList.add("bad");
    const { summary: text, details } = describeError(data.error);
    summary.append(...[el("div", { class: "status-title", text: "The last sync failed" }), el("div", { class: "status-sub", text }), details ? detailsBlock(details) : null].filter(Boolean));
  } else if (data.last_run) {
    summary.classList.add("ok");
    summary.append(el("div", { class: "status-title", text: `Pointing at ${data.ip}` }), el("div", { class: "status-sub", text: `Last sync ${data.last_run}` }));
  } else {
    summary.append(el("div", { class: "status-title", text: "Not synced yet" }), el("div", { class: "status-sub", text: "Press Sync now to check the public IP and update the records." }));
  }
  if (Array.isArray(data.whoami_urls) && data.whoami_urls.length) {
    summary.append(el("div", { class: "status-sub", text: `IP lookup: ${data.whoami_urls.join(", ")}` }));
  }
  $("#dnsResults").replaceChildren(...Object.entries(data.results || {}).map(([domain, outcome]) =>
    el("li", {}, el("span", { title: domain, text: domain }), outcomeBadge(outcome))));
  paintDnsDomains(data);
  for (const id of ["btnSyncDns", "btnVerifyDns", "btnSetIp", "dnsIp", "dnsAdd", "btnAddDomain"]) $("#" + id).disabled = !data.configured;
}

// ---- managed domains and the manual IP

const DNSD = { domains: [], env: [] };

function paintDnsDomains(data) {
  if (data) {
    DNSD.domains = data.domains || [];
    DNSD.env = data.env_domains || [];
  }
  const total = DNSD.domains.length + DNSD.env.length;
  $("#dnsCount").textContent = total ? `(${total})` : "";
  const configured = !$("#btnSyncDns").disabled;
  const row = (domain, fixed) => el("li", { class: "dns-row" },
    el("span", { class: "dns-name", title: domain, text: domain }),
    fixed ? badge2("test", "ENV · READ-ONLY", "Set by the environment, so it cannot be removed here") : null,
    el("button", { class: "tiny", type: "button", text: "Set IP", title: "Point just this domain at the address typed above", disabled: !configured, onclick: () => setDnsIp([domain]).catch(report) }),
    el("button", { class: "tiny danger-text dns-remove", type: "button", text: "✕", disabled: fixed, title: fixed ? "Set by the environment" : "Stop keeping it in sync. The DNS record on Cloudflare is not deleted.", "aria-label": `Stop managing ${domain}`,
      onclick: () => saveDnsDomains(DNSD.domains.filter((item) => item !== domain), `Stopped managing ${domain}.`).catch(report) }),
  );
  const rows = [...DNSD.domains.map((domain) => row(domain, false)), ...DNSD.env.map((domain) => row(domain, true))];
  $("#dnsList").replaceChildren(...(rows.length ? rows : [el("li", { class: "cert-empty", text: "No domains yet. Add one above, or apply a config with a server_name." })]));
}

async function saveDnsDomains(domains, message) {
  const data = await call("POST", "/api/dns/domains", { domains });
  DNSD.domains = data.domains || [];
  paintDnsDomains();
  if (message) toast(message);
}

async function addDnsDomain() {
  const input = $("#dnsAdd");
  const names = input.value.replace(/,/g, " ").split(/\s+/).map((name) => name.trim().toLowerCase()).filter(Boolean);
  if (!names.length) return;
  input.value = "";
  await saveDnsDomains([...new Set([...DNSD.domains, ...names])], `Added ${names.length === 1 ? names[0] : names.length + " domains"}.`);
  input.focus();
}

async function setDnsIp(domains) {
  const ip = $("#dnsIp").value.trim();
  if (!ip) {
    $("#dnsIp").focus();
    return toast("Type the IP address first.");
  }
  const button = $("#btnSetIp");
  button.disabled = true;
  try {
    const body = { ip };
    if (domains) body.domains = domains;
    const data = await call("POST", "/api/dns/set-ip", body);
    if (data.error) {
      showError("Could not set the IP", data.error);
      return;
    }
    $("#dnsSetResults").replaceChildren(...Object.entries(data.results || {}).map(([domain, outcome]) =>
      el("li", {}, el("span", { title: domain, text: domain }), outcomeBadge(outcome))));
    toast(`Pointed ${Object.keys(data.results || {}).length} domain(s) at ${data.ip || ip}.`);
  } finally {
    button.disabled = false;
  }
}

async function openDns() {
  renderDns(await call("GET", "/api/dns"));
  $("#dlgDns").showModal();
}

async function syncDns() {
  const button = $("#btnSyncDns");
  button.disabled = true;
  button.textContent = "Syncing…";
  try {
    const data = await call("POST", "/api/dns/sync");
    renderDns(await call("GET", "/api/dns"));
    if (data.error) showError("DNS sync failed", data.error);
    else toast(`DNS synced to ${data.ip}.`);
  } finally {
    button.disabled = false;
    button.textContent = "Sync now";
  }
}

async function verifyDns() {
  const data = await call("POST", "/api/dns/verify");
  if (data.ok) toast(data.message || "The Cloudflare token works.");
  else showProblem("Cloudflare token", "DNS", "Cloudflare did not accept the token.", data.message);
}

// ---------------------------------------------------------------- activity

const ACTIVITY_KIND = { applied: ["good", "APPLIED"], reloaded: ["good", "RELOADED"], rejected: ["bad", "REJECTED"],
  test_failed: ["bad", "TEST FAILED"], reload_failed: ["warn", "RELOAD FAILED"], reverted: ["test", "REVERTED"],
  not_reloaded: ["test", "NOT RELOADED"], git: ["self", "GIT SYNC"] };

async function openActivity() {
  const data = await call("GET", "/api/activity");
  $("#activityIntro").textContent = data.watching
    ? "Edits made from this page and outside it (a share, an editor, the shell) are tested, reloaded and listed here, newest first."
    : "Watching for outside edits is off. Turn it on in Settings > Nginx.";
  const events = data.events || [];
  $("#activityList").replaceChildren(...(events.length ? events.map((event) => {
    const [kind, label] = ACTIVITY_KIND[event.kind] || ["test", String(event.kind || "INFO").toUpperCase()];
    return el("li", {}, el("span", { title: event.message, text: `${event.time} · ${(event.files || []).join(", ") || event.title}` }), badge2(kind, label, event.title));
  }) : [el("li", { class: "cert-empty", text: "Nothing yet. Changes show up here when nginx is tested or reloaded." })]));
  if (!$("#dlgActivity").open) $("#dlgActivity").showModal();
}

// ---------------------------------------------------------------- startup

function setBadges(config) {
  $("#authBadge").textContent = config.auth ? "login on" : "login off";
  $("#authBadge").classList.toggle("on", config.auth);
  $("#reloadBadge").textContent = config.auto_reload ? "auto-reload on" : "auto-reload off";
  $("#reloadBadge").classList.toggle("on", config.auto_reload);
  $("#btnDns").classList.toggle("off", !config.cloudflare);
  $("#configRoot").textContent = config.root;
}

// ---------------------------------------------------------------- files

function walkNodes(nodes, visit) {
  for (const node of nodes) {
    visit(node);
    walkNodes(node.children || [], visit);
  }
}

// Hostnames a file serves, from its server_name lines.
function fileDomains(file) {
  const names = new Set();
  walkNodes(file.nodes, (node) => {
    if (node.kind === "directive" && node.name === "server_name") {
      for (const arg of node.args) if (arg && arg !== "_" && !arg.startsWith("~")) names.add(arg);
    }
  });
  return [...names];
}

// Certificate files a file refers to, from its ssl_certificate lines.
function fileCertificates(file) {
  const paths = new Set();
  walkNodes(file.nodes, (node) => {
    if (node.kind === "directive" && node.name === "ssl_certificate" && node.args[0]) paths.add(node.args[0]);
  });
  return [...paths];
}

function cloneNodes(nodes) {
  return nodes.map((node) => ({ ...node, id: uid(), args: [...node.args], children: cloneNodes(node.children || []) }));
}

function copyName(path) {
  const match = path.match(/^(.*?)(\.[^./]+)?$/);
  return match[1] + "-copy" + (match[2] || ".conf");
}

// cloneFile, renameFile and deleteFile live in files.js with the rest of the file navigator.

// ---------------------------------------------------------------- certificates in the editor

// Certificate paths for the server an auto-certificate is added to, named after its first server_name.
async function autoCertSource(template, target) {
  const probe = target !== undefined ? target : parentFor((await api("/api/parse", { text: template })).nodes);
  const hit = probe ? locate(probe) : null;
  if (!hit || hit.node.name !== "server") throw new Error("Select a server block first; the certificate belongs to a server.");
  const children = hit.node.children;
  if (children.some((node) => node.name === "ssl_certificate")) throw new Error("This server already has certificate files.");
  const names = children.filter((node) => node.kind === "directive" && node.name === "server_name").flatMap((node) => node.args);
  const first = names.find((name) => name && name !== "_" && !name.startsWith("~"));
  if (!first) throw new Error("Add a server_name to this server first; the certificate is named after it.");
  return template.replaceAll("__LINEAGE__", first.replace("*.", "wildcard."));
}

// ---------------------------------------------------------------- theme

const THEME_KEY = "nginx-autohandler-theme";

function currentTheme() {
  if (document.documentElement.dataset.theme) return document.documentElement.dataset.theme;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// `persist` is false for the startup call, so a visitor on "follow the system" stays there.
function setTheme(theme, persist = true) {
  $("#btnTheme").textContent = theme === "dark" ? "☀ Light" : "☾ Dark";
  if (!persist) return;
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (error) {
    // Storage is blocked: the choice still applies for this page view.
  }
  // files.js loads later; it keeps the theme with the other preferences.
  if (typeof prefs !== "undefined") {
    prefs.theme = theme;
    savePrefs();
    const select = document.getElementById("prefTheme");
    if (select) select.value = theme;
  }
}

function bindShell() {
  $("#btnTheme").onclick = () => setTheme(currentTheme() === "dark" ? "light" : "dark");
  $("#dlgAsk").addEventListener("close", settleAsk);
  $("#btnAskOk").onclick = askOk;
  $("#askInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      askOk();
    }
  });
  $("#askInput").addEventListener("input", () => $("#askInput").classList.remove("invalid"));
  for (const cancel of document.querySelectorAll("#dlgAsk [data-cancel]")) cancel.onclick = () => $("#dlgAsk").close();

  $("#historyBtn").onclick = () => openHistory().catch(report);
  $("#btnTest").onclick = () => testConfig().catch(report);
  $("#btnReload").onclick = () => reloadNginx().catch(report);
  $("#btnSettings").onclick = () => openSettings().catch(report);
  $("#btnSaveSettings").onclick = () => saveSettings().catch(report);
  $("#btnTestNotify").onclick = () => testNotify().catch(report);
  $("#btnCerts").onclick = () => openCerts().catch(report);
  $("#btnIssue").onclick = () => issueCert();
  bindCerts();
  $("#btnCertRefresh").onclick = () => refreshCerts().catch(report);
  $("#btnDns").onclick = () => openDns().catch(report);
  $("#btnAddDomain").onclick = () => addDnsDomain().catch(report);
  $("#dnsAdd").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); addDnsDomain().catch(report); } });
  $("#btnSetIp").onclick = () => setDnsIp().catch(report);
  $("#dnsIp").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); setDnsIp().catch(report); } });
  $("#btnSyncDns").onclick = () => syncDns().catch(report);
  $("#btnVerifyDns").onclick = () => verifyDns().catch(report);
  $("#btnActivity").onclick = () => openActivity().catch(report);
  $("#btnActivityRefresh").onclick = () => openActivity().catch(report);
}

async function startShell() {
  bindShell();
  setTheme(currentTheme(), false);
  setBadges(await call("GET", "/api/config"));
}

startShell().catch(report);
