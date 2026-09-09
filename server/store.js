'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');

const PRODUCTS = [
  { key: 'message', label: 'Message', blurb: 'Chat, threads and message migration scenarios' },
  { key: 'email', label: 'Email', blurb: 'Mailbox, folders and email delivery scenarios' },
  { key: 'content', label: 'Content', blurb: 'Files, folders, permissions and content scenarios' },
];

let db = { enhancements: [], documents: [] };

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      db = {
        enhancements: Array.isArray(parsed.enhancements) ? parsed.enhancements : [],
        documents: Array.isArray(parsed.documents) ? parsed.documents : [],
      };
    } catch (err) {
      // Keep a copy of the unreadable file instead of silently dropping data.
      const backup = `${DATA_FILE}.corrupt-${Date.now()}`;
      fs.copyFileSync(DATA_FILE, backup);
      console.error(`db.json could not be parsed; moved a copy to ${backup}`);
      db = { enhancements: [], documents: [] };
    }
  }
  try { lastWriteMtimeMs = fs.existsSync(DATA_FILE) ? fs.statSync(DATA_FILE).mtimeMs : 0; } catch (err) { lastWriteMtimeMs = 0; }
  return db;
}

let lastWriteMtimeMs = 0;

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE); // atomic-ish: never leaves a half-written db.json
  lastWriteMtimeMs = fs.statSync(DATA_FILE).mtimeMs;
}

/**
 * Re-read db.json when someone else changed it — another server instance, or a
 * script editing the file while this process is running. Without this, our
 * in-memory snapshot would overwrite their changes on the next write.
 */
function syncFromDisk() {
  if (!fs.existsSync(DATA_FILE)) return;
  try {
    if (fs.statSync(DATA_FILE).mtimeMs !== lastWriteMtimeMs) load();
  } catch (err) {
    // a transient stat failure must not take a request down
  }
}

function isProduct(key) {
  return PRODUCTS.some((p) => p.key === key);
}

function summary(enhancement) {
  const { scenarios, ...rest } = enhancement;
  return { ...rest, scenarioCount: scenarios.length };
}

function listProducts() {
  syncFromDisk();
  return PRODUCTS.map((product) => {
    const items = db.enhancements.filter((e) => e.product === product.key);
    return {
      ...product,
      enhancementCount: items.length,
      scenarioCount: items.reduce((sum, e) => sum + e.scenarios.length, 0),
    };
  });
}

function listEnhancements(productKey) {
  syncFromDisk();
  return db.enhancements
    .filter((e) => e.product === productKey)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(summary);
}

function getEnhancement(id) {
  syncFromDisk();
  return db.enhancements.find((e) => e.id === id) || null;
}

function findByName(productKey, name) {
  syncFromDisk();
  const wanted = name.trim().toLowerCase();
  return db.enhancements.find((e) => e.product === productKey && e.name.toLowerCase() === wanted) || null;
}

function createEnhancement({ product, name, description, sourceFile, scenarios, extraColumns }) {
  syncFromDisk();
  const now = new Date().toISOString();
  const enhancement = {
    id: crypto.randomUUID(),
    product,
    name: name.trim(),
    description: (description || '').trim(),
    sourceFile: sourceFile || '',
    extraColumns: extraColumns || [],
    scenarios,
    createdAt: now,
    updatedAt: now,
  };
  db.enhancements.push(enhancement);
  persist();
  return enhancement;
}

function renumber(scenarios) {
  return scenarios.map((s, idx) => ({ ...s, sno: idx + 1 }));
}

function setScenarios(id, { scenarios, extraColumns, sourceFile, mode = 'replace' }) {
  const enhancement = getEnhancement(id);
  if (!enhancement) return null;

  enhancement.scenarios =
    mode === 'append' ? renumber([...enhancement.scenarios, ...scenarios]) : renumber(scenarios);
  enhancement.extraColumns =
    mode === 'append'
      ? Array.from(new Set([...enhancement.extraColumns, ...(extraColumns || [])]))
      : extraColumns || [];
  enhancement.sourceFile = sourceFile || enhancement.sourceFile;
  enhancement.updatedAt = new Date().toISOString();
  persist();
  return enhancement;
}

