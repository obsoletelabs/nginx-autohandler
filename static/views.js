"use strict";

// The pages that are not a config file: the Overview (brand), the file browser (⌂) and the log viewer.
// They share the main area with the editor: state.view says which one is showing (see files.js).

const VIEWS = { built: "", home: { data: null, error: "", at: 0, loading: false, testing: false, tab: "enabled" }, logs: { list: [], at: 0, error: "" }, collapsed: new Set() };
const LOG_OPTS = {};
let viewTimer = 0;

function knownLogs() {
  return VIEWS.logs.list;
}

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function clockTime(date = new Date()) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function pageHeader(eyebrow, title, subtitle, ...actions) {
  return el("header", { class: "view-head" },
    el("div", {}, el("div", { class: "eyebrow", text: eyebrow }), el("h2", { text: title }), subtitle ? el("p", { class: "view-sub", text: subtitle }) : null),
    el("div", { class: "view-actions" }, ...actions),
  );
}

function viewSection(title, hint, ...children) {
  return el("section", { class: "view-section" },
    el("div", { class: "view-section-head" }, el("h3", { text: title }), hint ? el("span", { class: "view-hint", text: hint }) : null),
    ...children,
  );
}

function emptyNote(text) {
  return el("p", { class: "view-empty", text });
}

function linkButton(text, title, handler, extra = "") {
  return el("button", { class: "link-button " + extra, type: "button", title, onclick: handler, text });
}

// ---------------------------------------------------------------- entry point from files.js

function renderViewPane() {
  const pane = $("#viewPane");
  if (!pane) return;
  const key = state.view;
  document.querySelector(".editor-panel").classList.toggle("showing-view", !!key);
  document.body.classList.toggle("in-view", !!key);
  pane.hidden = !key;
  if (!key) {
    VIEWS.built = "";
    syncTimers();
    return;
  }
  if (VIEWS.built !== key) {
    VIEWS.built = key;
    pane.scrollTop = 0;
    if (key === "home") buildHome(pane);
    else if (key === "files") buildBrowser(pane);
    else buildLog(pane, key.slice(4));
  } else if (key === "files") {
    renderBrowserFiles();
  }
  syncTimers();
}

function syncTimers() {
  clearInterval(viewTimer);
  viewTimer = 0;
  if (state.view === "home") viewTimer = setInterval(() => { if (document.visibilityState === "visible") refreshOverview({ quiet: true }); }, 30000);
  else if (state.view.startsWith("log:")) {
    const opts = logOptions(state.view.slice(4));
    if (opts.auto) viewTimer = setInterval(() => { if (document.visibilityState === "visible") loadLog({ quiet: true }); }, 3000);
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (state.view === "home" && Date.now() - VIEWS.home.at > 30000) refreshOverview({ quiet: true });
});

// ---------------------------------------------------------------- shared: certificate badges, toggles

const CERT_STATE_TEXT = { ok: "good", soon: "warn", expired: "bad", missing: "bad", unknown: "test" };

function tlsBadge(cert, ssl) {
  if (!cert) return ssl ? badge2("test", "TLS", "TLS is on, but no certificate was found for these names") : el("span", { class: "muted", text: "HTTP only" });
  const days = Number.isFinite(cert.days_left) ? cert.days_left : null;
  let text = "TLS";
  if (cert.state === "ok") text = days === null ? "TLS ok" : `TLS · ${days} d`;
  else if (cert.state === "soon") text = days === null ? "EXPIRING" : `EXPIRES IN ${days} d`;
  else if (cert.state === "expired") text = "EXPIRED";
  else if (cert.state === "missing") text = "CERT MISSING";
  const tip = [cert.name || cert.path, cert.issuer, cert.expires ? `expires ${cert.expires}` : "", cert.staging ? "staging (not trusted by browsers)" : ""].filter(Boolean).join(" · ");
  const badgeEl = badge2(CERT_STATE_TEXT[cert.state] || "test", text, tip);
  badgeEl.classList.add("clickable");
  badgeEl.tabIndex = 0;
  badgeEl.setAttribute("role", "button");
  badgeEl.onclick = () => openCerts().catch(report);
  badgeEl.onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openCerts().catch(report); } };
  return badgeEl;
}

function fileLink(path) {
  if (!state.doc.files.some((file) => file.path === path)) return el("span", { class: "muted", text: path });
  return linkButton(path, `Open ${path}`, () => openFile(path).catch(report), "mono");
}

