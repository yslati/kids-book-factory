// Requests sheet: the row each request leaves, the preview page's updates to
// it, and posting both to the sheet's Apps Script against a stubbed fetch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { appendRow, previewFollowUp, requestRow, sheetConfigured, updateRow } from '../lib/sheet.js';
import { resetDiscordThrottle, setDiscordOutbox } from '../lib/discord.js';

const URL_ = 'https://script.google.com/macros/s/abc/exec';
const PHOTO = 'https://pub.r2.dev/photos/emma_5_fr_k3x9p2m7q1.jpg';
const COVER = 'https://pub.r2.dev/previews/emma_5_fr_the-winning-goal_k3x9p2m7q1.jpg';

const req = {
  headers: {
    'x-forwarded-for': '203.0.113.7',
    'x-vercel-ip-country': 'FR',
    'x-vercel-ip-city': 'Lyon',
    'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'
  }
};

function withSheet(t, url, secret) {
  const saved = [process.env.SHEET_WEBHOOK_URL, process.env.SHEET_WEBHOOK_SECRET];
  const set = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  set('SHEET_WEBHOOK_URL', url);
  set('SHEET_WEBHOOK_SECRET', secret);
  t.after(() => {
    set('SHEET_WEBHOOK_URL', saved[0]);
    set('SHEET_WEBHOOK_SECRET', saved[1]);
  });
}

function stubFetch(t, respond) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: JSON.parse(init.body) });
    return respond(String(url));
  };
  t.after(() => { globalThis.fetch = original; t.mock.restoreAll(); });
  return calls;
}

function book(overrides = {}) {
  return {
    form: 'Book',
    book: 'the-winning-goal',
    childName: 'Emma',
    age: '5',
    language: 'French',
    occasion: 'A birthday',
    photoUrl: PHOTO,
    customerId: null,
    generationId: 'k3x9p2m7q1',
    startedAt: Date.now() - 21400,
    ...overrides
  };
}

test('a book preview row carries every answer and the outcome', () => {
  const row = requestRow(req, book(), { coverUrl: COVER, bookTitle: 'The Winning Goal' });
  assert.match(row.Date, /^\d{4}-\d\d-\d\dT/);
  assert.match(String(row.Seconds), /^21\.\d$/);
  const { Date: _d, Seconds: _s, ...rest } = row;
  assert.deepEqual(rest, {
    Form: 'Book',
    Status: 'Ready',
    'Book / world': 'The Winning Goal',
    Hero: '',
    "Child's name": 'Emma',
    Age: 5,
    Language: 'French',
    Occasion: 'A birthday',
    'Story idea': '',
    Photo: PHOTO,
    Cover: COVER,
    'Added to cart': '',
    Customer: 'Guest',
    Country: 'France',
    City: 'Lyon',
    Device: 'iPhone · iOS 18.5 · Mobile Safari 18',
    Error: '',
    Generation: 'k3x9p2m7q1'
  });
});

test('both forms send the same columns in the same order', () => {
  const bookRow = requestRow(req, book(), { coverUrl: COVER });
  const customRow = requestRow(req, book({
    form: 'Custom story', book: 'Sports', hero: 'Girl', occasion: '', brief: 'Emma wins the cup.', customerId: '7212345678'
  }), { error: 'higgsfield-timeout' });
  assert.deepEqual(Object.keys(customRow), Object.keys(bookRow));
  assert.equal(customRow.Status, 'Failed');
  assert.equal(customRow['Book / world'], 'Sports');
  assert.equal(customRow.Hero, 'Girl');
  assert.equal(customRow['Story idea'], 'Emma wins the cup.');
  assert.equal(customRow.Cover, '');
  assert.equal(customRow.Error, 'higgsfield-timeout');
  assert.equal(customRow.Customer, 'Signed in · 7212345678');
});

test('a missing age stays blank', () => {
  assert.equal(requestRow(req, book({ age: '' }), { coverUrl: COVER }).Age, '');
});

test('does nothing until both the URL and the secret are set', async (t) => {
  withSheet(t, URL_, undefined);
  const calls = stubFetch(t, () => new Response('{"ok":true}'));
  assert.equal(sheetConfigured(), false);
  assert.equal(await appendRow({ Form: 'Book' }), false);
  assert.equal(calls.length, 0);
});

test('posts the row with the shared secret', async (t) => {
  withSheet(t, URL_, 's3cret');
  const calls = stubFetch(t, () => new Response('{"ok":true}', { status: 200 }));
  assert.equal(await appendRow({ Form: 'Book', Age: 5 }), true);
  assert.deepEqual(calls, [{ url: URL_, method: 'POST', body: { secret: 's3cret', row: { Form: 'Book', Age: 5 } } }]);
});

test('a refusal or an outage resolves false and never throws', async (t) => {
  withSheet(t, URL_, 's3cret');
  const warn = t.mock.method(console, 'warn', () => {});

  stubFetch(t, () => new Response('{"ok":false,"error":"forbidden"}', { status: 200 }));
  assert.equal(await appendRow({ Form: 'Book' }), false);
  assert.match(warn.mock.calls[0].arguments[1], /200 forbidden/);

  stubFetch(t, () => new Response('<html>Error</html>', { status: 500 }));
  assert.equal(await appendRow({ Form: 'Book' }), false);

  stubFetch(t, () => { throw new TypeError('fetch failed'); });
  assert.equal(await appendRow({ Form: 'Book' }), false);
  assert.equal(warn.mock.calls.length, 3);
});

