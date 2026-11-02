/* Command palette (Ctrl+K / Cmd+K / "/") for every page: jump anywhere, run common actions, find a site or file.
   Standalone: injects its own styles, talks to the API directly, and works inside the editor too. */
(() => {
  const css = `
  .pal-back{position:fixed;inset:0;z-index:200;background:rgba(8,10,14,.55);backdrop-filter:blur(3px);display:flex;justify-content:center;align-items:flex-start;padding:12vh 12px 0}
  .pal{width:min(620px,100%);background:var(--panel,#1a1e25);color:var(--text,#e7eaf0);border:1px solid var(--line,#2c333f);border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.45);overflow:hidden;animation:palIn .14s ease both;font:15px system-ui,-apple-system,"Segoe UI",sans-serif}
  @keyframes palIn{from{opacity:0;transform:translateY(-8px) scale(.98)}to{opacity:1;transform:none}}
  .pal input{width:100%;border:0;border-bottom:1px solid var(--line,#2c333f);background:transparent;color:inherit;font:inherit;font-size:1.05rem;padding:16px 18px;outline:none}
  .pal ul{list-style:none;margin:0;padding:6px;max-height:50vh;overflow:auto}
  .pal li{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:9px;cursor:pointer}
  .pal li[aria-selected=true]{background:color-mix(in srgb,var(--accent,#f06a3a) 22%,transparent)}
  .pal li .ic{width:22px;text-align:center;opacity:.85}.pal li .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pal li .h{color:var(--muted,#8b95a3);font-size:.82rem;white-space:nowrap}
  .pal .none{padding:22px;text-align:center;color:var(--muted,#8b95a3)}
  .pal .foot{display:flex;gap:14px;padding:8px 14px;border-top:1px solid var(--line,#2c333f);color:var(--muted,#8b95a3);font-size:.78rem}
  .pal kbd{font:inherit;font-size:.75rem;border:1px solid var(--line,#2c333f);border-radius:5px;padding:0 5px;background:var(--panel-2,#222731)}`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);

  const post = async (path) => {
    const response = await fetch(path, { method: "POST", headers: { "X-Requested-With": "nginx-autohandler", "Content-Type": "application/json" }, body: "{}" });
    return { ok: response.ok, data: await response.json().catch(() => ({})) };
  };
  const say = (message, kind) => (window.H ? H.toast(message, kind) : (window.toast ? window.toast(message) : console.log(message)));
  const showText = (title, text) => (window.H ? H.showOutput(title, text) : alert(title + "\n\n" + text));
  const extra = [];
  let cache = { at: 0, items: [] };

  const go = (url) => () => { location.href = url; };
  const base = () => [
    { icon: "📊", title: "Status and traffic", hint: "Lab", run: go("/lab#/status") },
    { icon: "🧩", title: "Sites and features", hint: "Lab", run: go("/lab#/sites") },
    { icon: "🕸", title: "Topology map", hint: "Lab", run: go("/lab#/topology") },
    { icon: "🔎", title: "Search all configs", hint: "Lab", run: go("/lab#/search") },
    { icon: "✨", title: "New site from a template", hint: "Lab", run: go("/lab#/templates") },
    { icon: "🕓", title: "Timeline of changes", hint: "Lab", run: go("/lab#/timeline") },
    { icon: "✏️", title: "Open the editor", hint: "Go", run: go("/?desktop=1") },
    { icon: "📱", title: "Open the phone view", hint: "Go", run: go("/m") },
    { icon: "✅", title: "Test the nginx config", hint: "Action", run: async () => {
      say("Testing…"); const { ok, data } = await post("/api/test");
      if (data.ok) say("nginx config test passed", "ok"); else showText("nginx config test failed", data.output || data.error || "");
      return ok; } },
    { icon: "🔁", title: "Reload nginx", hint: "Action", run: async () => {
      say("Reloading…"); const { ok, data } = await post("/api/reload");
      if (ok && data.ok !== false) say("nginx reloaded", "ok"); else showText("Reload failed", data.output || data.error || ""); } },
    { icon: "🌗", title: "Switch light / dark", hint: "Action", run: () => (window.H ? H.toggleTheme() : document.getElementById("btnTheme")?.click()) },
    ...[["btnCerts", "🔐", "Certificates"], ["btnDns", "🌍", "DNS"], ["btnGit", "🔀", "Git sync"], ["btnTasks", "⏳", "Background tasks"], ["btnActivity", "📰", "Recent activity"]]
      .filter(([id]) => document.getElementById(id)).map(([id, icon, title]) => ({ icon, title, hint: "Editor", run: () => document.getElementById(id).click() })),
  ];

  async function dynamic() {
    if (Date.now() - cache.at < 20000) return cache.items;
    const items = [];
    try {
      const response = await fetch("/api/sites");
      if (response.ok) for (const site of (await response.json()).sites) {
        items.push({ icon: "🌐", title: site.names.join(", ") || site.file, hint: site.file, run: go(`/lab#/sites/${encodeURIComponent(site.id)}`) });
        items.push({ icon: "📄", title: site.file, hint: "Open in editor", run: go(`/?desktop=1#open=${encodeURIComponent(site.file)}`), skipDuplicate: site.file });
      }
    } catch (error) { /* offline: the built-in commands still work */ }
    const seen = new Set();
    cache = { at: Date.now(), items: items.filter((item) => !item.skipDuplicate || (!seen.has(item.skipDuplicate) && seen.add(item.skipDuplicate))) };
    return cache.items;
  }

  const score = (query, text) => {
    text = text.toLowerCase();
    let at = 0, points = 0;
    for (const ch of query) {
      const found = text.indexOf(ch, at);
      if (found < 0) return -1;
      points += found === at ? 3 : 1;
      at = found + 1;
    }
    return points - text.length / 100 + (text.startsWith(query) ? 10 : 0);
  };

  function open() {
    if (document.querySelector(".pal-back")) return;
    const input = document.createElement("input");
    input.placeholder = "Type a command, site or file…";
    input.setAttribute("aria-label", "Command palette");
    const list = document.createElement("ul");
    list.setAttribute("role", "listbox");
    const back = document.createElement("div");
    back.className = "pal-back";
    const box = document.createElement("div");
    box.className = "pal";
    box.innerHTML = '<div class="foot"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>Enter</kbd> run</span><span><kbd>Esc</kbd> close</span></div>';
    box.prepend(input, list);
    back.append(box);
    document.body.append(back);
    let items = [...base(), ...extra.flatMap((fn) => fn())], shown = [], index = 0;
    const render = () => {
      const query = input.value.trim().toLowerCase();
      shown = (query ? items.map((item) => ({ item, s: score(query, item.title + " " + item.hint) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).map((x) => x.item) : items).slice(0, 40);
      index = Math.min(index, Math.max(0, shown.length - 1));
      list.replaceChildren(...shown.map((item, i) => {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", String(i === index));
        li.innerHTML = '<span class="ic"></span><span class="t"></span><span class="h"></span>';
        li.children[0].textContent = item.icon;
        li.children[1].textContent = item.title;
        li.children[2].textContent = item.hint;
        li.addEventListener("mousemove", () => { if (index !== i) { index = i; render(); } });
        li.addEventListener("click", () => run(item));
        return li;
      }));
      if (!shown.length) list.innerHTML = '<div class="none">Nothing matches.</div>';
      list.children[index]?.scrollIntoView?.({ block: "nearest" });
    };
    const close = () => back.remove();
    const run = (item) => { close(); Promise.resolve(item.run()).catch((error) => say(error.message, "bad")); };
    input.addEventListener("input", () => { index = 0; render(); });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close();
      else if (event.key === "ArrowDown") { event.preventDefault(); index = (index + 1) % Math.max(1, shown.length); render(); }
      else if (event.key === "ArrowUp") { event.preventDefault(); index = (index - 1 + shown.length) % Math.max(1, shown.length); render(); }
      else if (event.key === "Enter" && shown[index]) run(shown[index]);
    });
    back.addEventListener("mousedown", (event) => { if (event.target === back) close(); });
    render();
    input.focus();
    dynamic().then((more) => { if (document.body.contains(back)) { items = [...items, ...more]; render(); } });
  }

  document.addEventListener("keydown", (event) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable;
    if ((event.key.toLowerCase() === "k" && (event.ctrlKey || event.metaKey)) || (event.key === "/" && !typing && !event.ctrlKey && !event.metaKey)) {
      event.preventDefault();
      open();
    }
  });
  window.Palette = { open, register: (fn) => extra.push(fn) };

  // Deep link into the editor: /?desktop=1#open=conf.d/site.conf
  const wanted = /^#open=(.+)$/.exec(location.hash);
  if (wanted && document.getElementById("btnCerts")) {
    const path = decodeURIComponent(wanted[1]);
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (typeof window.openFile === "function" && typeof state !== "undefined" && state.doc) {
        clearInterval(timer);
        history.replaceState(null, "", location.pathname + location.search);
        Promise.resolve(window.openFile(path)).catch(() => {});
      } else if (tries > 80) clearInterval(timer);
    }, 250);
  }
})();
