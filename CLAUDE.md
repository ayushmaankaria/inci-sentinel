# INCI Sentinel — Project Rules

## Summary

INCI Sentinel is a self-healing data product that watches a skincare product's
ingredient list (INCI list) on incidecoder.com, detects silent reformulations
(ingredients added/removed), and records each reformulation as a first-class
event. When the source site's HTML breaks the scraper, the system detects the
break, raises an incident in Port, generates a repair proposal via Bright
Data's auto-repair, and waits for human approval before resuming.

Three mandatory judged integrations:
- **Port** (getport.io) — data model + incident/heal workflows + human approval + audit trail.
- **Bright Data Scraper Studio** (`@brightdata/cli`, terminal-only) — scraping + auto-repair.
- **SigNoz Cloud** (OpenTelemetry) — traces, metrics, and an alert on scraper breakage.

## Bright Data scraper configuration

Scraper settings are version-controlled here, NOT hardcoded in scrape.js/heal.js.
Collector IDs are read from `.env` at runtime (never hardcoded):

- `SCRAPER_STUDIO_COLLECTOR_ID` — primary collector, targets the real product page.
  Confirmed value: `c_mt2oaxao1y1rstrysh` (name `inci-sentinel-primary`, created
  via `bdata scraper create` on 2026-08-21 against the target URL below; view at
  `https://brightdata.com/cp/scrapers/c_mt2oaxao1y1rstrysh`).
- `DEMO_COLLECTOR_ID` — secondary collector for the break/heal drill (Phase 5).

  **Design rule, learned by burning two collectors:** the demo collector must be
  **created against `TARGET_URL`** and broken only in its *output schema*, so
  that (a) `validate.js` rejects it → `SCRAPER_BROKEN`, and (b) `scraper heal`,
  which always inspects the collector's own creation URL, is looking at a page
  that genuinely contains the ingredient list and is asked for an achievable
  field-shape change.

  Failed attempts, kept here so they are not repeated:

  - `c_mt3gesho134bddezvj` (`inci-sentinel-demo`, superseded) — created against
    `TARGET_URL` with a description asking for deliberately wrong selectors. The
    AI ignored that and found the real data under different field names
    (`ingredients_list` as a string, `key_ingredients` as objects). Broke our
    validator; heal failed after ~7 min.
  **Bright Data caps AI-generated scrapers at 3 per account.** Attempting a 4th
  fails with `{"error_limit":{"is_valid":false,"threshold":3}}`, which the CLI
  reports as a 429 and retries with backoff — misleading, because it is a quota,
  not a cooldown. Two attempts 40 minutes apart failed identically. Worse, each
  failed attempt still creates a half-built collector that consumes a slot, and
  **Bright Data exposes no programmatic deletion** — dead collectors must be
  removed in the web UI. Delete unused ones before creating a new one.

  - `c_mt4q5efe2exzhai9ap` (`inci-sentinel-demo-v2`, superseded) — created
    against the *ingredient* page `https://incidecoder.com/ingredients/niacinamide`,
    a different template on the same site. Run against `TARGET_URL` it returns
    `[{"products":[],"input":{...}}]` — no `ingredients` key, so it breaks
    cleanly, and the break half of the drill genuinely works with it. But the
    heal half cannot: because `--url` is cosmetic (see the `heal` entry below),
    the healer inspected the *ingredient* page while being asked to extract a
    product ingredient list that is not on it. `code_fixer` errored after ~12
    min and 423 poll attempts. This was the attempt that surfaced the `--url`
    finding.
- `ACTIVE_COLLECTOR_ID` — optional override; if set, used instead of
  `SCRAPER_STUDIO_COLLECTOR_ID`. Used to switch to `DEMO_COLLECTOR_ID` for the demo.

**Target URL:** `TARGET_URL` env var. Default:
`https://incidecoder.com/products/the-ordinary-niacinamide-10-zinc-1`

