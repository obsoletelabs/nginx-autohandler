"use strict";

// Git sync: the top-bar button and its dialog. Settings for it live in Settings > Git sync.

const GIT = { data: null, busy: "", error: "" };
const GIT_MODES = { pull: "Pull only", push: "Push only", both: "Pull and push" };
const GIT_CONFLICTS = { "keep-local": "Keep the local file", "use-repo": "The repository wins" };

function gitModeText(data) {
  const every = Number(data.interval_minutes) > 0 ? `every ${data.interval_minutes} min` : "only when you press a button";
  return `${GIT_MODES[data.mode] || data.mode || "Pull and push"} · ${every}`;
}

// What the last run found, whether it came from a button or from the timer.
function gitLastPull(data) {
  return (data && data.last_result && data.last_result.pull) || null;
}

function gitLastPush(data) {
  return (data && data.last_result && data.last_result.push) || null;
}

function openGitSettings() {
  $("#dlgGit").close();
  openSettings("Git sync").catch(report);
}

async function loadGit() {
  GIT.data = await call("GET", "/api/git");
  $("#btnGit").classList.toggle("off", !GIT.data.configured);
  return GIT.data;
}

async function openGit() {
  await loadGit();
  paintGit();
  if (!$("#dlgGit").open) $("#dlgGit").showModal();
}

function gitFileList(title, hint, files, tone) {
  if (!files || !files.length) return null;
  return el("section", { class: "git-files " + (tone || "") },
    el("h3", { class: "sub" }, title, el("span", { class: "count", text: ` (${files.length})` })),
    hint ? el("p", { class: "hint", text: hint }) : null,
    el("ul", { class: "git-list" }, ...files.map((path) => el("li", { title: path, text: path }))),
  );
}

function gitFact(label, value) {
  return el("div", { class: "git-fact" }, el("dt", { text: label }), el("dd", { title: typeof value === "string" ? value : "" }, value));
}

function paintGit() {
  const data = GIT.data;
  const body = $("#gitBody");
  if (!data) return;
  if (!data.configured) {
    body.replaceChildren(
      el("div", { class: "status-panel" },
        el("div", { class: "status-title", text: "Git sync is off" }),
        el("div", { class: "status-sub", text: "Point this app at a git repository and it can pull your nginx config from it, push your edits back, or both. Keys and certificates are never pushed." }),
      ),
      el("p", { class: "hint", text: "Set the repository URL, branch, access token and how often to sync in Settings." }),
      el("div", { class: "git-actions" }, el("button", { type: "button", class: "primary", text: "Open Settings", onclick: openGitSettings })),
    );
    return;
  }

  const pull = gitLastPull(data);
  const push = gitLastPush(data);
  const busy = !!GIT.busy;
  const parts = [];

  const lastRun = data.last_run
    ? el("span", {}, data.last_run, " ", data.error ? badge2("bad", "FAILED") : badge2("good", "OK"))
    : el("span", { class: "muted", text: "Never" });
  parts.push(el("dl", { class: "git-facts" },
    gitFact("Repository", el("code", { text: data.url || "" })),
    gitFact("Branch", data.branch + (data.subdir ? ` · folder ${data.subdir}` : "")),
    gitFact("Mode", gitModeText(data)),
    gitFact("When both changed", GIT_CONFLICTS[data.conflicts] || data.conflicts || ""),
    gitFact("Last sync", lastRun),
    gitFact("Commit", data.commit ? el("code", { title: data.commit, text: data.commit.slice(0, 7) }) : el("span", { class: "muted", text: "None yet" })),
    gitFact("Access token", data.token_set ? "Set" : el("span", { class: "muted", text: "Not set (fine for public repositories)" })),
  ));

  if (data.error) {
    const { summary, details } = describeError(data.error);
    parts.push(el("div", { class: "status-panel bad" },
      el("div", { class: "status-title", text: "The last sync failed" }),
      el("div", { class: "status-sub", text: summary }),
      details ? detailsBlock(details) : null,
    ));
  }

  const act = (label, direction, text) => el("button", { type: "button", class: direction === "mode" ? "primary" : "", disabled: busy, title: label,
    text: GIT.busy === direction ? text : (direction === "pull" ? "Pull now" : direction === "push" ? "Push now" : "Sync (per mode)"),
    onclick: () => runGit(direction === "mode" ? undefined : direction).catch(report) });
  parts.push(el("div", { class: "git-actions" },
    act("Bring the repository's changes into the config", "pull", "Pulling…"),
    act("Commit your changes and push them to the repository", "push", "Pushing…"),
    act("Do what Mode says: " + gitModeText(data), "mode", "Syncing…"),
  ));

  if (pull && pull.conflicts && pull.conflicts.length) {
    parts.push(el("section", { class: "git-files conflict" },
      el("h3", { class: "sub" }, "Conflicts", el("span", { class: "count", text: ` (${pull.conflicts.length})` })),
      el("p", { class: "hint", text: "These files changed here and in the repository. Your local copy was kept." }),
      el("ul", { class: "git-list" }, ...pull.conflicts.map((path) => el("li", { title: path, text: path }))),
      el("div", { class: "git-actions" }, el("button", { type: "button", class: "danger-text", disabled: busy, text: "Let the repository win", title: "Replace these files with the repository's version",
        onclick: () => repositoryWins(pull.conflicts).catch(report) })),
    ));
  }
  parts.push(
    gitFileList("Pulled", "Brought in from the repository and applied.", pull && pull.pulled, "ok"),
    gitFileList("Pushed", "Committed and pushed to the repository.", push && push.pushed, "ok"),
    gitFileList("Held back", "Keys and certificates are never pushed, nor are files that are not text.", push && push.held_back),
    gitFileList("Skipped", "Not text, too large or outside the config folder.", pull && pull.skipped),
  );
  if (pull && !(pull.pulled || []).length && !(pull.conflicts || []).length && pull.unchanged) {
    parts.push(el("p", { class: "hint", text: `Nothing to pull. ${pull.unchanged} file${pull.unchanged === 1 ? " is" : "s are"} already identical.` }));
  }
  body.replaceChildren(...parts.filter(Boolean));
}

