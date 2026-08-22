const { execFile } = require('child_process');

const TIMEOUT_MS = 120000;

// CLI syntax confirmed via `npx -p @brightdata/cli bdata scraper run --help`
// (Phase 3). Output is a JSON array containing one result object:
// [{ product_name, ingredients: string[], input: { url } }]. See CLAUDE.md.
function scrape(url) {
  const collectorId = process.env.ACTIVE_COLLECTOR_ID || process.env.SCRAPER_STUDIO_COLLECTOR_ID;

  return new Promise((resolve) => {
    if (!collectorId) {
      console.error('[scrape] no collector ID configured (ACTIVE_COLLECTOR_ID / SCRAPER_STUDIO_COLLECTOR_ID)');
      return resolve(null);
    }

    const args = ['-p', '@brightdata/cli', 'bdata', 'scraper', 'run', collectorId, url, '--json'];

    execFile('npx', args, { timeout: TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        console.error('[scrape] CLI error:', error.message, stderr ? `\nstderr: ${stderr}` : '');
        return resolve(null);
      }
      try {
        const parsed = JSON.parse(stdout);
        // `scraper run` returns a JSON array with one result object per URL.
        const result = Array.isArray(parsed) ? parsed[0] : parsed;
        resolve(result || null);
      } catch (parseErr) {
        console.error('[scrape] failed to parse CLI output as JSON:', parseErr.message);
        resolve(null);
      }
    });
  });
}

module.exports = { scrape };
