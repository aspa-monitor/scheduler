# aspa-scheduler

A Cloudflare Worker (free plan) that starts the hourly GitHub Actions
workflows of the [aspa-monitor](https://github.com/aspa-monitor) repos by
calling GitHub's `workflow_dispatch` API on a reliable Cloudflare Cron Trigger.

**Why it exists:** GitHub's built-in `schedule:` trigger for
`ris-routing-data` fired in only about 2 of 37 hourly slots over two days,
even after the workflow was turned off and on again. Adding more cron lines
does not help at that rate, so an external clock starts the runs instead.
GitHub's own cron stays in each workflow as a backup.

All times below are **IST (UTC+05:30)**. Cloudflare cron expressions are
always UTC, so each one is shown with its IST equivalent.

---

## Contents

1. [How it works](#1-how-it-works)
2. [Files](#2-files)
3. [Free-plan limits](#3-free-plan-limits)
4. [One-time setup](#4-one-time-setup)
5. [Check that it works](#5-check-that-it-works)
6. [Renewing the GitHub token](#6-renewing-the-github-token)
7. [Adding rpki-aspa-data and aspa-validation](#7-adding-rpki-aspa-data-and-aspa-validation)
8. [Changing the code](#8-changing-the-code)
9. [Troubleshooting](#9-troubleshooting)
10. [Security notes](#10-security-notes)
11. [Optional: deploying with Wrangler instead of the dashboard](#11-optional-deploying-with-wrangler-instead-of-the-dashboard)

---

## 1. How it works

```
Cloudflare Cron Trigger (UTC)          GitHub REST API                         GitHub Actions
 "20 * * * *"  ─► aspa-scheduler ─► POST /repos/aspa-monitor/ris-routing-data  ─► "RIS snapshot"
                    Worker             /actions/workflows/ris.yml/dispatches        run, event =
                                       {"ref":"main"}  → 204 No Content             workflow_dispatch
```

| Repo | Workflow file | Cloudflare cron (UTC) | Fires at (IST) | Status |
|---|---|---|---|---|
| `ris-routing-data` | `ris.yml` ("RIS snapshot") | `20 * * * *` | every hour at **:50** | **enabled** |
| `rpki-aspa-data` | `rpki.yml` *(to confirm)* | `30 * * * *` | every hour at **:00** | disabled, repo not created yet |
| `aspa-validation` | `validation.yml` *(to confirm)* | `50 * * * *` | every hour at **:20** | disabled, repo not created yet |

The list lives in the `JOBS` array at the top of [`src/worker.js`](src/worker.js).
When a Cron Trigger fires, the Worker starts every *enabled* job whose `cron`
matches that trigger's expression exactly.

For each job the Worker:

1. Sends `POST https://api.github.com/repos/aspa-monitor/<repo>/actions/workflows/<file>/dispatches`
   with body `{"ref":"main"}` and the headers `Accept: application/vnd.github+json`,
   `X-GitHub-Api-Version: 2022-11-28`, `Authorization: Bearer <GITHUB_TOKEN>`,
   and a generic `User-Agent: aspa-scheduler (Cloudflare Worker)` that carries no personal details.
2. Treats **only HTTP 204** as success. Any other status is logged as an error,
   with a hint for common causes such as an expired token, and the invocation
   is marked as failed in Cloudflare.
3. Retries once after 5 s on a 5xx or network error. It does not retry 4xx
   errors, because those need a fix, not a retry.

Every log line is stamped in IST, for example
`[2026-11-25 13:50:00 IST] cron: aspa-monitor/ris-routing-data ris.yml@main -> HTTP 204 dispatched`.

**Duplicate runs are harmless.** `ris.yml` keeps its own GitHub cron
(`20 * * * *`, :50 IST) as a backup. If GitHub's cron and the Worker both fire
in the same hour, `concurrency: group: ris-snapshot` (with
`cancel-in-progress: false`) makes the second run wait. Because the first run
has already processed the latest RIS files, the second one finishes quickly
in `continue` mode. Use the same concurrency pattern in the other two repos.

**Manual test endpoint (optional).** `POST /dispatch?repo=<name>` on the
Worker's `workers.dev` URL with `Authorization: Bearer <DISPATCH_KEY>` sends one
dispatch right away, so you don't have to wait for the next :50 IST. It accepts
only repos listed in `JOBS`. All other paths return 404, and the endpoint is
off whenever the `DISPATCH_KEY` secret is not set.

## 2. Files

| File | Purpose |
|---|---|
| `src/worker.js` | The whole Worker, which you paste into the Cloudflare dashboard. The config (`JOBS`) is at the top. |
| `test/worker.test.mjs` | Offline tests with a fake GitHub. Run them with the JavaScript engine built into macOS, so no Node.js is needed. |
| `wrangler.toml` | **Optional.** The same settings written down, in case you switch to the Wrangler CLI later ([§11](#11-optional-deploying-with-wrangler-instead-of-the-dashboard)). The dashboard setup doesn't use it. |
| `.gitignore` | Keeps local secret files (`.dev.vars`, `.env`) out of git. |

No Node.js or any other tooling is needed on your laptop. The Worker is
deployed by pasting `src/worker.js` into the Cloudflare dashboard editor.

## 3. Free-plan limits

Values from the Cloudflare docs, read 2026-11-25:
[limits](https://developers.cloudflare.com/workers/platform/limits/),
[pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/),
[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

| Limit (Workers Free) | Value | Our usage |
|---|---|---|
| Cron Triggers per **account** | 5 | 1 now, 3 when all repos are enabled |
| Requests per day (resets 00:00 UTC = 05:30 IST) | 100,000 | about 24 to 72 cron runs, plus any manual tests |
| CPU time per cron invocation | 10 ms | well under 1 ms. Waiting on `fetch` is I/O and does not count as CPU. |
| Wall-clock time per cron invocation | 15 min | about 1 s (at most about 10 s with one retry) |
| Subrequests (`fetch`) per invocation | 50 | 1, or 2 with a retry |
| Workers Logs | 200,000 events/day, kept 3 days | a few hundred per day |
| Cron Events history (dashboard) | last 100 invocations | about 4 days at one trigger per hour |

Notes:
- Cron Triggers are UTC, and a change to them can take **up to 15 minutes** to take effect.
- Cloudflare states that Workers Logs moves to "Cloudflare Observability
  pricing" on 2026-12-01. Our log volume is tiny, but check
  the Workers Logs page after that date in case the free allowance changes.
- No payment card is needed for the Free plan.

## 4. One-time setup

You do every step yourself in the browser. Never paste the token into code,
git, chat, or the command line. It goes only into GitHub's token page and
Cloudflare's secret field.

### 4.1 Create the Cloudflare account

1. Go to <https://dash.cloudflare.com/sign-up> and sign up with your email and a strong password. Turn on 2FA under **My Profile → Authentication**.
2. Verify your email address.
3. Open **Workers & Pages** in the left sidebar. The first time, Cloudflare
   asks you to choose a **workers.dev subdomain**, such as `<something>.workers.dev`.
   Pick any name. It becomes part of the test URL.
4. Stay on the **Free** plan. No domain is needed.

### 4.2 Create the Worker and paste the code

> **Do not use "Upload static files".** That option is only for static
> websites (HTML, CSS, images). It rejects `worker.js` with *"This uploader
> does not yet support projects that require a build process … Please use
> `wrangler deploy` instead"*. You don't need wrangler: paste the code into
> the editor as described below. If a project was created by an upload
> attempt, delete it first (**its Settings → Delete**) so the name is free.

1. Go to **Workers & Pages → Create** and choose **Start with Hello World!**,
   not "Upload static files", "Import a repository", or a template.
2. Name it **`aspa-scheduler`** and click **Deploy**. This deploys the Hello World placeholder.
3. On the Worker's page, click **Edit code** (top right). Click inside the
   editor, press **Cmd+A** then **Delete**, and paste the full contents of
   `src/worker.js` with **Cmd+V**. This Terminal command copies the file to
   the clipboard (it prints nothing):
   ```bash
   pbcopy < ~/Desktop/ASPA_Validation/scheduler/src/worker.js
   ```
4. Click **Deploy** (top right of the editor). The editor's preview should
   now show `{"error": "not found"}`. That is correct: the Worker answers
   only `POST /dispatch`, and only once `DISPATCH_KEY` is set.
5. Under **Settings → Observability**, make sure **Workers Logs** is enabled.
   It is on by default for new Workers.

### 4.3 Allow fine-grained tokens in the aspa-monitor org

This is needed once, as org owner:

1. Go to <https://github.com/organizations/aspa-monitor/settings/personal-access-tokens>.
2. Under **Fine-grained personal access tokens**, choose **Allow access via fine-grained personal access tokens**.
3. **Require approval** is up to you. If you turn it on, you must approve your own token in step 4.4.6.
4. If the org sets a **maximum token lifetime**, note it. Your token's expiry can't be longer.

### 4.4 Create the GitHub token (fine-grained PAT)

1. Go to <https://github.com/settings/personal-access-tokens/new>.
2. **Token name:** `aspa-scheduler (Cloudflare)`. **Description:** "Starts hourly workflow_dispatch runs".
3. **Resource owner:** **aspa-monitor**, not your personal account.
4. **Expiration:** pick a custom date, for example one year ahead. **Add a calendar reminder 7 days before that date** (see [§6](#6-renewing-the-github-token)).
5. **Repository access:** **Only select repositories → `ris-routing-data`**. Add the other repos later ([§7](#7-adding-rpki-aspa-data-and-aspa-validation)).
6. **Permissions → Repository permissions → Actions: Read and write.**
   GitHub adds **Metadata: Read-only** automatically, and that is required.
   Grant **nothing else**.
7. Click **Generate token**, then copy it. GitHub shows it only once.
   If the org requires approval, approve it at
   <https://github.com/organizations/aspa-monitor/settings/personal-access-token-requests>.

### 4.5 Store the secrets in the Worker

In Cloudflare, go to **aspa-scheduler → Settings → Variables and Secrets → + Add**:

| Type | Name | Value |
|---|---|---|
| **Secret** | `GITHUB_TOKEN` | paste the PAT from 4.4 |
| **Secret** | `DISPATCH_KEY` | a long random string (optional: needed only for the manual test endpoint) |

To make a `DISPATCH_KEY` without showing it on screen, run this in Terminal.
It copies a random key to the clipboard:

```bash
openssl rand -hex 32 | pbcopy
```

Paste it into the secret field, and also save it in your password manager,
because you need it for the test in 5.1. Click **Deploy** after adding the
secrets. Secrets are encrypted, can't be read back from the dashboard, and
stay in place when you paste new code.

> Choose type **Secret**, not **Text**. A Text variable is shown in plain text in the dashboard.

### 4.6 Add the Cron Trigger

**aspa-scheduler → Settings → Trigger Events → + Add → Cron Triggers**:

- Choose a custom cron expression and enter exactly **`20 * * * *`**. That is
  :20 UTC, which is **:50 IST** every hour.
- Click **Add**. It can take up to 15 minutes before the first run.

Add only triggers for enabled jobs. Each one counts toward the 5 per account.

## 5. Check that it works

### 5.1 Right away: manual dispatch (needs `DISPATCH_KEY`)

Copy the Worker's host name from the dashboard. It looks like
`aspa-scheduler.<subdomain>.workers.dev`. Run these in Terminal one at a time.

Set the host name (replace `<subdomain>`):

```bash
W=aspa-scheduler.<subdomain>.workers.dev
```

Read the key without showing it or saving it in shell history (paste it, then press Enter):

```bash
read -rs DISPATCH_KEY
```

Send the test dispatch. The path **must** be `/dispatch?repo=…`; plain `/` answers 404:

```bash
curl -sS -X POST -H "Authorization: Bearer $DISPATCH_KEY" "https://$W/dispatch?repo=ris-routing-data"
```

Never type the key directly into the command or paste it into a chat. If that
happens, make a new one (4.5) and replace the `DISPATCH_KEY` secret.

A good result is HTTP 200 with JSON like:

```json
{ "repo": "ris-routing-data", "ok": true, "status": 204, "detail": "dispatched", "at": "2026-11-25 14:05:12 IST" }
```

If you get `"ok": false`, the `status` and `detail` fields come from GitHub.
See [§9](#9-troubleshooting).

### 5.2 On GitHub: a run with event `workflow_dispatch`

- **Web:** go to <https://github.com/aspa-monitor/ris-routing-data/actions/workflows/ris.yml>.
  Runs started by the Worker show **"Manually run by <your GitHub user>"**, the PAT
  owner. To show only those, filter with `event:workflow_dispatch`.
- **CLI:** if you use `gh`, this lists the last 10 runs with times in IST:
  ```bash
  gh run list --repo aspa-monitor/ris-routing-data --workflow ris.yml --limit 10 --json event,createdAt,conclusion --jq '.[] | "\(.createdAt | fromdateiso8601 + 19800 | strftime("%Y-%m-%d %H:%M IST"))  \(.event)  \(.conclusion)"'
  ```
  Expect a `workflow_dispatch` line at about **:50 IST** every hour. An
  occasional `schedule` line is GitHub's backup cron.

### 5.3 On Cloudflare: cron history and logs

- **Settings → Trigger Events → Cron Triggers → View events** lists the last
  100 cron invocations and marks each as success or error.
- **Observability → Logs** (Workers Logs, kept for 3 days) holds the Worker's
  log lines. Search for `HTTP 204`, or filter by level `error`. Use the
  **Live** view to watch the next :50 IST run as it happens. This replaces
  `wrangler tail`, so you don't need the CLI.

After the first few hours, every hour at :50 IST should show a success in
Cloudflare and a `workflow_dispatch` run in GitHub.

## 6. Renewing the GitHub token

The token expires on the date you chose in 4.4. GitHub emails you a few days
before. Once it expires, every dispatch fails with **HTTP 401**, and the logs
say `token missing, wrong or EXPIRED`. Until you renew it, only GitHub's
unreliable backup cron runs.

To renew it, about a week before expiry:

1. Go to <https://github.com/settings/personal-access-tokens>, open
   `aspa-scheduler (Cloudflare)`, and click **Regenerate token**. This keeps
   the same repos and permissions. Pick a new expiry date.
2. Copy the new token.
3. In Cloudflare, go to **aspa-scheduler → Settings → Variables and Secrets →
   `GITHUB_TOKEN` → Edit**, paste the new token, and click **Deploy**.
4. Test with the curl command in 5.1, or wait for the next :50 IST run.
5. Add a new calendar reminder for 7 days before the new expiry date.

If the token leaks, revoke it on the same GitHub page right away, then follow
the steps above with a new token. The token can only start and cancel Actions
runs in the selected repos. It can't read or write code.

## 7. Adding rpki-aspa-data and aspa-validation

Do this for each repo once it exists on GitHub. The example uses `rpki-aspa-data`:

1. **Workflow.** Make sure its workflow on `main` has a `workflow_dispatch:`
   trigger, a backup `schedule:` cron, and a `concurrency:` group, as `ris.yml`
   does. GitHub accepts a dispatch only for workflow files on the default branch.
2. **Token.** Go to <https://github.com/settings/personal-access-tokens>, open
   `aspa-scheduler (Cloudflare)`, click **Edit**, and add the repo under
   **Only select repositories**. You don't need a new token, and the
   Cloudflare secret stays the same.
3. **Code.** In `src/worker.js`, find the repo's `JOBS` entry, set `workflow:`
   to the real file name, and change `enabled: false` to `enabled: true`.
   Run the tests ([§8](#8-changing-the-code)), commit, and paste the file
   into the dashboard (4.2, steps 3 and 4).
4. **Cron Trigger.** Add the matching trigger (4.6):

   | Repo | Cron expression (UTC) | Fires at (IST) |
   |---|---|---|
   | `rpki-aspa-data` | `30 * * * *` | :00 |
   | `aspa-validation` | `50 * * * *` | :20 |

5. **Test.** Run the curl from 5.1 with `?repo=rpki-aspa-data`. Manual dispatch
   also works for a disabled job, so you can test before step 3.
6. In `wrangler.toml`, uncomment the matching cron line to keep the reference
   file in sync.

With all three repos enabled, the account uses **3 of 5** free Cron Triggers.

## 8. Changing the code

The repo is the source of truth, and the dashboard holds a pasted copy.
After every change:

1. Edit `src/worker.js`.
2. Run the offline tests. They use the JavaScript engine that ships with
   macOS, so no install is needed:
   ```bash
   cd ~/Desktop/ASPA_Validation/scheduler && /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc -m test/worker.test.mjs
   ```
   Expect `31 passed, 0 failed`. A failing test makes the command exit non-zero.
3. Commit and push.
4. Copy the file with `pbcopy < src/worker.js`, paste it into **Edit code**,
   and click **Deploy**.

Pasting code doesn't change the secrets or the Cron Triggers.

## 9. Troubleshooting

| What you see | Likely cause | Fix |
|---|---|---|
| `HTTP 401` | Token expired, revoked, or mistyped | [§6](#6-renewing-the-github-token) |
| `HTTP 403` | Token lacks **Actions: Read and write**, the org blocks fine-grained PATs, or approval is pending | 4.3 / 4.4 |
| `HTTP 404` | Wrong workflow file name, repo not under **Selected repositories**, or repo doesn't exist | Check `JOBS` and the token's repo list |
| `HTTP 422` | Branch `main` not found, or the workflow has no `workflow_dispatch:` trigger | Fix the workflow file on `main` |
| `GITHUB_TOKEN secret is not set` | Secret missing, misspelled, or added as type Text | 4.5 |
| `no job in JOBS has cron "…"` | A dashboard Cron Trigger doesn't match any `JOBS` entry | Make the two match exactly, or remove the trigger |
| Cron Events shows nothing | Trigger added less than 15 min ago, or not added at all | 4.6 |
| curl returns `404 not found` | `DISPATCH_KEY` not set, or wrong path (it must be `/dispatch?repo=…`) | 4.5 / 5.1 |
| "This uploader does not yet support projects that require a build process" | Used **Upload static files** | Use **Start with Hello World! → Edit code** (4.2) |
| curl returns `401 unauthorized` | Wrong `DISPATCH_KEY` | Use the value from your password manager |
| 204 in logs, but no run on GitHub | Actions disabled for the repo, or the workflow is turned off | Repo → Actions → enable the workflow |

## 10. Security notes

- **Least privilege.** The PAT covers only the aspa-monitor repos you select,
  with only Actions: Read and write. It can't read or change code, releases,
  or settings.
- **No secrets in code or git.** `GITHUB_TOKEN` and `DISPATCH_KEY` exist only
  as encrypted Cloudflare secrets, so this repo can safely be public.
  `.gitignore` excludes local secret files.
- **No personal data in requests.** The User-Agent is generic, and nothing
  personal goes into URLs or request bodies.
- **Test endpoint.** It accepts only `POST` with the right `DISPATCH_KEY`,
  compared in constant time, and only for repos in `JOBS`. Its worst case is
  one extra workflow run. To turn it off, delete the `DISPATCH_KEY` secret.
- **Who shows as the actor.** Dispatched runs are attributed to the PAT owner
  (your GitHub user), and the workflow still uses its own `GITHUB_TOKEN`. The PAT is
  never passed into the workflow.

## 11. Optional: deploying with Wrangler instead of the dashboard

`wrangler.toml` holds the same settings for a future switch to the CLI
(`npx wrangler deploy`, which needs Node.js 18+) or to Cloudflare **Workers
Builds**, which deploys from this GitHub repo on every push with no local
tooling. If you switch, keep these points in mind:

- A deploy **replaces** the dashboard's Cron Triggers with the `crons` list in
  `wrangler.toml`, so keep that list in sync with `JOBS`.
- Secrets already set in the dashboard stay in place across deploys.
- `wrangler tail` streams the same logs as the dashboard's Live view.
