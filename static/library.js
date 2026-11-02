"use strict";

// Block library: the "Ready-made sections" in the Blocks tab. Built-in sections ship with the editor; users add
// their own (from the selection, or written from scratch), edit and delete them. They are kept on the server
// (/api/recipes), so they are there for every browser.

const BLOCK_SCOPES = [
  ["server", "Inside a site (server)"], ["location", "Inside a location"], ["http", "Among the sites (http)"], ["main", "Top of the file"],
  ["upstream", "Inside an upstream"], ["events", "Inside events"], ["stream", "Inside stream"], ["any", "Anywhere"],
];
const BLOCK = { id: "", title: "", hint: "", scope: "server", source: "", problem: "", checking: false, timer: 0, seq: 0 };

async function refreshRecipes() {
  const settings = await api("/api/palette");
  state.recipes = settings.recipes || [];
  renderPalette();
}

// ---------------------------------------------------------------- the list in the Blocks tab

function recipeRow(recipe) {
  prepareRecipe(recipe);
  const main = el("button", { class: "recipe-button", title: recipe.hint, "data-recipe": recipe.id, onclick: action(() => addRecipe(recipe)) },
    el("strong", { text: recipe.title }), el("small", { text: recipe.hint }));
  const actions = recipe.custom
    ? [el("button", { class: "tiny", type: "button", title: "Edit this block", "aria-label": "Edit " + recipe.title, text: "✎", onclick: () => openBlockDialog(recipe) }),
      el("button", { class: "tiny danger", type: "button", title: "Delete this block", "aria-label": "Delete " + recipe.title, text: "×", onclick: () => deleteBlock(recipe).catch(report) })]
    : [el("button", { class: "tiny", type: "button", title: "Make your own copy that you can change", "aria-label": "Duplicate " + recipe.title + " to edit", text: "⧉ Duplicate to edit", onclick: () => openBlockDialog({ ...recipe, id: "", custom: false, title: recipe.title + " (copy)" }) })];
  return el("div", { class: "recipe-row" + (recipe.custom ? " mine" : "") }, main, el("span", { class: "recipe-actions" }, ...actions));
}

renderRecipes = function (box, search) {
  const recipes = (state.recipes || []).filter((r) => (r.title + " " + (r.hint || "")).toLowerCase().includes(search));
  const head = el("div", { class: "palette-group-title with-action" }, el("span", { text: "READY-MADE SECTIONS" }),
    el("button", { class: "tiny", type: "button", text: "＋ New block", title: "Write a block of your own", onclick: () => openBlockDialog() }));
  box.append(head);
  const mine = recipes.filter((r) => r.custom);
  const built = recipes.filter((r) => !r.custom);
  if (mine.length) {
    box.append(el("div", { class: "palette-subtitle", text: "My blocks" }));
    for (const recipe of mine) box.append(recipeRow(recipe));
    if (built.length) box.append(el("div", { class: "palette-subtitle", text: "Built in" }));
  }
  for (const recipe of built) box.append(recipeRow(recipe));
  if (!recipes.length) box.append(el("p", { class: "field-hint", text: search ? "No block matches that search." : "No blocks yet." }));
  box.append(el("div", { class: "palette-group-title", text: "INDIVIDUAL DIRECTIVES" }));
};

// ---------------------------------------------------------------- the editor dialog

function scopeFor(hit) {
  const parent = hit.parent ? locate(hit.parent) : null;
  const name = parent ? parent.node.name : state.doc.context;
  return BLOCK_SCOPES.some(([value]) => value === name) ? name : "any";
}

function openBlockDialog(recipe) {
  Object.assign(BLOCK, { id: recipe && recipe.custom ? recipe.id : "", title: recipe ? recipe.title : "", hint: recipe ? recipe.hint || "" : "", scope: recipe ? recipe.scope || "server" : "server", source: recipe ? recipe.source || "" : "", problem: "", checking: false });
  $("#blockTitle").textContent = BLOCK.id ? "Edit block" : "New block";
  paintBlockDialog();
  if (!$("#dlgBlock").open) $("#dlgBlock").showModal();
  checkBlockSource();
  setTimeout(() => { const first = $("#blockName"); if (first) first.focus(); }, 0);
}

