"use strict";

// One place that turns whatever went wrong into a short message plus optional raw details.
// Loads before the other scripts; app.js and shell.js call into it when something fails.

// Plain text for any error value, including API error objects and arrays. Never "[object Object]".
function errorText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message || String(value.name || "Error");
  if (Array.isArray(value)) return value.map(errorText).filter(Boolean).join("\n");
  if (typeof value === "object") {
    const known = value.message || value.error || value.detail || value.msg || (Array.isArray(value.errors) && value.errors.length ? value.errors : null);
    if (known) return errorText(known);
    try {
      return JSON.stringify(value, null, 2);
    } catch (error) {
      return "Unknown error";
    }
  }
  return String(value);
}

// Known failures, in plain words. The first match wins; the raw text stays available as details.
const ERROR_HINTS = [
  [/authentication error|invalid api token|code['":\s]*(9103|10000)|cloudflare[^\n]*unauthori[sz]ed|unauthori[sz]ed[^\n]*cloudflare api/i, "Cloudflare refused the API token. Check it in Settings, and that it can edit DNS for the zone."],
  [/incorrect txt record|txt record[^\n]*(not found|did not match|incorrect)|no txt record|type:\s*unauthori[sz]ed|some challenges have failed|failed to authenticate some domains/i, "Let's Encrypt could not see the DNS challenge record yet. Wait a minute and try again, and check that the domain is in your Cloudflare account."],
  [/no zone for/i, "Cloudflare does not manage that domain with this token."],
  [/could not (resolve|connect)|name or service not known|getaddrinfo|network is unreachable|timed out|timeout/i, "A network request did not complete. Check the connection and try again."],
  [/rate ?limit|too many (certificates|requests|failed)/i, "Let's Encrypt or Cloudflare is rate limiting this. Wait a while, or use staging to test."],
  [/certbot cannot run|certbot.*not found|no such file.*certbot/i, "certbot is not available here. It is installed in the Docker image."],
  [/contact email|acme_email|unable to register|invalid contact/i, "Let's Encrypt needs a contact email. Set it in Settings."],
  [/dns problem|txt record|dns-01|challenge failed|unauthori[sz]ed.*acme/i, "Let's Encrypt could not verify the DNS challenge. Check the Cloudflare token and that the domain is in your account."],
  [/nginx did not run/i, "nginx could not be run on this machine, so the change was not tested."],
];

// Long tool output (certbot, nginx) starts with log noise. The summary is the line that says what went
// wrong, not the first line.
const NOISE_LINE = /^(saving debug log|plugins selected|requesting a (new )?certificate|account registered|waiting for verification|cleaning up challenges|creating (a )?(new )?account|obtaining|using the|the following|ask for help|if you like|hook |performing the following|\[?(info|debug)\]?)/i;
const PROBLEM_LINE = /(error|failed|failure|refused|denied|invalid|unauthori[sz]ed|rate limit|too many|could not|couldn't|unable|no such|not found|cannot|can't|timed out|timeout)/i;
function usefulLine(lines) {
  if (!lines.length) return "";
  const marker = lines.findIndex((line) => /^an unexpected error occurred:?$/i.test(line));
  if (marker >= 0 && lines[marker + 1]) return lines[marker + 1];
  if (lines.length < 3 && !NOISE_LINE.test(lines[0])) return lines[0];
  const hit = lines.find((line) => !NOISE_LINE.test(line) && PROBLEM_LINE.test(line));
  return hit || lines.find((line) => !NOISE_LINE.test(line)) || lines[0];
}

// { summary, details }. Short single-line messages have no details; long or multi-line ones keep
// the full text as details and show only their first useful line as the summary.
function describeError(value) {
  const raw = errorText(value).trim() || "Something went wrong.";
  for (const [pattern, summary] of ERROR_HINTS) {
    if (pattern.test(raw)) return { summary, details: raw === summary ? "" : raw };
  }
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const lead = usefulLine(lines);
  const first = /^[{[]/.test(lead || "") ? "The service sent back an error it could not explain." : lead || raw;
  const short = first.length > 140 ? first.slice(0, 137).trimEnd() + "..." : first;
  const more = lines.length > 1 || first.length > 140 || first !== lead;
  return { summary: short.replace(/:$/, ""), details: more ? raw : "" };
}

// Dialog with a plain-language summary and, when there is raw output, a "Details" section for it.
function showProblem(title, eyebrow, summary, details) {
  $("#resultTitle").textContent = title;
  $("#resultEyebrow").textContent = eyebrow;
  const body = $("#resultBody");
  body.textContent = "";
  body.append(el("p", { class: "error-summary", text: summary }));
  const raw = errorText(details).trim();
  if (raw && raw !== summary) body.append(detailsBlock(raw));
  $("#resultDialog").showModal();
}

// Raw text (certbot, nginx, Cloudflare): wrapped, with its own scroll area so a long log never stretches
// the dialog, and a copy button that stays in reach.
function detailsBlock(raw) {
  const count = raw.split(/\r?\n/).length;
  const details = el("details", { class: "error-details" },
    el("summary", {}, "Details", el("span", { class: "details-count", text: ` · ${count} line${count === 1 ? "" : "s"}` })),
    el("pre", { class: "pre details-pre", tabindex: "0", text: raw }),
    el("div", { class: "details-tools" }, el("button", { class: "tiny", type: "button", text: "Copy details", onclick: async (event) => {
      const button = event.currentTarget;
      await copyText(raw);
      button.textContent = "Copied";
      setTimeout(() => { button.textContent = "Copy details"; }, 1600);
    } })),
  );
  if (count <= 6) details.open = true;
  return details;
}

function showError(title, value) {
  const { summary, details } = describeError(value);
  showProblem(title, "SOMETHING WENT WRONG", summary, details);
}

// For failures the user caused or can fix at once, a toast is enough; anything with details gets
// the dialog, because a toast disappears before raw output can be read.
function reportError(error, title = "That did not work") {
  const { summary, details } = describeError(error);
  if (details) showError(title, error);
  else toast(summary);
}

// A network failure ("Failed to fetch") is usually a dropped connection, not a bad answer: the server closes
// every connection after one reply, so a burst of requests can lose one. Reads and the editor's pure
// calculations are repeated up to twice; anything that changes data is sent once.
const RETRY_POSTS = /^\/api\/(parse|render|validate|document|basic|modernize-http2|dns\/verify|import\/zip)$/;
const NETWORK_ERROR = "Could not reach the server. Check that it is running and try again.";

async function fetchRetry(url, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const again = method === "GET" || RETRY_POSTS.test(String(url).split("?")[0]);
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, options);
    } catch (error) {
      if (!again || attempt >= 2) throw new Error(NETWORK_ERROR);
      await new Promise((done) => setTimeout(done, 300 * (attempt + 1)));
    }
  }
}
