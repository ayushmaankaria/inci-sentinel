// Must be required FIRST in index.js, before any other module (esp. express).
require('dotenv').config();

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME } = require('@opentelemetry/semantic-conventions');

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const headers = parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);
const serviceName = process.env.OTEL_SERVICE_NAME || 'inci-sentinel';

function parseHeaders(raw) {
  const out = {};
  if (!raw) return out;
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return out;
}

const traceExporter = new OTLPTraceExporter({
  url: endpoint ? `${endpoint}/v1/traces` : undefined,
  headers,
});

const metricExporter = new OTLPMetricExporter({
  url: endpoint ? `${endpoint}/v1/metrics` : undefined,
  headers,
});

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
  }),
  traceExporter,
  metricReader: new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 10000,
  }),
});

if (!endpoint) {
  console.warn('[otel] OTEL_EXPORTER_OTLP_ENDPOINT not set — traces/metrics will fail to export (expected until SigNoz is configured).');
}

try {
  sdk.start();
  console.log('[otel] OpenTelemetry SDK started, service=%s', serviceName);
} catch (err) {
  console.error('[otel] failed to start SDK', err);
}

process.on('SIGTERM', () => {
  sdk.shutdown().finally(() => process.exit(0));
});

module.exports = sdk;
