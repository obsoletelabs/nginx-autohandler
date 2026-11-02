/* Phone view: status, sites (toggle, edit domain and target, HTTPS), certificates, background tasks and logs. */
(() => {
  const { api, el, toast, sheet, showOutput, number, ago, form, reportApply } = H;
  const main = document.getElementById("main");
  const title = document.getElementById("title");
  const badge = document.getElementById("taskBadge");
  let cleanup = null;
  document.getElementById("theme").addEventListener("click", H.toggleTheme);
  try { sessionStorage.removeItem("ham-desktop"); } catch (error) { /* storage blocked */ }

  const skeleton = () => el("div", { class: "stack" }, [1, 2, 3].map(() => el("div", { class: "skeleton", style: "height:90px" })));
  const failed = (error, retry) => el("div", { class: "empty" }, el("span", { class: "big" }, "📡"), el("b", {}, "Cannot reach the server"), error.message, el("div", { style: "margin-top:12px" }, el("button", { onclick: retry }, "Try again")));
  const busy = (button, fn) => async () => { button.disabled = true; try { await fn(); } finally { button.disabled = false; } };

  // ------------------------------------------------------------------ status

  async function status() {
    main.replaceChildren(skeleton());
    const load = async () => {
      try {
        const [overview, stats] = await Promise.all([api("/api/overview?test=1"), api("/api/stats?hours=24").catch(() => null)]);
        const test = overview.nginx && overview.nginx.test;
        const ok = test ? test.ok : null;
        const test_btn = el("button", {}, "✅ Test config"), reload_btn = el("button", { class: "primary" }, "🔁 Reload");
        test_btn.onclick = busy(test_btn, async () => { const r = await api("/api/test", {}); if (r.ok) toast("Config test passed", "ok"); else showOutput("Config test failed", r.output, "bad"); });
        reload_btn.onclick = busy(reload_btn, async () => {
          if (!confirm("Test and reload nginx now?")) return;
          try { const r = await api("/api/reload", {}); if (r.ok === false) showOutput("Reload failed", r.output, "bad"); else toast("nginx reloaded", "ok"); } catch (error) { showOutput("Reload failed", error.message, "bad"); }
        });
        const max = stats ? Math.max(1, ...stats.series.map((item) => item.requests)) : 1;
        main.replaceChildren(el("div", { class: "stack fade-in" },
          el("div", { class: "card hero" }, el("span", { class: `light ${ok === null ? "" : ok ? "ok" : "bad"}` }),
            el("div", { class: "grow" }, el("b", {}, ok === null ? "Status unknown" : ok ? "nginx is healthy" : "Config has an error"), el("span", { class: "muted" }, overview.nginx.version || "")),
            ),
          ok === false ? el("pre", { class: "out" }, test.output) : null,
          el("div", { class: "big-actions" }, test_btn, reload_btn),
          el("div", { class: "kpis" },
            el("div", { class: "card kpi" }, el("b", {}, overview.counts.servers), el("small", {}, "sites live")),
            el("div", { class: "card kpi" }, el("b", {}, overview.counts.domains), el("small", {}, "domains")),
            el("div", { class: "card kpi" }, el("b", { style: overview.counts.certs_attention ? "color:var(--warn)" : "" }, overview.counts.certs_attention), el("small", {}, "certs to check"))),
          stats ? el("div", { class: "card" }, el("div", { class: "row" }, el("b", { class: "grow" }, "Traffic, 24 h"), el("span", { class: "muted" }, `${number(stats.total)} requests · ${number(stats.status["5xx"] || 0)} errors`)),
            el("div", { class: "spark" }, stats.series.map((item) => el("i", { style: `height:${Math.max(4, (item.requests / max) * 100)}%` })))) : null,
          el("div", { class: "card" }, el("b", {}, "Recent activity"),
            overview.activity.length ? overview.activity.slice(0, 5).map((event) => el("div", { style: "padding:8px 0;border-top:1px solid var(--line);margin-top:8px" }, el("div", {}, event.title), el("small", { class: "muted" }, ago(event.time)))) : el("div", { class: "muted", style: "margin-top:6px" }, "Nothing yet."))));
      } catch (error) { main.replaceChildren(failed(error, load)); }
    };
    await load();
    const timer = setInterval(load, 30000);
    cleanup = () => clearInterval(timer);
  }

  // ------------------------------------------------------------------ sites

  async function sites() {
    main.replaceChildren(skeleton());
    const load = async () => {
      try {
        const data = await api("/api/sites");
        if (!data.sites.length) { main.replaceChildren(el("div", { class: "empty" }, el("span", { class: "big" }, "🌱"), el("b", {}, "No sites yet"), "Create one from the Lab templates on a bigger screen.")); return; }
        main.replaceChildren(el("div", { class: "stack fade-in" }, data.sites.map((site) => {
          const toggle = el("input", { type: "checkbox", checked: site.enabled, "aria-label": `Turn ${site.names[0] || site.file} on or off` });
          toggle.addEventListener("click", (event) => event.stopPropagation());
          toggle.addEventListener("change", async () => {
            toggle.disabled = true;
            try { const r = await api("/api/config/toggle", { path: site.file, enabled: toggle.checked }); toast(toggle.checked ? "Turned on" : "Turned off", "ok"); if (r.ok === false) throw new Error(r.output || "nginx rejected it"); }
            catch (error) { toast(error.message, "bad"); }
            await load();
          });
          const card = el("div", { class: `item tap ${site.enabled ? "" : "off"}` },
            el("div", { class: "top" }, el("b", {}, site.names.join(", ") || site.file), el("label", { class: "switch", onclick: (event) => event.stopPropagation() }, toggle, el("i"))),
            el("div", { class: "chips" }, el("span", { class: `chip ${site.ssl ? "ok" : "warn"}` }, site.ssl ? "🔒 HTTPS" : "HTTP"),
              site.forward ? el("span", { class: "chip accent" }, "→ " + site.forward) : null, site.root ? el("span", { class: "chip" }, "📁 " + site.root) : null, site.redirect ? el("span", { class: "chip" }, "↪ " + site.redirect.split(" ").slice(1).join(" ")) : null,
              site.features.length ? el("span", { class: "chip" }, `${site.features.length} features`) : null));
          card.addEventListener("click", () => edit(site, load));
          return card;
        })));
      } catch (error) { main.replaceChildren(failed(error, load)); }
    };
    H.whenUndone(() => load());
    await load();
  }

  function edit(site, reload) {
    let names, target;
    const run = async (request) => { try { const r = await request; if (reportApply(r)) reload(); } catch (error) { toast(error.message, "bad"); } };
    sheet(site.names[0] || site.file, (body) => {
      names = el("input", { value: site.names.join(" "), spellcheck: "false", autocapitalize: "off", inputmode: "url" });
      target = el("input", { value: site.forward, spellcheck: "false", autocapitalize: "off", inputmode: "url", disabled: !site.forward, placeholder: site.forward ? "" : "Does not forward to an app" });
      body.append(el("label", { class: "field" }, el("span", {}, "Domain names"), names), el("label", { class: "field" }, el("span", {}, "Forward to"), target),
        el("div", { class: "muted" }, site.file),
        el("button", { onclick: async (event) => { event.target.disabled = true; sheetClose(); https(site, reload); } }, site.ssl ? "🔒 Change HTTPS" : "🔒 Enable HTTPS"));
    }, (foot, close) => {
      sheetClose = close;
      foot.append(el("button", { onclick: close }, "Cancel"), el("button", { class: "primary", onclick: () => {
        const body = { id: site.id, names: names.value };
        if (site.forward) body.forward = target.value;
        close(); run(api("/api/sites/update", body));
      } }, "Save"));
    });
  }
  let sheetClose = () => {};

  async function https(site, reload) {
    let matches;
    try { matches = await api(`/api/certs/match?names=${encodeURIComponent(site.names.join(","))}`); } catch (error) { toast(error.message, "bad"); return; }
    const certs = matches.certificates || [];
    let select, redirect;
    sheet("HTTPS", (body) => {
      if (!certs.length) { body.append(el("div", { class: "empty" }, el("b", {}, "No certificate fits yet"), "Issue one from the Certs tab on the desktop first.")); return; }
      select = el("select", {}, certs.map((cert, i) => el("option", { value: i }, `${cert.name}${cert.valid ? "" : " (expired)"}`)));
      redirect = el("input", { type: "checkbox", checked: true });
      body.append(el("label", { class: "field" }, el("span", {}, "Certificate"), select), site.ssl ? null : el("label", { class: "check" }, redirect, "Send http visitors to https"));
    }, (foot, close) => {
      foot.append(el("button", { onclick: close }, "Cancel"));
      const run = async (request) => { close(); try { const r = await request; if (reportApply(r)) reload(); } catch (error) { toast(error.message, "bad"); } };
      if (site.ssl) foot.append(el("button", { class: "danger", onclick: () => run(api("/api/sites/https/off", { id: site.id })) }, "Turn off"));
      if (certs.length) foot.append(el("button", { class: "primary", onclick: () => { const cert = certs[Number(select.value)]; run(api("/api/sites/https", { id: site.id, certificate: cert.path, key: cert.key_path, redirect: redirect ? redirect.checked : false })); } }, "Apply"));
    });
  }

  // ------------------------------------------------------------------ certificates

  async function certs() {
    main.replaceChildren(skeleton());
    const load = async () => {
      try {
        const data = await api("/api/certs");
        if (!data.certificates.length) { main.replaceChildren(el("div", { class: "empty" }, el("span", { class: "big" }, "🔐"), el("b", {}, "No certificates"), "Issue one from the desktop editor.")); return; }
        main.replaceChildren(el("div", { class: "stack fade-in" }, data.certificates.map((cert) => {
          const days = cert.days_left;
          const kind = days === null ? "" : days <= 0 ? "bad" : days <= (data.warn_days || 14) ? "soon" : "";
          const again = cert.read_only ? null : el("button", { onclick: async (event) => {
            event.target.disabled = true;
            try { const r = await api("/api/certs/reissue", { name: cert.name }); toast(r.message || "Done", r.ok ? "ok" : "bad"); await load(); } catch (error) { toast(error.message, "bad"); event.target.disabled = false; }
          } }, "Renew now");
          return el("div", { class: "item" }, el("div", { class: "top" }, el("b", {}, cert.name), el("span", { class: `chip ${kind === "bad" ? "bad" : kind === "soon" ? "warn" : "ok"}` }, days === null ? "unknown" : days <= 0 ? "expired" : `${days} days`)),
            el("div", { class: `bar ${kind}` }, el("i", { style: `width:${days === null ? 0 : Math.max(3, Math.min(100, (days / 90) * 100))}%` })),
            el("div", { class: "muted", style: "word-break:break-all" }, cert.domains.join(", ")),
            el("div", { class: "chips" }, el("span", { class: "chip" }, cert.kind || "certificate"), cert.staging ? el("span", { class: "chip warn" }, "staging") : null, again));
        })));
      } catch (error) { main.replaceChildren(failed(error, load)); }
    };
    await load();
  }

  // ------------------------------------------------------------------ tasks

  async function tasks() {
    main.replaceChildren(skeleton());
    const load = async () => {
      try {
        const data = await api("/api/tasks");
        if (!data.tasks.length) { main.replaceChildren(el("div", { class: "empty" }, el("span", { class: "big" }, "😌"), el("b", {}, "Nothing running"), "Certificate requests, git syncs and DNS updates show up here.")); return; }
        main.replaceChildren(el("div", { class: "stack fade-in" }, data.tasks.map((task) => el("div", { class: "item" },
          el("div", { class: "top" }, el("span", { class: `dot ${task.state === "running" ? "warn" : task.state === "failed" ? "bad" : "ok"}` }), el("b", {}, task.title), el("span", { class: "chip" }, task.state === "running" ? `${Math.round(task.seconds)}s…` : task.state)),
          task.detail ? el("div", { class: "muted" }, task.detail) : null, task.error ? el("pre", { class: "out" }, task.error) : null, el("small", { class: "muted" }, task.started)))));
      } catch (error) { main.replaceChildren(failed(error, load)); }
    };
    await load();
    const timer = setInterval(load, 3000);
    cleanup = () => clearInterval(timer);
  }

  // ------------------------------------------------------------------ logs

  async function logs() {
    main.replaceChildren(skeleton());
    let list;
    try { list = (await api("/api/logs")).logs.filter((item) => item.group === "nginx" || item.group === "app"); } catch (error) { main.replaceChildren(failed(error, logs)); return; }
    if (!list.length) { main.replaceChildren(el("div", { class: "empty" }, el("b", {}, "No logs yet"))); return; }
    const select = el("select", { "aria-label": "Log file" }, list.map((item) => el("option", { value: item.id }, `${item.id}`)));
    const filter = el("input", { type: "search", placeholder: "Filter lines", autocapitalize: "off", spellcheck: "false" });
    const box = el("div", { class: "logbox", role: "log" });
    const live = el("input", { type: "checkbox", checked: true });
    const read = async () => {
      try {
        const data = await api(`/api/logs/read?id=${encodeURIComponent(select.value)}&lines=150&contains=${encodeURIComponent(filter.value)}`);
        const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
        box.replaceChildren(...(data.lines.length ? data.lines : ["(nothing to show)"]).map((line) => el("div", { class: /\[(error|crit|emerg|alert)\]| 5\d\d /.test(line) ? "e" : /\[warn\]| 4\d\d /.test(line) ? "w" : "" }, line)));
        if (stick) box.scrollTop = box.scrollHeight;
      } catch (error) { box.replaceChildren(error.message); }
    };
    select.addEventListener("change", () => { read().then(() => { box.scrollTop = box.scrollHeight; }); });
    filter.addEventListener("input", H.debounce(read, 300));
    main.replaceChildren(el("div", { class: "stack fade-in" }, select, filter, el("label", { class: "check" }, live, "Follow new lines"), box));
    await read();
    box.scrollTop = box.scrollHeight;
    const timer = setInterval(() => { if (live.checked && !document.hidden) read(); }, 4000);
    cleanup = () => clearInterval(timer);
  }

  // ------------------------------------------------------------------ routing and the task badge

  const pages = { status, sites, certs, tasks, logs };
  const names = { status: "Status", sites: "Sites", certs: "Certificates", tasks: "Tasks", logs: "Logs" };
  async function route() {
    if (cleanup) { cleanup(); cleanup = null; }
    const name = pages[location.hash.replace(/^#\//, "")] ? location.hash.replace(/^#\//, "") : "status";
    title.textContent = names[name];
    document.querySelectorAll(".mnav a").forEach((a) => a.classList.toggle("active", a.dataset.page === name));
    window.scrollTo(0, 0);
    await pages[name]();
  }
  async function pollBadge() {
    try { const data = await api("/api/tasks"); badge.hidden = !data.running; badge.textContent = data.running; } catch (error) { /* the page itself reports connection problems */ }
  }
  addEventListener("hashchange", route);
  H.ready.then(route);
  pollBadge();
  setInterval(pollBadge, 10000);
})();
