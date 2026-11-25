// aspa-scheduler: Cloudflare Worker that starts the hourly GitHub Actions
// workflows of the aspa-monitor repos via the workflow_dispatch API.
//
// Why: GitHub's own `schedule:` trigger skipped ~35 of 37 hourly slots.
// Cloudflare Cron Triggers fire reliably and call the GitHub API instead.
//
// Deploy: paste this whole file into the Cloudflare dashboard editor
// (Workers & Pages > aspa-scheduler > Edit code) and click Deploy.
// See README.md for the full setup guide.
//
// Required Worker secrets (Settings > Variables and Secrets, type "Secret"):
//   GITHUB_TOKEN  fine-grained PAT, aspa-monitor, Actions: Read and write
//   DISPATCH_KEY  optional; long random string that protects POST /dispatch
//
// Times: Cloudflare cron is always UTC. Everything this Worker logs or
// returns is shown in IST (UTC+05:30).

// ---------------------------------------------------------------------------
// CONFIG: the only part you normally edit.
//
// Each job is started when the Cloudflare Cron Trigger whose expression
// equals `cron` fires. The cron expression must ALSO be added under
// Settings > Trigger Events > Cron Triggers in the dashboard, character
// for character (e.g. "20 * * * *").
// ---------------------------------------------------------------------------
const OWNER = "aspa-monitor";

const JOBS = [
  {
    repo: "ris-routing-data",
    workflow: "ris.yml",          // file name in .github/workflows/ ("RIS snapshot")
    ref: "main",
    cron: "20 * * * *",           // :20 UTC = :50 IST
    enabled: true,
  },
  {
    repo: "rpki-aspa-data",
    workflow: "rpki.yml",         // TODO: confirm the file name once the repo exists
    ref: "main",
    cron: "30 * * * *",           // :30 UTC = :00 IST
    enabled: false,               // repo not on GitHub yet
  },
  {
    repo: "aspa-validation",
    workflow: "validation.yml",   // TODO: confirm the file name once the repo exists
    ref: "main",
    cron: "50 * * * *",           // :50 UTC = :20 IST
    enabled: false,               // repo not on GitHub yet
  },
];
// ---------------------------------------------------------------------------

const API_VERSION = "2022-11-28";
const USER_AGENT = "aspa-scheduler (Cloudflare Worker)";
const RETRY_DELAY_MS = 5000;

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** Format a time as "2026-11-25 13:50:00 IST". */
export function ist(ms = Date.now()) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 19).replace("T", " ") + " IST";
}

/**
 * Send one workflow_dispatch request. GitHub answers 204 No Content on
 * success; anything else is an error. 5xx and network errors are retried
 * once (a duplicate run is harmless: the workflow's concurrency group
 * makes it wait, and it then finishes quickly).
 * Returns { ok, status, detail }.
 */
export async function dispatch(job, token) {
  const url = `https://api.github.com/repos/${OWNER}/${job.repo}/actions/workflows/${job.workflow}/dispatches`;
  const init = {
    method: "POST",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": USER_AGENT,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: job.ref }),
  };

  let last = { ok: false, status: 0, detail: "not attempted" };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status === 204) {
        return { ok: true, status: 204, detail: "dispatched" };
      }
      const body = (await res.text()).slice(0, 300);
      last = { ok: false, status: res.status, detail: body || res.statusText };
      if (res.status < 500) break; // 4xx: retrying will not help
    } catch (err) {
      last = { ok: false, status: 0, detail: `network error: ${err && err.message}` };
    }
    if (attempt === 1) {
      console.warn(`[${ist()}] ${job.repo}: attempt 1 failed (${last.status}), retrying in ${RETRY_DELAY_MS / 1000}s`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  return last;
}

/** Explain common failures in the log, so the fix is obvious. */
function hint(status) {
  switch (status) {
    case 401: return "token missing, wrong or EXPIRED: create a new PAT and update the GITHUB_TOKEN secret";
    case 403: return "token lacks Actions: Read and write on this repo, or the org blocks fine-grained PATs / approval pending";
    case 404: return "repo or workflow file not found, or the token cannot see this repo (check 'Selected repositories')";
    case 422: return "branch (ref) not found, or the workflow has no workflow_dispatch trigger";
    default: return "";
  }
}

async function runJob(job, env, why) {
  if (!env.GITHUB_TOKEN) {
    console.error(`[${ist()}] ${job.repo}: GITHUB_TOKEN secret is not set`);
    return { repo: job.repo, ok: false, status: 0, detail: "GITHUB_TOKEN secret is not set" };
  }
  const r = await dispatch(job, env.GITHUB_TOKEN);
  const line = `[${ist()}] ${why}: ${OWNER}/${job.repo} ${job.workflow}@${job.ref} -> HTTP ${r.status} ${r.detail}`;
  if (r.ok) {
    console.log(line);
  } else {
    const h = hint(r.status);
    console.error(h ? `${line} | hint: ${h}` : line);
  }
  return { repo: job.repo, ...r };
}

async function sha256(text) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

/** Constant-time comparison of two strings (hash first so lengths match). */
async function sameSecret(a, b) {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(ha, hb);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function json(status, obj) {
  return new Response(JSON.stringify(obj, null, 2) + "\n", {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default {
  // Cron Trigger: start every enabled job whose cron matches this trigger.
  async scheduled(event, env, ctx) {
    const due = JOBS.filter((j) => j.cron === event.cron);
    const enabled = due.filter((j) => j.enabled);
    console.log(`[${ist(event.scheduledTime)}] cron "${event.cron}" fired; jobs: ${enabled.map((j) => j.repo).join(", ") || "none"}`);
    if (due.length === 0) {
      console.warn(`no job in JOBS has cron "${event.cron}": remove this Cron Trigger in the dashboard, or fix JOBS`);
      return;
    }
    for (const j of due.filter((j) => !j.enabled)) {
      console.log(`${j.repo}: disabled in JOBS, skipped`);
    }
    const results = await Promise.all(enabled.map((j) => runJob(j, env, "cron")));
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      // Throwing marks this invocation as an error in Cron Events / Workers Logs.
      throw new Error(`dispatch failed for: ${failed.map((f) => `${f.repo} (HTTP ${f.status})`).join(", ")}`);
    }
  },

  // Manual test: POST /dispatch?repo=<name> with header
  //   Authorization: Bearer <DISPATCH_KEY>
  // Works for any repo listed in JOBS (enabled or not), never for others.
  // Everything else answers 404, and the endpoint is off if DISPATCH_KEY is unset.
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/dispatch" || !env.DISPATCH_KEY) {
      return json(404, { error: "not found" });
    }
    if (request.method !== "POST") {
      return json(405, { error: "use POST" });
    }
    const auth = request.headers.get("Authorization") || "";
    const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!given || !(await sameSecret(given, env.DISPATCH_KEY))) {
      return json(401, { error: "unauthorized" });
    }
    const repo = url.searchParams.get("repo") || "";
    const job = JOBS.find((j) => j.repo === repo);
    if (!job) {
      return json(400, { error: "unknown repo", known: JOBS.map((j) => j.repo) });
    }
    const r = await runJob(job, env, "manual");
    return json(r.ok ? 200 : 502, { ...r, at: ist() });
  },
};

export { JOBS, OWNER };
