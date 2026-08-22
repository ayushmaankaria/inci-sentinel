const { execFile } = require('child_process');

// Bright Data's own docs say a refactor "can take up to 15 minutes", and the CLI
// polls up to 600 attempts, which is wall-clock LONGER than its own 600s default
// --timeout. Two separate clocks have to be beaten:
//   1. the CLI's --timeout, which we raise to 900s explicitly below, and
//   2. our execFile timeout, which must exceed that again.
// A 650s execFile timeout looked generous and still killed a live repair at
// `code_fixer — polling (attempt 583/600)`. The job was progressing fine; we
// were the ones who gave up. Keep HEAL_TIMEOUT_SECONDS < TIMEOUT_MS.
const HEAL_TIMEOUT_SECONDS = 900;
const TIMEOUT_MS = 950000;

function runCli(args) {
  return new Promise((resolve, reject) => {
    execFile('npx', args, { timeout: TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        return reject(new Error(`${error.message}${stderr ? `\nstderr: ${stderr}` : ''}`));
      }
      resolve(stdout);
    });
  });
}

// CLI syntax confirmed via `npx -p @brightdata/cli bdata scraper heal --help`
// and `scraper approve --help` (Phase 3). `heal` stops at an awaiting_approval
// gate by default (no --auto-approve passed here) — that gate is our human
// approval step, surfaced as a Port `heal_proposal` entity. `approve` resumes
// the healed scraper once a human signs off. See CLAUDE.md.
//
// NOTE on `--url`: per `heal --help` it is "not sent to the heal call" — it
// only decorates the next-step hint in the output. The heal ALWAYS inspects the
// page the collector was created against. We pass it anyway because it makes
// the returned next_step a runnable verify command, but it does not and cannot
// retarget the repair. Consequence: a collector can only be healed against its
// own creation URL, so DEMO_COLLECTOR_ID must be created against TARGET_URL.
async function heal(collectorId, diagnosis, url) {
  const args = ['-p', '@brightdata/cli', 'bdata', 'scraper', 'heal', collectorId, diagnosis,
    '--url', url, '--timeout', String(HEAL_TIMEOUT_SECONDS), '--json'];
  try {
    const stdout = await runCli(args);
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = { raw: stdout };
    }
    return { ok: true, diagnosis, proposal: parsed };
  } catch (err) {
    console.error('[heal] heal command failed:', err.message);
    return { ok: false, diagnosis, error: err.message };
  }
}

// `--auto-save` is REQUIRED, and its absence is silent. Plain `scraper approve`
// returns {"status":"done","completed_steps":[...,"user_approval"]} and looks
// entirely successful, but only clears the approval gate — it never writes the
// healed template to the live scraper, so the very next run still returns the
// broken shape. Confirmed empirically: approved without it, got status done,
// and `ingredients` was still absent from the collector output.
async function approve(collectorId, url) {
  const args = ['-p', '@brightdata/cli', 'bdata', 'scraper', 'approve', collectorId,
    '--url', url, '--auto-save', '--timeout', String(HEAL_TIMEOUT_SECONDS), '--json'];
  try {
    const stdout = await runCli(args);
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = { raw: stdout };
    }
    return { ok: true, result: parsed };
  } catch (err) {
    console.error('[heal] approve command failed:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { heal, approve };
