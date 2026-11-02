/* The Lab: traffic status, sites with advanced features, topology map, search, templates and a timeline. */
(() => {
  const { api, el, toast, sheet, showOutput, bytes, number, ago, debounce, form, reportApply } = H;
  const main = document.getElementById("main");
  let cleanup = null;

  document.getElementById("theme").addEventListener("click", H.toggleTheme);
  document.getElementById("palette").addEventListener("click", () => Palette.open());

  const loading = (rows = 3) => el("div", { class: "stack" }, Array.from({ length: rows }, () => el("div", { class: "skeleton", style: "height:84px" })));
  const failed = (error, retry) => el("div", { class: "empty card" }, el("span", { class: "big" }, "⚠️"), el("b", {}, "That did not load"), error.message,
    el("div", { style: "margin-top:12px" }, el("button", { onclick: retry }, "Try again")));
  const head = (title, blurb, ...actions) => el("div", { class: "page-head" }, el("div", { class: "grow" }, el("h1", {}, title), blurb ? el("p", {}, blurb) : null), ...actions);

  // ------------------------------------------------------------------ status

  async function status() {
    let hours = 24, log = "nginx/access.log", timer;
    const view = el("div", { class: "fade-in" });
    main.replaceChildren(head("Status", "What nginx is serving right now."), view);
    const load = async () => {
      try {
        const [data, overview] = await Promise.all([api(`/api/stats?hours=${hours}&log=${encodeURIComponent(log)}`), api("/api/overview?test=1")]);
        draw(data, overview);
      } catch (error) { view.replaceChildren(failed(error, load)); }
    };
    const draw = (data, overview) => {
      const total = data.total || 1;
      const errors = data.status["5xx"] || 0;
      const test = overview.nginx && overview.nginx.test;
      const max = Math.max(1, ...data.series.map((item) => item.requests));
      const logSelect = el("select", { "aria-label": "Log file", onchange: (event) => { log = event.target.value; load(); } }, data.logs.map((id) => el("option", { value: id, selected: id === log }, id.replace("nginx/", ""))));
      const hourSelect = el("select", { "aria-label": "Time range", onchange: (event) => { hours = Number(event.target.value); load(); } },
        [[1, "Last hour"], [6, "Last 6 hours"], [24, "Last 24 hours"], [72, "Last 3 days"], [168, "Last 7 days"]].map(([value, label]) => el("option", { value, selected: value === hours }, label)));
      const tile = (label, value, sub, kind) => el("div", { class: "card tile" }, el("small", {}, label), el("b", { class: kind || "" }, value), sub ? el("small", {}, sub) : null);
      view.replaceChildren(
        el("div", { class: "toolbar" }, logSelect, hourSelect, el("span", { class: "grow" }), el("span", { class: "muted" }, "Updated " + new Date().toLocaleTimeString()), el("button", { onclick: load }, "Refresh")),
        el("div", { class: "tiles" },
          tile("nginx", test ? (test.ok ? "Healthy" : "Config error") : "Unknown", `${overview.nginx.version || "version unknown"} · ${overview.counts.enabled}/${overview.counts.files} configs on`, test && test.ok ? "" : "bad-text"),
          tile("Requests", number(data.total), `${number(data.last_five_minutes)} in the last 5 minutes`),
          tile("Server errors", number(errors), data.total ? `${((errors / total) * 100).toFixed(1)}% of requests` : "no traffic yet"),
          tile("Data sent", bytes(data.bytes), data.bots ? `${number(data.bots)} from bots and tools` : "no bots seen"),
          tile("Certificates", overview.counts.certs_attention ? `${overview.counts.certs_attention} need attention` : "All fine", `${overview.certificates.total} in total`)),
        el("div", { class: "cols" },
          el("div", { class: "card" }, el("h3", {}, "Requests per hour"),
            data.total ? el("div", {}, el("div", { class: "bars" }, data.series.map((item) => el("div", { class: "bar", style: `height:${Math.max(2, (item.requests / max) * 100)}%`, title: `${item.hour}: ${number(item.requests)} requests, ${item.errors} errors` },
              item.errors ? el("div", { class: "err", style: `height:${(item.errors / Math.max(1, item.requests)) * 100}%` }) : null))),
              el("div", { class: "axis" }, el("span", {}, data.series[0].hour), el("span", {}, data.series[data.series.length - 1].hour)))
              : el("div", { class: "empty" }, el("span", { class: "big" }, "🌙"), el("b", {}, "No requests in this window"), "Traffic shows up here as soon as nginx logs it.")),
          el("div", { class: "card" }, el("h3", {}, "Responses"),
            el("div", { class: "meter" }, Object.entries(data.status).map(([klass, count]) => el("span", { class: `s${klass}`, style: `width:${(count / total) * 100}%`, title: `${klass}: ${count}` }))),
            el("div", { class: "legend" }, Object.entries(data.status).map(([klass, count]) => el("span", {}, el("i", { class: `s${klass}` }), `${klass} ${number(count)}`))),
            el("h3", { style: "margin-top:18px" }, "Methods"), el("div", { class: "row wrap", style: "margin-top:8px" }, Object.entries(data.methods).map(([method, count]) => el("span", { class: "chip" }, `${method} ${number(count)}`)))),
          el("div", { class: "card" }, el("h3", {}, "Busiest pages"), table(data.top_paths, ["Path", "Hits"], (row) => [el("span", { class: "mono" }, row[0]), number(row[1])])),
          el("div", { class: "card" }, el("h3", {}, "Top visitors"), table(data.top_ips, ["Address", "Requests"], (row) => [el("span", { class: "mono" }, row[0]), number(row[1])])),
          el("div", { class: "card" }, el("h3", {}, "Recent server errors"),
            data.recent_errors.length ? table(data.recent_errors, ["When", "Status", "Path"], (row) => [row.time.slice(5), el("span", { class: "chip bad" }, row.status), el("span", { class: "mono" }, row.path)])
              : el("div", { class: "empty" }, el("b", {}, "None"), "Nothing returned a 5xx in this window.")),
          el("div", { class: "card" }, el("h3", {}, "nginx error log"),
            Object.keys(data.error_log.counts).length ? el("div", {}, el("div", { class: "row wrap", style: "margin:8px 0" }, Object.entries(data.error_log.counts).map(([level, count]) => el("span", { class: `chip ${level === "warn" ? "warn" : "bad"}` }, `${level} ${count}`))),
              data.error_log.latest.map((line) => el("div", { class: "mono muted", style: "margin:4px 0;word-break:break-all" }, line)))
              : el("div", { class: "empty" }, el("b", {}, "Quiet"), "No warnings or errors logged."))));
    };
    view.append(loading());
    await load();
    timer = setInterval(load, 30000);
    cleanup = () => clearInterval(timer);
  }

  function table(rows, headings, cells) {
    if (!rows.length) return el("div", { class: "empty" }, "Nothing here yet.");
    return el("table", {}, el("thead", {}, el("tr", {}, headings.map((text) => el("th", {}, text)))), el("tbody", {}, rows.map((row) => el("tr", {}, cells(row).map((cell) => el("td", {}, cell))))));
  }

  // ------------------------------------------------------------------ sites and features

  async function sites(arg) {
    const view = el("div", { class: "stack fade-in" });
    main.replaceChildren(head("Sites", "Every site in your config, with switches for the advanced settings."), view);
    view.append(loading());
    let catalog, list, enabledFeatures;
    const load = async () => {
      try {
        [catalog, list] = await Promise.all([api("/api/features"), api("/api/sites")]);
        draw();
      } catch (error) { view.replaceChildren(failed(error, load)); }
    };
    const run = async (request, success) => {
      try { const result = await request; if (reportApply(result) && success) success(result); await load(); } catch (error) { toast(error.message, "bad"); }
    };
    const draw = () => {
      if (!list.sites.length) { view.replaceChildren(el("div", { class: "empty card" }, el("span", { class: "big" }, "🌱"), el("b", {}, "No sites yet"), "Create one from a template.", el("div", { style: "margin-top:12px" }, el("a", { class: "btn primary", href: "#/templates" }, "Browse templates")))); return; }
      view.replaceChildren(...list.sites.map((site) => card(site)));
      if (arg) { const target = view.querySelector(`[data-id="${CSS.escape(arg)}"]`); if (target) { target.scrollIntoView({ block: "center" }); target.classList.add("open"); } }
    };
    const card = (site) => {
      const on = new Set(site.features);
      const node = el("div", { class: "card site", "data-id": site.id },
        el("div", { class: "site-top" },
          el("span", { class: `dot ${site.enabled === false ? "" : "ok"}`, title: site.enabled === false ? "Turned off" : "Live" }),
          el("h3", { class: "grow" }, site.names.join(", ") || site.file),
          el("span", { class: `chip ${site.ssl ? "ok" : "warn"}` }, site.ssl ? "🔒 HTTPS" : "HTTP only")),
        el("div", { class: "chips" },
          el("span", { class: "chip" }, site.file),
          site.forward ? el("span", { class: "chip accent" }, "→ " + site.forward) : null,
          site.root ? el("span", { class: "chip" }, "📁 " + site.root) : null,
          site.redirect ? el("span", { class: "chip" }, "↪ " + site.redirect) : null,
          catalog.features.filter((item) => on.has(item.id)).map((item) => el("span", { class: "chip ok" }, `${item.icon} ${item.title}`))),
        el("div", { class: "site-actions" },
          el("button", { class: "primary", onclick: () => features(site) }, "Features"),
          el("button", { onclick: () => edit(site) }, "Domain & target"),
          el("button", { onclick: () => https(site) }, site.ssl ? "Change HTTPS" : "Enable HTTPS"),
          el("a", { class: "btn", href: `/?desktop=1#open=${encodeURIComponent(site.file)}` }, "Open in editor")));
      return node;
    };
    const edit = (site) => {
      let names, target;
      sheet("Domain & target", (body) => {
        names = el("input", { value: site.names.join(" "), spellcheck: "false" });
        target = el("input", { value: site.forward, spellcheck: "false", disabled: !site.forward, placeholder: site.forward ? "" : "This site does not forward to an app" });
        body.append(el("label", { class: "field" }, el("span", {}, "Domain names (space separated)"), names), el("label", { class: "field" }, el("span", {}, "Forward to"), target, el("small", {}, "Like http://127.0.0.1:8080")));
      }, (foot, close) => foot.append(el("button", { onclick: close }, "Cancel"), el("button", { class: "primary", onclick: () => {
        const body = { id: site.id, names: names.value };
        if (site.forward) body.forward = target.value;
        close(); run(api("/api/sites/update", body));
      } }, "Save")));
    };
    const https = async (site) => {
      let matches;
      try { matches = await api(`/api/certs/match?names=${encodeURIComponent(site.names.join(","))}`); } catch (error) { toast(error.message, "bad"); return; }
      const certs = matches.certificates || [];
      let select, redirect;
      sheet(site.ssl ? "Change HTTPS certificate" : "Enable HTTPS", (body) => {
        if (!certs.length) { body.append(el("div", { class: "empty" }, el("b", {}, "No certificate fits these names yet"), "Issue or upload one from the editor's Certificates dialog, then come back."), el("a", { class: "btn", href: "/?desktop=1" }, "Open certificates")); return; }
        select = el("select", {}, certs.map((cert, i) => el("option", { value: i }, `${cert.name} · ${cert.domains.join(", ")}${cert.valid ? "" : " (expired)"}`)));
        redirect = el("input", { type: "checkbox", checked: true });
        body.append(el("label", { class: "field" }, el("span", {}, "Certificate"), select), site.ssl ? null : el("label", { class: "check" }, redirect, "Send http visitors to https"));
      }, (foot, close) => {
        foot.append(el("button", { onclick: close }, "Cancel"));
        if (site.ssl) foot.append(el("button", { class: "danger", onclick: () => { close(); run(api("/api/sites/https/off", { id: site.id })); } }, "Turn HTTPS off"));
        if (certs.length) foot.append(el("button", { class: "primary", onclick: () => {
          const cert = certs[Number(select.value)];
          close(); run(api("/api/sites/https", { id: site.id, certificate: cert.path, key: cert.key_path, redirect: redirect ? redirect.checked : false }));
        } }, "Apply"));
      });
    };
    const features = (site) => {
      const on = new Set(site.features);
      sheet(`Features · ${site.names[0] || site.file}`, (body) => {
        const groups = {};
        for (const item of catalog.features) (groups[item.group] = groups[item.group] || []).push(item);
        body.append(el("p", { class: "muted", style: "margin:0" }, "Pick a feature to turn it on or change it. Every change is tested by nginx first and rolled back if it fails."),
          el("div", { class: "feature-groups" }, Object.entries(groups).map(([group, items]) => el("div", { class: "feature-group" }, el("h4", {}, group),
            el("div", { class: "features" }, items.map((item) => el("button", { class: `feature ${on.has(item.id) ? "on" : ""}`, onclick: () => { configure(site, item); } },
              el("span", { class: "ft" }, el("span", {}, item.icon), item.title, on.has(item.id) ? el("span", { class: "chip ok" }, "On") : null), el("small", {}, item.summary))))))));
      }, (foot, close) => foot.append(el("button", { class: "primary", onclick: close }, "Done")));
    };
    const configure = async (site, item) => {
      document.querySelectorAll("dialog.sheet").forEach((d) => d.remove());
      const on = site.features.includes(item.id);
      let users = [];
      if (item.id === "basic_auth") { try { users = (await api(`/api/htpasswd?slug=${encodeURIComponent(site.slug)}`)).users; } catch (error) { /* none yet */ } }
      const f = form(item.fields);
      sheet(`${item.icon} ${item.title}`, (body) => {
        body.append(el("p", { class: "muted", style: "margin:0" }, item.summary));
        if (on) body.append(el("span", { class: "chip ok" }, "Currently on. Saving replaces its settings."));
        if (users.length) body.append(el("div", { class: "muted" }, "Users: ", users.map((user) => el("span", { class: "chip", style: "margin-right:4px" }, user, el("button", { class: "ghost", style: "padding:0 4px", title: `Remove ${user}`, onclick: async (event) => {
          try { await api("/api/htpasswd/remove", { slug: site.slug, user }); event.target.closest(".chip").remove(); toast(`Removed ${user}`, "ok"); } catch (error) { toast(error.message, "bad"); } } }, "✕")))));
        if (item.fields.length) body.append(f.node);
      }, (foot, close) => {
        foot.append(el("button", { onclick: () => { close(); features(site); } }, "Back"));
        if (on) foot.append(el("button", { class: "danger", onclick: () => { close(); run(api("/api/features/disable", { id: site.id, feature: item.id })); } }, "Turn off"));
        foot.append(el("button", { class: "primary", onclick: () => { close(); run(api("/api/features/apply", { id: site.id, feature: item.id, values: f.values() })); } }, on ? "Update" : "Turn on"));
      });
    };
    await load();
  }

  // ------------------------------------------------------------------ topology

  async function topology() {
    const view = el("div", { class: "fade-in" });
    main.replaceChildren(head("Topology", "How visitors reach your apps. Hover a box to follow its path; click a site to manage it."), view);
    view.append(loading(1));
    let data;
    try { data = await api("/api/topology"); } catch (error) { view.replaceChildren(failed(error, topology)); return; }
    if (!data.nodes.length) { view.replaceChildren(el("div", { class: "empty card" }, el("span", { class: "big" }, "🕸"), el("b", {}, "Nothing to map yet"), "Add a site and it appears here.")); return; }
    const columns = { domain: 0, site: 1, pool: 2, app: 3, folder: 3, redirect: 3 };
    const titles = ["Domains", "Sites", "Pools", "Apps & files"];
    const groups = [[], [], [], []];
    for (const node of data.nodes) groups[columns[node.kind] ?? 3].push(node);
    groups[0].sort((a, b) => a.label.localeCompare(b.label));
    const rank = {};
    groups[0].forEach((node, i) => { rank[node.id] = i; });
    for (let c = 1; c < groups.length; c++) {
      // Order each column by where its parents sit, so the lines cross as little as possible.
      const mean = (node) => { const parents = data.edges.filter((e) => e[1] === node.id && rank[e[0]] !== undefined).map((e) => rank[e[0]]); return parents.length ? parents.reduce((a, b) => a + b, 0) / parents.length : 1e6; };
      groups[c].sort((a, b) => mean(a) - mean(b) || a.label.localeCompare(b.label));
      groups[c].forEach((node, i) => { rank[node.id] = i; });
    }
    const W = 190, H_ = 44, gapX = 90, gapY = 16, top = 34;
    const pos = {};
    groups.forEach((group, c) => group.forEach((node, r) => { pos[node.id] = { x: 14 + c * (W + gapX), y: top + r * (H_ + gapY) }; }));
    const height = top + Math.max(...groups.map((g) => g.length)) * (H_ + gapY) + 10, width = 28 + 4 * W + 3 * gapX;
    const NS = "http://www.w3.org/2000/svg";
    const s = (tag, attrs, ...kids) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v); kids.forEach((k) => n.append(k)); return n; };
    const svg = s("svg", { viewBox: `0 0 ${width} ${height}`, width, height, role: "img", "aria-label": "Topology of domains, sites and apps" });
    titles.forEach((title, c) => { const t = s("text", { class: "topo-col", x: 14 + c * (W + gapX), y: 18 }); t.textContent = title; svg.append(t); });
    const edgeEls = data.edges.map(([a, b]) => {
      const from = pos[a], to = pos[b];
      const x1 = from.x + W, y1 = from.y + H_ / 2, x2 = to.x, y2 = to.y + H_ / 2, mid = (x1 + x2) / 2;
      const path = s("path", { class: "topo-edge", d: `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}` });
      svg.append(path);
      return { a, b, path };
    });
    const nodeEls = {};
    const trim = (text, n) => text.length > n ? text.slice(0, n - 1) + "…" : text;
    for (const node of data.nodes) {
      const { x, y } = pos[node.id];
      const g = s("g", { class: `topo-node ${node.kind} ${node.state === "off" ? "off" : ""}`, transform: `translate(${x},${y})`, tabindex: node.kind === "site" ? 0 : -1 });
      g.append(s("rect", { width: W, height: H_, rx: 10 }));
      const label = s("text", { x: 12, y: node.sub ? 19 : 27 }); label.textContent = trim(node.label, 28); g.append(label);
      if (node.sub) { const sub = s("text", { class: "sub", x: 12, y: 34 }); sub.textContent = trim(node.sub, 34); g.append(sub); }
      const t = s("title"); t.textContent = node.label + (node.sub ? " · " + node.sub : ""); g.append(t);
      nodeEls[node.id] = g; svg.append(g);
      g.addEventListener("mouseenter", () => highlight(node.id)); g.addEventListener("mouseleave", () => highlight(null));
      if (node.kind === "site") { const open = () => { location.hash = "#/sites/" + encodeURIComponent(node.id.slice(5)); }; g.addEventListener("click", open); g.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); }); }
    }
    function highlight(id) {
      const hot = new Set();
      if (id) {
        hot.add(id);
        let changed = true;
        while (changed) { changed = false; for (const e of data.edges) { if (hot.has(e[0]) && !hot.has(e[1]) && direction(e[0], id)) { hot.add(e[1]); changed = true; } if (hot.has(e[1]) && !hot.has(e[0]) && !direction(e[1], id)) { hot.add(e[0]); changed = true; } } }
      }
      const colOf = (n) => columns[data.nodes.find((x) => x.id === n).kind] ?? 3;
      function direction(n, origin) { return colOf(n) >= colOf(origin); }
      for (const [nid, g] of Object.entries(nodeEls)) { g.classList.toggle("hot", !!id && hot.has(nid)); g.classList.toggle("dim", !!id && !hot.has(nid)); }
      for (const e of edgeEls) { const on = !!id && hot.has(e.a) && hot.has(e.b); e.path.classList.toggle("hot", on); e.path.classList.toggle("dim", !!id && !on); }
    }
    view.replaceChildren(el("div", { class: "topo-wrap" }, svg));
  }

  // ------------------------------------------------------------------ search

  function search() {
    const query = el("input", { type: "search", placeholder: "Search every config file…  (try proxy_pass, a domain, a port)", autofocus: true, "aria-label": "Search" });
    const regex = el("input", { type: "checkbox" }), cased = el("input", { type: "checkbox" });
    const results = el("div", { class: "fade-in" });
    main.replaceChildren(head("Search", "Find any setting across all your config files, including the ones that are turned off."),
      el("div", { class: "toolbar" }, query, el("label", { class: "check" }, regex, "Regex"), el("label", { class: "check" }, cased, "Match case")), results);
    const run = async () => {
      const text = query.value;
      if (!text.trim()) { results.replaceChildren(el("div", { class: "empty" }, el("span", { class: "big" }, "🔎"), el("b", {}, "Type to search"), "Results appear as you type.")); return; }
      try {
        const data = await api(`/api/search?q=${encodeURIComponent(text)}&regex=${regex.checked ? 1 : 0}&case=${cased.checked ? 1 : 0}`);
        if (!data.matches.length) { results.replaceChildren(el("div", { class: "empty" }, el("b", {}, "No matches"), `Searched ${data.files} files.`)); return; }
        const byFile = {};
        for (const hit of data.matches) (byFile[hit.file] = byFile[hit.file] || []).push(hit);
        results.replaceChildren(el("p", { class: "muted" }, `${data.matches.length}${data.truncated ? "+" : ""} matches in ${Object.keys(byFile).length} files`),
          ...Object.entries(byFile).map(([file, hits]) => el("div", { class: "card", style: "margin-bottom:10px;padding:8px 10px" },
            el("div", { class: "file-head" }, el("span", { class: "mono" }, file), el("span", { class: "grow" }), el("a", { href: `/?desktop=1#open=${encodeURIComponent(file)}` }, "Open")),
            hits.map((hit) => el("div", { class: "hit" }, el("code", {}, hit.text.slice(0, Math.max(0, hit.start)), el("mark", {}, hit.text.slice(Math.max(0, hit.start), Math.max(0, hit.end))), hit.text.slice(Math.max(0, hit.end))),
              el("small", { class: "muted" }, `line ${hit.line}`))))));
      } catch (error) { results.replaceChildren(el("div", { class: "empty" }, el("b", {}, "Cannot search"), error.message)); }
    };
    const soon = debounce(run, 200);
    query.addEventListener("input", soon); regex.addEventListener("change", run); cased.addEventListener("change", run);
    const q = new URLSearchParams(location.hash.split("?")[1] || "").get("q");
    if (q) query.value = q;
    run();
    query.focus();
  }

  // ------------------------------------------------------------------ templates

  async function templates() {
    const view = el("div", { class: "fade-in" });
    main.replaceChildren(head("Templates", "Start a new site in one step. Each template writes a normal config file you can edit later."), view);
    view.append(loading(2));
    let data;
    try { data = await api("/api/templates"); } catch (error) { view.replaceChildren(failed(error, templates)); return; }
    view.replaceChildren(el("div", { class: "templates" }, data.templates.map((item) => el("button", { class: "template", onclick: () => open(item) }, el("span", { class: "ic" }, item.icon), el("b", {}, item.title), el("span", {}, item.summary)))));
    function open(item) {
      const f = form(item.fields);
      sheet(`${item.icon} ${item.title}`, (body) => {
        body.append(el("p", { class: "muted", style: "margin:0" }, item.summary));
        if (item.fields.length) body.append(f.node); else body.append(el("p", {}, "No settings needed."));
      }, (foot, close) => foot.append(el("button", { onclick: close }, "Cancel"), el("button", { class: "primary", onclick: async (event) => {
        event.target.disabled = true;
        try {
          const result = await api("/api/templates/create", { template: item.id, values: f.values() });
          if (reportApply(result)) { close(); toast(result.note || "Created.", "ok", { label: "See sites", run: () => { location.hash = "#/sites"; } }); } else event.target.disabled = false;
        } catch (error) { toast(error.message, "bad"); event.target.disabled = false; }
      } }, "Create")));
    }
  }

  // ------------------------------------------------------------------ timeline

  async function timeline() {
    const view = el("div", { class: "fade-in" });
    main.replaceChildren(head("Timeline", "Every change, rejection and outside edit. It is kept across restarts."), view);
    view.append(loading(2));
    let data;
    try { data = await api("/api/timeline?limit=300"); } catch (error) { view.replaceChildren(failed(error, timeline)); return; }
    if (!data.events.length) { view.replaceChildren(el("div", { class: "empty card" }, el("span", { class: "big" }, "🕓"), el("b", {}, "No history yet"), "Save a change and it will be listed here.")); return; }
    const days = {};
    for (const event of data.events) (days[String(event.time).slice(0, 10)] = days[String(event.time).slice(0, 10)] || []).push(event);
    const line = el("div", { class: "timeline" });
    for (const [day, events] of Object.entries(days)) {
      line.append(el("div", { class: "day" }, day));
      for (const event of events) line.append(el("div", { class: `event ${event.kind || ""}` },
        el("div", { class: "et" }, event.title), el("div", { class: "muted" }, `${String(event.time).slice(11)} · ${ago(event.time)}`),
        el("div", { style: "white-space:pre-wrap" }, String(event.message || "").split("\nFiles:")[0]),
        event.files && event.files.length ? el("div", { class: "row wrap", style: "margin-top:6px" }, event.files.map((file) => el("a", { class: "chip", href: `/?desktop=1#open=${encodeURIComponent(file)}` }, file))) : null));
    }
    view.replaceChildren(line);
  }

  // ------------------------------------------------------------------ routing

  const pages = { status, sites, topology, search, templates, timeline };
  async function route() {
    if (cleanup) { cleanup(); cleanup = null; }
    const [path] = location.hash.slice(1).split("?");
    const [, name = "status", ...rest] = path.split("/");
    const page = pages[name] || status;
    document.querySelectorAll(".rail a[data-page]").forEach((a) => a.classList.toggle("active", a.dataset.page === (pages[name] ? name : "status")));
    document.title = `${(pages[name] ? name : "status").replace(/^./, (c) => c.toUpperCase())} · Lab`;
    await page(rest.length ? decodeURIComponent(rest.join("/")) : undefined);
    main.focus({ preventScroll: true });
  }
  addEventListener("hashchange", route);
  H.ready.then(route);
  addEventListener("keydown", (event) => {
    if (event.target.matches("input,textarea,select") || event.ctrlKey || event.metaKey || event.altKey) return;
    const keys = { 1: "status", 2: "sites", 3: "topology", 4: "search", 5: "templates", 6: "timeline" };
    if (keys[event.key]) location.hash = "#/" + keys[event.key];
  });
})();
