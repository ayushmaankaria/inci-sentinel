const db = require('./db');

// Real list scraped from the live product page via collector
// c_mt2oaxao1y1rstrysh (Phase 3), minus "cocoyl proline" — so the first
// live /run demonstrably detects it as a newly-added ingredient.
const STALE_INGREDIENTS = [
  'aqua (water)',
  'niacinamide',
  'pentylene glycol',
  'zinc pca',
  'tamarindus indica seed gum',
  'carrageenan',
  'acacia senegal gum',
  'xanthan gum',
  'ethoxydiglycol',
  'phenoxyethanol',
  'chlorphenesin',
];

const PRODUCT_ID = 'default';
const PRODUCT_NAME = 'The Ordinary Niacinamide 10% + Zinc 1%';

db.saveFormula(PRODUCT_ID, STALE_INGREDIENTS, PRODUCT_NAME);
console.log(`[seed] seeded product "${PRODUCT_ID}" with ${STALE_INGREDIENTS.length} ingredients (stale list).`);
