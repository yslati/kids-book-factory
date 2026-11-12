// Apps Script for the requests sheet: the backend (lib/sheet.js) posts rows
// for a tab (TABS below), which this appends, and later updates for a cover
// row (the occasion and add to cart from the preview page), matched by its
// Generation id. Columns are found by their header name, so they can be
// moved freely in the sheet; renaming a header makes a new column. Setup
// is in the README, under "Requests sheet". Paste this file into the sheet's
// Extensions → Apps Script editor; it is not part of the Vercel deployment.
//
// Tabs and columns come from the backend: a tab or field the sheet doesn't
// have yet is added (a column at the end, or after its PLACE_AFTER
// neighbour), so the backend can add data without changing this script.

// Limits the script's access to this one spreadsheet.
/** @OnlyCurrentDoc */

// The tabs setup() and tidy() lay out, in this order, with a colour per group;
// others are added when used.
const TABS = ['Daily', 'Weekly', 'Orders', 'Checkouts', 'Carts', 'Book previews', 'Custom stories', 'Shares', 'Visits', 'Searches', 'Chats', 'Logs'];
const TAB_COLORS = {
  Daily: '#8e7cc3', Weekly: '#8e7cc3',
  Orders: '#6aa84f', Checkouts: '#6aa84f', Carts: '#6aa84f',
  'Book previews': '#3d85c6', 'Custom stories': '#3d85c6', Shares: '#3d85c6',
  Visits: '#e69138', Searches: '#e69138', Chats: '#e69138',
  Logs: '#999999'
};
// A new column goes right after its neighbour when the tab has it, else at the end.
const PLACE_AFTER = { Language: 'Age' };
// Column widths in pixels; other columns fit their content, up to MAX_WIDTH.
const WIDE = ['Prompt', 'Story idea', 'Extra details', 'Details', 'Journey', 'Items', 'Reported problem', 'Error',
  'Top sources', 'Orders by source', 'Top pages', 'Top countries', 'Top books', 'Top searches'];
const LINKS = ['Photo', 'Cover', 'Fixed cover', 'Link', 'Landing page', 'Page', 'Reply in Inbox', 'Reference book'];
const MAX_WIDTH = 220;
const HEADER_COLOR = '#f3e9d8';

