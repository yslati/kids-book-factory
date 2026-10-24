// Apps Script for the requests sheet: the backend (lib/sheet.js) posts one
// row per cover request, which this appends to the "Requests" tab, and later
// updates for that row (the occasion and add to cart from the preview page),
// matched by its Generation id. Setup is in the README, under "Requests
// sheet". Paste this file into the sheet's Extensions → Apps Script editor;
// it is not part of the Vercel deployment.
//
// Columns come from the field names: a field the tab doesn't have yet gets a
// new column at the end, so the backend can add fields without changing this
// script.

const TAB = 'Requests';

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply({ ok: false, error: 'bad-json' });
  }
  const secret = PropertiesService.getScriptProperties().getProperty('SECRET');
  if (!secret || !body || body.secret !== secret) return reply({ ok: false, error: 'forbidden' });
  const row = body.row;
  const update = body.update;
  if (row !== undefined && !isFields(row)) return reply({ ok: false, error: 'bad-row' });
  if (row === undefined && !(update && typeof update.generation === 'string' && isFields(update.set))) {
    return reply({ ok: false, error: 'bad-update' });
  }

  // One writer at a time, so two requests can't both add the same column.
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = requestsTab();
    if (row) {
      const headers = headerRow(sheet, Object.keys(row));
      sheet.appendRow(headers.map((h) => cell(h, row[h])));
    } else if (!updateRow(sheet, update.generation, update.set)) {
      return reply({ ok: false, error: 'not-found' });
    }
  } finally {
    lock.releaseLock();
  }
  return reply({ ok: true });
}

function isFields(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Sets fields on the newest row with this Generation id; false when there is
// none, and then nothing is written.
function updateRow(sheet, generation, fields) {
  const last = sheet.getLastRow();
  const width = sheet.getLastColumn();
  if (last < 2 || !generation) return false;
  const column = sheet.getRange(1, 1, 1, width).getValues()[0].map(String).indexOf('Generation') + 1;
  if (!column) return false;
  const ids = sheet.getRange(2, column, last - 1, 1).getValues();
  let index = ids.length - 1;
  while (index >= 0 && String(ids[index][0]) !== generation) index--;
  if (index < 0) return false;

  const headers = headerRow(sheet, Object.keys(fields));
  Object.keys(fields).forEach((f) => {
    sheet.getRange(index + 2, headers.indexOf(f) + 1).setValue(cell(f, fields[f]));
  });
  return true;
}

function requestsTab() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  return book.getSheetByName(TAB) || book.insertSheet(TAB, 0);
}

// The header row, extended with any field it doesn't have yet.
function headerRow(sheet, fields) {
  const width = sheet.getLastColumn();
  const headers = width ? sheet.getRange(1, 1, 1, width).getValues()[0].map(String) : [];
  const missing = fields.filter((f) => headers.indexOf(f) === -1);
  if (missing.length) {
    sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    headers.push(...missing);
  }
  return headers;
}

// Dates and numbers stay typed. A leading apostrophe keeps any other text
// exactly as sent: a name or story idea starting with "=" never becomes a
// formula, and an id never turns into a number or a date.
function cell(header, value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return value;
  const text = String(value);
  if (header === 'Date') {
    const date = new Date(text);
    if (!isNaN(date.getTime())) return date;
  }
  return /^[=+\-@]|^[\d\s.,:\/+\-e]+$/i.test(text) ? "'" + text : text;
}

function reply(result) {
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}
