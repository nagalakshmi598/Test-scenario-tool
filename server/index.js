'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const store = require('./store');
const { extractScenarios } = require('./parse');
const { generateTestCases, hasApiKey, activeProvider, keyProblem } = require('./testcases');
const {
  ALLOWED_EXT: DOC_EXT,
  ingestDocument,
  documentFilePath,
  removeDocumentFiles,
} = require('./documents');

const PORT = process.env.PORT || 4310;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const SCENARIO_EXT = new Set(['.csv', '.txt', '.xlsx', '.xls', '.xlsm']);
const DOCUMENT_EXT = new Set(DOC_EXT);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
store.load();

/* Two kinds of upload: the scenario sheet, and the enhancement document.
   The "file" field is always the sheet, "document" is always the write-up. */
function extensionFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  const wantsDocument = file.fieldname === 'document';
  const allowed = wantsDocument ? DOCUMENT_EXT : SCENARIO_EXT;

  if (!allowed.has(ext)) {
    cb(new Error(
      wantsDocument
        ? `Documents must be one of: ${[...DOCUMENT_EXT].join(', ')}.`
        : 'Only .csv, .xlsx, .xls or .txt files can be uploaded as test scenarios.'
    ));
    return;
  }
  cb(null, true);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: extensionFilter,
});

// documents carry screenshots, so they get a bigger ceiling
const uploadDocument = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!DOCUMENT_EXT.has(ext)) {
      cb(new Error(`Documents must be one of: ${[...DOCUMENT_EXT].join(', ')}.`));
      return;
    }
    cb(null, true);
  },
});

const enhancementUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024 },
  fileFilter: extensionFilter,
}).fields([
  { name: 'file', maxCount: 1 },
  { name: 'document', maxCount: 1 },
]);

const app = express();
app.use(express.json());
// no-cache so a UI change shows up on a plain refresh, without a hard reload
app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: true,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-cache');
  },
}));

const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const truthy = (value) => value === undefined || value === 'true' || value === true || value === 'on';

