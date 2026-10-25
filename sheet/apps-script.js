// Apps Script for the requests sheet: the backend (lib/sheet.js) posts rows
// for a tab (Book previews, Custom stories, Orders, Carts, Checkouts, Visits,
// Daily), which this appends, and later updates for a cover row (the occasion
// and add to cart from the preview page), matched by its Generation id. Setup
// is in the README, under "Requests sheet". Paste this file into the sheet's
// Extensions → Apps Script editor; it is not part of the Vercel deployment.
//
// Tabs and columns come from the backend: a tab or field the sheet doesn't
// have yet is added (columns at the end), so the backend can add data
// without changing this script.

// Limits the script's access to this one spreadsheet.
/** @OnlyCurrentDoc */

// The tabs setup() lays out, in this order; others are added when used.
const TABS = ['Book previews', 'Custom stories', 'Orders', 'Carts', 'Checkouts', 'Visits', 'Daily'];
const MAX_ROWS = 50;
// Rows stay one line high, so a prompt's line breaks don't stretch them;
// the cell still holds the full text.
const ROW_HEIGHT = 21;

// Run from the editor (Run → setup): creates the secret the backend must
// send, unless there is one, lays out the tabs, removes the empty sheet a
// new spreadsheet starts with (and the empty "Requests" tab of the first
// version), sets every data row to one line, and logs the secret to copy
// into SHEET_WEBHOOK_SECRET.
function setup() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('SECRET');
  if (!secret) {
    secret = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    props.setProperty('SECRET', secret);
  }
  const book = SpreadsheetApp.getActiveSpreadsheet();
  TABS.forEach((name, i) => {
    if (!book.getSheetByName(name)) book.insertSheet(name, i);
  });
  book.getSheets().forEach((sheet) => {
    const leftover = sheet.getSheetId() === 0 || sheet.getName() === 'Requests';
    const empty = sheet.getLastRow() === 0 && sheet.getLastColumn() === 0;
    if (leftover && empty && TABS.indexOf(sheet.getName()) === -1) book.deleteSheet(sheet);
    else if (sheet.getLastRow() > 1) sheet.setRowHeightsForced(2, sheet.getLastRow() - 1, ROW_HEIGHT);
  });
  Logger.log('SHEET_WEBHOOK_SECRET=' + secret);
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply({ ok: false, error: 'bad-json' });
  }
  const secret = PropertiesService.getScriptProperties().getProperty('SECRET');
  if (!secret || !body || body.secret !== secret) return reply({ ok: false, error: 'forbidden' });
  if (typeof body.tab !== 'string' || !/^[A-Z][A-Za-z ]{0,39}$/.test(body.tab)) return reply({ ok: false, error: 'bad-tab' });
  const rows = body.rows;
  const update = body.update;
  if (rows !== undefined && !(Array.isArray(rows) && rows.length && rows.length <= MAX_ROWS && rows.every(isFields))) {
    return reply({ ok: false, error: 'bad-rows' });
  }
  if (rows === undefined && !(update && typeof update.generation === 'string' && isFields(update.set))) {
    return reply({ ok: false, error: 'bad-update' });
  }

  // One writer at a time, so two requests can't both add the same tab or column.
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (rows) {
      const sheet = tab(body.tab);
      const fields = [];
      rows.forEach((row) => Object.keys(row).forEach((f) => { if (fields.indexOf(f) === -1) fields.push(f); }));
      const headers = headerRow(sheet, fields);
      rows.forEach((row) => sheet.appendRow(headers.map((h) => cell(h, row[h]))));
      sheet.setRowHeightsForced(sheet.getLastRow() - rows.length + 1, rows.length, ROW_HEIGHT);
    } else if (!updateRow(tab(body.tab), update.generation, update.set)) {
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

function tab(name) {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  return book.getSheetByName(name) || book.insertSheet(name);
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

// The header row, extended with any field it doesn't have yet (and the grid
// widened when a new tab's 26 columns run out).
function headerRow(sheet, fields) {
  const width = sheet.getLastColumn();
  const headers = width ? sheet.getRange(1, 1, 1, width).getValues()[0].map(String) : [];
  const missing = fields.filter((f) => headers.indexOf(f) === -1);
  if (missing.length) {
    const short = headers.length + missing.length - sheet.getMaxColumns();
    if (short > 0) sheet.insertColumnsAfter(sheet.getMaxColumns(), short);
    sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    headers.push(...missing);
  }
  return headers;
}

// Dates and numbers stay typed. A leading apostrophe keeps any other text
// exactly as sent: a name or story idea starting with "=" never becomes a
// formula, and an id or a day never turns into a number or a date.
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
