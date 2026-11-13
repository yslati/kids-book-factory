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
const PLACE_AFTER = { Language: 'Age', Cost: 'Model' };
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
  const dashboard = book.getSheetByName(ANALYTICS);
  if (dashboard) {
    book.setActiveSheet(dashboard);
    book.moveActiveSheet(1);
  }
  book.getSheets().forEach(style);
  book.setActiveSheet(book.getSheets()[0]);
}

// A readable tab: a frozen, shaded header row and first column, dates as
// "2026-11-12 19:56", sized columns, one-line cells, and colour for what
// needs a look (a failed cover, an error, a book added to the cart).
function style(sheet) {
  const width = sheet.getLastColumn();
  if (!width || sheet.getName() === ANALYTICS) return;
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

// The Analytics tab: totals and charts drawn from the other tabs by live
// formulas, so it stays current as rows arrive. Morocco (the owner's own
// tests) is left out wherever rows carry a country; Daily and Weekly totals
// can't be split and include it.
const ANALYTICS = 'Analytics';
const PALETTE = ['#3d85c6', '#e69138', '#6aa84f', '#8e7cc3', '#cc4125', '#f1c232', '#45818e', '#c27ba0', '#999999', '#674ea7'];
// Charts sit two per row in B:P; the tables they draw from start at DATA_COLUMN.
const DATA_COLUMN = 22;
const CHART_WIDTH = 600;
const CHART_HEIGHT = 340;
const CHART_ROWS = 18;
const SERIES_DAYS = 60;

// Run from the editor (Run → analytics) to create or rebuild the tab.
function analytics() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = book.getSheetByName(ANALYTICS) || book.insertSheet(ANALYTICS, 0);
  sheet.getCharts().forEach((chart) => sheet.removeChart(chart));
  sheet.clear();
  sheet.setConditionalFormatRules([]);
  sheet.setTabColor('#cc4125');
  sheet.setHiddenGridlines(true);
  if (sheet.getMaxColumns() < DATA_COLUMN + 10) sheet.insertColumnsAfter(sheet.getMaxColumns(), DATA_COLUMN + 10 - sheet.getMaxColumns());
  if (sheet.getMaxRows() < 2500) sheet.insertRowsAfter(sheet.getMaxRows(), 2500 - sheet.getMaxRows());
  sheet.setColumnWidth(1, 20);
  sheet.setColumnWidth(2, 130);
  sheet.setColumnWidths(3, 13, 80);
  sheet.setColumnWidths(DATA_COLUMN, 8, 130);

  // Formula pieces. A column is found by its header, like the rest of the script.
  const ref = (tab, name) => "INDEX('" + tab + "'!A2:BZ,0,MATCH(\"" + name + "\",'" + tab + "'!A1:BZ1,0))";
  const text = (tab, name) => 'ARRAYFORMULA(""&' + ref(tab, name) + ')';
  // 1 for rows to leave out: Morocco, and damaged rows whose country is a number.
  const away = (tab) => 'ARRAYFORMULA(IF((' + ref(tab, 'Country') + '="Morocco")+ISNUMBER(' + ref(tab, 'Country') + '),1,0))';
  const dayOf = (tab) => 'ARRAYFORMULA(IF(ISNUMBER(' + ref(tab, 'Date') + '),TEXT(' + ref(tab, 'Date') + ',"yyyy-mm-dd"),""))';
  const since = '"&TEXT(TODAY()-' + (SERIES_DAYS - 1) + ',"yyyy-mm-dd")&"';
  const wrap = (formula) => '=IFERROR(' + formula + ',"")';
  // Rows per key: { numeric } keys skip nulls instead of blanks, { byKey } sorts by key.
  const countBy = (tab, key, limit, opts = {}) => wrap('QUERY({' + key + ',' + away(tab) + '},"select Col1, count(Col2) where Col2 = 0 and ' +
    (opts.numeric ? 'Col1 is not null' : "Col1 <> ''") + (opts.where ? ' and ' + opts.where : '') + ' group by Col1 order by ' +
    (opts.byKey ? 'Col1' : 'count(Col2) desc') + ' limit ' + limit + " label count(Col2) ''\",0)");
  const totalBy = (tab, key, value, limit, fn = 'sum') => wrap('QUERY({' + key + ',' + value + ',' + away(tab) + '},"select Col1, ' + fn +
    "(Col2) where Col3 = 0 and Col1 <> '' group by Col1 order by " + fn + '(Col2) desc limit ' + limit + ' label ' + fn + "(Col2) ''\",0)");
  // Orders has a row per book, so order-level counts first keep one row per order.
  const perOrder = (key, limit, value) => wrap('QUERY(UNIQUE({' + text('Orders', 'Order') + ',' + key + ',' +
    (value || ref('Orders', 'Order total')) + ',' + away('Orders') + '}),"select Col2, ' + (value === undefined ? 'count(Col1)' : 'sum(Col3)') +
    " where Col4 = 0 and Col1 <> '' and Col2 <> '' group by Col2 order by " + (value === undefined ? 'count(Col1)' : 'sum(Col3)') +
    ' desc limit ' + limit + ' label ' + (value === undefined ? 'count(Col1)' : 'sum(Col3)') + " ''\",0)");
  const daily = (tab, names) => wrap('QUERY({' + text(tab, tab === 'Weekly' ? 'Week' : 'Day') + ',' + names.map((n) => ref(tab, n)).join(',') +
    "},\"select * where Col1 <> '' " + (tab === 'Daily' ? "and Col1 >= '" + since + "' " : '') + 'order by Col1' + (tab === 'Weekly' ? '' : ' limit ' + SERIES_DAYS) + '",0)');
  const perDay = (tab, by) => wrap('QUERY({' + dayOf(tab) + ',' + by + ',' + away(tab) + "},\"select Col1, count(Col3) where Col3 = 0 and Col1 >= '" +
    since + "' and Col2 <> '' group by Col1 pivot Col2 order by Col1\",0)");
  const device = (pattern) => 'ARRAYFORMULA(IFERROR(' + pattern + ',""))';

  // Tables stack down the data columns; each returns the range a chart reads.
  let dataRow = 1;
  const data = (title, headers, formula, rows, width) => {
    sheet.getRange(dataRow, DATA_COLUMN).setValue(title).setFontWeight('bold').setFontColor('#8a5a00');
    let top = dataRow + 1;
    if (headers) sheet.getRange(top, DATA_COLUMN, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground(HEADER_COLOR);
    sheet.getRange(headers ? top + 1 : top, DATA_COLUMN).setFormula(formula);
    const range = sheet.getRange(top, DATA_COLUMN, rows + 1, width || headers.length);
    dataRow = top + rows + 3;
    return range;
  };

  // Charts fill the grid left to right under their section heading.
  let gridRow = 12;
  let side = 0;
  const heading = (title) => {
    if (side) gridRow += CHART_ROWS;
    side = 0;
    sheet.getRange(gridRow, 2).setValue(title).setFontSize(14).setFontWeight('bold').setFontColor('#5b34b5');
    gridRow += 2;
  };
  const chart = (type, ranges, title, options = {}) => {
    let builder = sheet.newChart().setChartType(type);
    [].concat(ranges).forEach((range) => { builder = builder.addRange(range); });
    builder = builder.setNumHeaders(1).setPosition(gridRow, side ? 9 : 2, side ? 10 : 0, 0)
      .setOption('title', title).setOption('width', CHART_WIDTH).setOption('height', CHART_HEIGHT)
      .setOption('colors', PALETTE).setOption('legend', { position: 'bottom' }).setOption('useFirstColumnAsDomain', true);
    Object.keys(options).forEach((key) => { builder = builder.setOption(key, options[key]); });
    sheet.insertChart(builder.build());
    if (side) gridRow += CHART_ROWS;
    side = 1 - side;
  };
  const T = Charts.ChartType;
  const pie = (range, title) => chart(T.PIE, range, title, { pieHole: 0.45, legend: { position: 'right' } });
  const bars = (range, title, options) => chart(T.BAR, range, title, Object.assign({ legend: { position: 'none' } }, options));
  const columns = (range, title, options) => chart(T.COLUMN, range, title, Object.assign({ legend: { position: 'none' } }, options));
  const line = (range, title, options) => chart(T.LINE, range, title, Object.assign({ pointSize: 4 }, options));

  // Key numbers: all time, recent windows and the week-on-week change.
  sheet.getRange(1, 2).setValue('Book to Kids analytics').setFontSize(20).setFontWeight('bold').setFontColor('#3c4858');
  sheet.getRange(2, 2).setValue('Live from the other tabs. Daily totals (this table and the daily charts) include Morocco; every other chart leaves it out. Rebuild: Extensions → Apps Script → Run analytics.')
    .setFontColor('#777777').setFontStyle('italic');
  const metrics = ['Visitors', 'Visits', 'Product views', 'Previews started', 'Previews ready', 'Added to cart', 'Checkouts started', 'Orders', 'Revenue'];
  const rates = [['Visitor → preview', 'Previews started', 'Visitors'], ['Preview → cart', 'Added to cart', 'Previews ready'],
    ['Cart → order', 'Orders', 'Added to cart'], ['Visitor → order', 'Orders', 'Visitors']];
  const windows = [['All time', null], ['Last 30 days', [29, 0]], ['Last 7 days', [6, 0]], ['Previous 7 days', [13, 7]]];
  const day = ref('Daily', 'Day');
  const letterOf = (n) => sheet.getRange(1, n).getA1Notation().replace(/\d+/, '');
  sheet.getRange(4, 2, 1, 1 + metrics.length + rates.length).setValues([[''].concat(metrics, rates.map((r) => r[0]))])
    .setFontWeight('bold').setBackground(HEADER_COLOR).setWrap(true).setVerticalAlignment('middle').setHorizontalAlignment('center');
  sheet.setRowHeight(4, 42);
  windows.forEach(([label, span], i) => {
    const row = 5 + i;
    const inside = span ? '(' + day + '>=TEXT(TODAY()-' + span[0] + ',"yyyy-mm-dd"))*(' + day + '<=TEXT(TODAY()-' + span[1] + ',"yyyy-mm-dd"))*' : '';
    sheet.getRange(row, 2).setValue(label).setFontWeight('bold');
    metrics.forEach((name, j) => sheet.getRange(row, 3 + j).setFormula('=IFERROR(SUMPRODUCT(' + inside + 'IFERROR(' + ref('Daily', name) + '*1,0)),0)'));
    rates.forEach(([, top, bottom], j) => sheet.getRange(row, 3 + metrics.length + j).setFormula('=IFERROR(' +
      letterOf(3 + metrics.indexOf(top)) + row + '/' + letterOf(3 + metrics.indexOf(bottom)) + row + ',"")'));
  });
  sheet.getRange(9, 2).setValue('Week on week').setFontWeight('bold');
  for (let j = 0; j < metrics.length + rates.length; j++) {
    const col = letterOf(3 + j);
    sheet.getRange(9, 3 + j).setFormula('=IFERROR(' + col + '7/' + col + '8-1,"")');
  }
  const width = metrics.length + rates.length;
  sheet.getRange(5, 3, 4, metrics.length).setNumberFormat('#,##0');
  sheet.getRange(5, 3 + metrics.indexOf('Revenue'), 4, 1).setNumberFormat('#,##0.00');
  sheet.getRange(5, 3 + metrics.length, 4, rates.length).setNumberFormat('0.0%');
  sheet.getRange(9, 3, 1, width).setNumberFormat('+0%;-0%;0%');
  sheet.getRange(5, 2, 5, width + 1).setHorizontalAlignment('center').setBorder(true, true, true, true, true, true, '#e5e5e5', SpreadsheetApp.BorderStyle.SOLID);
  sheet.getRange(7, 2, 1, width + 1).setBackground('#eef5ff').setFontWeight('bold');
  sheet.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().setRanges([sheet.getRange(9, 3, 1, width)]).whenNumberGreaterThan(0).setFontColor('#1e7b45').setBold(true).build(),
    SpreadsheetApp.newConditionalFormatRule().setRanges([sheet.getRange(9, 3, 1, width)]).whenNumberLessThan(0).setFontColor('#a61c1c').setBold(true).build()
  ]);

  heading('Traffic');
  line(data('Daily traffic', ['Day', 'Visitors', 'Visits', 'Page views'], daily('Daily', ['Visitors', 'Visits', 'Page views']), SERIES_DAYS),
    'Visitors, visits and page views per day (last ' + SERIES_DAYS + ' days)');
  columns(data('Weekly', ['Week', 'Visitors', 'Previews started', 'Added to cart', 'Orders'],
    daily('Weekly', ['Visitors', 'Previews started', 'Added to cart', 'Orders']), 30), 'Weekly totals', { legend: { position: 'bottom' } });
  line(data('Visits per day', ['Day', 'Visits'], countBy('Visits', dayOf('Visits'), SERIES_DAYS, { byKey: true, where: "Col1 >= '" + since + "'" }), SERIES_DAYS),
    'Visits per day, without Morocco', { legend: { position: 'none' } });
  pie(data('Visits by source', ['Source', 'Visits'], countBy('Visits', text('Visits', 'Source'), 10), 10), 'Where visits come from');
  chart(T.GEO, data('Visits by country (map)', ['Country', 'Visits'], countBy('Visits', text('Visits', 'Country'), 200), 200),
    'Visits by country', { colors: ['#dfe9ff', '#1f5fbf'], colorAxis: { colors: ['#dfe9ff', '#1f5fbf'] }, legend: { position: 'none' } });
  bars(data('Top countries', ['Country', 'Visits'], countBy('Visits', text('Visits', 'Country'), 10), 10), 'Top 10 countries');
  bars(data('Top landing pages', ['Landing page', 'Visits'], countBy('Visits',
    'ARRAYFORMULA(REGEXREPLACE(' + text('Visits', 'Landing page') + ',"^https?://[^/]+|\\?.*$",""))', 10), 10), 'Top 10 landing pages');
  bars(data('Top cities', ['City', 'Visits'], countBy('Visits', text('Visits', 'City'), 10), 10), 'Top 10 cities');
  columns(data('Visits by hour', ['Hour', 'Visits'], countBy('Visits', 'ARRAYFORMULA(IF(ISNUMBER(' + ref('Visits', 'Date') + '),TEXT(HOUR(' +
    ref('Visits', 'Date') + '),"00")&":00",""))', 24, { byKey: true }), 24), 'Visits by hour of day (sheet time zone)');
  columns(data('Visits by weekday', ['Weekday', 'Visits'], countBy('Visits', 'ARRAYFORMULA(IF(ISNUMBER(' + ref('Visits', 'Date') + '),WEEKDAY(' +
    ref('Visits', 'Date') + ',2)&" "&TEXT(' + ref('Visits', 'Date') + ',"ddd"),""))', 7, { byKey: true }), 7), 'Visits by weekday');
  const dev = text('Visits', 'Device');
  pie(data('Device type', ['Device', 'Visits'], countBy('Visits', 'ARRAYFORMULA(IF(' + dev + '="","",IF(REGEXMATCH(' + dev + ',"🤖"),"Bot",IF(REGEXMATCH(' +
    dev + ',"iOS|Android"),"Phone or tablet",IF(' + dev + '="unknown","Unknown","Computer")))))', 5), 5), 'Phone vs computer');
  pie(data('Browsers', ['Browser', 'Visits'], countBy('Visits', device('TRIM(REGEXREPLACE(REGEXEXTRACT(' + dev + ',"[^·]*$"),"[\\d.]+$",""))'), 8), 8), 'Browsers');
  pie(data('Operating systems', ['System', 'Visits'], countBy('Visits', device('REGEXEXTRACT(' + dev + ',"iOS|Android|Windows|Mac OS|macOS|Linux|Chrome OS|Ubuntu")'), 8), 8), 'Operating systems');
  pie(data('New vs returning', ['Visit', 'Visits'], countBy('Visits', 'ARRAYFORMULA(IF(' + text('Visits', 'Date') + '="","",IF(' + text('Visits', 'Visit number') +
    '="","No cookie consent",IF(' + text('Visits', 'Visit number') + '="1","First visit","Return visit"))))', 3), 3), 'First visits vs return visits');
  pie(data('Cookie consent', ['Consent', 'Visits'], countBy('Visits', text('Visits', 'Cookie consent'), 3), 3), 'Cookie consent given');
  bars(data('Campaigns', ['Campaign', 'Visits'], countBy('Visits', text('Visits', 'Campaign'), 10), 10), 'Top campaigns');

  heading('Funnel and sales over time');
  const funnelNames = ['Visitors', 'Product views', 'Previews started', 'Previews ready', 'Added to cart', 'Checkouts started', 'Orders'];
  const funnel = sheet.getRange(dataRow + 1, DATA_COLUMN, funnelNames.length + 1, 2);
  sheet.getRange(dataRow, DATA_COLUMN).setValue('Funnel, all time').setFontWeight('bold').setFontColor('#8a5a00');
  funnel.setValues([['Step', 'Count']].concat(funnelNames.map((n) => [n, ''])));
  funnelNames.forEach((n, i) => funnel.getCell(i + 2, 2).setFormula('=' + letterOf(3 + Math.max(0, metrics.indexOf(n))) + '5'));
  funnel.getCell(1, 1).offset(0, 0, 1, 2).setFontWeight('bold').setBackground(HEADER_COLOR);
  dataRow += funnelNames.length + 4;
  bars(funnel, 'Funnel: visitors to orders (all time)', { colors: ['#6aa84f'] });
  line(data('Daily funnel', ['Day', 'Previews started', 'Previews ready', 'Added to cart', 'Checkouts started', 'Orders'],
    daily('Daily', ['Previews started', 'Previews ready', 'Added to cart', 'Checkouts started', 'Orders']), SERIES_DAYS), 'Funnel steps per day');
  chart(T.COMBO, data('Daily revenue', ['Day', 'Revenue', 'Orders'], daily('Daily', ['Revenue', 'Orders']), SERIES_DAYS), 'Revenue (bars) and orders (line) per day',
    { seriesType: 'bars', series: { 1: { type: 'line', targetAxisIndex: 1, pointSize: 5 } }, colors: ['#6aa84f', '#cc4125'] });
  const raw = data('Daily conversion', ['Day', 'Visitors', 'Previews ready', 'Added to cart', 'Orders'],
    daily('Daily', ['Visitors', 'Previews ready', 'Added to cart', 'Orders']), SERIES_DAYS);
  const top = raw.getRow() + 1;
  const end = top + SERIES_DAYS - 1;
  const at = (offset) => letterOf(DATA_COLUMN + offset) + top + ':' + letterOf(DATA_COLUMN + offset) + end;
  const rateCols = sheet.getRange(raw.getRow(), DATA_COLUMN + 5, SERIES_DAYS + 1, 3);
  rateCols.offset(0, 0, 1, 3).setValues([['Visitor → order', 'Preview → cart', 'Cart → order']]).setFontWeight('bold').setBackground(HEADER_COLOR);
  [[4, 1], [3, 2], [4, 3]].forEach(([num, den], i) => rateCols.getCell(2, i + 1).setFormula('=ARRAYFORMULA(IF(' + at(0) + '="","",IFERROR(' + at(num) + '/' + at(den) + ',0)))'));
  rateCols.offset(1, 0, SERIES_DAYS, 3).setNumberFormat('0%');
  line([raw.offset(0, 0, SERIES_DAYS + 1, 1), rateCols], 'Conversion rates per day', { vAxis: { format: 'percent' } });
  line(data('Daily shares', ['Day', 'Share clicks', 'Shared links opened', 'Chat link previews'],
    daily('Daily', ['Share clicks', 'Shared links opened', 'Chat link previews']), SERIES_DAYS), 'Shares per day');
  line(data('Daily searches and cart views', ['Day', 'Searches', 'Cart views', 'Collection views'],
    daily('Daily', ['Searches', 'Cart views', 'Collection views']), SERIES_DAYS), 'Searches, cart and collection views per day');

  heading('Book previews');
  chart(T.COLUMN, data('Previews per day by status', null, perDay('Book previews', text('Book previews', 'Status')), SERIES_DAYS, 4),
    'Previews per day: ready vs failed', { isStacked: true, colors: ['#cc4125', '#6aa84f', '#999999'] });
  pie(data('Preview status', ['Status', 'Previews'], countBy('Book previews', text('Book previews', 'Status'), 5), 5), 'Ready vs failed');
  bars(data('Top previewed books', ['Book', 'Previews'], countBy('Book previews', text('Book previews', 'Book'), 15), 15), 'Most previewed books');
  bars(data('Preview to cart by book', ['Book', 'Previews', 'Added to cart'], wrap('QUERY({' + text('Book previews', 'Book') + ',' +
    ref('Book previews', 'Added to cart') + ',' + away('Book previews') + "},\"select Col1, count(Col1), count(Col2) where Col3 = 0 and Col1 <> '' group by Col1 order by count(Col1) desc limit 15 label count(Col1) '', count(Col2) ''\",0)"), 15),
    'Previews vs added to cart, by book', { legend: { position: 'bottom' } });
  pie(data('Preview languages', ['Language', 'Previews'], countBy('Book previews', text('Book previews', 'Language'), 8), 8), 'Book languages');
  columns(data('Child ages', ['Age', 'Previews'], countBy('Book previews', ref('Book previews', 'Age'), 20, { numeric: true, byKey: true }), 20), "Children's ages");
  pie(data('Occasions', ['Occasion', 'Previews'], countBy('Book previews', text('Book previews', 'Occasion'), 8), 8), 'Occasions picked');
  pie(data('Added to cart from preview', ['Result', 'Previews'], countBy('Book previews', 'ARRAYFORMULA(IF(' + text('Book previews', 'Status') +
    '<>"Ready","",IF(' + text('Book previews', 'Added to cart') + '="","Not added","Added to cart")))', 2), 2), 'Ready previews added to cart');
  pie(data('Models', ['Model', 'Previews'], countBy('Book previews', text('Book previews', 'Model'), 8), 8), 'Cover models used');
  bars(data('Seconds by model', ['Model', 'Average seconds'], totalBy('Book previews', text('Book previews', 'Model'), ref('Book previews', 'Seconds'), 8, 'avg'), 8),
    'Average generation time by model (seconds)');
  line(data('Seconds per day', ['Day', 'Average seconds'], wrap('QUERY({' + dayOf('Book previews') + ',' + ref('Book previews', 'Seconds') + ',' +
    away('Book previews') + "},\"select Col1, avg(Col2) where Col3 = 0 and Col1 >= '" + since + "' group by Col1 order by Col1 label avg(Col2) ''\",0)"), SERIES_DAYS),
    'Average generation time per day (seconds)', { legend: { position: 'none' } });
  columns(data('Ratings', ['Rating', 'Previews'], countBy('Book previews', ref('Book previews', 'Rating'), 10, { numeric: true, byKey: true }), 10), 'Cover ratings');
  bars(data('Reported problems', ['Problem', 'Fixes'], countBy('Book previews', device('REGEXEXTRACT(' + text('Book previews', 'Reported problem') + ',"^[^:]+")'), 10), 10),
    'Problems reported for a free fix');
  pie(data('Shared from preview', ['Shared via', 'Previews'], countBy('Book previews', text('Book previews', 'Shared'), 6), 6), 'Previews shared, by channel');
  bars(data('Preview countries', ['Country', 'Previews'], countBy('Book previews', text('Book previews', 'Country'), 10), 10), 'Previews by country');
  pie(data('Signed in vs guest', ['Customer', 'Previews'], countBy('Book previews', 'ARRAYFORMULA(IF(' + text('Book previews', 'Customer') + '="","",IF(LEFT(' +
    text('Book previews', 'Customer') + ',9)="Signed in","Signed in","Guest")))', 2), 2), 'Signed in vs guest');

  heading('Custom stories');
  pie(data('Story worlds', ['World', 'Stories'], countBy('Custom stories', text('Custom stories', 'World'), 8), 8), 'Story worlds picked');
  pie(data('Heroes', ['Hero', 'Stories'], countBy('Custom stories', text('Custom stories', 'Hero'), 3), 3), 'Boy vs girl hero');
  pie(data('Story status', ['Status', 'Stories'], countBy('Custom stories', text('Custom stories', 'Status'), 3), 3), 'Custom stories ready vs failed');
  pie(data('Story occasions', ['Occasion', 'Stories'], countBy('Custom stories', text('Custom stories', 'Occasion'), 8), 8), 'Custom story occasions');

  heading('Carts, checkouts and orders');
  bars(data('Books added to cart', ['Book', 'Copies'], totalBy('Carts', text('Carts', 'Book'), ref('Carts', 'Quantity'), 15), 15), 'Books added to cart (copies)');
  pie(data('Cart covers', ['Variant', 'Adds'], countBy('Carts', text('Carts', 'Variant'), 6), 6), 'Hardcover vs softcover in carts');
  pie(data('Cart sources', ['Source', 'Adds'], countBy('Carts', text('Carts', 'Source'), 8), 8), 'Add to cart by traffic source');
  bars(data('Checkouts by country', ['Country', 'Checkouts'], countBy('Checkouts', text('Checkouts', 'Country'), 10), 10), 'Checkouts started by country');
  bars(data('Books sold', ['Book', 'Copies'], totalBy('Orders', text('Orders', 'Book'), ref('Orders', 'Quantity'), 15), 15), 'Books sold (copies)', { colors: ['#6aa84f'] });
  pie(data('Order covers', ['Cover', 'Copies'], totalBy('Orders', text('Orders', 'Cover'), ref('Orders', 'Quantity'), 6), 6), 'Hardcover vs softcover sold');
  pie(data('Orders by source', ['Source', 'Orders'], perOrder(text('Orders', 'Source'), 8), 8), 'Orders by traffic source');
  bars(data('Revenue by country', ['Country', 'Revenue'], perOrder(text('Orders', 'Country'), 10, ref('Orders', 'Order total')), 10), 'Revenue by country', { colors: ['#6aa84f'] });
  pie(data('New vs returning customers', ['Customer', 'Orders'], perOrder(text('Orders', 'Customer'), 4), 4), 'First orders vs returning customers');
  bars(data('Discount codes', ['Code', 'Checkouts'], countBy('Checkouts', text('Checkouts', 'Discount codes'), 10), 10), 'Discount codes used at checkout');
  bars(data('Revenue by book', ['Book', 'Revenue'], totalBy('Orders', text('Orders', 'Book'), ref('Orders', 'Price'), 15), 15), 'Revenue by book', { colors: ['#6aa84f'] });
  pie(data('Order devices', ['Device', 'Orders'], perOrder('ARRAYFORMULA(IF(' + text('Orders', 'Device') + '="","",IF(REGEXMATCH(' + text('Orders', 'Device') +
    ',"iOS|Android"),"Phone or tablet","Computer")))', 3), 3), 'Orders: phone vs computer');

  heading('Sharing, search and chat');
  pie(data('Share channels', ['Via', 'Shares'], countBy('Shares', text('Shares', 'Via'), 6), 6), 'Share buttons used');
  pie(data('Share events', ['Event', 'Count'], countBy('Shares', text('Shares', 'Event'), 4), 4), 'Shares clicked vs links opened');
  bars(data('Most shared books', ['Book', 'Shares'], countBy('Shares', text('Shares', 'Book'), 10, { where: "Col1 <> ''" }), 10), 'Most shared books');
  bars(data('Share countries', ['Country', 'Events'], countBy('Shares', text('Shares', 'Country'), 10), 10), 'Shares and opens by country');
  bars(data('Top searches', ['Search', 'Searches'], countBy('Searches', 'ARRAYFORMULA(LOWER(TRIM(' + text('Searches', 'Search') + ')))', 15), 15), 'Top searches');
  bars(data('Searches without results', ['Search', 'Searches'], countBy('Searches', 'ARRAYFORMULA(IF(' + text('Searches', 'Results') + '="0",LOWER(TRIM(' +
    text('Searches', 'Search') + ')),""))', 15), 15), 'Searches with no results', { colors: ['#cc4125'] });
  pie(data('Chat cover ratings', ['Rating', 'Chats'], countBy('Chats', text('Chats', 'Cover rating'), 6), 6), 'Cover rating when chat opened');
  bars(data('Chats by book', ['Book', 'Chats'], countBy('Chats', text('Chats', 'Book'), 10), 10), 'Chats opened by book');

  heading('Site health');
  pie(data('Log levels', ['Level', 'Logs'], countBy('Logs', text('Logs', 'Level'), 5), 5), 'Logs by level');
  chart(T.COLUMN, data('Logs per day by level', null, perDay('Logs', text('Logs', 'Level')), SERIES_DAYS, 5), 'Logs per day by level',
    { isStacked: true, colors: ['#cc4125', '#3d85c6', '#f1c232', '#999999'] });
  bars(data('Top error places', ['Where', 'Errors'], countBy('Logs', 'ARRAYFORMULA(IF(' + text('Logs', 'Level') + '="Error",' + text('Logs', 'Where') + ',""))', 10), 10),
    'Where errors happen', { colors: ['#cc4125'] });
  bars(data('Log sources', ['Source', 'Logs'], countBy('Logs', text('Logs', 'Source'), 10), 10), 'Logs by source');
  bars(data('Failure reasons', ['Error', 'Failed previews'], countBy('Book previews', device('LEFT(' + text('Book previews', 'Error') + ',60)'), 10), 10),
    'Why previews fail', { colors: ['#cc4125'] });

  sheet.setFrozenRows(0);
  book.setActiveSheet(sheet);
  book.moveActiveSheet(1);
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
