// Offline tests for src/worker.js. No Node.js needed: runs with the
// JavaScriptCore shell that ships with macOS (see README "Testing locally").
// Also runs under Node 18+ (`node test/worker.test.mjs`).
// GitHub is never contacted: fetch is replaced by a fake.

const g = globalThis;
const print = g.print || console.log;

// --- minimal stand-ins for Workers globals the jsc shell lacks ------------
g.console = g.console || { log: print, warn: print, error: print };
const logs = [];
for (const k of ["log", "warn", "error"]) g.console[k] = (...a) => logs.push(`${k}: ${a.join(" ")}`);
g.setTimeout = (fn) => { Promise.resolve().then(fn); return 0; }; // retries run instantly
if (!g.TextEncoder) g.TextEncoder = class { encode(s) { return Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 255)); } };
if (!g.crypto || !g.crypto.subtle) {
  // Fake digest: not a real hash, only needs equal input -> equal output.
  const digest = async (_alg, bytes) => { const out = new Uint8Array(32); bytes.forEach((b, i) => { out[i % 32] = (out[i % 32] * 31 + b + i) & 255; }); return out.buffer; };
  g.crypto = { subtle: { digest } };
}
if (!g.URL) {
  g.URL = class {
    constructor(u) {
      const m = u.match(/^https?:\/\/[^/]+(\/[^?]*)?(\?.*)?$/);
      this.pathname = m[1] || "/";
      const q = new Map();
      (m[2] || "").slice(1).split("&").filter(Boolean).forEach((p) => { const [k, v = ""] = p.split("="); q.set(decodeURIComponent(k), decodeURIComponent(v)); });
      this.searchParams = { get: (k) => (q.has(k) ? q.get(k) : null) };
    }
  };
}
if (!g.Response) {
  g.Response = class { constructor(body, init = {}) { this.body = body; this.status = init.status || 200; } async json() { return JSON.parse(this.body); } };
}
const req = (url, method = "GET", headers = {}) => ({ url, method, headers: { get: (k) => headers[k] ?? null } });

// --- fake GitHub ------------------------------------------------------------
let calls = [];
let answers = [];
g.fetch = async (url, init) => {
  calls.push({ url, init });
  const a = answers.length ? answers.shift() : { status: 204 };
  if (a.throw) throw new Error(a.throw);
  return { status: a.status, statusText: "", text: async () => a.body || "" };
};

const { default: worker, ist, JOBS } = await import("../src/worker.js");

// --- tiny test runner ---------------------------------------------------------
let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; print(`FAIL ${name}`); } }
function reset(a = []) { calls = []; answers = a; logs.length = 0; }
const env = { GITHUB_TOKEN: "test-token", DISPATCH_KEY: "test-key" };

// IST formatting
check("ist formats +05:30", ist(Date.UTC(2026, 10, 25, 8, 20, 0)) === "2026-11-25 13:50:00 IST");

// Config sanity: unique crons/repos, valid shapes
check("repos unique", new Set(JOBS.map((j) => j.repo)).size === JOBS.length);
check("crons unique", new Set(JOBS.map((j) => j.cron)).size === JOBS.length);
check("only ris enabled", JOBS.filter((j) => j.enabled).map((j) => j.repo).join() === "ris-routing-data");

// Cron :20 UTC dispatches ris-routing-data correctly
reset();
await worker.scheduled({ cron: "20 * * * *", scheduledTime: Date.UTC(2026, 10, 25, 8, 20) }, env, {});
check("one call", calls.length === 1);
check("url", calls[0].url === "https://api.github.com/repos/aspa-monitor/ris-routing-data/actions/workflows/ris.yml/dispatches");
check("method", calls[0].init.method === "POST");
check("body", calls[0].init.body === '{"ref":"main"}');
const h = calls[0].init.headers;
check("accept", h.Accept === "application/vnd.github+json");
check("auth", h.Authorization === "Bearer test-token");
check("api version", h["X-GitHub-Api-Version"] === "2022-11-28");
check("generic UA", h["User-Agent"] === "aspa-scheduler (Cloudflare Worker)");
check("log in IST", logs.some((l) => l.includes("2026-11-25 13:50:00 IST")));
check("logs 204", logs.some((l) => l.includes("HTTP 204")));

