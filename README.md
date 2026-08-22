# INCI Sentinel

INCI Sentinel watches a skincare product's ingredient list (its INCI list) on
incidecoder.com, records every silent reformulation as a first-class event, and
treats a broken scraper as an observable, recoverable incident with a human
approval gate — never a crash.

## Why this shape

Scrapers rot the moment a source site changes its markup. Most pipelines respond
by throwing an exception into a log nobody reads, and the data quietly goes
stale. INCI Sentinel makes breakage a *modelled event* instead: bad output is a
validation outcome, not a thrown exception, so the process stays up, an incident
is created with a diagnosis attached, a repair is proposed automatically, and a
human decides whether to apply it. Every step of that — including refusals —
lands in Port's audit trail.

The product being watched matters for the same reason: if a brand quietly adds a
fragrance or preservative, someone with an allergy needs to know *that it
changed*, not just what the list says today.

## The loop

```
  POST /run
     │
     ▼
  ┌────────┐   ┌──────────┐   ┌──────┐   ┌─────────┐
  │ scrape │──▶│ validate │──▶│ diff │──▶│ persist │──▶ {status:"OK", diff}
  └────────┘   └────┬─────┘   └──────┘   └─────────┘         │
   Bright Data      │                                         ▼
   CLI collector    │ bad / empty / wrong shape        reformulation entity
                    │  (never an exception)                  (Port)
                    ▼
            {status:"SCRAPER_BROKEN"}
                    │
      ┌─────────────┴──────────────┐
      ▼                            ▼
  scraper.validation_failures   incident entity ──────┐
  + red span  ──▶ SigNoz        (Port, status:open)   │
      │                                               │ ENTITY_CREATED
      ▼                                               ▼
  alert "scraper broken"                    Port workflow: heal_scraper
      │                                               │
      ▼                                               ▼
  webhook ──▶ POST /alert                   webhook ──▶ POST /heal
  (observability only;                              │
   deliberately does NOT heal)          returns 202 in ~1.4s
                                                    │
                          ┌─────────────────────────┴────────────┐
                          ▼                                      ▼
                  background: Bright Data              heal_proposal entity
                  scraper heal (5–12 min)              (Port, status:pending)
                          │                                      │
                          └──▶ upsert fix_summary ──────────────▶│
                                                                 ▼
                                                   Port workflow: approve_fix
                                                   ┌──────────────────────┐
                                                   │  Approve   /  Reject │  ◀── human
                                                   └──────┬─────────┬─────┘
                                                          ▼         ▼
                                              POST /approve      status:rejected
                                                          │      + rejection_reason
                                                          ▼
                                              apply fix, re-run ──▶ green
```

Every `pipeline.run` is one root span with `scrape` / `validate` / `diff` /
`persist` children, exported to SigNoz. Metrics:
`scraper.validation_failures` and `reformulations.detected` (counters),
`pipeline.duration_ms` (histogram).

## Field notes

These are the bugs this build actually hit. They are recorded because each one
was invisible until something specific was checked.

**The webhook timeout that hid itself.** Port's workflow webhook nodes are
synchronous with roughly a **ten second** timeout. A Bright Data heal takes five
to twelve minutes. `/heal` awaited the CLI before responding, so `call_heal`
failed on *every single break* with `{"error":{"message":"Request timed out"}}`.
What made this genuinely dangerous is that the node carries
`onFailure: continue`, so the next node still ran, the incident still turned
orange, and the Port UI looked exactly like a healthy run. Nothing surfaced the
failure — it was only found by reading the workflow run's per-node output
through Port's MCP server. `/heal` now creates the proposal, returns **202 in
about 1.4 seconds**, and heals in the background, upserting `fix_summary` when
the CLI finally returns.

**Two implementations of the same flow, both firing.** Port's AI Builder had
produced *both* a pair of workflows and an action-plus-automation covering the
same heal loop, and both triggered on `incident` creation — so every break would
have fired two `/heal` calls and produced two proposals. `GET /v1/actions` shows
only half of this; it took `list_workflows` to see all four objects side by side.
The workflows were kept because they carry a real Approve/Reject gate and write
status transitions back into Port; the duplicates were retired. This also
explained a months-old mystery: incidents flipping from `open` to `healing` a
second after creation was the workflow's `mark_healing` node, not the automation
everyone had blamed.

**A flag that does nothing.** `scraper heal --url` reads like it retargets the
repair. It does not — the help text says it is "not sent to the heal call," and
the healer always inspects the page the collector was *created* against. Two
demo collectors were burned before this was read carefully: one was built
against an ingredient page, so the AI was asked to extract a product ingredient
list from a page that has none, and `code_fixer` ground for twelve minutes
before erroring.

