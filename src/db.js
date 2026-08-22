const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(STORE_PATH, JSON.stringify({ products: {} }, null, 2));
  }
}

function readStore() {
  ensureStore();
  return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
}

function writeStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function getFormula(productId) {
  const store = readStore();
  return store.products[productId]?.formula || null;
}

function saveFormula(productId, ingredients, productName) {
  const store = readStore();
  if (!store.products[productId]) {
    store.products[productId] = { formula: null, history: [] };
  }
  store.products[productId].formula = {
    productName: productName || store.products[productId].formula?.productName || productId,
    ingredients,
    updatedAt: new Date().toISOString(),
  };
  writeStore(store);
}

function recordReformulation(productId, diff) {
  const store = readStore();
  if (!store.products[productId]) {
    store.products[productId] = { formula: null, history: [] };
  }
  const entry = {
    timestamp: new Date().toISOString(),
    added: diff.added,
    removed: diff.removed,
  };
  store.products[productId].history.unshift(entry);
  writeStore(store);
  return entry;
}

function getHistory(productId) {
  const store = readStore();
  return store.products[productId]?.history || [];
}

module.exports = { getFormula, saveFormula, recordReformulation, getHistory };