function paintBlockDialog() {
  const name = el("input", { id: "blockName", type: "text", maxlength: "60", value: BLOCK.title, placeholder: "e.g. Admin only", "aria-label": "Block name" });
  name.addEventListener("input", () => { BLOCK.title = name.value; updateBlockSave(); });
  const hint = el("input", { id: "blockHint", type: "text", maxlength: "200", value: BLOCK.hint, placeholder: "What it does, in a few words", "aria-label": "Description" });
  hint.addEventListener("input", () => { BLOCK.hint = hint.value; });
  const scope = el("select", { id: "blockScope", "aria-label": "Where it goes" }, BLOCK_SCOPES.map(([value, text]) => el("option", { value, text })));
  scope.value = BLOCK.scope;
  scope.addEventListener("change", () => { BLOCK.scope = scope.value; });
  const code = el("textarea", { id: "blockSource", class: "block-source", rows: "9", spellcheck: "false", placeholder: "allow 192.168.0.0/16;\ndeny all;", "aria-label": "nginx code" });
  code.value = BLOCK.source;
  code.addEventListener("input", () => { BLOCK.source = code.value; BLOCK.checking = true; updateBlockSave(); clearTimeout(BLOCK.timer); BLOCK.timer = setTimeout(checkBlockSource, 350); });
  $("#blockBody").replaceChildren(
    el("label", { class: "field" }, el("span", { text: "Name" }), name),
    el("label", { class: "field" }, el("span", { text: "Description (optional)" }), hint),
    el("label", { class: "field" }, el("span", { text: "Where it can be placed" }), scope),
    el("label", { class: "field" }, el("span", { text: "nginx code" }), code),
    el("div", { id: "blockCheck", class: "block-check" }));
  updateBlockSave();
}

async function checkBlockSource() {
  const mine = ++BLOCK.seq;
  const text = BLOCK.source;
  const box = $("#blockCheck");
  if (!text.trim()) { BLOCK.problem = "Write some nginx code first."; BLOCK.checking = false; paintBlockCheck(null); return; }
  try {
    const parsed = await api("/api/parse", { text, path: "block" });
    if (mine !== BLOCK.seq) return;
    BLOCK.problem = parsed.nodes.length ? "" : "That has no nginx code in it.";
    BLOCK.checking = false;
    paintBlockCheck(parsed.nodes.length ? parsed.nodes : null);
  } catch (error) {
    if (mine !== BLOCK.seq) return;
    BLOCK.problem = describeError(error).summary;
    BLOCK.checking = false;
    paintBlockCheck(null);
  }
  if (!box) return;
}

function paintBlockCheck(nodes) {
  const box = $("#blockCheck");
  if (!box) return;
  const count = nodes ? flatten(nodes).filter((n) => n.node.kind !== "comment").length : 0;
  box.className = "block-check " + (BLOCK.problem ? "bad" : "good");
  box.textContent = BLOCK.problem ? BLOCK.problem : `Valid nginx. ${count} item${count === 1 ? "" : "s"}.`;
  updateBlockSave();
}

function updateBlockSave() {
  const go = $("#btnBlockSave");
  go.disabled = BLOCK.checking || !!BLOCK.problem || !BLOCK.title.trim();
}

async function saveBlock() {
  const go = $("#btnBlockSave");
  go.disabled = true;
  try {
    const body = { title: BLOCK.title.trim(), hint: BLOCK.hint.trim(), scope: BLOCK.scope, source: BLOCK.source.trim() };
    if (BLOCK.id) body.id = BLOCK.id;
    await api("/api/recipes", body);
    $("#dlgBlock").close();
    await refreshRecipes();
    toast(BLOCK.id ? "Block updated." : "Block saved. Find it under My blocks.");
  } catch (error) {
    BLOCK.problem = describeError(error).summary;
    paintBlockCheck(null);
  }
}

async function deleteBlock(recipe) {
  const answer = await ask({ title: `Delete “${recipe.title}”?`, message: "Only the saved block is removed. Places where you already used it are not changed.", ok: "Delete block", danger: true });
  if (answer !== true) return;
  await api("/api/recipes/delete", { id: recipe.id });
  await refreshRecipes();
  toast("Block deleted.");
}

// ---------------------------------------------------------------- "Save as block" from the selection

async function saveSelectionAsBlock() {
  if (!(await applyDraft())) return;
  const hit = state.selected && locate(state.selected);
  if (!hit) return;
  const nodes = hit.nodes.slice(hit.index, hit.index + spanLength(hit.nodes, hit.index));
  const first = nodes[0];
  const title = first.kind === "comment" ? "My block" : [first.name, ...first.args].join(" ").slice(0, 56);
  showRight("library");
  openBlockDialog({ id: "", custom: false, title, hint: "", scope: scopeFor(hit), source: renderNodes(nodes).trimEnd() });
}

const baseRenderInspector = renderInspector;
renderInspector = function () {
  baseRenderInspector();
  const actions = document.querySelector("#inspector .node-actions");
  if (actions && state.selected && !actions.querySelector(".save-block")) {
    actions.append(el("button", { class: "save-block", type: "button", title: "Keep this as a reusable block in the library", text: "Save as block", onclick: () => saveSelectionAsBlock().catch(report) }));
  }
};

document.addEventListener("DOMContentLoaded", () => {
  $("#btnBlockSave").addEventListener("click", () => saveBlock());
});