function switchButton(on, label, handler) {
  const button = el("button", { class: "switch" + (on ? " on" : ""), type: "button", role: "switch", "aria-checked": String(on), "aria-label": label, title: label, onclick: handler }, el("span", { class: "knob" }));
  return button;
}

// Disabling renames name.conf to name.conf.disabled (tested, reloaded and rolled back by the server).
async function toggleConfig(path, enable) {
  if (!(await allowReplace())) return;
  if (!enable) {
    const answer = await ask({
      title: `Disable ${path}?`,
      message: "nginx stops using it. The file is kept as " + path + ".disabled, nginx is tested and reloaded, and the change is rolled back if the test fails. You can turn it back on from the Overview.",
      ok: "Disable",
      danger: true,
    });
    if (answer !== true) return;
  }
  const data = await call("POST", "/api/config/toggle", { path, enabled: enable });
  if (!data.ok) {
    showProblem(
      enable ? `Could not enable ${path}` : `Could not disable ${path}`, "CONFIG",
      data.rolled_back ? "nginx did not accept the change, so it was rolled back and nothing changed." : "The change was not made.",
      data.output,
    );
    return;
  }
  setDocument(await call("GET", "/api/workspace"));
  toast(enable ? `Enabled ${data.path || path}${data.reloaded ? " · nginx reloaded" : ""}` : `Disabled ${path} · kept as ${data.path || path + ".disabled"}`);
  if (VIEWS.built === "home" || state.view === "home") await refreshOverview({ quiet: true });
}

// ---------------------------------------------------------------- overview

async function fetchOverview(test) {
  return call("GET", "/api/overview" + (test ? "?test=1" : ""));
}

async function refreshOverview({ quiet = false, test = false } = {}) {
  const home = VIEWS.home;
  if (home.loading) return;
  home.loading = true;
  if (test) home.testing = true;
  if (!quiet || !home.data) paintHome();
  try {
    const [data, git] = await Promise.all([fetchOverview(test), call("GET", "/api/git").catch(() => null)]);
    home.git = git;
    if (!test && home.data && home.data.nginx && home.data.nginx.test && data.nginx && !data.nginx.test) data.nginx.test = home.data.nginx.test;
    home.data = data;
    home.error = "";
    home.at = Date.now();
  } catch (error) {
    home.error = describeError(error).summary;
  } finally {
    home.loading = false;
    home.testing = false;
  }
  if (state.view === "home") paintHome();
}

function buildHome(pane) {
  pane.replaceChildren(el("div", { class: "view-page", id: "homePage" }));
  paintHome();
  refreshOverview({ quiet: true });
}

function statCard(title, value, sub, { tone = "", foot = null, onclick = null, label = "" } = {}) {
  return el("section", { class: "stat-card " + tone },
    el("div", { class: "stat-title", text: title }),
    el("div", { class: "stat-value" }, value),
    sub ? el("div", { class: "stat-sub" }, sub) : null,
    foot ? el("div", { class: "stat-foot" }, foot) : null,
  );
}

function onOff(on, text) {
  return el("span", { class: "chip-state " + (on ? "on" : "off"), text: `${text} ${on ? "on" : "off"}` });
}

function paintHome() {
  const page = $("#homePage");
  if (!page) return;
  const home = VIEWS.home;
  const data = home.data;
  const updated = home.at ? `Updated ${clockTime(new Date(home.at))} · refreshes every 30 s` : "Loading…";
  const header = pageHeader("OVERVIEW", "What is running", updated,
    el("button", { type: "button", text: home.loading ? "Refreshing…" : "↻ Refresh", disabled: home.loading, onclick: () => refreshOverview() }),
    el("button", { type: "button", text: "⇪ Import", onclick: () => openImportDialog().catch(report) }),
    el("button", { type: "button", text: "⌂ Browse files", onclick: () => openFileBrowser().catch(report) }),
  );
  const parts = [header];
  if (home.error) {
    parts.push(el("div", { class: "status-panel bad" },
      el("div", { class: "status-title", text: "The overview could not be loaded" }),
      el("div", { class: "status-sub", text: home.error }),
      el("button", { class: "tiny", type: "button", text: "Try again", onclick: () => refreshOverview() }),
    ));
  }
  if (!data) {
    if (!home.error) parts.push(el("div", { class: "status-panel" }, el("span", { class: "spinner" }), "Reading your configuration…"));
    page.replaceChildren(...parts);
    return;
  }
  parts.push(
    el("div", { class: "stat-grid" }, ...homeCards(data)),
    homeSites(data),
    homeConfigs(data),
    homeDomains(data),
    homeActivity(data),
  );
  const scroll = $("#viewPane").scrollTop;
  page.replaceChildren(...parts);
  $("#viewPane").scrollTop = scroll;
}