**Confirmed real output schema** (from `bdata scraper run`, before validation) —
a JSON **array** with one result object per URL, NOT a bare object:
```json
[{ "product_name": "string", "ingredients": ["string", "..."], "input": { "url": "string" } }]
```
`src/scrape.js` unwraps `parsed[0]` before returning. `src/validate.js` then
requires a non-empty `ingredients` array of non-empty strings; normalizes to
lowercase/trimmed. Anything else (empty array, missing key, non-array) is a
validation failure (`SCRAPER_BROKEN`), not a thrown exception.

**CLI commands — confirmed via `npx -p @brightdata/cli bdata scraper <subcommand> --help`
on 2026-08-21. These differ from the project brief's original guesses (`repair`/`confirm`
don't exist — the real subcommands are `heal`/`approve`):**

- Create a collector (one-time, AI-generated, ~5-10 min):
  `npx -p @brightdata/cli bdata scraper create <url> "<natural-language description>" --name <name> --pretty -o out.json`
- Run a scrape: `npx -p @brightdata/cli bdata scraper run <collectorId> <url> --json`
  (used by `src/scrape.js`)
- Propose a fix (AI self-healing, stops at an `awaiting_approval` gate unless
  `--auto-approve` is passed — we deliberately never pass `--auto-approve`,
  since that gate IS our human-approval step):
  `npx -p @brightdata/cli bdata scraper heal <collectorId> "<diagnosis prompt>" --url <url> --json`
  (used by `src/heal.js` → `heal()`)

  **`--url` is cosmetic — this is the single most important fact about `heal`.**
  Per `heal --help`: *"Verify target woven into the next-step hint. Not sent to
  the heal call; heal only mutates the scraper."* The heal always inspects the
  page the collector was **created** against. You cannot retarget a repair at a
  different URL. Therefore any collector you intend to heal — including
  `DEMO_COLLECTOR_ID` — must be created against `TARGET_URL`. Two demo
  collectors were burned learning this (see `DEMO_COLLECTOR_ID` above).

  Other flags worth knowing: `--timeout <seconds>` (default 600),
  `--max-retries <n>` for the AI-Flow concurrent-job cap 429 (default 4,
  exponential backoff up to ~4 min), `--auto-save` (with `--auto-approve`).
- Approve (or `--reject`) a heal awaiting approval, resumes and applies the fix:
  `npx -p @brightdata/cli bdata scraper approve <collectorId> --url <url> --json`
  (used by `src/heal.js` → `approve()`)

**Rule:** scraper settings live here and are version-controlled. Do not
hardcode collector IDs, URLs, or CLI flags anywhere in source — read from
`.env` and document changes here.

## Environment variable contract

| Variable | Purpose |
|---|---|
| `PORT` | Express server port (default 3000) |
| `TARGET_URL` | Product page URL to scrape |
| `SCRAPER_STUDIO_COLLECTOR_ID` | Primary Bright Data collector ID |
| `DEMO_COLLECTOR_ID` | Secondary collector for break/heal demo |
| `ACTIVE_COLLECTOR_ID` | Optional override of which collector is active |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | SigNoz Cloud OTLP HTTP endpoint |
| `OTEL_EXPORTER_OTLP_HEADERS` | `signoz-ingestion-key=KEY` |
| `OTEL_SERVICE_NAME` | Service name reported to SigNoz (default `inci-sentinel`) |
| `PORT_CLIENT_ID` / `PORT_CLIENT_SECRET` | Port API client-credentials auth |
| `BRIGHTDATA_API_TOKEN` | Bright Data API token, consumed by the Bright Data **MCP** server (see below). The `bdata` CLI authenticates separately via its own login, so this is MCP-only. |

## Port blueprints (confirmed 2026-08-21)

Blueprints already existed in the Port org when Phase 3 started (created
outside this session, presumably via the Port AI Builder). Schemas fetched
directly from the Port API and `src/pipeline.js`/`src/index.js` payloads are
aligned to these exact property identifiers:

- **`pipeline_run`** — no relations. Created on every `pipeline.run()`, both
  OK and SCRAPER_BROKEN paths, identifier `run-<productId>-<ts>`.
  - `status`: enum `["OK","SCRAPER_BROKEN"]`
  - `product_id`: string
  - `duration_ms`: number
  - `timestamp`: date-time
- **`incident`** — relation `pipeline_run` → `pipeline_run`. Created only on
  SCRAPER_BROKEN, identifier `incident-<productId>-<ts>`.
  - `status`: enum `["open","healing","resolved"]`
  - `diagnosis`: string
  - `created_at`: date-time
- **`reformulation`** — relation `pipeline_run` → `pipeline_run`. Created only
  when a diff is non-empty AND a previous formula existed (never on the very
  first run for a product), identifier `reformulation-<productId>-<ts>`.
  - `product_id`: string
  - `ingredients_added` / `ingredients_removed`: string (comma-joined list,
    NOT an array — the blueprint types these as plain strings)
  - `detected_at`: date-time
- **`heal_proposal`** — relation `incident` → `incident`. Created by
  `POST /heal` after the Bright Data `heal` CLI call, identifier
  `heal-<collectorId>-<ts>`. Related to the triggering incident only if the
  caller passes `incident_id` in the request body (Port's automation webhook
  should be configured to pass the triggering incident's identifier — see
  Phase 6).
  - `status`: enum `["pending","approved","rejected"]`
  - `fix_summary`: string
  - `created_at`: date-time
  - `rejection_reason`: string (added 2026-08-22) — why a proposal was refused.
    The audit trail has to explain refusals, not just approvals; without this
    a rejected proposal looks identical to one nobody got around to.

**`incident.status` gained `closed_unrepaired` (2026-08-22).** The enum was
`open | healing | resolved`, which had no honest terminal state for "the
proposal was rejected and the scraper was never fixed". Marking such an
incident `resolved` would claim a repair that never happened, and leaving it
`healing` strands it forever. `closed_unrepaired` (darkGray) is that state.
Full enum: `open | healing | resolved | closed_unrepaired`.

## Port workflows — the heal/approve loop (revised 2026-08-22)

Port's AI Builder produced **two competing implementations** of the same flow,
which Port MCP surfaced (`list_workflows` shows `type: WORKFLOW | ACTION |
AUTOMATION` in one call; `GET /v1/actions` alone hides the workflows entirely).
Both fired on `ENTITY_CREATED` for `incident`, so every incident produced two
`/heal` calls and two `heal_proposal` entities.

**Decision: keep the WORKFLOWS, retire the action + automation.** The workflows
are strictly richer — they carry a real Approve/Reject gate and they write
status transitions back into Port, which is the audit-trail story this project
is judged on.

Kept (`list_workflows` → `type: WORKFLOW`):

- **`heal_scraper`** — `EVENT_TRIGGER` on `ENTITY_CREATED` / `incident`. Nodes:
  1. `call_heal` — `WEBHOOK` `POST <tunnel>/heal`, body
     `{"diagnosis": "{{ .outputs.trigger.diff.after.properties.diagnosis }}", "product_id": "...", "incident_id": "{{ .outputs.trigger.diff.after.identifier }}"}`
  2. `mark_healing` — `UPSERT_ENTITY` setting `incident.status = "healing"`.
     **This is what flips a new incident from `open` to `healing` about a second
     after creation** — previously an unexplained mystery, wrongly blamed on the
     automation.
- **`approve_fix`** — `SELF_SERVE_TRIGGER` taking a `heal_proposal` entity, then
  an `INPUT` node `approval_gate` with real Approve/Reject buttons plus a
  comments field. Approve → `call_approve` (`POST <tunnel>/approve`, body
  `{"approved_by": "{{ .workflowRun.trigger.by.email }}", "heal_proposal_id": "..."}`)
  → `mark_proposal_approved` (`heal_proposal.status = "approved"`).
  Reject → `mark_proposal_rejected`. **This node is the human approval gate.**