/** Append one scenario typed straight into the tool (no file involved). */
function addScenario(id, { scenario, extra }) {
  const enhancement = getEnhancement(id);
  if (!enhancement) return null;

  const cleanExtra = {};
  enhancement.extraColumns.forEach((col) => {
    cleanExtra[col] = String((extra || {})[col] || '').trim();
  });

  enhancement.scenarios.push({
    sno: enhancement.scenarios.length + 1,
    scenario: scenario.trim(),
    sourceSno: '',
    extra: cleanExtra,
    addedInTool: true,
  });
  enhancement.updatedAt = new Date().toISOString();
  persist();
  return enhancement;
}

/** Cache the generated test cases on the scenario row so they survive a restart. */
function setTestCases(id, sno, { testCases, model, provider, generatedAt }) {
  const enhancement = getEnhancement(id);
  if (!enhancement) return null;

  const scenario = enhancement.scenarios.find((s) => Number(s.sno) === Number(sno));
  if (!scenario) return null;

  scenario.testCases = testCases;
  scenario.testCasesMeta = { model, provider, generatedAt };
  enhancement.updatedAt = new Date().toISOString();
  persist();
  return scenario;
}

/** Delete one scenario row; the rows left keep a clean 1..N numbering. */
function deleteScenario(id, sno) {
  const enhancement = getEnhancement(id);
  if (!enhancement) return { status: 'no-enhancement' };

  const idx = enhancement.scenarios.findIndex((s) => Number(s.sno) === Number(sno));
  if (idx === -1) return { status: 'no-scenario' };

  const [removed] = enhancement.scenarios.splice(idx, 1);
  enhancement.scenarios = renumber(enhancement.scenarios);
  enhancement.updatedAt = new Date().toISOString();
  persist();
  return { status: 'ok', enhancement, removed };
}

function updateEnhancement(id, { name, description }) {
  const enhancement = getEnhancement(id);
  if (!enhancement) return null;
  if (typeof name === 'string' && name.trim()) enhancement.name = name.trim();
  if (typeof description === 'string') enhancement.description = description.trim();
  enhancement.updatedAt = new Date().toISOString();
  persist();
  return enhancement;
}

function deleteEnhancement(id) {
  syncFromDisk();
  const idx = db.enhancements.findIndex((e) => e.id === id);
  if (idx === -1) return false;
  db.enhancements.splice(idx, 1);
  persist();
  return true;
}

/* ---------------- enhancement documents ---------------- */

/** List view never carries the HTML body — only what the cards show. */
function documentSummary(doc) {
  const { html, ...rest } = doc;
  return { ...rest, hasBody: Boolean(html) };
}

function listDocuments() {
  syncFromDisk();
  return db.documents
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(documentSummary);
}

function countDocuments() {
  syncFromDisk();
  return db.documents.length;
}

function getDocument(id) {
  syncFromDisk();
  return db.documents.find((d) => d.id === id) || null;
}

function documentsForEnhancement(enhancementId) {
  syncFromDisk();
  return db.documents.filter((d) => d.enhancementId === enhancementId).map(documentSummary);
}

function createDocument(doc) {
  syncFromDisk();
  const now = new Date().toISOString();
  const record = { ...doc, createdAt: now, updatedAt: now };
  db.documents.push(record);
  persist();
  return record;
}

function updateDocument(id, { name, description, product }) {
  syncFromDisk();
  const doc = getDocument(id);
  if (!doc) return null;
  if (typeof name === 'string' && name.trim()) doc.name = name.trim();
  if (typeof description === 'string') doc.description = description.trim();
  if (typeof product === 'string') doc.product = product;
  doc.updatedAt = new Date().toISOString();
  persist();
  return doc;
}

function deleteDocument(id) {
  syncFromDisk();
  const idx = db.documents.findIndex((d) => d.id === id);
  if (idx === -1) return false;
  db.documents.splice(idx, 1);
  persist();
  return true;
}

module.exports = {
  PRODUCTS,
  load,
  listDocuments,
  countDocuments,
  getDocument,
  documentsForEnhancement,
  createDocument,
  updateDocument,
  deleteDocument,
  documentSummary,
  isProduct,
  listProducts,
  listEnhancements,
  getEnhancement,
  findByName,
  createEnhancement,
  setScenarios,
  addScenario,
  deleteScenario,
  setTestCases,
  updateEnhancement,
  deleteEnhancement,
  summary,
};
