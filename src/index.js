require('./otel'); // must be required first

const express = require('express');
const path = require('path');
const pipeline = require('./pipeline');
const heal = require('./heal');
const db = require('./db');
const port = require('./port');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.post('/run', async (req, res) => {
  const productId = req.body?.product_id || 'default';
  try {
    const result = await pipeline.run(productId);
    res.json(result);
  } catch (err) {
    console.error('[POST /run] error:', err);
    res.status(500).json({ status: 'ERROR', error: err.message });
  }
});

// Port's webhook nodes are SYNCHRONOUS with a ~10 SECOND timeout, but a Bright
// Data `scraper heal` takes 5-12 minutes. Blocking here made Port's `call_heal`
// node fail with {"error":{"message":"Request timed out"}} on every single
// break — confirmed in workflow run wfr_7Rqyc4BMNEUeW9dL. The heal itself was
// running fine server-side; Port had simply stopped listening.
//
// So: create the `heal_proposal` as `pending` and respond 202 IMMEDIATELY, then
// run the CLI in the background and upsert `fix_summary` when it returns. Do not
// "simplify" this back to awaiting the heal before responding.
app.post('/heal', async (req, res) => {
  const diagnosis = req.body?.diagnosis || 'scraper validation failure';
  const incidentId = req.body?.incident_id;
  const collectorId = process.env.ACTIVE_COLLECTOR_ID || process.env.SCRAPER_STUDIO_COLLECTOR_ID;
  const targetUrl = process.env.TARGET_URL;
  const healProposalId = `heal-${collectorId}-${Date.now()}`;

  console.log(`[POST /heal] incident=${incidentId || 'n/a'} collector=${collectorId} proposal=${healProposalId}`);

  await port.createEntity('heal_proposal', {
    identifier: healProposalId,
    title: `Heal proposal: ${collectorId}`,
    properties: {
      status: 'pending',
      fix_summary: 'Bright Data self-heal in progress…',
      created_at: new Date().toISOString(),
    },
    ...(incidentId ? { relations: { incident: incidentId } } : {}),
  });

  res.status(202).json({ accepted: true, healProposalId, collectorId });

  // Fire-and-forget: fill in the real summary once the CLI finishes.
  heal
    .heal(collectorId, diagnosis, targetUrl)
    .then(async (result) => {
      // The CLI emits one "polling (attempt N/600)" line per second, which buried
      // the actual outcome under ~52KB of noise in Port. Strip it before storing.
      const denoise = (text) =>
        String(text)
          .split('\n')
          .filter((line) => !/polling \(attempt \d+\/\d+\)/.test(line))
          .join('\n')
          .trim()
          .slice(0, 1500);
      const summary = result.ok
        ? denoise(JSON.stringify(result.proposal))
        : `heal command failed: ${denoise(result.error)}`;
      console.log(`[heal] proposal ${healProposalId} finished ok=${result.ok}`);
      await port.createEntity(
        'heal_proposal',
        { identifier: healProposalId, properties: { fix_summary: summary } },
        { upsert: true }
      );
    })
    .catch((err) => console.error('[heal] background heal threw:', err));
});

// SigNoz alert receiver. The alert on `scraper.validation_failures > 0` posts
// here when the scraper breaks. It deliberately does NOT call /heal: the Port
// `heal_scraper` workflow already does that on incident creation, and wiring
// both would fire two heals per break (the exact duplicate-trigger bug we
// removed from Port). This endpoint is the observability half of the loop —
// proof the SigNoz alert reached the service.
app.post('/alert', (req, res) => {
  const alertName = req.body?.alerts?.[0]?.labels?.alertname || req.body?.alertname || 'unknown';
  const status = req.body?.status || 'unknown';
  console.log(`[POST /alert] SigNoz alert received: name=${alertName} status=${status}`);
  res.json({ received: true, alert: alertName, status });
});

app.get('/api/products/:id/history', (req, res) => {
  const history = db.getHistory(req.params.id);
  const formula = db.getFormula(req.params.id);
  res.json({ formula, history });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[index] INCI Sentinel listening on http://localhost:${PORT}`);
});