function homeCards(data) {
  const home = VIEWS.home;
  const test = data.nginx && data.nginx.test;
  let nginxValue = "Not tested";
  let nginxTone = "";
  let nginxSub = data.nginx && data.nginx.version ? data.nginx.version : "Press the button to run nginx -t";
  if (test) {
    nginxValue = test.ok ? "Config OK" : "Config error";
    nginxTone = test.ok ? "good" : "bad";
    nginxSub = test.ok ? (data.nginx.version || "nginx -t passed") : "nginx -t failed";
  }
  const nginxFoot = [
    el("button", { class: "tiny", type: "button", disabled: home.testing, text: home.testing ? "Testing…" : "Run config test", onclick: () => runOverviewTest() }),
    test && !test.ok ? linkButton("Details", "Show the nginx output", () => showProblem("nginx -t failed", "NGINX", "nginx rejected the current configuration.", test.output)) : null,
  ];
  const counts = data.counts || {};
  const certs = data.certificates || {};
  const attention = counts.certs_attention || 0;
  const soonest = certs.soonest;
  const dns = data.dns || {};
  const settings = data.settings || {};
  const notify = data.notify || {};
  const dnsTone = dns.error ? "bad" : dns.last_run ? "good" : "";
  const cards = [
    statCard("nginx", nginxValue, nginxSub, { tone: nginxTone, foot: nginxFoot }),
    statCard("Configs", `${counts.enabled || 0} enabled`, `${counts.disabled || 0} disabled · ${counts.files || 0} files`, {
      tone: counts.disabled ? "" : "", foot: linkButton("See configs", "Jump to the configs list", () => document.getElementById("homeConfigs")?.scrollIntoView({ behavior: "smooth", block: "start" })),
    }),
    statCard("Domains", String(counts.domains || 0), `${counts.servers || 0} server block${counts.servers === 1 ? "" : "s"}`, {
      foot: linkButton("See domains", "Jump to the domains list", () => document.getElementById("homeDomains")?.scrollIntoView({ behavior: "smooth", block: "start" })),
    }),
    statCard("Certificates", String(certs.total || 0), attention ? `${attention} need${attention === 1 ? "s" : ""} attention` : soonest ? `Soonest: ${soonest.name} · ${soonest.days_left} d` : "None found", {
      tone: attention ? "bad" : certs.total ? "good" : "", foot: linkButton("Open Certificates", "Issue, upload or review certificates", () => openCerts().catch(report)),
    }),
    statCard("Public IP", dns.ip || "unknown", dns.error ? describeError(dns.error).summary : dns.last_run ? `Last sync ${dns.last_run}` : dns.configured ? "Not synced yet" : "Cloudflare is off", {
      tone: dnsTone, foot: [el("span", { class: "chip-state " + (dns.tracked ? "on" : "off"), text: `${dns.tracked || 0} tracked` }), linkButton("Open DNS", "DNS sync and records", () => openDns().catch(report))],
    }),
    statCard("Notifications", notify.discord || notify.smtp ? "On" : "Off", el("span", { class: "chips" }, onOff(notify.discord, "Discord"), onOff(notify.smtp, "Email")), {
      tone: notify.discord || notify.smtp ? "good" : "", foot: linkButton("Settings", "Channels, test messages", () => openSettings().catch(report)),
    }),
    statCard("Automation", settings.auto_reload ? "Auto-reload" : "Manual reload", el("span", { class: "chips" }, onOff(settings.auto_reload, "Reload"), onOff(settings.watch_config, "Watch"), el("span", { class: "chip-state on", text: `${settings.acme_provider || "letsencrypt"}${settings.acme_staging ? " · staging" : ""}` })), {
      foot: linkButton("Settings", "Reload, watching and certificate authority", () => openSettings().catch(report)),
    }),
  ];
  const git = gitCard(home.git);
  if (git) cards.push(git);
  return cards;
}

async function runOverviewTest() {
  await refreshOverview({ test: true });
}

function servesText(server) {
  const parts = [];
  if (server.proxy && server.proxy.length) parts.push("→ " + server.proxy.join(", "));
  if (server.root && server.root.length) parts.push("files: " + server.root.join(", "));
  if (server.returns && server.returns.length) parts.push("returns " + server.returns.join(", "));
  return parts.length ? parts.join(" · ") : "";
}

