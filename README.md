# INCI Sentinel

INCI Sentinel watches a skincare product's ingredient list (its INCI list) on
incidecoder.com and records every silent reformulation as a first-class event.
When the source site changes its markup and the scraper breaks, that breakage
becomes an incident with a diagnosis, an AI-proposed repair, and a human
approval gate. It never becomes a crash.

## Why this shape

Scrapers rot the moment a source site changes its markup. Most pipelines
respond by throwing an exception into a log nobody reads, and the data quietly
goes stale. INCI Sentinel models breakage as an event instead. Bad output is a
validation result, not an exception, so the process stays up, an incident is
created with a diagnosis attached, a repair is proposed automatically, and a
person decides whether to apply it. Every step of that, refusals included,
lands in Port's audit trail.

The product being watched matters for the same reason. If a brand quietly adds
a fragrance or a preservative, someone with an allergy needs to know *that it
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
   does NOT heal)                       returns 202 in ~1.4s
                                                    │
                          ┌─────────────────────────┴────────────┐
                          ▼                                      ▼
                  background: Bright Data              heal_proposal entity
                  scraper heal (5-12 min)              (Port, status:pending)
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

Every `pipeline.run` is one root span with `scrape`, `validate`, `diff` and
`persist` children, exported to SigNoz. Metrics:
`scraper.validation_failures` and `reformulations.detected` (counters),
`pipeline.duration_ms` (histogram).

## Walkthrough

Captured from a live run rather than written from memory. Entity IDs below are
real and queryable in Port.

**1. A healthy run.** The pipeline scrapes, validates, diffs against the last
stored formula, and persists.

```bash
curl -X POST localhost:3000/run -H 'Content-Type: application/json' \
  -d '{"product_id":"default"}'
```