Retired: `auto_diagnose_broken_scraper` (automation) and `approve_heal_fix`
(self-service action). They duplicated the trigger and never wrote
`heal_proposal.status` back, which is why stale proposals sat at `pending`
forever.

**Body contract — `/approve` does NOT receive `product_id`.** `approve_fix`
sends `{approved_by, heal_proposal_id}`. `src/index.js` accepts all three and
falls back to `'default'` for the product. Do not "simplify" that back to
`product_id`-only: it made the endpoint depend on an undefined-value fallback
and silently discarded the approver's identity.

**Placeholder URLs — there are TWO different ones, both must be replaced in
Phase 6.** The workflows use `https://your-app.example.com`; the retired
action/automation used `https://REPLACE-ME.ngrok-free.app`. Updating only the
latter (as an earlier version of this file implied) wires up nothing, since the
workflows are the live path.

A dashboard "Scraper Heal Dashboard" also exists (org-wide, 2x2 widgets:
incidents by status, heal_proposals by status, reformulations by
detected_at desc, pipeline_runs by timestamp desc).

`src/port.js`'s `createEntity(blueprint, entityBody)` takes the full entity
body (`{identifier, title, properties, relations}`), not just a bare
properties object, despite the parameter being named `properties` — see the
call sites in `src/pipeline.js` and `src/index.js` for the exact shape.

## MCP Servers (added 2026-08-22)

`.mcp.json` at the repo root is **project-scoped and committed** — it is part of
the deliverable, since it documents how the coding agent itself observes the
running system. It contains **no secrets**: the only credential referenced is
`${BRIGHTDATA_API_TOKEN}`, expanded from the shell environment at Claude Code
launch. The other two servers authenticate over OAuth, with tokens stored
outside the repo.

| Server | Transport | Auth | Used for |
|---|---|---|---|
| `brightdata` | stdio, `npx -y @brightdata/mcp` | `API_TOKEN=${BRIGHTDATA_API_TOKEN}` | Ad-hoc verification only — fetch the live incidecoder page to sanity-check what ingredients *should* be present when debugging a diff. |
| `signoz` | http, `https://mcp.us2.signoz.cloud/mcp` | OAuth 2.1 (PKCE) via `/mcp` | Query traces/metrics/alerts after each run — verify the red `scrape` span, the `scraper.validation_failures` counter, and alert state. |
| `port` | stdio, `npx -y mcp-remote https://mcp.port.io/v1` | OAuth via `mcp-remote` | Query blueprints and entities directly to confirm `pipeline_run` / `incident` / `reformulation` / `heal_proposal` landed with the right properties and relations. |

Region/URL derivation — do not guess these:
- SigNoz region `us2` comes from `OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.us2.signoz.cloud`.
- Port is the **EU** region (`src/port.js` uses `https://api.getport.io`, not
  `api.us.port.io`), so the MCP URL is `https://mcp.port.io/v1`. The US
  equivalent would be `https://mcp.us.port.io/v1`.

Setup, if `.mcp.json` is ever lost:

```bash
claude mcp add brightdata --scope project -e 'API_TOKEN=${BRIGHTDATA_API_TOKEN}' -- npx -y @brightdata/mcp
claude mcp add signoz --scope project --transport http https://mcp.us2.signoz.cloud/mcp
claude mcp add port --scope project -- npx -y mcp-remote https://mcp.port.io/v1 --header "x-read-only-mode: 0"
claude mcp list   # confirm all three connected
```

**Gotchas, confirmed empirically:**
- Project-scoped servers start as `⏸ Pending approval`. They must be approved
  in an interactive `claude` session; `claude mcp list` alone will not clear it.