// Colour chips for the values that repeat, so a column reads at a glance:
// [background, text colour, bold?].
const COLORS = {
  good: ['#d9f2e3', '#1e7b45', true], bad: ['#fbd5d2', '#a61c1c', true], warn: ['#fff1c2', '#8a5a00', true],
  boy: ['#dcebff', '#1f5fbf', true], girl: ['#ffdff0', '#b0306f', true],
  hard: ['#e9e1fb', '#5b34b5', true], soft: ['#ffe8d1', '#b5540b', true], cart: ['#d9f2e3', '#1e7b45', true],
  en: ['#eef1f5', '#3c4858'], es: ['#ffe9c7', '#a35400'], fr: ['#dfe9ff', '#2747a8'],
  de: ['#f1e4d6', '#6b4423'], it: ['#dcf5e3', '#1d7a3e'], pt: ['#fde0e0', '#a12a2a'],
  google: ['#e3edff', '#1a56c4'], ai: ['#dff6f1', '#11806b'], direct: ['#eeeeee', '#555555'],
  share: ['#efe3ff', '#6c2fb8'], social: ['#ffe3ef', '#b51f63'],
  guest: ['#f1f1f1', '#777777'], member: ['#dff6f1', '#11806b', true], first: ['#fff1c2', '#8a5a00', true],
  whatsapp: ['#dcf8e5', '#128c3e', true], copy: ['#eeeeee', '#555555'], native: ['#efe3ff', '#6c2fb8'],
  flare: ['#ffeede', '#b5540b'], sunburst: ['#fff8cc', '#8a6d00'],
  birthday: ['#ffe3ef', '#b51f63'], holidays: ['#dcf5e3', '#1d7a3e'], baby: ['#e6f4ff', '#2b6cb0'],
  school: ['#fff1c2', '#8a5a00'], because: ['#efe3ff', '#6c2fb8'],
  sports: ['#dcf5e3', '#1d7a3e'], careers: ['#fff1c2', '#8a5a00'], adventure: ['#efe3ff', '#6c2fb8'],
  stem: ['#dfe9ff', '#2747a8'], bedtime: ['#e8e6ff', '#3f3a99'], other: ['#eeeeee', '#555555'],
  note: ['#fff8e1', '#8a5a00']
};
// [column(s), 'is' | 'has' | 'filled', value, look].
const CHIPS = [
  ['Status', 'is', 'Ready', 'good'], ['Status', 'is', 'Failed', 'bad'],
  ['Level', 'is', 'Error', 'bad'], ['Level', 'is', 'Warning', 'warn'],
  [['Hero'], 'is', 'Boy', 'boy'], [['Hero'], 'is', 'Girl', 'girl'],
  [['Variant', 'Cover', 'Added to cart'], 'has', 'Hardcover', 'hard'],
  [['Variant', 'Cover', 'Added to cart'], 'has', 'Softcover', 'soft'],
  ['Added to cart', 'filled', '', 'cart'],
  ['Language', 'is', 'English', 'en'], ['Language', 'is', 'Spanish', 'es'], ['Language', 'is', 'French', 'fr'],
  ['Language', 'is', 'German', 'de'], ['Language', 'is', 'Italian', 'it'], ['Language', 'is', 'Portuguese', 'pt'],
  ['Source', 'has', 'share', 'share'], ['Source', 'has', 'google', 'google'], ['Source', 'has', 'bing', 'google'],
  ['Source', 'has', 'chatgpt', 'ai'], ['Source', 'has', 'perplexity', 'ai'], ['Source', 'has', 'gemini', 'ai'],
  ['Source', 'has', 'facebook', 'social'], ['Source', 'has', 'instagram', 'social'], ['Source', 'has', 'ig /', 'social'], ['Source', 'has', 'pinterest', 'social'],
  ['Source', 'has', 'tiktok', 'social'], ['Source', 'is', 'direct', 'direct'],
  ['Customer', 'is', 'Guest', 'guest'], ['Customer', 'has', 'Signed in', 'member'],
  ['Customer', 'is', 'First order', 'first'], ['Customer', 'is', 'Returning', 'member'],
  ['Cookie consent', 'is', 'Yes', 'good'], ['Cookie consent', 'is', 'No', 'guest'],
  ['Event', 'is', 'Link opened', 'good'], ['Event', 'is', 'Share clicked', 'share'],
  [['Via', 'Shared'], 'is', 'whatsapp', 'whatsapp'], [['Via', 'Shared'], 'is', 'copy', 'copy'],
  [['Via', 'Shared'], 'is', 'native', 'native'], [['Via', 'Shared'], 'is', 'facebook', 'social'],
  ['Model', 'has', 'flare', 'flare'], ['Model', 'has', 'sunburst', 'sunburst'],
  ['Occasion', 'is', 'A birthday', 'birthday'], ['Occasion', 'is', 'The holidays', 'holidays'],
  ['Occasion', 'is', 'A new baby', 'baby'], ['Occasion', 'is', 'Starting school', 'school'],
  ['Occasion', 'is', 'Just because', 'because'],
  ['World', 'is', 'Sports', 'sports'], ['World', 'is', 'Dream jobs', 'careers'],
  ['World', 'is', 'Adventure & fantasy', 'adventure'], ['World', 'is', 'STEM & space', 'stem'],
  ['World', 'is', 'Bedtime & kindness', 'bedtime'], ['World', 'is', 'Something else', 'other'],
  ['Where', 'is', 'Search page', 'google'], ['Where', 'has', 'collection', 'share'],
  [['Reported problem', 'Fixed cover', 'Extra details', 'Discount codes'], 'filled', '', 'note'],
  ['Error', 'filled', '', 'bad'],
  ['Cover rating', 'filled', '', 'note']
];
// Who and what each row is about, in bold.
const BOLD = ["Child's name", 'Child', 'Search', 'Order', 'Day', 'Week'];
// Numbers shaded from the first colour (lowest) to the second (highest).
const SCALES = [
  ['Rating', '#f8c4c0', '#b7e4c7'],
  ['Seconds', '#d9f2e3', '#fbd5d2'],
  [['Visit number', 'Opens', 'Quantity', 'Results'], '#ffffff', '#c9dcff'],
  [['Price', 'Order total', 'Total', 'Revenue', 'Orders'], '#ffffff', '#b7e4c7'],
  [['Visitors', 'Visits', 'Page views', 'Product views', 'Previews started', 'Previews ready', 'Added to cart', 'Checkouts started',
    'Share clicks', 'Shared links opened'], '#ffffff', '#c9dcff'],
  ['Previews failed', '#ffffff', '#fbd5d2']
];
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
  tidy();
  Logger.log('SHEET_WEBHOOK_SECRET=' + secret);
}

// Run from the editor (Run → tidy), any time: puts the tabs in TABS order with
// their group colours and styles every tab (style()). Columns keep the order
// they have; rows are untouched.
function tidy() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let position = 0;
  TABS.forEach((name) => {
    const sheet = book.getSheetByName(name);
    if (!sheet) return;
    book.setActiveSheet(sheet);
    book.moveActiveSheet(++position);
  });
  book.getSheets().forEach(style);
  book.setActiveSheet(book.getSheets()[0]);
}

