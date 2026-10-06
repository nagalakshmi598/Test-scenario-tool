'use strict';

/**
 * What a scenario's result starts as.
 *
 * A negative scenario describes the migration refusing something — a missing
 * mapping, an unsupported format, a user without permission. Its result is
 * Fail, because that is the outcome the row is about, and showing Pass beside
 * "Verify that migration fails when…" reads as a contradiction.
 *
 * This is only the starting value. The pill on each row is clickable, so a
 * tester's own result always stands: nothing here is re-applied to a row that
 * already has one.
 */

const NEGATIVE = /^(negative|neg)$/i;

/** The Type column, whatever case the sheet or the model used for the header. */
function typeOf(scenario) {
  const extra = (scenario && scenario.extra) || {};
  const key = Object.keys(extra).find((k) => /^type$/i.test(k));
  return key ? String(extra[key]).trim() : '';
}

function isNegative(scenario) {
  return NEGATIVE.test(typeOf(scenario));
}

function defaultStatus(scenario) {
  return isNegative(scenario) ? 'fail' : 'pass';
}

module.exports = { defaultStatus, isNegative, typeOf };