- MCP tools bind at **session start**. Adding or approving a server mid-session
  does not make its tools callable in that session — restart Claude Code.
- `${BRIGHTDATA_API_TOKEN}` is read from the environment of the process that
  launches Claude Code, so it must be exported *before* launching, not merely
  present in `.env`. **Put it in `~/.zshenv`, not `~/.zshrc`.** zsh sources
  `.zshrc` only for *interactive* shells; Claude Code's launch context is not
  one, so a `.zshrc` export silently yields an empty `API_TOKEN` and every
  Bright Data MCP call fails with `HTTP 401: Auth method is not supported`.
  `.zshenv` is sourced by every zsh invocation. Verify with:
  `zsh -lc 'echo $BRIGHTDATA_API_TOKEN'` — if that prints empty, the MCP will
  401 no matter how many times you restart.
- That 401 message is misleading: it means the token was *absent*, not that the
  token is the wrong kind. To confirm a token is valid independently, use
  `curl -s -H "Authorization: Bearer $TOKEN" https://api.brightdata.com/zone/get_active_zones`
  — a 200 with a zone list (e.g. `mcp_unlocker`, `cli_unlocker`) means the token
  is fine and the problem is delivery, not the credential.
- SigNoz uses **header-based auth**, not OAuth, in this repo: `SIGNOZ-API-KEY`
  and `X-SigNoz-URL`, both expanded from `${SIGNOZ_API_KEY}` /
  `${SIGNOZ_INSTANCE_URL}` so no secret is committed. This is deliberate — the
  OAuth flow needs an interactive browser session, which a judge cloning the
  repo cannot replay. The API key is a **different credential** from the
  ingestion key in `OTEL_EXPORTER_OTLP_HEADERS`.
- The instance URL (`https://<workspace>.us2.signoz.cloud`) is only readable
  from the browser address bar or Settings → Ingestion. It is NOT
  `ingest.us2.signoz.cloud`, and no region-level host exists as a fallback
  (`us2.signoz.cloud` does not resolve; `app.us2.signoz.cloud` 404s).