**A timeout shorter than the thing it was timing.** `heal.js` used a 120-second
`execFile` timeout against a CLI whose own default heal timeout is 600 seconds.
The client process was killed while the job kept running server-side, producing
a confusing failure and then a `409 another refactor job is still in progress`
on the retry. The local timeout now exceeds Bright Data's.

**A token that was never delivered.** Every Bright Data MCP call returned
`HTTP 401: Auth method is not supported`, which reads like the credential is the
wrong kind. It was not: the token was simply *absent*. zsh sources `.zshrc` only
for interactive shells, and Claude Code's launch context is not one, so
`${BRIGHTDATA_API_TOKEN}` expanded to an empty string. Moving the export to
`.zshenv`, which every zsh invocation reads, fixed it. The token itself was
provably fine all along — `curl` against `api.brightdata.com/zone/get_active_zones`
returned 200 and a zone list.

## Honest status

Everything in the loop above is built and verified end to end **except one
step**: Bright Data applying an approved repair.

The AI repair itself does work. Heals reach `status: awaiting_approval` with a
valid preview extracting the correct ingredient list:

```json
{"status":"awaiting_approval",
 "completed_steps":["planner","control_preview_runner","step_advance"],
 "preview_result":[{"product_name":"Niacinamide 10%+ Zinc 1% Serum",
                    "ingredients":["Aqua (Water)","Niacinamide","10 more items"]}]}
```

The human gate is exercised in **both** directions, but only the reject branch
is driven all the way through to Bright Data. Rejection is fully demonstrated
end to end: Port records `status: rejected` with a `rejection_reason`, and
`scraper approve --reject` discards the proposed template server-side —
confirmed by the collector immediately re-running and returning all twelve
ingredients unchanged.

Approval is deliberately not exercised against the live collector. `scraper
approve` overwrites a collector's template with the AI's regenerated one, and
because the account has exhausted its scraper-creation quota there is exactly
one collector and no way to rebuild it if a regenerated template regressed. The
break is also staged rather than real — the collector is pointed at a page with
no ingredient list, so it is not actually damaged, and approving would rewrite a
working scraper to fix a problem it does not have. Risking the only remaining
scraper on a repair that is not needed is the wrong trade, so the proposals are
refused, with that reasoning recorded in Port rather than left implicit.

Building a disposable collector to break for real is currently blocked upstream:

```
Failed to start AI generation for collector c_mt4rp800de0nhl01t:
Error: {"error_limit":{"is_valid":false,"threshold":3}}
  Status: 429
  Hint: Rate limit exceeded. Wait a moment and try again.
```

This is a Bright Data AI-Flow limit on scraper *authoring*, unrelated to
credits — the credit table prices Web Unlocker, SERP, Browser API and scraper
*records*, not AI generation, and the account has ~4,993 credits unspent.

Four explanations were tested and eliminated. It is not a cooldown: attempts
forty minutes apart failed identically, and one attempt's own backoff (17s, 32s,
60s, 233s) burned four retries with the same error. It is not a cap on *stored*
scrapers: with the account down to a single collector, creating one more —
two of three — still failed. It is not concurrency from parked jobs either: the
one heal sitting at `awaiting_approval` was released with
`scraper approve --reject` (confirmed, a second reject returns
`400 Invalid ide automation`, meaning nothing is pending), and creation still
failed. And it is not credits.

What fits every observation is a **lifetime cap of three AI scraper _creations_
per account, which deleting collectors does not refund**. Exactly three ever
succeeded; every attempt afterwards failed. Notably, *heals* continued to work
after that point — reaching `awaiting_approval` with valid previews — so the cap
applies to creation specifically, not to AI-Flow generally.

Two operational notes for anyone reproducing this. A heal parked at
`awaiting_approval` blocks later heals on that same collector with
`409 Another refactor job is still in progress`, which is easy to mistake for
the quota but is a different problem with a different fix
(`scraper approve <id> --reject`). And every failed create still leaves a
half-built collector occupying a slot, with no programmatic deletion — they must
be removed in the web UI.

Everything downstream of the repair — proposal creation, incident linkage, the
human approval gate, `/approve` — is implemented and wired.

## Running it again

From a fresh clone:

```bash
npm install
cp .env.example .env      # then fill in real values
npm run seed              # seed a stale formula so the first run shows a diff
npm start                 # http://localhost:3000
```

`.env` keys (names only — never commit values): `PORT`, `TARGET_URL`,
`SCRAPER_STUDIO_COLLECTOR_ID`, `DEMO_COLLECTOR_ID`, `ACTIVE_COLLECTOR_ID`,
`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`,
`OTEL_SERVICE_NAME`, `PORT_CLIENT_ID`, `PORT_CLIENT_SECRET`,
`BRIGHTDATA_API_TOKEN`, `NGROK_DOMAIN`.