function homeSites(data) {
  const rows = [];
  for (const file of data.files || []) {
    if (!file.enabled) continue;
    for (const server of file.servers || []) rows.push({ file, server });
  }
  rows.sort((a, b) => (a.server.names[0] || "~").localeCompare(b.server.names[0] || "~"));
  const head = el("tr", {}, ...["Domains", "Listens on", "Serves", "TLS", "File"].map((text) => el("th", { text })));
  const body = rows.map(({ file, server }) => el("tr", {},
    el("td", { class: "cell-domains" }, ...(server.names.length ? server.names : ["(default server)"]).map((name) => el("span", { class: "domain-chip", text: name }))),
    el("td", { class: "mono", text: (server.listen || []).join(", ") || "—" }),
    el("td", { class: "cell-serves", title: servesText(server) }, servesText(server) || el("span", { class: "muted", text: server.locations ? `${server.locations} location${server.locations === 1 ? "" : "s"}` : "—" })),
    el("td", {}, tlsBadge(server.cert, server.ssl)),
    el("td", {}, fileLink(file.path)),
  ));
  return viewSection("Sites", `${rows.length} server block${rows.length === 1 ? "" : "s"} in enabled files`,
    rows.length
      ? el("div", { class: "table-wrap" }, el("table", { class: "view-table" }, el("thead", {}, head), el("tbody", {}, ...body)))
      : emptyNote("No server blocks yet. Add a server block in a config file and it shows up here."));
}

function configRow(file) {
  const dis = !file.enabled;
  return el("li", { class: "config-row" + (dis ? " disabled" : "") },
    el("div", { class: "config-main" },
      dis ? el("span", { class: "mono", title: file.path, text: file.path }) : fileLink(file.path),
      el("span", { class: "badge test", text: (file.role || "").toUpperCase() }),
      file.error ? badge2("bad", "ERROR", file.error) : null,
    ),
    el("div", { class: "config-meta" },
      el("span", { class: "muted", text: file.reason || "" }),
      file.modified ? el("span", { class: "muted", text: "· " + file.modified }) : null,
      !dis && file.servers && file.servers.length ? el("span", { class: "muted", text: `· ${file.servers.length} server${file.servers.length === 1 ? "" : "s"}` }) : null,
    ),
    file.can_toggle
      ? switchButton(!dis, dis ? `Enable ${file.path}` : `Disable ${file.path}`, () => toggleConfig(dis ? file.path : file.path, dis).catch(report))
      : el("span", { class: "muted tiny", text: file.role === "main" ? "entry file" : "" }),
  );
}

function homeConfigs(data) {
  const files = data.files || [];
  const enabled = files.filter((file) => file.enabled);
  const disabled = files.filter((file) => !file.enabled);
  const real = enabled.filter((file) => file.role !== "snippet");
  const snippets = enabled.filter((file) => file.role === "snippet");
  const tab = VIEWS.home.tab;
  const tabs = el("div", { class: "seg", role: "tablist" },
    ...[["enabled", `Enabled (${enabled.length})`], ["disabled", `Disabled (${disabled.length})`]].map(([id, text]) =>
      el("button", { type: "button", role: "tab", class: tab === id ? "active" : "", "aria-selected": String(tab === id), text, onclick: () => { VIEWS.home.tab = id; paintHome(); } })));
  let body;
  if (tab === "enabled") {
    body = el("div", {},
      real.length ? el("ul", { class: "config-list" }, ...real.map(configRow)) : emptyNote("No site or main files are enabled."),
      snippets.length
        ? el("details", { class: "snippet-group" },
          el("summary", { text: `Shared snippets and includes (${snippets.length})` }),
          el("ul", { class: "config-list quiet" }, ...snippets.map(configRow)))
        : null,
    );
  } else {
    body = disabled.length
      ? el("ul", { class: "config-list" }, ...disabled.map(configRow))
      : emptyNote("Nothing is disabled. Turn a file off with its switch and it is listed here.");
  }
  const section = viewSection("Configs", "Disabled files are kept as name.conf.disabled and listed here", tabs, body);
  section.id = "homeConfigs";
  return section;
}

