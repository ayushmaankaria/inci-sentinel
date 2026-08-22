const { trace, metrics, SpanStatusCode } = require('@opentelemetry/api');
const { scrape } = require('./scrape');
const { validate } = require('./validate');
const db = require('./db');
const port = require('./port');

const tracer = trace.getTracer('inci-sentinel');
const meter = metrics.getMeter('inci-sentinel');

const validationFailures = meter.createCounter('scraper.validation_failures', {
  description: 'Count of scrape outputs that failed shape validation',
});
const reformulationsDetected = meter.createCounter('reformulations.detected', {
  description: 'Count of detected ingredient list reformulations',
});
const pipelineDuration = meter.createHistogram('pipeline.duration_ms', {
  description: 'Duration of a full pipeline.run in milliseconds',
  unit: 'ms',
});

function diffIngredients(oldList, newList) {
  const oldSet = new Set(oldList || []);
  const newSet = new Set(newList || []);
  const added = newList.filter((i) => !oldSet.has(i));
  const removed = (oldList || []).filter((i) => !newSet.has(i));
  return { added, removed };
}

async function run(productId = 'default') {
  const start = Date.now();

  return tracer.startActiveSpan('pipeline.run', async (rootSpan) => {
    rootSpan.setAttribute('product.id', productId);

    try {
      const targetUrl = process.env.TARGET_URL;

      const scrapeResult = await tracer.startActiveSpan('scrape', async (span) => {
        span.setAttribute('target.url', targetUrl);
        const result = await scrape(targetUrl);
        span.end();
        return result;
      });

      const { ok, ingredients, productName } = await tracer.startActiveSpan('validate', async (span) => {
        const validated = validate(scrapeResult);
        span.setAttribute('validation.ok', validated.ok);
        span.end();
        return { ...validated, productName: scrapeResult?.product_name };
      });

      if (!ok) {
        rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'scraper validation failed' });
        validationFailures.add(1, { product_id: productId });

        const duration = Date.now() - start;
        const runId = `run-${productId}-${Date.now()}`;
        const incidentId = `incident-${productId}-${Date.now()}`;

        await port.createEntity('pipeline_run', {
          identifier: runId,
          title: `Run: ${productId} (SCRAPER_BROKEN)`,
          properties: {
            status: 'SCRAPER_BROKEN',
            product_id: productId,
            duration_ms: duration,
            timestamp: new Date().toISOString(),
          },
        });

        await port.createEntity('incident', {
          identifier: incidentId,
          title: `Scraper broken for product ${productId}`,
          properties: {
            status: 'open',
            diagnosis: 'scraper validation failed: scrape output missing/empty/wrong-shape ingredients array',
            created_at: new Date().toISOString(),
          },
          relations: { pipeline_run: runId },
        });

        pipelineDuration.record(duration, { product_id: productId, status: 'SCRAPER_BROKEN' });
        rootSpan.end();
        return { status: 'SCRAPER_BROKEN', incidentId };
      }

      const previousFormula = db.getFormula(productId);
      const previousIngredients = previousFormula?.ingredients || [];

      const diff = await tracer.startActiveSpan('diff', async (span) => {
        const d = diffIngredients(previousIngredients, ingredients);
        span.setAttribute('diff.added_count', d.added.length);
        span.setAttribute('diff.removed_count', d.removed.length);

        if (d.added.length > 0 || d.removed.length > 0) {
          span.addEvent('formulation_changed', {
            added: JSON.stringify(d.added),
            removed: JSON.stringify(d.removed),
          });
        }

        span.end();
        return d;
      });

      const hasChanged = diff.added.length > 0 || diff.removed.length > 0;
      const duration = Date.now() - start;
      const runId = `run-${productId}-${Date.now()}`;

      await tracer.startActiveSpan('persist', async (span) => {
        await port.createEntity('pipeline_run', {
          identifier: runId,
          title: `Run: ${productId} (OK)`,
          properties: {
            status: 'OK',
            product_id: productId,
            duration_ms: duration,
            timestamp: new Date().toISOString(),
          },
        });

        if (hasChanged && previousFormula) {
          reformulationsDetected.add(1, { product_id: productId });
          db.recordReformulation(productId, diff);

          await port.createEntity('reformulation', {
            identifier: `reformulation-${productId}-${Date.now()}`,
            title: `Reformulation detected: ${productId}`,
            properties: {
              product_id: productId,
              ingredients_added: diff.added.join(', '),
              ingredients_removed: diff.removed.join(', '),
              detected_at: new Date().toISOString(),
            },
            relations: { pipeline_run: runId },
          });
        }

        db.saveFormula(productId, ingredients, productName);
        span.end();
      });

      pipelineDuration.record(duration, { product_id: productId, status: 'OK' });
      rootSpan.end();

      return { status: 'OK', diff };
    } catch (err) {
      rootSpan.recordException(err);
      rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      pipelineDuration.record(Date.now() - start, { product_id: productId, status: 'ERROR' });
      rootSpan.end();
      throw err;
    }
  });
}

module.exports = { run, diffIngredients };
