"use strict";

// Background tasks: certificate requests, reissues, git syncs and DNS updates that the server runs and
// remembers. The top bar shows how many are running; the panel lists the recent ones with their outcome.
// GET /api/tasks -> { running, tasks: [{ id, kind, title, state, started, finished, detail, error, seconds }] }.

const TASKS = { running: 0, tasks: [], known: new Map(), primed: false, timer: 0, error: "", missing: false };
const TASK_KINDS = { certificate: "Certificate", reissue: "Reissue", git: "Git", dns: "DNS", import: "Import" };

function taskTime(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  const date = Number.isFinite(number) && String(value).trim() !== "" ? new Date(number < 1e12 ? number * 1000 : number) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function taskDuration(task) {
  let seconds = Number(task.seconds);
  if (!Number.isFinite(seconds)) {
    const start = taskTime(task.started);
    const end = taskTime(task.finished) || (task.state === "running" ? new Date() : null);
    seconds = start && end ? (end - start) / 1000 : NaN;
  }
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 90) return `${Math.round(seconds)} s`;
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

function taskRow(task) {
  const started = taskTime(task.started);
  const duration = taskDuration(task);
  const state = task.state === "running" ? ["test", "RUNNING"] : task.state === "failed" ? ["bad", "FAILED"] : ["good", "DONE"];
  const pill = badge2(state[0], state[1]);
  if (task.state === "running") pill.prepend(el("span", { class: "spinner tiny-spinner" }));
  const error = task.state === "failed" && task.error ? describeError(task.error) : null;
  return el("li", { class: "task-row " + (task.state || "") },
    el("div", { class: "task-head" },
      pill,
      el("span", { class: "task-title", text: task.title || TASK_KINDS[task.kind] || task.kind || "Task" }),
      task.kind && TASK_KINDS[task.kind] ? el("span", { class: "task-kind", text: TASK_KINDS[task.kind] }) : null,
      el("span", { class: "task-when", text: [started ? `started ${clockTime(started)}` : "", duration].filter(Boolean).join(" · ") })),
    task.detail && task.state !== "failed" ? el("div", { class: "task-detail", text: task.detail }) : null,
    error ? el("div", { class: "task-error" }, el("div", { text: error.summary }), error.details ? detailsBlock(error.details) : null) : null);
}

function paintTasksButton() {
  const button = $("#btnTasks");
  if (!button) return;
  const badge = $("#tasksBadge");
  const failed = TASKS.tasks.filter((task) => task.state === "failed" && !TASKS.seenFailed?.has(task.id)).length;
  button.classList.toggle("busy", TASKS.running > 0);
  badge.hidden = !(TASKS.running > 0 || failed > 0);
  badge.classList.toggle("failed", TASKS.running === 0 && failed > 0);
  badge.textContent = TASKS.running > 0 ? String(TASKS.running) : String(failed);
  button.title = TASKS.running ? `${TASKS.running} running: certificates, git and DNS work happens in the background` : failed ? `${failed} failed recently` : "Background tasks: certificates, git and DNS";
}

function paintTasks() {
  const list = $("#tasksList");
  if (!list) return;
  const intro = $("#tasksIntro");
  intro.textContent = TASKS.running ? `${TASKS.running} running now. This list refreshes by itself.` : "Certificate requests, reissues, git syncs and DNS updates are listed here while they run and afterwards.";
  if (TASKS.error) {
    list.replaceChildren(el("li", { class: "task-empty" }, TASKS.missing ? "The server does not list tasks yet." : TASKS.error));
    return;
  }
  list.replaceChildren(...(TASKS.tasks.length ? TASKS.tasks.map(taskRow) : [el("li", { class: "task-empty", text: "Nothing has run yet." })]));
}

function announceFinished(list) {
  for (const task of list) {
    const was = TASKS.known.get(task.id);
    if (TASKS.primed && was === "running" && task.state !== "running") {
      const title = task.title || TASK_KINDS[task.kind] || "Task";
      if (task.state === "failed") toast(`${title} failed. Open Tasks for the details.`, "warn");
      else toast(`${title} finished.`);
    }
    TASKS.known.set(task.id, task.state);
  }
  TASKS.primed = true;
}

async function pollTasks() {
  clearTimeout(TASKS.timer);
  try {
    const data = await call("GET", "/api/tasks");
    TASKS.error = "";
    TASKS.missing = false;
    const list = Array.isArray(data.tasks) ? data.tasks : [];
    announceFinished(list);
    TASKS.tasks = list;
    TASKS.running = Number(data.running) || list.filter((task) => task.state === "running").length;
  } catch (error) {
    TASKS.error = describeError(error).summary;
    TASKS.missing = /404|not found/i.test(String(error.message));
  }
  if (!TASKS.seenFailed) TASKS.seenFailed = new Set(TASKS.tasks.filter((task) => task.state === "failed").map((task) => task.id));
  if ($("#dlgTasks").open) {
    for (const task of TASKS.tasks) TASKS.seenFailed.add(task.id);
    paintTasks();
  }
  paintTasksButton();
  const fast = TASKS.running > 0 || $("#dlgTasks").open;
  TASKS.timer = setTimeout(pollTasks, fast ? 3000 : 20000);
}

// Called when this page starts something that shows up as a task, so the button reacts at once.
function nudgeTasks() {
  clearTimeout(TASKS.timer);
  TASKS.timer = setTimeout(pollTasks, 700);
}

async function openTasks() {
  $("#dlgTasks").showModal();
  paintTasks();
  await pollTasks();
}

$("#btnTasks").addEventListener("click", () => openTasks().catch(report));
$("#btnTasksRefresh").addEventListener("click", () => pollTasks());
$("#dlgTasks").addEventListener("close", () => { for (const task of TASKS.tasks) TASKS.seenFailed.add(task.id); paintTasksButton(); pollTasks(); });
pollTasks();