test('a lost row is reported to #logs without the child\'s details', async (t) => {
  withSheet(t, URL_, 's3cret');
  withLogs(t);
  t.mock.method(console, 'warn', () => {});
  const calls = stubFetch(t, (url) => (url.startsWith('https://discord.com')
    ? new Response(null, { status: 204 })
    : new Response('{"ok":false,"error":"forbidden"}', { status: 200 })));

  assert.equal(await appendRow(requestRow(req, book(), { coverUrl: COVER })), false);

  const report = calls.find((c) => c.url.startsWith('https://discord.com'));
  const embed = report.body.embeds[0];
  assert.equal(embed.title, '⚠️ Row not added to the requests sheet');
  assert.match(embed.description, /sheet answered 200 forbidden/);
  assert.deepEqual(embed.fields.map((f) => [f.name, f.value]), [['Form', 'Book'], ['Generation', '`k3x9p2m7q1`']]);
  const sent = JSON.stringify(report.body);
  assert.ok(!sent.includes('Emma') && !sent.includes(PHOTO), 'no name or photo in #logs');
});

function withLogs(t) {
  const saved = process.env.DISCORD_WEBHOOK_LOGS;
  process.env.DISCORD_WEBHOOK_LOGS = 'https://discord.com/api/webhooks/1/logs-token';
  resetDiscordThrottle();
  setDiscordOutbox(null);
  t.after(() => {
    if (saved === undefined) delete process.env.DISCORD_WEBHOOK_LOGS;
    else process.env.DISCORD_WEBHOOK_LOGS = saved;
    resetDiscordThrottle();
  });
}

// Lets pending promises run (fetch stubs, awaits) without real timers.
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

test('preview page follow-ups become sheet fields', () => {
  assert.deepEqual(previewFollowUp({ action: 'occasion', generation_id: 'k3x9p2m7q1', occasion: 'A birthday' }),
    { value: { generationId: 'k3x9p2m7q1', fields: { Occasion: 'A birthday' } } });
  assert.deepEqual(previewFollowUp({ action: 'occasion', generation_id: 'k3x9p2m7q1', occasion: '' }).value.fields,
    { Occasion: '' }, 'clearing the chip clears the cell');
  assert.deepEqual(previewFollowUp({ action: 'cart', generation_id: 'k3x9p2m7q1', occasion: 'A new baby', variant: 'Hardcover' }).value.fields,
    { Occasion: 'A new baby', 'Added to cart': 'Hardcover' });
  assert.deepEqual(previewFollowUp({ action: 'cart', generation_id: 'k3x9p2m7q1', variant: 'Softcover' }).value.fields,
    { 'Added to cart': 'Softcover' }, 'a cart without an occasion leaves the answer alone');
  assert.deepEqual(previewFollowUp({ action: 'cart', generation_id: 'k3x9p2m7q1' }).value.fields, { 'Added to cart': 'Yes' });
});

test('follow-ups with anything off the list are refused', () => {
  assert.equal(previewFollowUp({ action: 'delete', generation_id: 'k3x9p2m7q1' }).error, 'bad-action');
  assert.equal(previewFollowUp({ action: 'occasion', generation_id: '../x', occasion: 'A birthday' }).error, 'bad-generation-id');
  assert.equal(previewFollowUp({ action: 'occasion', generation_id: 'k3x9p2m7q1', occasion: '=HYPERLINK("x")' }).error, 'bad-occasion');
  assert.equal(previewFollowUp(null).error, 'bad-action');
});

test('an update names the generation and the fields to set', async (t) => {
  withSheet(t, URL_, 's3cret');
  const calls = stubFetch(t, () => new Response('{"ok":true}'));
  assert.equal(await updateRow('k3x9p2m7q1', { Occasion: 'A birthday' }), true);
  assert.deepEqual(calls.map((c) => c.body), [{ secret: 's3cret', update: { generation: 'k3x9p2m7q1', set: { Occasion: 'A birthday' } } }]);
});

test('an update that beats its row waits and tries once more', async (t) => {
  withSheet(t, URL_, 's3cret');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let answers = ['{"ok":false,"error":"not-found"}', '{"ok":true}'];
  const calls = stubFetch(t, () => new Response(answers.shift()));

  const done = updateRow('k3x9p2m7q1', { 'Added to cart': 'Hardcover' });
  await settle();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(5000);
  assert.equal(await done, true);
  assert.equal(calls.length, 2);
});

test('a row that never turns up is left alone, without a report', async (t) => {
  withSheet(t, URL_, 's3cret');
  withLogs(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const info = t.mock.method(console, 'info', () => {});
  const calls = stubFetch(t, () => new Response('{"ok":false,"error":"not-found"}'));

  const done = updateRow('old-preview', { Occasion: 'A birthday' });
  await settle();
  t.mock.timers.tick(5000);
  assert.equal(await done, false);
  assert.equal(calls.filter((c) => c.url.startsWith('https://discord.com')).length, 0);
  assert.equal(info.mock.calls.length, 1);
});

test('an update the sheet refuses is reported to #logs', async (t) => {
  withSheet(t, URL_, 's3cret');
  withLogs(t);
  t.mock.method(console, 'warn', () => {});
  const calls = stubFetch(t, (url) => (url.startsWith('https://discord.com')
    ? new Response(null, { status: 204 })
    : new Response('{"ok":false,"error":"forbidden"}')));

  assert.equal(await updateRow('k3x9p2m7q1', { Occasion: 'A birthday' }), false);
  const embed = calls.find((c) => c.url.startsWith('https://discord.com')).body.embeds[0];
  assert.equal(embed.title, '⚠️ Row not updated in the requests sheet');
  assert.deepEqual(embed.fields.map((f) => f.name), ['Generation']);
});
