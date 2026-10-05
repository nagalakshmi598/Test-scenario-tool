'use strict';

/**
 * Which store the tool uses.
 *
 * MONGODB_URI set  -> MongoDB  (shared, several people or machines)
 * nothing set      -> JSON file (zero setup, this machine only)
 *
 * Both modules expose the same async API, so nothing else in the app knows or
 * cares which one is behind it. Moving between them is `node server/migrate.js`.
 */

require('./testcases');                 // loads .env into process.env

const useMongo = Boolean((process.env.MONGODB_URI || '').trim());

module.exports = useMongo ? require('./store.mongo') : require('./store.file');
module.exports.backend = useMongo ? 'mongodb' : 'json-file';