function homeDomains(data) {
  const domains = data.domains || [];
  const body = domains.map((domain) => el("tr", {},
    el("td", {}, el("span", { class: "domain-chip", text: domain.name })),
    el("td", {}, ...domain.files.flatMap((path, i) => [i ? ", " : null, fileLink(path)])),
    el("td", {}, tlsBadge(domain.cert, false)),
    el("td", {}, domain.dns ? linkButton("tracked", "Kept pointing at this host by DNS sync", () => openDns().catch(report), "tracked") : el("span", { class: "muted", text: "not tracked" })),
    el("td", {}, badge2(domain.enabled ? "good" : "test", domain.enabled ? "ENABLED" : "DISABLED")),
  ));
  const section = viewSection("Domains", `${domains.length} name${domains.length === 1 ? "" : "s"} across your configs`,
    domains.length
      ? el("div", { class: "table-wrap" }, el("table", { class: "view-table" },
        el("thead", {}, el("tr", {}, ...["Domain", "Config", "Certificate", "DNS", "State"].map((text) => el("th", { text })))),
        el("tbody", {}, ...body)))
      : emptyNote("No domains yet. They are read from the server_name directives."));
  section.id = "homeDomains";
  return section;
}

function homeActivity(data) {
  const events = data.activity || [];
  return viewSection("Recent activity", "applies, reloads, rejected changes and outside edits",
    events.length
      ? el("ul", { class: "result-list activity-list" }, ...events.map((event) => {
        const [kind, label] = (typeof ACTIVITY_KIND !== "undefined" && ACTIVITY_KIND[event.kind]) || ["test", String(event.kind || "INFO").toUpperCase()];
        return el("li", {}, el("span", { title: event.message, text: `${event.time} · ${(event.files || []).join(", ") || event.title}` }), badge2(kind, label, event.title));
      }))
      : emptyNote("Nothing yet. Changes show up here when nginx is tested or reloaded."),
    el("div", { class: "view-more" }, linkButton("All activity →", "Open the full activity list", () => openActivity().catch(report))));
}

// ---------------------------------------------------------------- file browser

function buildBrowser(pane) {
  const filter = el("input", { id: "browseFilter", class: "view-filter", placeholder: "Filter by file or domain…", "aria-label": "Filter config files", autocomplete: "off", spellcheck: "false" });
  filter.value = VIEWS.browseFilter || "";
  filter.addEventListener("input", () => {
    VIEWS.browseFilter = filter.value;
    renderBrowserFiles();
  });
  const page = el("div", { class: "view-page" },
    pageHeader("FILES", "Browse everything", "Config files, logs and certificates in one place",
      el("button", { type: "button", text: "＋ New file", onclick: () => addFileFlow().catch(report) }),
      el("button", { type: "button", text: "⇪ Import", onclick: () => openImportDialog().catch(report) }),
      el("button", { type: "button", text: "◎ Overview", onclick: () => openHome().catch(report) })),
    viewSection("Config files", "click a file to open it", el("label", { class: "search-box view-search" }, el("span", { text: "⌕" }), filter), el("div", { id: "browseTree", class: "browse-tree", role: "tree", "aria-label": "Config files" })),
    viewSection("Logs", "nginx, this app and certbot", el("div", { id: "browseLogs", class: "browse-logs" })),
    viewSection("Certificates", "", el("div", { id: "browseCerts", class: "browse-certs" })),
  );
  pane.replaceChildren(page);
  renderBrowserFiles();
  paintBrowserLogs();
  paintBrowserCerts();
  loadLogList().then(paintBrowserLogs).catch(() => paintBrowserLogs());
  if (!VIEWS.home.data || Date.now() - VIEWS.home.at > 30000) refreshOverview({ quiet: true }).then(paintBrowserCerts);
}

function renderBrowserFiles() {
  const box = $("#browseTree");
  if (!box || !state.doc) return;
  const tokens = (VIEWS.browseFilter || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
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
    const emit = () => leaves.forEach((file) => rows.push(browseFileRow(file, infos.get(file.path), depth)));
    if (depth === 0) emit();
    for (const sub of subs) {
      const open = tokens.length > 0 || !VIEWS.collapsed.has(sub.path);
      const row = el("button", {
        class: "browse-row folder", type: "button", role: "treeitem", "aria-expanded": String(open),
        onclick: () => { if (VIEWS.collapsed.has(sub.path)) VIEWS.collapsed.delete(sub.path); else VIEWS.collapsed.add(sub.path); renderBrowserFiles(); },
      }, el("span", { class: "nav-twist", text: open ? "▾" : "▸" }), el("span", { class: "folder-name", text: sub.name + "/" }), el("span", { class: "nav-count", text: String(countFiles(sub)) }));
      row.style.setProperty("--depth", depth);
      rows.push(row);
      if (open) walk(sub, depth + 1);
    }
    if (depth !== 0) emit();
  };
  walk(buildTree(files), 0);
  if (!rows.length) rows.push(el("div", { class: "view-empty" }, tokens.length ? `Nothing matches "${VIEWS.browseFilter.trim()}".` : "No files yet."));
  box.replaceChildren(...rows);
}

