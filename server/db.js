'use strict';

/**
 * MongoDB connection.
 *
 * One client for the process, opened on first use and reused after that. The
 * URI comes from MONGODB_URI in .env; the database name from MONGODB_DB, or
 * from the URI's own path when it carries one.
 */

const { MongoClient } = require('mongodb');

const DEFAULT_DB = 'cf_test_scenarios';

let client = null;
let database = null;
let connecting = null;

function uri() {
  return (process.env.MONGODB_URI || '').trim();
}

function dbName() {
  const explicit = (process.env.MONGODB_DB || '').trim();
  if (explicit) return explicit;

  // mongodb+srv://user:pass@host/thisName?opts
  const match = uri().match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/);
  return (match && decodeURIComponent(match[1])) || DEFAULT_DB;
}

function configured() {
  return Boolean(uri());
}

/** Indexes the tool actually queries on. Safe to run on every start. */
async function ensureIndexes(db) {
  await Promise.all([
    db.collection('enhancements').createIndex({ product: 1, createdAt: -1 }),
    db.collection('enhancements').createIndex({ product: 1, nameLower: 1 }),
    db.collection('documents').createIndex({ product: 1, createdAt: -1 }),
    db.collection('documents').createIndex({ enhancementId: 1 }),
  ]);
}

async function connect() {
  if (database) return database;
  if (connecting) return connecting;

  if (!configured()) {
    const err = new Error(
      'No MONGODB_URI configured. Put MONGODB_URI=mongodb+srv://... (and optionally '
      + 'MONGODB_DB=cf_test_scenarios) in the .env file in the project folder, then restart the server.'
    );
    err.status = 503;
    throw err;
  }

  connecting = (async () => {
    client = new MongoClient(uri(), {
      serverSelectionTimeoutMS: 8000,
      retryWrites: true,
    });
    await client.connect();
    database = client.db(dbName());
    await ensureIndexes(database);
    return database;
  })();

  try {
    return await connecting;
  } catch (err) {
    connecting = null;
    client = null;
    database = null;
    throw err;
  } finally {
    connecting = null;
  }
}

/** The live database handle, connecting on first use. */
async function getDb() {
  return database || connect();
}

async function close() {
  if (client) await client.close();
  client = null;
  database = null;
}

/** Mongo stores our uuid as _id; the rest of the app calls it id. */
function fromDoc(doc) {
  if (!doc) return null;
  const { _id, nameLower, ...rest } = doc;
  return { id: _id, ...rest };
}

module.exports = { getDb, connect, close, configured, dbName, fromDoc };
