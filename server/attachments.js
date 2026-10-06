'use strict';

/**
 * Files dropped into the chat.
 *
 * Whatever is attached has to become something the model can read: a picture
 * goes to it as a picture, anything with words in it becomes text that sits
 * alongside the question. A spreadsheet of scenarios is read as rows, because
 * that is what it is, and saying so is more useful than handing over a wall of
 * comma-separated text.
 *
 * Nothing here is stored. An attachment informs one answer and is then gone;
 * the write-ups that need keeping go through the Documents page.
 */

const path = require('path');
const mammoth = require('mammoth');
const { parseCsv } = require('./parse');

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_TEXT = 12000;          // per file, in characters handed to the model
const MAX_FILES = 5;

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const SHEET_EXT = new Set(['.csv', '.tsv', '.xlsx', '.xls', '.xlsm']);
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.log', '.yml', '.yaml', '.xml', '.html',
  '.htm', '.js', '.ts', '.java', '.py', '.sql', '.sh', '.ini', '.env', '.properties',
]);

/**
 * The picture formats the models accept, recognised by their opening bytes.
 *
 * The extension is a claim, not a fact: a screenshot saved as .png may be a
 * JPEG, and a half-finished upload may be a .png with nothing behind it.
 * Either one comes back from the provider as a 400 that loses the whole
 * message, including the files that were fine, so the bytes decide.
 */
function imageType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  const hex = buffer.subarray(0, 12).toString('hex');

  if (hex.startsWith('89504e470d0a1a0a')) return 'image/png';
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('474946383761') || hex.startsWith('474946383961')) return 'image/gif';
  if (hex.startsWith('52494646') && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';

  return null;
}

function clip(text) {
  const clean = String(text || '').replace(/\u0000/g, '').trim();
  return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT)}\n…(truncated)` : clean;
}

/** A sheet read as the rows it holds, rather than as raw characters. */
function fromSheet(buffer, name) {
  const ext = path.extname(name).toLowerCase();

  if (ext === '.csv' || ext === '.tsv') {
    const rows = parseCsv(buffer.toString('utf8'));
    return clip(rows.map((row) => row.join(' | ')).join('\n'));
  }

  // xlsx is already a dependency, for scenario sheets
  const xlsx = require('xlsx');
  const book = xlsx.read(buffer, { type: 'buffer' });
  const out = [];

  book.SheetNames.slice(0, 5).forEach((sheetName) => {
    const rows = xlsx.utils.sheet_to_json(book.Sheets[sheetName], { header: 1, blankrows: false });
    if (!rows.length) return;
    out.push(`--- sheet: ${sheetName} ---`);
    rows.slice(0, 300).forEach((row) => out.push(row.join(' | ')));
  });

  return clip(out.join('\n'));
}

/**
 * Turn one uploaded file into something the model can use.
 * @returns {Promise<{name, kind, text?, image?, mime?, note?}>}
 */
async function readAttachment(file) {
  const name = file.originalname || 'attachment';
  const ext = path.extname(name).toLowerCase();

  if (file.size > MAX_BYTES) {
    return { name, kind: 'skipped', note: 'larger than 10 MB' };
  }

  if (IMAGE_EXT.has(ext)) {
    const mime = imageType(file.buffer);
    if (!mime) {
      return {
        name,
        kind: 'skipped',
        note: ext === '.bmp'
          ? 'BMP screenshots cannot be read — save it as PNG or JPEG'
          : 'this does not look like a readable image — it may be damaged or still uploading',
      };
    }

    return { name, kind: 'image', image: file.buffer.toString('base64'), mime };
  }

  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return { name, kind: 'document', text: clip(result.value) };
  }

  if (ext === '.pdf') {
    // No PDF text extractor is installed, and guessing at the bytes would
    // produce nonsense. Say so rather than feed the model rubbish.
    return { name, kind: 'skipped', note: 'PDF text cannot be read here — paste the part you need, or upload it under Documents' };
  }

  if (SHEET_EXT.has(ext)) {
    return { name, kind: 'sheet', text: fromSheet(file.buffer, name) };
  }

  if (TEXT_EXT.has(ext) || !ext) {
    return { name, kind: 'text', text: clip(file.buffer.toString('utf8')) };
  }

  // Unknown extension: if it reads as text, use it; otherwise say what it was.
  const sample = file.buffer.slice(0, 4096).toString('utf8');
  const printable = sample.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '').length / Math.max(sample.length, 1);
  if (printable > 0.85) return { name, kind: 'text', text: clip(file.buffer.toString('utf8')) };

  return { name, kind: 'skipped', note: `${ext || 'this file type'} is not readable as text` };
}

/** Read everything attached to one message. */
async function readAll(files) {
  const list = (files || []).slice(0, MAX_FILES);
  return Promise.all(list.map((file) => readAttachment(file)));
}

/** The text ones, as a block to sit alongside the question. */
function asContext(attachments) {
  const usable = attachments.filter((a) => a.text);
  if (!usable.length) return '';

  return [
    '',
    '=== FILES THE USER ATTACHED ===',
    ...usable.map((a) => `\n--- ${a.name} (${a.kind}) ---\n${a.text}`),
  ].join('\n');
}

module.exports = { readAll, asContext, MAX_FILES, MAX_BYTES };