function browseFileRow(file, info, depth) {
  const name = file.path.split("/").pop();
  const entry = file.path === state.doc.entrypoint;
  const chips = info.domains.slice(0, 4).map((domain) => el("span", { class: "nav-domain", text: domain }));
  if (info.domains.length > 4) chips.push(el("span", { class: "nav-more", title: info.domains.slice(4).join(", "), text: `+${info.domains.length - 4}` }));
  const row = el("button", { class: "browse-row file", type: "button", role: "treeitem", title: file.path, onclick: () => openFile(file.path).catch(report) },
    el("span", { class: "file-icon", text: "▤" }),
    el("span", { class: "browse-name", text: name }),
    entry ? badge("entry", "ENTRY", "Entry file: nginx loads this first") : null,
    info.tls ? badge("tls", "TLS", "Serves TLS certificates") : null,
    info.errors ? badge("err", String(info.errors), `${info.errors} problem(s) found by the checks`) : null,
    !info.errors && info.warnings ? badge("warn", String(info.warnings), `${info.warnings} suggestion(s)`) : null,
    info.isNew ? badge("new", "NEW", "Not on disk yet. Apply writes it.") : null,
    info.changed ? el("span", { class: "nav-dot", title: "Unsaved changes" }) : null,
    el("span", { class: "browse-domains" }, ...(chips.length ? chips : [el("span", { class: "nav-none", text: entry ? "entry · main settings" : isMainFile(file) ? "main settings" : "no server_name" })])),
  );
  row.style.setProperty("--depth", depth);
  return row;
}

function paintBrowserLogs() {
  const box = $("#browseLogs");
  if (!box) return;
  const logs = VIEWS.logs;
  if (logs.error) {
    box.replaceChildren(el("div", { class: "status-panel bad" }, el("div", { class: "status-title", text: "Logs could not be listed" }), el("div", { class: "status-sub", text: logs.error }), el("button", { class: "tiny", type: "button", text: "Try again", onclick: () => loadLogList().then(paintBrowserLogs).catch(() => paintBrowserLogs()) })));
    return;
  }
  if (!logs.at) {
    box.replaceChildren(el("div", { class: "view-empty" }, el("span", { class: "spinner" }), "Looking for logs…"));
    return;
  }
  box.replaceChildren(logGroups(logs.list, ""));
}

const LOG_GROUPS = { nginx: "nginx", app: "This app", certbot: "certbot" };

function logGroups(list, activeId) {
  if (!list.length) return el("p", { class: "view-empty", text: "No log files yet. They appear once nginx, this app or certbot have written something." });
  const out = [];
  for (const group of Object.keys(LOG_GROUPS)) {
    const items = list.filter((log) => log.group === group);
    if (!items.length) continue;
    out.push(el("div", { class: "log-group" },
      el("div", { class: "log-group-title", text: LOG_GROUPS[group] }),
      ...items.map((log) => el("button", { class: "browse-row log" + (log.id === activeId ? " active" : ""), type: "button", title: `${log.id} · ${log.modified}`, onclick: () => openLog(log.id).catch(report) },
        el("span", { class: "file-icon", text: "☰" }),
        el("span", { class: "browse-name", text: log.name }),
        el("span", { class: "browse-domains muted", text: `${fmtBytes(log.size)} · ${log.modified}` })))));
  }
  return el("div", { class: "log-groups" }, ...out);
}

async function loadLogList() {
  const logs = VIEWS.logs;
  try {
    const data = await call("GET", "/api/logs");
    logs.list = Array.isArray(data.logs) ? data.logs : [];
    logs.error = "";
  } catch (error) {
    logs.error = describeError(error).summary;
  }
  logs.at = Date.now();
}

function paintBrowserCerts() {
  const box = $("#browseCerts");
  if (!box) return;
  const data = VIEWS.home.data;
  if (!data) {
    box.replaceChildren(VIEWS.home.error ? el("div", { class: "view-empty", text: VIEWS.home.error }) : el("div", { class: "view-empty" }, el("span", { class: "spinner" }), "Reading certificates…"));
    return;
  }
  const certs = data.certificates || {};
  const attention = (data.counts || {}).certs_attention || 0;
  const soonest = certs.soonest;
  box.replaceChildren(el("div", { class: "cert-summary" },
    el("div", { class: "cert-number" }, el("strong", { text: String(certs.total || 0) }), el("span", { text: certs.total === 1 ? "certificate" : "certificates" })),
    el("div", { class: "cert-number" + (attention ? " bad" : "") }, el("strong", { text: String(attention) }), el("span", { text: "need attention" })),
    el("div", { class: "cert-soon" },
      soonest ? el("span", {}, "Soonest to expire: ", el("strong", { text: soonest.name }), ` · ${soonest.days_left} day${soonest.days_left === 1 ? "" : "s"} (${soonest.expires})`) : el("span", { class: "muted", text: certs.total ? "No expiry dates known." : "No certificates yet." })),
    el("button", { type: "button", class: "primary", text: "Open Certificates", onclick: () => openCerts().catch(report) }),
  ));
}

