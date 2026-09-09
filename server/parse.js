'use strict';

const path = require('path');
const XLSX = require('xlsx');

const SCENARIO_HEADERS = /^(test\s*scenario(s)?|scenario(s)?|test\s*case(s)?|test\s*description|description|test)$/i;
const SNO_HEADERS = /^(s\.?\s*no\.?|sr\.?\s*no\.?|serial\s*no\.?|serial\s*number|no\.?|#|sl\.?\s*no\.?|id)$/i;
const LIST_PREFIX = /^\s*(?:\(?\d+[.)\]:-]|[-*\u2022\u25cf\u25aa])\s+/;

/**
 * Minimal RFC 4180 CSV reader: handles quoted fields, escaped quotes,
 * embedded newlines, CRLF endings and a leading BOM.
 */
function parseCsv(text) {
  const src = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];

    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      // handled by the \n branch (or a lone \r terminates the row)
      if (src[i + 1] !== '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      }
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.map((r) => r.map((cell) => String(cell == null ? '' : cell).trim()));
}

function parseSheet(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '', raw: false });
  return rows.map((r) => r.map((cell) => String(cell == null ? '' : cell).trim()));
}

function isBlankRow(row) {
  return !row || row.every((cell) => cell === '');
}

/** Locate the header row (if any) and the meaningful column indexes. */
function resolveLayout(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i += 1) {
    const row = rows[i];
    if (isBlankRow(row)) continue;

    const scenarioIdx = row.findIndex((cell) => SCENARIO_HEADERS.test(cell));
    if (scenarioIdx !== -1) {
      const snoIdx = row.findIndex((cell) => SNO_HEADERS.test(cell));
      const extraColumns = row
        .map((cell, idx) => ({ name: cell, idx }))
        .filter((c) => c.name !== '' && c.idx !== scenarioIdx && c.idx !== snoIdx);
      return { headerRow: i, scenarioIdx, snoIdx, extraColumns };
    }
  }

  // No recognisable header: assume a plain list, optionally prefixed by numbers.
  const firstRow = rows.findIndex((row) => !isBlankRow(row));
  if (firstRow === -1) return null;

  const dataRows = rows.slice(firstRow).filter((row) => !isBlankRow(row));
  const firstColNumeric =
    dataRows.length > 0 &&
    dataRows.every((row) => row[0] !== undefined && /^\d+\.?$/.test(row[0])) &&
    dataRows.some((row) => (row[1] || '') !== '');

  return {
    headerRow: firstRow - 1,
    scenarioIdx: firstColNumeric ? 1 : 0,
    snoIdx: firstColNumeric ? 0 : -1,
    extraColumns: [],
  };
}

function splitCell(value) {
  return String(value)
    .split(/\r?\n+/)
    .map((line) => line.replace(LIST_PREFIX, '').trim())
    .filter((line) => line !== '');
}

/**
 * Turn an uploaded CSV/XLSX buffer into a normalised scenario list.
 * Every scenario ends up on its own row with a fresh sequential serial number.
 */
function extractScenarios(buffer, filename, { splitLines = true } = {}) {
  const ext = path.extname(filename || '').toLowerCase();
  const rows =
    ext === '.xlsx' || ext === '.xls' || ext === '.xlsm'
      ? parseSheet(buffer)
      : parseCsv(buffer.toString('utf8'));

  if (!rows.length) {
    const err = new Error('The uploaded file is empty.');
    err.status = 400;
    throw err;
  }

  const layout = resolveLayout(rows);
  if (!layout) {
    const err = new Error('No rows found in the uploaded file.');
    err.status = 400;
    throw err;
  }

  const extraColumns = layout.extraColumns.map((c) => c.name);
  const scenarios = [];
  let skipped = 0;

  for (let i = layout.headerRow + 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (isBlankRow(row)) continue;

    const raw = row[layout.scenarioIdx] || '';
    const texts = splitLines ? splitCell(raw) : [raw.trim()].filter(Boolean);

    if (!texts.length) {
      skipped += 1;
      continue;
    }

    const extra = {};
    layout.extraColumns.forEach((col) => {
      extra[col.name] = row[col.idx] || '';
    });

    texts.forEach((text) => {
      scenarios.push({
        sno: scenarios.length + 1,
        scenario: text,
        sourceSno: row[layout.snoIdx] || '',
        extra,
      });
    });
  }

  if (!scenarios.length) {
    const err = new Error(
      'No test scenarios were found. Expected a column named "Test Scenario" (a plain single-column list also works).'
    );
    err.status = 400;
    throw err;
  }

  return { scenarios, extraColumns, skipped };
}

module.exports = { extractScenarios, parseCsv };
