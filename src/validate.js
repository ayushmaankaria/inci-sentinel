function normalize(name) {
  return String(name).toLowerCase().trim();
}

function validate(scrapeOutput) {
  if (!scrapeOutput || typeof scrapeOutput !== 'object') {
    return { ok: false, ingredients: [] };
  }

  const raw = scrapeOutput.ingredients;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, ingredients: [] };
  }

  if (!raw.every((item) => typeof item === 'string' && item.trim().length > 0)) {
    return { ok: false, ingredients: [] };
  }

  const ingredients = raw.map(normalize);
  return { ok: true, ingredients };
}

module.exports = { validate };
