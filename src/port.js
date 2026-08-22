const PORT_API_BASE = 'https://api.getport.io';
const TOKEN_TTL_MS = 50 * 60 * 1000; // 50 min

let cachedToken = null;
let cachedTokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry) {
    return cachedToken;
  }

  const clientId = process.env.PORT_CLIENT_ID;
  const clientSecret = process.env.PORT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('PORT_CLIENT_ID / PORT_CLIENT_SECRET not set');
  }

  const res = await fetch(`${PORT_API_BASE}/v1/auth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret }),
  });

  if (!res.ok) {
    throw new Error(`Port auth failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  cachedToken = data.accessToken;
  cachedTokenExpiry = Date.now() + TOKEN_TTL_MS;
  return cachedToken;
}

// `properties` is the FULL entity body ({identifier, title, properties, relations}).
// Pass { upsert: true } to update an entity that already exists — used by /heal,
// which creates a `pending` proposal immediately and fills in fix_summary later
// once the (slow) Bright Data CLI call returns.
async function createEntity(blueprint, properties, { upsert = false } = {}) {
  try {
    const token = await getAccessToken();
    const qs = `create_missing_related_entities=true${upsert ? '&upsert=true&merge=true' : ''}`;
    const res = await fetch(
      `${PORT_API_BASE}/v1/blueprints/${blueprint}/entities?${qs}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(properties),
      }
    );

    if (!res.ok) {
      console.error(`[port] createEntity(${blueprint}) failed: ${res.status} ${await res.text()}`);
      return null;
    }

    return await res.json();
  } catch (err) {
    // Port failures must never crash the pipeline.
    console.error(`[port] createEntity(${blueprint}) error:`, err.message);
    return null;
  }
}

module.exports = { getAccessToken, createEntity };
