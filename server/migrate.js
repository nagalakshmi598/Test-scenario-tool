'use strict';

/**
 * One-off import of the old JSON store into MongoDB.
 *
 *   node server/migrate.js            # import, refusing to touch non-empty collections
 *   node server/migrate.js --replace  # drop what is there first
 *
 * Reads server/data/db.json, which stays on disk untouched as a backup.
 */

const fs = require('fs');
const path = require('path');

require('./testcases');                 // loads .env into process.env
const { getDb, close, dbName, configured } = require('./db');

const DATA_FILE = path.join(__dirname, 'data', 'db.json');
const REPLACE = process.argv.includes('--replace');

function read() {
  if (!fs.existsSync(DATA_FILE)) {
    console.log(`No ${DATA_FILE} to import — nothing to do.`);
    return null;
  }
  const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  return {
    enhancements: Array.isArray(parsed.enhancements) ? parsed.enhancements : [],
    documents: Array.isArray(parsed.documents) ? parsed.documents : [],
  };
}

/** The app's `id` becomes Mongo's `_id`; names get a folded copy for lookups. */
function toEnhancement(e) {
  const { id, ...rest } = e;
  return {
    _id: id,
    ...rest,
    nameLower: String(e.name || '').trim().toLowerCase(),
    scenarios: (e.scenarios || []).map((s, idx) => ({ status: 'pass', ...s, sno: idx + 1 })),
  };
}

function toDocument(d) {
  const { id, ...rest } = d;
  return { _id: id, ...rest };
}

(async () => {
  if (!configured()) {
    console.error('MONGODB_URI is not set. Put it in .env and run again.');
    process.exit(1);
  }

  const data = read();
  if (!data) return;

  const db = await getDb();
  console.log(`database: ${dbName()}`);

  const enhancements = db.collection('enhancements');
  const documents = db.collection('documents');

  const existing = await Promise.all([enhancements.countDocuments(), documents.countDocuments()]);
  if ((existing[0] || existing[1]) && !REPLACE) {
    console.error(
      `Refusing to import: the database already holds ${existing[0]} enhancements and `
      + `${existing[1]} documents. Re-run with --replace to overwrite them.`
    );
    await close();
    process.exit(1);
  }

  if (REPLACE) {
    await Promise.all([enhancements.deleteMany({}), documents.deleteMany({})]);
    console.log('cleared existing collections');
  }

  if (data.enhancements.length) {
    await enhancements.insertMany(data.enhancements.map(toEnhancement));
  }
  if (data.documents.length) {
    await documents.insertMany(data.documents.map(toDocument));
  }

  const scenarios = data.enhancements.reduce((sum, e) => sum + (e.scenarios || []).length, 0);
  console.log(`imported ${data.enhancements.length} enhancements (${scenarios} scenarios)`);
  console.log(`imported ${data.documents.length} documents`);
  console.log(`\n${DATA_FILE} is unchanged — keep it until you are happy with the migration.`);

  await close();
})().catch(async (err) => {
  console.error('migration failed:', err.message);
  await close().catch(() => {});
  process.exit(1);
});