- **Distinguishing a bad key from a roleless service account** — the status code
  tells you which, and this is easy to misread:
  - `401 unauthenticated` → key is wrong/absent, or the header name is wrong.
  - `403 authz_forbidden` ("only viewers/editors/admins can access") → the key
    is **valid and authenticating**, but its service account has no role.
    Fix in SigNoz → Settings → Service Accounts by granting the account a role
    (Admin, per SigNoz's docs); do not regenerate the key, it is not the problem.

  Probe with, in order — `/api/v1/version` (200 proves the URL is a real SigNoz
  instance, no auth needed) then `/api/v1/rules` (proves the key AND its role):

  ```bash
  curl -s -H "SIGNOZ-API-KEY: $SIGNOZ_API_KEY" "$SIGNOZ_INSTANCE_URL/api/v1/rules"
  ```

  Note `/api/v1/services` and `/api/v1/orgs/me` return the SPA HTML shell on a
  GET, not JSON — they are useless as auth probes. Use `/api/v1/rules`.
- `x-read-only-mode: 0` on the Port server leaves write tools enabled. Set it
  to `1` if a session should be prevented from mutating the catalog.

**Rule:** MCP is for *the agent's* observation and verification. The pipeline
itself keeps using the version-controlled Bright Data CLI collector — never
replace `src/scrape.js` with ad-hoc MCP scrape calls.

## Phase 6 wiring — tunnel, alert, webhook URLs (2026-08-22)

**Why a tunnel is required at all.** Port workflows and SigNoz alerts run in
*their* clouds. When `heal_scraper` fires `POST <url>/heal`, the request
originates on Port's servers, so `localhost:3000` would mean Port's own machine.
MCP does not solve this: MCP is outbound (this machine -> the SaaS APIs), while
webhooks are inbound (SaaS -> this machine). A tunnel, a public deployment, or
manual `curl` are the only options.

**Tunnel: `https://YOUR-DOMAIN.ngrok-free.dev` — a RESERVED STATIC
domain**, not an ephemeral one. Free ngrok accounts include one static domain;
claim it at dashboard.ngrok.com -> Domains. Always start the tunnel pinned to it:

```bash
npm run tunnel     # ngrok http --domain=YOUR-DOMAIN.ngrok-free.dev 3000
```

Starting a bare `ngrok http 3000` may hand out a *different* random host, which
silently breaks all three webhook targets below. Always use the npm script.

Three places hold this URL. If the domain ever changes, all three must move
together or the loop half-works:
1. `heal_scraper` workflow -> node `call_heal` -> `config.url` (`/heal`)
2. `approve_fix` workflow -> node `call_approve` -> `config.url` (`/approve`)
3. SigNoz notification channel `inci-sentinel-webhook` -> `webhook_url` (`/alert`)

All three are reachable over MCP (`upsert_workflow`,
`signoz_update_notification_channel`) — no UI clicking needed. Verified
2026-08-22: all three on the static domain, and a forced break drove
`call_heal` to `SUCCESS` with `{"response":{"status":202,...}}` in 1.36s
(run `wfr_rRVinA09s8TeIWg3`).

**`POST /alert`** is a deliberate addition, not part of the original brief. The
SigNoz alert had nowhere to route: pointing it at `/heal` would fire a second
heal per break, recreating the duplicate-trigger bug removed from Port. `/alert`
just logs the payload and returns 200 — it is the observability half of the
loop, proving the alert reached the service. Verified: the channel's test
notification appeared in the server log as
`[POST /alert] SigNoz alert received: name=Test Alert (inci-sentinel-webhook)`.

**Alert rule** `INCI Sentinel — scraper broken` (id `01a02b00-9707-7753-9ea5-9f110c2d65b2`):
- metric `scraper.validation_failures`, `timeAggregation: increase`,
  `spaceAggregation: max`, `stepInterval: 60`
- threshold `critical`, `op: above`, `target: 0`, `matchType: at_least_once`
- evaluation `rolling`, `evalWindow: 5m`, `frequency: 1m`

Note the brief specified a 1-minute *window*; a 5m window with 1m frequency is
used instead because the metric is exported roughly every 60s and a 1m window
can contain too few points to evaluate reliably. Detection latency is still
~1 minute, set by `frequency`.

Because the metric is a **cumulative monotonic counter**, the aggregation must
be `increase` (or `rate`), never `sum` — a cumulative counter's raw value only
ever grows, so `sum > 0` would latch on permanently after the first failure and
never resolve.

## Port webhooks time out at ~10s — /heal MUST be async (2026-08-22)

**The single most important runtime constraint in this project.** Port workflow
`WEBHOOK` nodes are synchronous with an approximately **10 second** timeout. A
Bright Data `scraper heal` takes 5-12 minutes. The original `/heal` awaited the
CLI before responding, so `call_heal` failed on *every* break with:

```json
{"error": {"message": "Request timed out"}}     result: FAILED
```

(workflow run `wfr_7Rqyc4BMNEUeW9dL`, node `call_heal`, 19:46:41.612 ->
19:46:51.806 — almost exactly 10s).

This was invisible from the Port UI, because `call_heal` has
`onFailure: continue`, so `mark_healing` still ran and the incident still turned
orange. The flow *looked* healthy while the webhook never actually landed.

**Fix:** `/heal` creates the `heal_proposal` as `pending` with a placeholder
`fix_summary`, responds **202 immediately** (measured: 1.96s, nearly all of it
the Port token fetch), then runs the CLI fire-and-forget and upserts the real
`fix_summary` when it returns. Verified after the fix: `call_heal` result
`SUCCESS`, `{"response":{"status":202,...}}`, 1.4s (run `wfr_vAZIzM15cmz9Hdrh`).

Do not make `/heal` await the heal again. If a future endpoint calls any
Bright Data AI operation from a Port webhook, it must follow the same pattern.

`port.createEntity` now takes `{ upsert: true }` as a third argument, which adds
`&upsert=true&merge=true`, so the background task can patch `fix_summary` onto
the already-created proposal without clobbering its relations.

## Breaking the scraper WITHOUT a demo collector

`DEMO_COLLECTOR_ID` is not required to demo a break. Running the **primary**
collector against a non-product page produces a clean `SCRAPER_BROKEN`:

```bash
TARGET_URL="https://incidecoder.com/ingredients/niacinamide" node src/index.js
curl -X POST localhost:3000/run -H 'Content-Type: application/json' -d '{"product_id":"default"}'
# => {"status":"SCRAPER_BROKEN","incidentId":"incident-default-..."}
```

The env var is set on the process, NOT in `.env` — dotenvx does not override
variables already present in the environment (the startup banner drops from
`injected env (10)` to `(9)`, which is how you confirm the override took).

Caveat: `/heal` heals whatever `ACTIVE_COLLECTOR_ID` / `SCRAPER_STUDIO_COLLECTOR_ID`
points at, so a break staged this way aims the healer at the **primary**
collector. That is safe only because `heal` parks at `awaiting_approval` and we
never pass `--auto-approve`. **Never approve a heal produced by this staging
method** — it would rewrite the working primary collector against the wrong page.

**Bright Data AI-Flow quota, corrected twice.** `{"error_limit":{"threshold":3}}`
is neither a cooldown nor a cap on stored collectors. Proven: after deleting
three collectors (`scraper run` returns `Collector not found` for each), leaving
only two, creation still failed. It counts **AI-Flow jobs** — creates *and*
heals — and deleting collectors does not refund them. Separately, a heal already
running server-side makes the next one fail with
`409 Another refactor job is still in progress`; killing the client does not
cancel it.

## Staged breaks leave live Bright Data jobs parked — clean them up

A break staged through the primary collector (see above) sends a real
`scraper heal` at `c_mt2oaxao1y1rstrysh`. Those heals **succeed**: they reach
`status: awaiting_approval` with a valid `preview_result` extracting the correct
product ingredient list. That is the self-healing feature genuinely working.

Two consequences:

1. **Never approve one of these.** The collector was never actually broken — it
   was pointed at the wrong page. Applying the template would rewrite a working
   production scraper. Reject them in Port with a `rejection_reason` saying so.
2. **A parked job blocks every later heal** on that collector with
   `409 Another refactor job is still in progress`. This is NOT the AI-Flow
   quota, and the two are easy to confuse. Clear a parked job with
   `bdata scraper approve <collectorId> --reject --url <url>`, which discards the
   proposal and leaves the collector unchanged.

Rejecting in Port does **not** cancel the Bright Data job — Port entities and
Bright Data jobs are separate systems. Both sides need clearing.

## Heal timeouts: there are TWO clocks, and both must be beaten

A heal has been killed prematurely **twice** by our own client, and both times it
was misread as "Bright Data's AI cannot repair this". It was not — `code_fixer`
was still making progress when we gave up:

- 120s `execFile` timeout -> killed mid-job (first misdiagnosis).
- 650s `execFile` timeout -> killed at `code_fixer — polling (attempt 583/600)`.

650s looked safe because the CLI's `--timeout` *defaults* to 600s. It is not
safe: the CLI polls up to **600 attempts at roughly one per second**, which is
wall-clock longer than its own default, and Bright Data's docs separately state
a refactor "can take up to 15 minutes". So:

```
HEAL_TIMEOUT_SECONDS = 900   // passed explicitly as --timeout
TIMEOUT_MS           = 950000 // execFile, must exceed the above
```

**Invariant: `HEAL_TIMEOUT_SECONDS` < `TIMEOUT_MS`.** Never raise one without the
other. Before concluding that a heal "failed", check whether the last line is a
`polling (attempt N/600)` — if so, we timed out, Bright Data did not fail.

**Killing the client does NOT cancel the server-side job.** After a client-side
timeout the refactor keeps running, and the next heal on that collector returns
`409 Another refactor job is still in progress`. Do not immediately re-issue the
heal: wait for the in-flight job and `scraper approve` it, or discard it with
`scraper approve <id> --reject`.

**`fix_summary` must be denoised before it reaches Port.** The CLI emits one
polling line per second, which put ~52KB of noise into a single `heal_proposal`
entity and buried the actual outcome. `src/index.js` strips
`polling (attempt N/M)` lines and caps the result at 1500 chars.

## `scraper approve` needs `--auto-save`, and failing to pass it is SILENT

Plain `bdata scraper approve <id>` clears the approval gate but **does not write
the healed template to the live scraper**. It returns what looks like complete
success:

```json
{"status":"done","completed_steps":[...,"user_approval"]}
```

and the very next run still returns the broken shape. Confirmed empirically: a
heal reached `awaiting_approval` with a correct `ingredients` array in its
`preview_result`, was approved, reported `done` — and the collector's
`output_schema` still had no `ingredients` field.

`src/heal.js` → `approve()` therefore passes `--auto-save`. Do not remove it.
Once the gate is consumed, a later `--auto-save` cannot rescue it:
`approve` then returns `400 Invalid ide automation`, and the whole heal must be
re-run.

## The diagnosis text IS the heal prompt — make it actionable

The `incident.diagnosis` written by `src/pipeline.js` becomes the prompt Bright
Data's AI receives. The original string was:

> `scraper validation failed: scrape output missing/empty/wrong-shape ingredients array`

That is a *symptom*, not an instruction. Given it, the AI ran for over 22
minutes, completed, and changed nothing but the collector's name. Given an
actionable prompt naming the target field, the source field and the transform,
the same heal succeeded in **39 poll attempts (~40 seconds)**.

`validate.js` now exports `describeFailure(scrapeOutput)`, which inspects the
observed output and generates that instruction — e.g. for the demo collector:

> The consumer requires a field named `ingredients` that is a non-empty ARRAY of
> ingredient name strings, one element per ingredient. There is no `ingredients`
> field. The ingredient data appears to be in `ingredients_list` (a string).
> Derive `ingredients` from it by splitting on commas into one trimmed element
> per ingredient, dropping any [more] or [less] markers. Fields currently
> returned: product_name, brand, ... Keep all existing fields.

**Rule:** a self-healing system is only as good as the diagnosis it emits. If a
heal "succeeds" but changes nothing, suspect the prompt before the AI.

## Smoke-test commands

```bash
npm start                                   # start server (localhost:3000 by default)
curl -X POST localhost:3000/run -H 'Content-Type: application/json' -d '{"product_id":"default"}'
curl -X POST localhost:3000/heal -H 'Content-Type: application/json' -d '{"diagnosis":"test"}'
curl -X POST localhost:3000/approve -H 'Content-Type: application/json' -d '{"product_id":"default"}'
curl localhost:3000/api/products/default/history
npm run seed                                # seed stale formula for product "default"
```

## Operating rules

- Restart the server after every source file change (`Ctrl+C` then `npm start`).
- Never touch values already in `.env` — only append new keys if instructed;
  real secrets are filled by the human operator, never guessed or invented.
- Bad/unparseable scrape output is a **validation failure**
  (`{status:"SCRAPER_BROKEN"}`), never a thrown exception that crashes the process.
- Port API failures must be logged and swallowed — they must never crash the pipeline.
- No TypeScript, no build step, no database server — JSON file store only.
- Verify all external CLI/API syntax empirically (`--help`, small test calls)
  before relying on it. Update this file when reality differs from assumptions.