// A readable tab: a frozen, shaded header row and first column, dates as
// "2026-11-12 19:56", sized columns, one-line cells, and colour for what
// needs a look (a failed cover, an error, a book added to the cart).
function style(sheet) {
  const width = sheet.getLastColumn();
  if (!width) return;
  if (TAB_COLORS[sheet.getName()]) sheet.setTabColor(TAB_COLORS[sheet.getName()]);
  const headers = sheet.getRange(1, 1, 1, width).getValues()[0].map(String);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(1);
  sheet.getRange(1, 1, 1, width).setFontWeight('bold').setBackground(HEADER_COLOR).setVerticalAlignment('middle');
  sheet.setRowHeight(1, 30);
  sheet.getRange(1, 1, sheet.getMaxRows(), width).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);

  const column = (name) => sheet.getRange(1, headers.indexOf(name) + 1, sheet.getMaxRows(), 1);
  BOLD.forEach((name) => { if (headers.indexOf(name) !== -1) column(name).setFontWeight('bold'); });
  if (headers.indexOf('Date') !== -1) {
    // A column of a Sheets table keeps the format of its column type. Writes
    // are batched, so flush to meet the refusal here rather than later.
    try {
      column('Date').setNumberFormat('yyyy-mm-dd hh:mm');
      SpreadsheetApp.flush();
    } catch (e) { /* typed table column */ }
  }
  headers.forEach((name, i) => {
    if (WIDE.indexOf(name) !== -1) sheet.setColumnWidth(i + 1, 280);
    else if (LINKS.indexOf(name) !== -1) sheet.setColumnWidth(i + 1, 180);
    else {
      sheet.autoResizeColumn(i + 1);
      sheet.setColumnWidth(i + 1, Math.max(80, Math.min(MAX_WIDTH, sheet.getColumnWidth(i + 1) + 16)));
    }
  });

  // Whole columns, so rows added later are coloured too. The first rule that
  // matches a cell wins.
  const letter = (name) => {
    const n = headers.indexOf(name) + 1;
    return n ? sheet.getRange(1, n).getA1Notation().replace(/\d+/, '') : '';
  };
  const rules = [];
  // Daily and Weekly hold counts, which only get shading.
  const totals = sheet.getName() === 'Daily' || sheet.getName() === 'Weekly';
  (totals ? [] : CHIPS).forEach(([names, test, value, look]) => [].concat(names).forEach((name) => {
    const col = letter(name);
    if (!col) return;
    let rule = SpreadsheetApp.newConditionalFormatRule().setRanges([sheet.getRange(col + '2:' + col)]);
    if (test === 'is') rule = rule.whenTextEqualTo(value);
    else if (test === 'has') rule = rule.whenTextContains(value);
    else rule = rule.whenCellNotEmpty();
    const [background, color, bold] = COLORS[look];
    rule = rule.setBackground(background).setFontColor(color);
    if (bold) rule = rule.setBold(true);
    rules.push(rule.build());
  }));
  SCALES.forEach(([names, low, high]) => [].concat(names).forEach((name) => {
    const col = letter(name);
    if (!col) return;
    rules.push(SpreadsheetApp.newConditionalFormatRule().setRanges([sheet.getRange(col + '2:' + col)])
      .setGradientMinpoint(low).setGradientMaxpoint(high).build());
  }));
  sheet.setConditionalFormatRules(rules);
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

// The tab, created where TABS puts it when it doesn't exist yet.
function tab(name) {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = book.getSheetByName(name);
  if (sheet) return sheet;
  const order = TABS.indexOf(name);
  return book.insertSheet(name, order === -1 ? book.getSheets().length : Math.min(order, book.getSheets().length));
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
  if (!missing.length) return headers;
  const created = !headers.length;
  const last = missing.filter((f) => {
    const after = headers.indexOf(PLACE_AFTER[f]);
    if (after === -1) return true;
    sheet.insertColumnAfter(after + 1);
    sheet.getRange(1, after + 2).setValue(f);
    headers.splice(after + 1, 0, f);
    return false;
  });
  if (last.length) {
    const short = headers.length + last.length - sheet.getMaxColumns();
    if (short > 0) sheet.insertColumnsAfter(sheet.getMaxColumns(), short);
    sheet.getRange(1, headers.length + 1, 1, last.length).setValues([last]);
    headers.push(...last);
  }
  // A new tab gets the full styling; a new column only the header look.
  if (created) style(sheet);
  else sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground(HEADER_COLOR);
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