// ---------------------------------------------------------------- log viewer

function logOptions(id) {
  if (!LOG_OPTS[id]) LOG_OPTS[id] = { lines: 300, contains: "", wrap: false, follow: true, auto: false, token: 0, data: null, error: "", loading: false };
  return LOG_OPTS[id];
}

function logClass(line) {
  const status = line.match(/"\s(\d{3})\s/);
  if (status) {
    const code = Number(status[1]);
    if (code >= 500) return "err";
    if (code >= 400) return "warn";
  }
  if (/\[(emerg|alert|crit|error)\]|\bERROR\b|\bCRITICAL\b|\bFATAL\b|Traceback/.test(line)) return "err";
  if (/\[warn\]|\bWARN(ING)?\b/.test(line)) return "warn";
  if (/\[(notice|info)\]|\bINFO\b/.test(line)) return "info";
  return "";
}

function markLine(row, line, needle) {
  if (!needle) {
    row.textContent = line;
    return;
  }
  const lower = line.toLowerCase();
  const target = needle.toLowerCase();
  let at = 0;
  for (;;) {
    const hit = lower.indexOf(target, at);
    if (hit < 0) break;
    if (hit > at) row.append(line.slice(at, hit));
    row.append(el("mark", { text: line.slice(hit, hit + target.length) }));
    at = hit + target.length;
  }
  row.append(line.slice(at));
}

function buildLog(pane, id) {
  const opts = logOptions(id);
  const filter = el("input", { id: "logFilter", class: "view-filter", placeholder: "Filter lines (searched on the server)…", "aria-label": "Filter log lines", autocomplete: "off", spellcheck: "false" });
  filter.value = opts.contains;
  let typing = 0;
  filter.addEventListener("input", () => {
    opts.contains = filter.value;
    clearTimeout(typing);
    typing = setTimeout(() => loadLog(), 350);
  });
  const select = el("select", { id: "logLines", "aria-label": "How many lines" }, ...[100, 300, 1000, 5000].map((n) => el("option", { value: String(n), text: `${n} lines` })));
  select.value = String(opts.lines);
  select.addEventListener("change", () => { opts.lines = Number(select.value); loadLog(); });
  const toggle = (idName, text, key, onChange) => {
    const label = el("label", { class: "log-toggle", title: text });
    const box = el("input", { type: "checkbox", id: idName });
    box.checked = opts[key];
    box.addEventListener("change", () => { opts[key] = box.checked; onChange && onChange(); });
    label.append(box, el("span", { text }));
    return label;
  };
  const toolbar = el("div", { class: "log-toolbar" },
    el("label", { class: "search-box view-search" }, el("span", { text: "⌕" }), filter),
    select,
    toggle("logAuto", "Auto-refresh (3 s)", "auto", () => { syncTimers(); if (opts.auto) loadLog({ quiet: true }); }),
    toggle("logFollow", "Follow", "follow", () => { if (opts.follow) scrollLogToEnd(); }),
    toggle("logWrap", "Wrap", "wrap", () => $("#logTail")?.classList.toggle("wrap", opts.wrap)),
    el("button", { type: "button", id: "logRefresh", text: "↻ Refresh", onclick: () => loadLog() }),
    el("button", { type: "button", id: "logCopy", text: "Copy", onclick: () => copyLog() }),
  );
  const tail = el("div", { id: "logTail", class: "log-tail" + (opts.wrap ? " wrap" : ""), tabindex: "0", role: "log", "aria-label": `Tail of ${id}` });
  tail.addEventListener("scroll", () => {
    if (VIEWS.programmaticScroll) return;
    const atEnd = tail.scrollHeight - tail.scrollTop - tail.clientHeight < 24;
    if (atEnd !== opts.follow) {
      opts.follow = atEnd;
      const box = $("#logFollow");
      if (box) box.checked = atEnd;
    }
  });
  const side = el("nav", { id: "logSide", class: "log-side", "aria-label": "Logs" });
  const page = el("div", { class: "view-page log-page" },
    pageHeader("LOG", id, "", el("button", { type: "button", text: "⌂ Browse files", onclick: () => openFileBrowser().catch(report) })),
    el("div", { class: "log-layout" },
      side,
      el("div", { class: "log-main" }, toolbar, el("div", { id: "logMeta", class: "log-meta" }), tail)),
  );
  pane.replaceChildren(page);
  paintLogSide(id);
  loadLogList().then(() => paintLogSide(id)).catch(() => {});
  loadLog();
}

function paintLogSide(id) {
  const side = $("#logSide");
  if (!side) return;
  const logs = VIEWS.logs;
  side.replaceChildren(logs.error ? el("p", { class: "view-empty", text: logs.error }) : logs.at ? logGroups(logs.list, id) : el("p", { class: "view-empty", text: "Loading…" }));
}

function scrollLogToEnd() {
  const tail = $("#logTail");
  if (!tail) return;
  VIEWS.programmaticScroll = true;
  tail.scrollTop = tail.scrollHeight;
  requestAnimationFrame(() => { VIEWS.programmaticScroll = false; });
}

async function loadLog({ quiet = false } = {}) {
  if (!state.view.startsWith("log:")) return;
  const id = state.view.slice(4);
  const opts = logOptions(id);
  const token = ++opts.token;
  const query = new URLSearchParams({ id, lines: String(opts.lines) });
  if (opts.contains.trim()) query.set("contains", opts.contains.trim());
  opts.loading = !quiet;
  if (!quiet) paintLog(id);
  try {
    const data = await call("GET", "/api/logs/read?" + query);
    if (token !== opts.token) return;
    opts.data = data;
    opts.error = "";
    opts.missing = false;
  } catch (error) {
    if (token !== opts.token) return;
    const text = error && error.message ? String(error.message) : "";
    opts.data = null;
    opts.missing = /does not exist|unknown log/i.test(text);
    opts.error = opts.missing ? "" : describeError(error).summary;
  } finally {
    if (token === opts.token) opts.loading = false;
  }
  if (state.view === "log:" + id) paintLog(id);
}

function paintLog(id) {
  const opts = logOptions(id);
  const tail = $("#logTail");
  const meta = $("#logMeta");
  if (!tail || !meta) return;
  if (opts.loading && !opts.data) {
    meta.textContent = "";
    tail.replaceChildren(el("div", { class: "view-empty" }, el("span", { class: "spinner" }), "Reading the log…"));
    return;
  }
  if (opts.missing) {
    meta.textContent = "";
    tail.replaceChildren(el("div", { class: "log-empty" },
      el("strong", { text: "Nothing here yet" }),
      el("p", { text: `${id} has not been written yet. It shows up as soon as nginx or the app logs something.` }),
      el("button", { class: "tiny", type: "button", text: "Check again", onclick: () => loadLog() })));
    return;
  }
  if (opts.error) {
    meta.textContent = "";
    tail.replaceChildren(el("div", { class: "log-empty bad" }, el("strong", { text: "The log could not be read" }), el("p", { text: opts.error }), el("button", { class: "tiny", type: "button", text: "Try again", onclick: () => loadLog() })));
    return;
  }
  const data = opts.data || { lines: [], size: 0, truncated: false };
  const needle = opts.contains.trim();
  const lines = data.lines || [];
  const info = [`${lines.length} line${lines.length === 1 ? "" : "s"}`, fmtBytes(data.size)];
  if (needle) info.push(`matching "${needle}"`);
  if (data.truncated) info.push("older lines are cut off");
  meta.textContent = info.join(" · ") + (opts.auto ? " · refreshing every 3 s" : "");
  if (!lines.length) {
    tail.replaceChildren(el("div", { class: "log-empty" }, el("strong", { text: needle ? "No matching lines" : "The log is empty" }), el("p", { text: needle ? "Try a different filter, or show more lines." : "Nothing has been written to it yet." })));
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const line of lines) {
    const row = el("div", { class: "log-line " + logClass(line) });
    markLine(row, line, needle);
    fragment.append(row);
  }
  const previous = tail.scrollTop;
  tail.replaceChildren(fragment);
  if (opts.follow) scrollLogToEnd();
  else tail.scrollTop = previous;
}

async function copyLog() {
  const opts = logOptions(state.view.slice(4));
  const lines = (opts.data && opts.data.lines) || [];
  if (!lines.length) return toast("Nothing to copy.");
  await copyText(lines.join("\n"));
  toast(`Copied ${lines.length} line${lines.length === 1 ? "" : "s"}.`);
}