function keepOriginal(id, file) {
  const ext = path.extname(file.originalname).toLowerCase();
  const stored = `${id}-${Date.now()}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), file.buffer);
  return stored;
}

app.get('/api/products', wrap((req, res) => {
  res.json({ products: store.listProducts(), documentCount: store.countDocuments() });
}));

app.get('/api/products/:product/enhancements', wrap((req, res) => {
  const { product } = req.params;
  if (!store.isProduct(product)) return res.status(404).json({ error: 'Unknown product.' });
  res.json({ product, enhancements: store.listEnhancements(product) });
}));

// New enhancement: test scenario sheet, and optionally the enhancement document.
app.post('/api/enhancements', enhancementUpload, wrap(async (req, res) => {
  const { product, name, description } = req.body;
  const sheet = req.files && req.files.file && req.files.file[0];
  const docFile = req.files && req.files.document && req.files.document[0];

  if (!store.isProduct(product)) {
    return res.status(400).json({ error: 'Pick a product: message, email or content.' });
  }
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Enhancement / feature name is required.' });
  }
  if (store.findByName(product, name)) {
    return res.status(409).json({ error: `"${name.trim()}" already exists for this product.` });
  }
  if (!sheet && !docFile) {
    return res.status(400).json({
      error: 'Attach a test scenario file, a document, or both — at least one is needed.',
    });
  }

  // Both files are optional: scenarios can come later, and a document-only
  // enhancement is a valid starting point.
  let scenarios = [];
  let extraColumns = [];
  let skipped = 0;
  if (sheet) {
    ({ scenarios, extraColumns, skipped } = extractScenarios(sheet.buffer, sheet.originalname, {
      splitLines: truthy(req.body.splitLines),
    }));
  }

  const created = store.createEnhancement({
    product,
    name,
    description,
    sourceFile: sheet ? sheet.originalname : '',
    scenarios,
    extraColumns,
  });
  if (sheet) keepOriginal(created.id, sheet);

  let document = null;
  if (docFile) {
    const saved = await storeDocument({
      name: name.trim(),
      description,
      product,
      enhancementId: created.id,
      file: docFile,
    });
    document = store.documentSummary(saved);
  }

  res.status(201).json({
    enhancement: store.summary(created),
    imported: scenarios.length,
    skipped,
    document,
  });
}));

app.get('/api/enhancements/:id', wrap((req, res) => {
  const enhancement = store.getEnhancement(req.params.id);
  if (!enhancement) return res.status(404).json({ error: 'Enhancement not found.' });
  res.json({ enhancement, documents: store.documentsForEnhancement(enhancement.id) });
}));

// Re-upload scenarios for an existing enhancement (replace or append).
app.post('/api/enhancements/:id/scenarios', upload.single('file'), wrap((req, res) => {
  const enhancement = store.getEnhancement(req.params.id);
  if (!enhancement) return res.status(404).json({ error: 'Enhancement not found.' });
  if (!req.file) return res.status(400).json({ error: 'Attach a CSV or XLSX file of test scenarios.' });

  const mode = req.body.mode === 'append' ? 'append' : 'replace';
  const { scenarios, extraColumns, skipped } = extractScenarios(req.file.buffer, req.file.originalname, {
    splitLines: truthy(req.body.splitLines),
  });

  const updated = store.setScenarios(enhancement.id, {
    scenarios,
    extraColumns,
    sourceFile: req.file.originalname,
    mode,
  });
  keepOriginal(enhancement.id, req.file);

  res.json({ enhancement: updated, imported: scenarios.length, skipped, mode });
}));

// Add a single scenario typed in the tool (no CSV) — appended after the last row.
app.post('/api/enhancements/:id/scenario', wrap((req, res) => {
  const enhancement = store.getEnhancement(req.params.id);
  if (!enhancement) return res.status(404).json({ error: 'Enhancement not found.' });

  const { scenario, extra } = req.body || {};
  if (typeof scenario !== 'string' || !scenario.trim()) {
    return res.status(400).json({ error: 'Type the test scenario before adding it.' });
  }
  if (scenario.trim().length > 2000) {
    return res.status(400).json({ error: 'That test scenario is too long (2000 characters max).' });
  }

  const updated = store.addScenario(enhancement.id, { scenario, extra });
  res.status(201).json({ enhancement: updated, sno: updated.scenarios.length });
}));

// Generate (or re-generate) detailed test cases for one scenario, via Claude.
app.post('/api/enhancements/:id/scenarios/:sno/testcases', wrap(async (req, res) => {
  const enhancement = store.getEnhancement(req.params.id);
  if (!enhancement) return res.status(404).json({ error: 'Enhancement not found.' });

  const sno = Number(req.params.sno);
  const scenario = enhancement.scenarios.find((s) => Number(s.sno) === sno);
  if (!scenario) return res.status(404).json({ error: `Test scenario ${req.params.sno} not found.` });

  // Serve the cached set unless the caller explicitly asked for a fresh one.
  if (scenario.testCases && scenario.testCases.length && req.body && req.body.regenerate !== true) {
    return res.json({ sno, testCases: scenario.testCases, meta: scenario.testCasesMeta, cached: true });
  }

  const product = store.PRODUCTS.find((p) => p.key === enhancement.product);
  const generated = await generateTestCases({
    productLabel: product ? product.label : enhancement.product,
    enhancementName: enhancement.name,
    scenarioText: scenario.scenario,
    sno,
  });

  store.setTestCases(enhancement.id, sno, generated);
  res.status(201).json({
    sno,
    testCases: generated.testCases,
    meta: { model: generated.model, provider: generated.provider, generatedAt: generated.generatedAt },
    cached: false,
  });
}));

/* ---------------- enhancement documents ---------------- */

async function storeDocument({ name, description, product, enhancementId, file }) {
  const id = crypto.randomUUID();
  const ingested = await ingestDocument({ id, buffer: file.buffer, originalName: file.originalname });

  return store.createDocument({
    id,
    name: name.trim(),
    description: (description || '').trim(),
    product: product || '',
    enhancementId: enhancementId || '',
    fileName: file.originalname,
    ...ingested,
  });
}

app.get('/api/documents', wrap((req, res) => {
  res.json({ documents: store.listDocuments() });
}));

app.post('/api/documents', uploadDocument.single('file'), wrap(async (req, res) => {
  const { description, product, enhancementId } = req.body;
  if (!req.file) return res.status(400).json({ error: 'Attach the document file.' });

  // No name typed? Use the file name — the document is the point, not the label.
  const name = (req.body.name || '').trim() || path.basename(req.file.originalname, path.extname(req.file.originalname));

  const doc = await storeDocument({ name, description, product, enhancementId, file: req.file });
  res.status(201).json({ document: store.documentSummary(doc) });
}));

app.get('/api/documents/:id', wrap((req, res) => {
  const doc = store.getDocument(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  res.json({ document: doc });
}));

// The stored file itself: PDFs render in the browser viewer, images as <img>.
app.get('/api/documents/:id/file', wrap((req, res) => {
  const doc = store.getDocument(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });

  const file = documentFilePath(doc.id, doc.storedFile);
  if (!file) return res.status(404).json({ error: 'The stored file is missing.' });

  res.setHeader('Content-Type', doc.mime || 'application/octet-stream');
  if (req.query.download === '1') {
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(doc.fileName)}"`);
  }
  res.sendFile(file);
}));