The operator dashboard at `/` shows the same state: a green status banner, the
current formula, and the reformulation log. The two red entries are the false
removal described under [A caveat worth stating
plainly](#a-caveat-worth-stating-plainly).

![INCI Sentinel operator dashboard showing status OK, the current formula, and
reformulation history](docs/dashboard.png)

`GET /api/products/default/history` returns the same data as JSON:

```json
{
  "formula": {
    "productName": "Niacinamide 10%+ Zinc 1% Serum",
    "ingredients": ["aqua (water)", "niacinamide", "pentylene glycol", "..."],
    "updatedAt": "2026-08-23T00:16:15.058Z"
  },
  "history": [
    { "timestamp": "2026-08-22T22:21:31.433Z", "added": [], "removed": ["ethoxydiglycol", "chlorphenesin"] },
    { "timestamp": "2026-08-21T08:18:54.761Z", "added": ["cocoyl proline"], "removed": [] }
  ]
}
```

**2. Break it.** Point the run at a page that has no product ingredient list.
The scraper returns an empty `ingredients` array, which fails validation:

```bash
TARGET_URL="https://incidecoder.com/ingredients/niacinamide" npm start
curl -X POST localhost:3000/run -H 'Content-Type: application/json' \
  -d '{"product_id":"default"}'
# {"status":"SCRAPER_BROKEN","incidentId":"incident-default-1787445233008"}
```

No exception, no stack trace, no dead process. The break is a return value.

**3. The incident carries a usable diagnosis.** `validate.js` inspects the
observed output and writes an instruction, not a symptom. This is the text
Bright Data's AI receives verbatim as its repair prompt:

> The consumer requires a field named `ingredients` that is a non-empty ARRAY
> of ingredient name strings, one element per ingredient. `ingredients` is an
> empty array, the selector matches nothing. Re-locate the ingredient list on
> the page. The list may be partly collapsed behind a [more] / "show more"
> toggle, so read the full underlying list rather than the visible portion, and
> return every ingredient in source order. Fields currently returned:
> ingredients. Keep all existing fields.

**4. Port reacts in about a second.** Creating the incident fires the
`heal_scraper` workflow, which calls back into the service over the tunnel and
flips the incident to `healing`. From the server log:

```
[POST /heal] incident=incident-default-1787445233008
             collector=c_mt2oaxao1y1rstrysh
             proposal=heal-c_mt2oaxao1y1rstrysh-1787445235799
```

Incident created at `00:33:54.508Z`, `/heal` reached at `00:33:55.799Z`. The
endpoint returns 202 immediately and runs the repair in the background, because
Port's webhook nodes time out at roughly ten seconds while a heal takes five to
twelve minutes (see Field notes).

**5. The proposal waits for a human.** A `heal_proposal` entity appears in Port
straight away:

```json
{
  "identifier": "heal-c_mt2oaxao1y1rstrysh-1787445235799",
  "properties": {
    "status": "pending",
    "fix_summary": "Bright Data self-heal in progress…",
    "created_at": "2026-08-23T00:33:55.799Z"
  }
}
```

Bright Data's `scraper heal` stops at its own `awaiting_approval` gate. We
never pass `--auto-approve`, so nothing reaches the live scraper until someone
approves it through Port's `approve_fix` workflow. Rejecting instead records a
`rejection_reason` and closes the incident as `closed_unrepaired`, which is an
honest terminal state for "nobody fixed this".

**6. The full cycle, previously verified.** An earlier break ran all the way
through: incident, proposal, human approval, `save_new_template`, and a re-run
that came back green. Port recorded `run-default-1787437290578` with
`status: OK` immediately after two `SCRAPER_BROKEN` runs, confirmed through the
Port MCP server.

## A real reformulation chain

The single-product demo above is the mechanism. This is the payoff, on data
nobody staged.

incidecoder uses one template for every product page, so the collector built
against one Ordinary serum reads any other brand without modification. All 17
Fancl products scraped cleanly, 473 ingredient rows total, with no code changes
and no second collector.

Three of those 17 are the same product. incidecoder keeps
`fancl-mild-cleansing-oil`, `fancl-mild-cleansing-oil-2` (labelled "2017
formulation") and `fancl-mild-cleansing-oil-3` as separate pages, which makes
them three generations of one formula. Running the project's own
`diffIngredients` across them:

```
14 → 18 ingredients
  + glycerin, dicaprylyl ether, diglycerin,
    peg/ppg/polybutylene glycol-8/5/3 glycerin, glycine soja (soybean) oil
  − dextrin palmitate

18 → 26 ingredients
  + tridecane, humulus lupulus (hops) extract, camellia sinensis leaf extract,
    rubus ellipticus root extract, helianthus annuus (sunflower) seed oil,
    butylene glycol, pentylene glycol, ppg-12, arginine, water, lactic acid
  − caprylyl caprylate/caprate, dimethicone, glycine soja (soybean) oil
```

Soybean oil enters in the second generation and leaves in the third. That is
the case the README opens with, sitting in real data: someone avoiding soy
would need to know the middle formulation existed, and a product page only ever
shows the current one. Reading today's list tells you nothing about that.

Watching all three at once needs one small change, which is not in this build.
`pipeline.js` reads `TARGET_URL` from the environment, so `product_id` labels
storage rather than selecting a URL, and the service watches one product per
process. Multiple products means restarting with a different `TARGET_URL`, or
letting `product_id` resolve to a URL.

## Field notes

Bugs this build actually hit. Each one stayed invisible until something
specific was checked.

**The webhook timeout that hid itself.** Port's workflow webhook nodes are
synchronous with roughly a ten second timeout, and a Bright Data heal takes
five to twelve minutes. `/heal` awaited the CLI before responding, so
`call_heal` failed on every single break with
`{"error":{"message":"Request timed out"}}`. The dangerous part: the node
carries `onFailure: continue`, so the next node still ran, the incident still
turned orange, and the Port UI looked exactly like a healthy run. Reading the
workflow run's per-node output through Port's MCP server was the only thing
that surfaced it. `/heal` now creates the proposal, returns 202 in about 1.4
seconds, and heals in the background, upserting `fix_summary` when the CLI
returns.

**Two implementations of the same flow, both firing.** Port's AI Builder had
produced a pair of workflows *and* an action-plus-automation covering the same
heal loop, both triggering on `incident` creation. Every break would have fired
two `/heal` calls and produced two proposals. `GET /v1/actions` shows only half
of this; `list_workflows` showed all four objects side by side. The workflows
survived because they carry a real Approve/Reject gate and write status
transitions back into Port. This also explained a standing mystery: incidents
flipping from `open` to `healing` a second after creation was the workflow's
`mark_healing` node, not the automation everyone had blamed.

**A flag that does nothing.** `scraper heal --url` reads like it retargets the
repair. It does not. The help text says it is "not sent to the heal call", and
the healer always inspects the page the collector was *created* against. Two
demo collectors were burned before anyone read that closely. One was built
against an ingredient page, so the AI was asked to extract a product ingredient
list from a page that has none, and `code_fixer` ground for twelve minutes
before erroring.

**A timeout shorter than the thing it was timing, twice.** `heal.js` first used
a 120 second `execFile` timeout against a CLI whose own default heal timeout is
600 seconds, so the client died while the job kept running server-side. Raising
it to 650 seconds looked generous and was still wrong: the CLI polls up to 600
attempts at roughly one per second, which is wall-clock longer than its own
default, and Bright Data separately documents refactors taking up to fifteen
minutes. A live repair died at `code_fixer — polling (attempt 583/600)`. Both
times the job was progressing fine and we were the ones who gave up, and both
times it was first misread as the AI being unable to repair anything. There are
two independent clocks. The CLI now gets an explicit `--timeout 900` and
`execFile` sits above it. Killing the client never cancels the server-side job
either, which then blocks the next attempt with a `409`.

**An approval that approved nothing.** `scraper approve` returns
`{"status":"done","completed_steps":[...,"user_approval"]}` and reads as
complete success, but without `--auto-save` it only clears the approval gate.
It never writes the healed template to the live scraper. A heal whose preview
contained a correct `ingredients` array was approved, reported `done`, and left
the collector's schema unchanged. Adding the flag introduces a
`save_new_template` step, and only then does anything apply. Every approval
made before this discovery was a silent no-op.

**A diagnosis that described the symptom.** The `diagnosis` written onto an
incident is handed to Bright Data's AI as its repair prompt. Ours said
"scrape output missing/empty/wrong-shape ingredients array", which is true and
useless. Given it, the AI ran for over twenty minutes and renamed the
collector. Given a prompt naming the target field, the source field and the
transform, the identical repair landed in about forty seconds. A self-healing
system is only as good as the diagnosis it emits, so `validate.js` derives that
instruction from the observed output instead of hardcoding a sentence. Prompts
are also capped at 1000 characters, and an over-long one is rejected outright
before the job starts.

**A bug you cannot see.** Scraping all 17 Fancl products surfaced invisible
`U+200B` zero-width spaces in 35 of 473 ingredient strings, roughly 7%.
incidecoder injects them after slashes so long INCI names wrap, so
`Caprylic/Capric Triglyceride` is really `Caprylic/` + `U+200B` + `Capric
Triglyceride`. They pass every check the validator had: non-empty strings that
survive lowercase and trim, then reach the diff engine and the store looking
exactly like clean data. Nothing was visibly wrong, which is the point. If the
source ever moved or dropped one of those hints, every affected ingredient
would diff as removed *and* re-added in the same run, inventing a
reformulation across 7% of the list. That is the `[more]` truncation bug again
in a different costume: a presentation artifact from the source site becoming a
claim about a product. `normalize()` now strips zero-width and soft-hyphen
characters before anything downstream sees them.

**A token that was never delivered.** Every Bright Data MCP call returned
`HTTP 401: Auth method is not supported`, which reads like the credential is
the wrong kind. The token was simply absent. zsh sources `.zshrc` only for
interactive shells, and Claude Code's launch context is not one, so
`${BRIGHTDATA_API_TOKEN}` expanded to an empty string. Moving the export to
`.zshenv`, which every zsh invocation reads, fixed it. The token was provably
fine all along: `curl` against `api.brightdata.com/zone/get_active_zones`
returned 200 and a zone list.

## Honest status

The loop closes end to end. A real break, the scraper returning correct data in
the wrong shape, was detected, raised as a Port incident with an auto-generated
diagnosis, repaired by Bright Data's AI, approved by a human, and the pipeline
went green again. Port recorded `run-default-1787437290578` as `status: OK`
directly after two `SCRAPER_BROKEN` runs. Every stage was verified through the
Port and SigNoz MCP servers rather than by reading dashboards.

Getting there meant fixing two silent defects: a `scraper approve` that
approved nothing without `--auto-save`, and a diagnosis string too vague for
the AI to act on. Both are in Field notes above.

### `POST /approve` is not yet wired up

`heal.js` exports a working `approve(collectorId, url)`, and Port's
`approve_fix` workflow, the dashboard's Approve button, and the Endpoints table
below all assume `src/index.js` calls it behind `POST /approve`. It does not.
That route was never added, and `index.js` currently implements only `/run`,
`/heal` and `/alert`. The human approval step in the run cited above was
performed by invoking the Bright Data CLI (`bdata scraper approve --auto-save`)
directly, not by Port's webhook reaching this service. Until the route exists,
`POST <tunnel>/approve` returns 404 and the dashboard's Approve button does
nothing. Known gap, tracked, not a design choice.

### A caveat worth stating plainly

The first successful heal fixed the *shape* but not the *completeness*. It
returned 10 of the product's 12 ingredients, missing the two hidden behind the
page's `[more]` toggle. The pipeline then did exactly what it is built to do
and reported the difference as a reformulation, `ingredients_removed:
"ethoxydiglycol, chlorphenesin"`, for ingredients that were never removed.

That false event is the clearest argument for the human approval gate in this
whole project. Nothing malfunctioned. A scraping artifact became a claim about
a real product, and only a person looking at it would catch that. A system that
auto-approved its own repairs would have published it silently. The generated
diagnosis now warns the healer about collapsed content for this reason.

## Running it

From a fresh clone:

```bash
npm install
cp .env.example .env      # then fill in real values
npm run seed              # seed a stale formula so the first run shows a diff
npm start                 # http://localhost:3000
```

`.env` keys (names only, never commit values): `PORT`, `TARGET_URL`,
`SCRAPER_STUDIO_COLLECTOR_ID`, `DEMO_COLLECTOR_ID`, `ACTIVE_COLLECTOR_ID`,
`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`,
`OTEL_SERVICE_NAME`, `PORT_CLIENT_ID`, `PORT_CLIENT_SECRET`,
`BRIGHTDATA_API_TOKEN`, `NGROK_DOMAIN`.

Bright Data's CLI authenticates separately from the API token, with its own
login:

```bash
npx -p @brightdata/cli bdata login
```

You also need your own collector. `SCRAPER_STUDIO_COLLECTOR_ID` refers to a
scraper in *your* Bright Data account, not a shared one. Create it once (AI
generation takes five to ten minutes) and put the returned id in `.env`:

```bash
npx -p @brightdata/cli bdata scraper create \
  "https://incidecoder.com/products/the-ordinary-niacinamide-10-zinc-1" \
  "Extract product_name as a string and ingredients as an array of INCI ingredient name strings." \
  --name inci-sentinel-primary --pretty -o collector.json
```

Bright Data caps AI scraper *generation* at roughly 3 per account, so create
sparingly. Heals are not capped. `CLAUDE.md` documents the quota behaviour
under `DEMO_COLLECTOR_ID`.

Port and SigNoz call *in*, so `localhost` is unreachable to them and a public
URL is required. Start the tunnel pinned to a reserved static domain:

```bash
npm run tunnel            # ngrok http --domain=$NGROK_DOMAIN 3000
```

A bare `ngrok http 3000` may hand out a different random host and silently
break all three webhook targets. If your domain changes, update it in three
places: the `heal_scraper` and `approve_fix` workflows in Port, and the
`inci-sentinel-webhook` notification channel in SigNoz.

To force a break without touching a production collector, point the run at a
page with no product ingredient list:

```bash
TARGET_URL="https://incidecoder.com/ingredients/niacinamide" npm start
curl -X POST localhost:3000/run -H 'Content-Type: application/json' \
  -d '{"product_id":"default"}'
# {"status":"SCRAPER_BROKEN","incidentId":"incident-default-..."}
```

A heal staged this way targets the *primary* collector, whose page was never
actually broken. Reject those proposals rather than approving them.

MCP setup for the agent-side tooling lives in `CLAUDE.md` under **MCP
Servers**, including region derivation and connection gotchas.

## The agent-operated factory

The three integrations are wired into the coding agent as well as the running
service. A committed, secret-free `.mcp.json` connects Claude Code to Port,
SigNoz and Bright Data, so the agent verifies its own work against live systems
instead of asking a human to read a dashboard and report back.

Port MCP caught the duplicate-workflow double-fire described above:
`list_workflows` returned all four objects with their types in one call, which
the actions API alone does not show. It also produced the per-node workflow run
output that exposed the hidden webhook timeout, where `call_heal` held
`{"error":{"message":"Request timed out"}}` while the run's overall result
still read `SUCCESS`.

SigNoz MCP confirmed the custom metrics existed and were incrementing.
`scraper.validation_failures` is a cumulative monotonic counter, which is also
why the alert aggregates with `increase` rather than `sum`: a raw cumulative
value only grows, so `sum > 0` would latch on after the first failure and never
clear. Bright Data MCP is used only for ground truth, fetching the live
incidecoder page to check what the ingredient list *should* contain when a diff
looks wrong.

The boundary matters. **The pipeline never scrapes over MCP.** Production
scraping stays on the version-controlled CLI collector whose ID and syntax live
in `CLAUDE.md`. MCP is the agent's instrument panel, not a second undocumented
data path. Otherwise "it works" would depend on an agent session nobody can
replay.

## Project layout

```
src/
  otel.js       OpenTelemetry bootstrap (must be required first)
  index.js      Express app: /run /heal /alert, history API
  pipeline.js   scrape → validate → diff → persist, spans and metrics
  scrape.js     Bright Data CLI wrapper
  heal.js       Bright Data heal + approve wrappers
  validate.js   shape validation (failure is a value, never a throw)
  port.js       Port auth + entity upsert
  db.js         JSON file store (data/store.json)
  seed.js       seeds a stale formula for the demo
public/
  index.html    operator dashboard, vanilla JS, no build step
CLAUDE.md       operator manual: scraper config, env contract, gotchas
.mcp.json       agent-side MCP servers (no secrets; safe to commit)
```

## Endpoints

| Method | Path | Body | Purpose |
|---|---|---|---|
| POST | `/run` | `{product_id}` | scrape → validate → diff → persist |
| POST | `/heal` | `{diagnosis, incident_id?}` | creates a pending proposal, returns 202, heals in background |
| POST | `/approve` | `{approved_by?, heal_proposal_id?, product_id?}` | **not yet implemented**, see Honest status |
| POST | `/alert` | SigNoz alert payload | observability receiver; does not heal |
| GET | `/api/products/:id/history` | — | reformulation history |
| GET | `/` | — | operator dashboard |