Bright Data's CLI authenticates separately from the API token, with its own
login:

```bash
npx -p @brightdata/cli bdata login
```

You also need a collector of your own — `SCRAPER_STUDIO_COLLECTOR_ID` refers to
a scraper in *your* Bright Data account, not a shared one. Create it once (AI
generation takes five to ten minutes) and put the returned id in `.env`:

```bash
npx -p @brightdata/cli bdata scraper create \
  "https://incidecoder.com/products/the-ordinary-niacinamide-10-zinc-1" \
  "Extract product_name as a string and ingredients as an array of INCI ingredient name strings." \
  --name inci-sentinel-primary --pretty -o collector.json
```

Bright Data caps AI scraper generation per account, so create sparingly — see
the quota note above and the `DEMO_COLLECTOR_ID` section of `CLAUDE.md`.

For the Port and SigNoz webhooks to reach a local machine you need a public
URL — those services call *in*, so `localhost` is not reachable to them. Start
the tunnel pinned to a reserved static domain:

```bash
npm run tunnel            # ngrok http --domain=<your-static-domain> 3000
```

A bare `ngrok http 3000` may hand out a different random host and silently break
all three webhook targets. If your domain differs from the committed one, update
it in three places — the `heal_scraper` and `approve_fix` workflows in Port, and
the `inci-sentinel-webhook` notification channel in SigNoz.

To force a break without touching a production collector, point the run at a
page that has no product ingredient list:

```bash
TARGET_URL="https://incidecoder.com/ingredients/niacinamide" npm start
curl -X POST localhost:3000/run -H 'Content-Type: application/json' -d '{"product_id":"default"}'
# => {"status":"SCRAPER_BROKEN","incidentId":"incident-default-..."}
```

MCP server setup for the agent-side tooling is documented in `CLAUDE.md` under
**MCP Servers**, including region derivation and the connection gotchas.

## The Agent-Operated Factory

The three integrations are wired into the *coding agent* as well as the running
service. A committed, secret-free `.mcp.json` connects Claude Code to Port,
SigNoz and Bright Data, so the agent verifies its own work against live systems
instead of asking a human to read a dashboard and report back.

Port MCP is what caught the duplicate-workflow double-fire described above —
`list_workflows` returned all four objects with their types in one call,
something the actions API alone does not show. It also produced the per-node
workflow run output that exposed the hidden webhook timeout: `call_heal` with
`{"error":{"message":"Request timed out"}}` while the run's overall result still
read `SUCCESS`.

SigNoz MCP confirmed the custom metrics existed and were incrementing
(`scraper.validation_failures` as a cumulative monotonic counter — which is
also why the alert aggregates with `increase` rather than `sum`, since a raw
cumulative value only grows and would latch on forever). Bright Data MCP is used
only for ground truth: fetching the live incidecoder page to check what the
ingredient list *should* contain when a diff looks wrong.

The boundary matters. **The pipeline never scrapes over MCP.** Production
scraping stays on the version-controlled CLI collector whose ID and syntax live
in `CLAUDE.md`. MCP is the agent's instrument panel, not a second undocumented
data path — otherwise "it works" would depend on an agent session nobody can
replay.

## Project layout

```
src/
  otel.js       OpenTelemetry bootstrap (must be required first)
  index.js      Express app: /run /heal /approve /alert, history API
  pipeline.js   scrape → validate → diff → persist, spans and metrics
  scrape.js     Bright Data CLI wrapper
  heal.js       Bright Data heal + approve wrappers
  validate.js   shape validation (failure is a value, never a throw)
  port.js       Port auth + entity upsert
  db.js         JSON file store (data/store.json)
  seed.js       seeds a stale formula for the demo
public/
  index.html    operator dashboard, vanilla JS, no build step
CLAUDE.md       operator manual: scraper config, env contract, hard-won gotchas
.mcp.json       agent-side MCP servers (no secrets; safe to commit)
```

## Endpoints

| Method | Path | Body | Purpose |
|---|---|---|---|
| POST | `/run` | `{product_id}` | scrape → validate → diff → persist |
| POST | `/heal` | `{diagnosis, incident_id?}` | creates a pending proposal, returns 202, heals in background |
| POST | `/approve` | `{approved_by?, heal_proposal_id?, product_id?}` | applies the fix, re-runs the pipeline |
| POST | `/alert` | SigNoz alert payload | observability receiver; does not heal |
| GET | `/api/products/:id/history` | — | reformulation history |
| GET | `/` | — | operator dashboard |