// Screenshots pulled out of a .docx.
app.get('/api/documents/:id/assets/:asset', wrap((req, res) => {
  const doc = store.getDocument(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });

  const file = documentFilePath(doc.id, req.params.asset);
  if (!file) return res.status(404).json({ error: 'Image not found.' });
  res.sendFile(file);
}));

// Rename a document, or move it to another product tab.
app.patch('/api/documents/:id', wrap((req, res) => {
  const doc = store.getDocument(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });

  const { name, description, product } = req.body || {};
  if (product !== undefined && product !== '' && !store.isProduct(product)) {
    return res.status(400).json({ error: 'Unknown product.' });
  }
  if (name !== undefined && !String(name).trim()) {
    return res.status(400).json({ error: 'The document needs a name.' });
  }

  res.json({ document: store.documentSummary(store.updateDocument(doc.id, { name, description, product })) });
}));

app.delete('/api/documents/:id', wrap((req, res) => {
  const doc = store.getDocument(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });

  store.deleteDocument(doc.id);
  removeDocumentFiles(doc.id);
  res.status(204).end();
}));

// Is a Claude key configured? Lets the UI explain itself before you click.
app.get('/api/ai-status', wrap((req, res) => {
  const { provider, model } = activeProvider();
  res.json({ ready: hasApiKey(), provider, model, problem: keyProblem() });
}));

// Delete a single scenario row by its serial number.
app.delete('/api/enhancements/:id/scenarios/:sno', wrap((req, res) => {
  const sno = Number(req.params.sno);
  if (!Number.isInteger(sno) || sno < 1) {
    return res.status(400).json({ error: 'Invalid scenario number.' });
  }

  const result = store.deleteScenario(req.params.id, sno);
  if (result.status === 'no-enhancement') return res.status(404).json({ error: 'Enhancement not found.' });
  if (result.status === 'no-scenario') return res.status(404).json({ error: `Test scenario ${sno} no longer exists.` });

  res.json({ enhancement: result.enhancement, removed: result.removed });
}));

app.patch('/api/enhancements/:id', wrap((req, res) => {
  const { name, description } = req.body || {};
  const enhancement = store.getEnhancement(req.params.id);
  if (!enhancement) return res.status(404).json({ error: 'Enhancement not found.' });

  if (name && name.trim()) {
    const clash = store.findByName(enhancement.product, name);
    if (clash && clash.id !== enhancement.id) {
      return res.status(409).json({ error: `"${name.trim()}" already exists for this product.` });
    }
  }
  res.json({ enhancement: store.summary(store.updateEnhancement(enhancement.id, { name, description })) });
}));

app.delete('/api/enhancements/:id', wrap((req, res) => {
  if (!store.deleteEnhancement(req.params.id)) {
    return res.status(404).json({ error: 'Enhancement not found.' });
  }
  res.status(204).end();
}));

// Download the stored scenarios back as a clean CSV.
app.get('/api/enhancements/:id/export.csv', wrap((req, res) => {
  const enhancement = store.getEnhancement(req.params.id);
  if (!enhancement) return res.status(404).json({ error: 'Enhancement not found.' });

  const cell = (value) => {
    const text = String(value == null ? '' : value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = ['S.No', 'Test Scenario', ...enhancement.extraColumns];
  const lines = [header.map(cell).join(',')];
  enhancement.scenarios.forEach((s) => {
    lines.push([s.sno, s.scenario, ...enhancement.extraColumns.map((c) => (s.extra || {})[c] || '')].map(cell).join(','));
  });

  const safeName = enhancement.name.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 60) || 'scenarios';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.csv"`);
  res.send(`\uFEFF${lines.join('\r\n')}\r\n`);
}));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File is larger than the 10 MB limit.' });
  }
  const status = err.status || 400;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Something went wrong.' });
});

app.listen(PORT, () => {
  console.log(`QA Test Scenario Tool running at http://localhost:${PORT}`);
});
