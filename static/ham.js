/* Shared helpers for the Lab and phone pages: api(), el(), toast(), sheet(), formatting, theme. No build step. */
(() => {
  const THEME_KEY = "nginx-autohandler-theme";
  try { const saved = localStorage.getItem(THEME_KEY); if (saved) document.documentElement.dataset.theme = saved; } catch (error) { /* storage blocked */ }

  async function api(path, body, method) {
    const options = { headers: { "X-Requested-With": "nginx-autohandler" } };
    if (body !== undefined) { options.method = method || "POST"; options.headers["Content-Type"] = "application/json"; options.body = JSON.stringify(body); }
    else if (method) options.method = method;
    let response;
    try { response = await fetch(path, options); } catch (error) { throw new Error("Could not reach the server. Check your connection."); }
    let data = {};
    try { data = await response.json(); } catch (error) { /* empty body */ }
    if (!response.ok) { const err = new Error(data.error || `Request failed (${response.status})`); err.status = response.status; throw err; }
    return data;
  }

  function el(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === false || value === null || value === undefined) continue;
      if (key === "class") node.className = value;
      else if (key === "html") node.innerHTML = value;
      else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return node;
  }

  let toastBox;
  function toast(message, kind = "info", action) {
    if (!toastBox) { toastBox = el("div", { class: "toasts", "aria-live": "polite" }); document.body.append(toastBox); }
    const node = el("div", { class: `toast ${kind}` }, el("span", {}, message));
    let timer;
    const close = () => { clearTimeout(timer); node.remove(); };
    if (action) node.append(el("button", { onclick: () => { close(); action.run(); } }, action.label));
    toastBox.append(node);
    timer = setTimeout(close, action ? 9000 : kind === "bad" ? 8000 : 4500);
    return close;
  }

  /** A modal sheet. Returns {dialog, body, close}. `build(body, api)` fills it; resolve with api.done(value). */
  function sheet(title, build, footer) {
    const dialog = el("dialog", { class: "sheet" });
    const body = el("div", { class: "sheet-body" });
    const foot = el("div", { class: "sheet-foot" });
    const close = () => { dialog.close(); dialog.remove(); };
    dialog.append(el("div", { class: "sheet-head" }, el("h2", {}, title), el("button", { class: "ghost", "aria-label": "Close", onclick: close }, "✕")), body, foot);
    dialog.addEventListener("cancel", () => setTimeout(() => dialog.remove(), 0));
    document.body.append(dialog);
    build(body, { close, foot });
    if (footer) footer(foot, close);
    dialog.showModal();
    return { dialog, body, foot, close };
  }

  function showOutput(title, text, kind) {
    return sheet(title, (body) => {
      if (kind) body.append(el("span", { class: `chip ${kind}` }, kind === "ok" ? "Success" : kind === "warn" ? "Needs attention" : "Failed"));
      body.append(el("pre", { class: "out" }, text || "(no output)"));
    }, (foot, close) => foot.append(el("button", { class: "primary", onclick: close }, "OK")));
  }

  const bytes = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;
  const number = (n) => Number(n).toLocaleString();
  // The server stamps events in its own local time. Learn its clock once so "5 min ago" is right in any time zone.
  let clock = null;
  const ready = fetch("/api/clock").then((r) => r.json()).then((c) => { clock = { skew: c.epoch * 1000 - Date.now(), offset: c.utc_offset }; }).catch(() => {});
  const ago = (stamp) => {
    const m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)/.exec(String(stamp));
    if (!m) return stamp || "";
    const naive = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    const then = clock ? naive - clock.offset * 1000 : new Date(String(stamp).replace(" ", "T")).getTime();
    const s = Math.max(0, ((clock ? Date.now() + clock.skew : Date.now()) - then) / 1000);
    return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`;
  };
  function toggleTheme() {
    const dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch (error) { /* storage blocked */ }
  }
  const debounce = (fn, ms = 250) => { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; };

  /** Fields from a feature or template spec -> {node, values()}. */
  function form(fields, initial = {}) {
    const inputs = {};
    const node = el("div", { class: "stack" });
    for (const spec of fields) {
      let input;
      const start = initial[spec.name] !== undefined ? initial[spec.name] : spec.default;
      if (spec.type === "bool") { input = el("input", { type: "checkbox" }); input.checked = !!start; node.append(el("label", { class: "check" }, input, spec.label)); inputs[spec.name] = () => input.checked; continue; }
      if (spec.type === "select") { input = el("select", {}, spec.options.map(([value, label]) => el("option", { value }, label))); input.value = start; }
      else if (spec.type === "lines") { input = el("textarea", { rows: 4 }); input.value = Array.isArray(start) ? start.join("\n") : start; }
      else if (spec.type === "int") { input = el("input", { type: "number", min: spec.min, max: spec.max }); input.value = start; }
      else if (spec.type === "password") { input = el("input", { type: "password", autocomplete: "new-password", placeholder: "Leave empty to keep the current one" }); }
      else { input = el("input", { type: "text", autocomplete: "off", spellcheck: "false" }); input.value = start; }
      inputs[spec.name] = () => input.value;
      node.append(el("label", { class: "field" }, el("span", {}, spec.label), input, spec.help ? el("small", {}, spec.help) : null));
    }
    return { node, values: () => Object.fromEntries(Object.entries(inputs).map(([name, read]) => [name, read()])) };
  }

  /** A human line for an apply result, and whether it worked. */
  function describeApply(result) {
    if (result.needs_certificates) return { kind: "warn", text: "A certificate needs to be chosen first. Use the main editor to answer that question." };
    if (!result.ok) return { kind: "bad", text: "nginx rejected the change, so nothing was changed.\n\n" + (result.output || "") };
    if (!result.saved) return { kind: "info", text: "Nothing changed." };
    if (result.warning) return { kind: "warn", text: result.warning };
    return { kind: "ok", text: result.reloaded ? "Saved and nginx reloaded." : "Saved. Automatic reload is off, so nginx was not reloaded." };
  }
  function reportApply(result) {
    const info = describeApply(result);
    if (info.kind === "bad") showOutput("Change rejected", info.text, "bad"); else toast(info.text, info.kind);
    return info.kind !== "bad";
  }

  window.H = { ready, api, el, toast, sheet, showOutput, bytes, number, ago, toggleTheme, debounce, form, describeApply, reportApply };
})();
