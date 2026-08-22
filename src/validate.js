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

// The diagnosis written onto the `incident` becomes the prompt Bright Data's
// self-healing AI receives. A generic "wrong-shape ingredients array" was
// empirically NOT enough — the AI completed a heal and changed nothing but the
// collector name, because the message says what is wrong without saying what to
// build or what to build it from. This reports the observed shape and names a
// likely source field, which is the difference between a repair and a no-op.
function describeFailure(scrapeOutput) {
  const contract =
    'The consumer requires a field named `ingredients` that is a non-empty ARRAY of ingredient name strings, one element per ingredient.';

  if (!scrapeOutput || typeof scrapeOutput !== 'object') {
    return `${contract} The scraper returned no usable object at all — re-extract the product page.`;
  }

  const keys = Object.keys(scrapeOutput).filter((k) => k !== 'input');
  const raw = scrapeOutput.ingredients;
  let detail;

  if (raw === undefined) {
    const candidate = keys.find((k) => /ingredient/i.test(k));
    detail = candidate
      ? `There is no \`ingredients\` field. The ingredient data appears to be in \`${candidate}\` (a ${
          Array.isArray(scrapeOutput[candidate]) ? 'array' : typeof scrapeOutput[candidate]
        }). Derive \`ingredients\` from it by splitting on commas into one trimmed element per ingredient, dropping any [more] or [less] markers.`
      : 'There is no `ingredients` field and no field that obviously holds ingredient data. Extract the INCI ingredient list from the page into a new `ingredients` array.';
  } else if (!Array.isArray(raw)) {
    detail = `\`ingredients\` is a ${typeof raw}, not an array. Split it into one trimmed element per ingredient.`;
  } else if (raw.length === 0) {
    detail = '`ingredients` is an empty array — the selector matches nothing. Re-locate the ingredient list on the page.';
  } else {
    detail = '`ingredients` contains empty or non-string entries. Every element must be a non-empty ingredient name string.';
  }

  // Source sites often collapse long lists behind a "more" toggle. A healed
  // template that reads only the visible portion validates fine but silently
  // truncates — which the diff engine then reports as ingredients being
  // *removed*, fabricating a reformulation that never happened. Observed:
  // a heal produced 10 of 12 ingredients and Port recorded a false
  // "removed: ethoxydiglycol, chlorphenesin".
  const completeness =
    'The list may be partly collapsed behind a [more] / "show more" toggle — read the full underlying list, not just the visible portion, and return every ingredient in source order.';

  return `${contract} ${detail} ${completeness} Fields currently returned: ${keys.join(', ') || '(none)'}. Keep all existing fields.`;
}

module.exports = { validate, describeFailure };