async function repositoryWins(files) {
  const answer = await ask({
    title: "Let the repository win?",
    message: `Your local edits to ${files.length === 1 ? "this file" : "these " + files.length + " files"} are replaced by the repository's version: ${files.join(", ")}. History keeps a backup of each file, so you can restore it.`,
    ok: "Replace with repository",
    danger: true,
  });
  if (answer !== true) return;
  await runGit("pull", "repo");
}

function gitSummary(result) {
  const pulled = (result.pull && result.pull.pulled || []).length;
  const pushed = (result.push && result.push.pushed || []).length;
  const conflicts = (result.pull && result.pull.conflicts || []).length;
  const bits = [];
  if (result.pull) bits.push(pulled ? `pulled ${pulled} file${pulled === 1 ? "" : "s"}` : "nothing to pull");
  if (result.push) bits.push(pushed ? `pushed ${pushed} file${pushed === 1 ? "" : "s"}` : "nothing to push");
  if (conflicts) bits.push(`${conflicts} conflict${conflicts === 1 ? "" : "s"}`);
  const text = bits.join(" · ");
  return text.charAt(0).toUpperCase() + text.slice(1) + ".";
}

async function runGit(direction, prefer) {
  if (GIT.busy) return;
  // A pull rewrites files on disk, so unapplied edits in the editor would be lost.
  if (direction !== "push" && !(await allowReplace())) return;
  GIT.busy = direction || "mode";
  paintGit();
  let result;
  try {
    const body = {};
    if (direction) body.direction = direction;
    if (prefer) body.prefer = prefer;
    result = await call("POST", "/api/git/sync", body);
  } finally {
    GIT.busy = "";
    await loadGit().catch(() => {});
    paintGit();
  }
  if (result.error) showProblem("Git sync failed", "GIT", describeError(result.error).summary, describeError(result.error).details);
  else toast(gitSummary(result));
  if (result.pull && result.pull.pulled && result.pull.pulled.length) {
    setDocument(await call("GET", "/api/workspace"));
  }
  if (VIEWS.home.data && state.view === "home") refreshOverview({ quiet: true });
}

// Home page card, only when git sync is set up.
function gitCard(git) {
  if (!git || !git.configured) return null;
  const pull = gitLastPull(git);
  const conflicts = pull && pull.conflicts ? pull.conflicts.length : 0;
  let value = "Not synced yet";
  let tone = "";
  if (git.error) { value = "Sync failed"; tone = "bad"; }
  else if (conflicts) { value = `${conflicts} conflict${conflicts === 1 ? "" : "s"}`; tone = "bad"; }
  else if (git.last_run) { value = "In sync"; tone = "good"; }
  const sub = git.error ? describeError(git.error).summary
    : git.last_run ? `Last sync ${git.last_run}${conflicts ? " · local copies kept" : ""}`
    : `${git.branch} · ${GIT_MODES[git.mode] || git.mode}`;
  return statCard("Git sync", value, sub, { tone, foot: linkButton("Open Git sync", "Pull, push and see what changed", () => openGit().catch(report)) });
}

function bindGit() {
  $("#btnGit").onclick = () => openGit().catch(report);
  $("#btnGitRefresh").onclick = () => openGit().catch(report);
  loadGit().catch(() => {});
}

bindGit();