// Disabled job's cron: no call
reset();
await worker.scheduled({ cron: "30 * * * *", scheduledTime: Date.now() }, env, {});
check("disabled -> no call", calls.length === 0);

// Unknown cron: no call, warning
reset();
await worker.scheduled({ cron: "0 0 * * *", scheduledTime: Date.now() }, env, {});
check("unknown cron -> no call", calls.length === 0 && logs.some((l) => l.startsWith("warn")));

// 401: no retry, throws, hint logged
reset([{ status: 401, body: '{"message":"Bad credentials"}' }]);
let threw = null;
try { await worker.scheduled({ cron: "20 * * * *", scheduledTime: Date.now() }, env, {}); } catch (e) { threw = e; }
check("401 throws", threw && threw.message.includes("HTTP 401"));
check("401 not retried", calls.length === 1);
check("401 hint", logs.some((l) => l.includes("EXPIRED")));

// 502 then 204: retried once, succeeds
reset([{ status: 502 }, { status: 204 }]);
threw = null;
try { await worker.scheduled({ cron: "20 * * * *", scheduledTime: Date.now() }, env, {}); } catch (e) { threw = e; }
check("5xx retried", calls.length === 2 && !threw);

// network error twice: throws after 2 attempts
reset([{ throw: "boom" }, { throw: "boom" }]);
threw = null;
try { await worker.scheduled({ cron: "20 * * * *", scheduledTime: Date.now() }, env, {}); } catch (e) { threw = e; }
check("network error throws", threw && calls.length === 2);

// 200 is not success (only 204 is)
reset([{ status: 200 }]);
threw = null;
try { await worker.scheduled({ cron: "20 * * * *", scheduledTime: Date.now() }, env, {}); } catch (e) { threw = e; }
check("200 treated as error", !!threw);

// Missing token
reset();
threw = null;
try { await worker.scheduled({ cron: "20 * * * *", scheduledTime: Date.now() }, {}, {}); } catch (e) { threw = e; }
check("no token -> throws, no call", threw && calls.length === 0);

// --- fetch handler ------------------------------------------------------------
const base = "https://aspa-scheduler.example.workers.dev";
reset();
let r = await worker.fetch(req(`${base}/`), env);
check("GET / -> 404", r.status === 404);
r = await worker.fetch(req(`${base}/dispatch?repo=ris-routing-data`, "POST", { Authorization: "Bearer test-key" }), {});
check("no DISPATCH_KEY -> 404", r.status === 404 && calls.length === 0);
r = await worker.fetch(req(`${base}/dispatch?repo=ris-routing-data`, "GET"), env);
check("GET /dispatch -> 405", r.status === 405);
r = await worker.fetch(req(`${base}/dispatch?repo=ris-routing-data`, "POST", { Authorization: "Bearer wrong" }), env);
check("wrong key -> 401", r.status === 401 && calls.length === 0);
r = await worker.fetch(req(`${base}/dispatch?repo=ris-routing-data`, "POST"), env);
check("no key -> 401", r.status === 401 && calls.length === 0);
r = await worker.fetch(req(`${base}/dispatch?repo=evil/repo`, "POST", { Authorization: "Bearer test-key" }), env);
check("unknown repo -> 400", r.status === 400 && calls.length === 0);
r = await worker.fetch(req(`${base}/dispatch?repo=ris-routing-data`, "POST", { Authorization: "Bearer test-key" }), env);
check("manual ok -> 200", r.status === 200 && calls.length === 1);
reset([{ status: 404 }]);
r = await worker.fetch(req(`${base}/dispatch?repo=rpki-aspa-data`, "POST", { Authorization: "Bearer test-key" }), env);
check("manual disabled repo allowed, GitHub 404 -> 502", r.status === 502 && calls.length === 1);

print(`${passed} passed, ${failed} failed`);
if (failed) throw new Error(`${failed} test(s) failed`);
