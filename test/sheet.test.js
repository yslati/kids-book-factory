// Requests sheet: the rows each tab gets, the preview page's updates, and
// posting both to the sheet's Apps Script against a stubbed fetch.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendRows, customRow, dailyRow, previewFollowUp, previewRow, sheetConfigured, storefrontRows, TABS, updateRow
} from '../lib/sheet.js';
import { resetDiscordThrottle, setDiscordOutbox } from '../lib/discord.js';

const URL_ = 'https://script.google.com/macros/s/abc/exec';
const PHOTO = 'https://pub.r2.dev/photos/emma_5_fr_k3x9p2m7q1.jpg';
const COVER = 'https://pub.r2.dev/previews/emma_5_fr_the-winning-goal_k3x9p2m7q1.jpg';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const ATTEMPT = { provider: 'higgsfield', model: 'marketing-studio/image/flare', quality: 'medium' };

const req = {
  headers: { 'x-forwarded-for': '203.0.113.7', 'x-vercel-ip-country': 'FR', 'x-vercel-ip-city': 'Lyon', 'user-agent': IPHONE }
};
const visitor = { country: 'FR', city: 'Lyon', userAgent: IPHONE };
const PLACE = { Country: 'France', City: 'Lyon', Device: 'iPhone · iOS 18.5 · Mobile Safari 18' };

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

// Lets pending promises run (fetch stubs, awaits) without real timers.
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

const without = (row, ...keys) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));
const toDiscord = (calls) => calls.filter((c) => c.url.startsWith('https://discord.com'));

function book(overrides = {}) {
  return {
    book: 'the-winning-goal',
    childName: 'Emma',
    age: '5',
    language: 'French',
    photoUrl: PHOTO,
    customerId: null,
    generationId: 'k3x9p2m7q1',
    startedAt: Date.now() - 21400,
    ...overrides
  };
}

test('a Book previews row carries the answers, the prompt and the outcome', () => {
  const row = previewRow(req, book(), { coverUrl: COVER, bookTitle: 'The Winning Goal', attempt: ATTEMPT, prompt: 'Paint Emma...' });
  assert.match(row.Date, /^\d{4}-\d\d-\d\dT/);
  assert.match(String(row.Seconds), /^21\.\d$/);
  assert.deepEqual(without(row, 'Date', 'Seconds'), {
    Status: 'Ready',
    Book: 'The Winning Goal',
    "Child's name": 'Emma',
    Age: 5,
    Language: 'French',
    Occasion: '',
    'Extra details': '',
    'Added to cart': '',
    Photo: PHOTO,
    Cover: COVER,
    Model: 'higgsfield marketing-studio/image/flare medium',
    Customer: 'Guest',
    ...PLACE,
    Error: '',
    Generation: 'k3x9p2m7q1',
    Prompt: 'Paint Emma...'
  });
  assert.deepEqual(Object.keys(row).slice(0, 3), ['Date', 'Status', 'Book']);
  assert.equal(Object.keys(row).pop(), 'Prompt', 'the long prompt comes last');
});

test('a failed preview keeps the prompt and the error, without cover or model', () => {
  const row = previewRow(req, book({ age: '', customerId: '7212345678' }), { error: 'higgsfield-timeout', prompt: 'Paint Emma...' });
  assert.equal(row.Status, 'Failed');
  assert.equal(row.Book, 'the-winning-goal', 'the handle when Shopify gave no title');
  assert.equal(row.Age, '');
  assert.equal(row.Cover, '');
  assert.equal(row.Model, '');
  assert.equal(row.Error, 'higgsfield-timeout');
  assert.equal(row.Prompt, 'Paint Emma...');
  assert.equal(row.Customer, 'Signed in · 7212345678');
});

test('a Custom stories row names the world, hero, idea and reference book', () => {
  const row = customRow(req, {
    world: 'stem', gender: 'girl', childName: 'Lina', age: '6', occasion: 'A birthday',
    brief: 'Lina fixes a robot on the moon.', reference: 'girl-astronaut', photoKey: 'photos/x.jpg',
    photoUrl: PHOTO, customerId: null, generationId: 'c1', startedAt: Date.now() - 19000
  }, { coverUrl: COVER, attempt: ATTEMPT, prompt: 'Custom prompt' });
  assert.deepEqual(without(row, 'Date', 'Seconds'), {
    Status: 'Ready',
    World: 'STEM & space',
    Hero: 'Girl',
    "Child's name": 'Lina',
    Age: 6,
    Occasion: 'A birthday',
    'Story idea': 'Lina fixes a robot on the moon.',
    'Extra details': '',
    'Reference book': 'girl-astronaut',
    'Added to cart': '',
    Photo: PHOTO,
    Cover: COVER,
    Model: 'higgsfield marketing-studio/image/flare medium',
    Customer: 'Guest',
    ...PLACE,
    Error: '',
    Generation: 'c1',
    Prompt: 'Custom prompt'
  });
});

test('a new visit goes to Visits with its source and landing page', () => {
  const out = storefrontRows(
    { name: 'page_viewed', path: '/products/the-winning-goal' },
    { visit: 2, source: { label: 'instagram', campaign: 'autumn' } },
    visitor
  );
  assert.equal(out.tab, TABS.visits);
  assert.deepEqual(without(out.rows[0], 'Date'), {
    Source: 'instagram', Campaign: 'autumn', 'Landing page': '/products/the-winning-goal', 'Visit number': 2, 'Cookie consent': 'Yes', ...PLACE
  });
  assert.equal(storefrontRows({ name: 'page_viewed', path: '/' }, { visit: null, source: null }, visitor), null, 'later pages of a visit');
  assert.equal(storefrontRows({ name: 'page_viewed', path: '/' }, null, visitor), null, 'no Redis, no visit');
  assert.equal(storefrontRows({ name: 'product_viewed', product: {} }, null, visitor), null, 'views are only counted');
});

test('a visit without cookie consent has no visit number', () => {
  const out = storefrontRows(
    { name: 'page_viewed', path: '/', consented: false },
    { visit: 1, source: { label: 'direct', campaign: '' } },
    visitor
  );
  assert.equal(out.rows[0]['Visit number'], '');
  assert.equal(out.rows[0]['Cookie consent'], 'No');
});

test('an add to cart goes to Carts', () => {
  const out = storefrontRows({
    name: 'product_added_to_cart',
    product: { title: 'The Winning Goal', variant: 'Hardcover', quantity: 1, price: { amount: 44.99, currency: 'USD' }, total: { amount: 44.99, currency: 'USD' } }
  }, { visit: null, source: { label: 'google', campaign: '' } }, visitor);
  assert.equal(out.tab, TABS.carts);
  assert.deepEqual(without(out.rows[0], 'Date'), {
    Book: 'The Winning Goal', Variant: 'Hardcover', Quantity: 1, Price: 44.99, Currency: 'USD', Source: 'google', ...PLACE
  });
});

test('a checkout start goes to Checkouts with its items', () => {
  const out = storefrontRows({
    name: 'checkout_started',
    checkout: {
      orderId: '', firstOrder: null, total: { amount: 74.98, currency: 'USD' }, discounts: ['WELCOME10'],
      items: [{ title: 'The Winning Goal', variant: 'Hardcover', quantity: 1 }, { title: 'Mira and the Moon', variant: 'Softcover', quantity: 1 }]
    }
  }, null, visitor);
  assert.equal(out.tab, TABS.checkouts);
  assert.deepEqual(without(out.rows[0], 'Date'), {
    Total: 74.98, Currency: 'USD', Items: 'The Winning Goal · Hardcover ×1; Mira and the Moon · Softcover ×1',
    'Discount codes': 'WELCOME10', Source: '', ...PLACE
  });
});

test('an order adds one Orders row per book', () => {
  const out = storefrontRows({
    name: 'checkout_completed',
    checkout: {
      orderId: '6612345678', firstOrder: true, total: { amount: 74.98, currency: 'USD' }, discounts: [],
      items: [
        { title: 'The Winning Goal', variant: 'Hardcover', quantity: 1, price: { amount: 44.99, currency: 'USD' } },
        { title: 'Custom storybook', variant: 'Softcover', quantity: 1, price: { amount: 29.99, currency: 'USD' } }
      ]
    }
  }, { visit: null, source: { label: 'tiktok', campaign: '' } }, visitor);
  assert.equal(out.tab, TABS.orders);
  assert.equal(out.rows.length, 2);
  assert.deepEqual(without(out.rows[1], 'Date'), {
    Order: '6612345678', Book: 'Custom storybook', Cover: 'Softcover', Quantity: 1, Price: 29.99,
    'Order total': 74.98, Currency: 'USD', 'Discount codes': '', Customer: 'First order', Source: 'tiktok', ...PLACE
  });
  const empty = storefrontRows({ name: 'checkout_completed', checkout: { orderId: '1', firstOrder: null, total: null, discounts: [], items: [] } }, null, visitor);
  assert.equal(empty.rows.length, 1, 'an order without items still leaves a row');
  assert.equal(empty.rows[0].Customer, '');
});

test('a Daily row has the funnel, revenue and top lists', () => {
  const row = dailyRow({
    day: '2026-10-24',
    visitors: 120,
    count: { visits: 150, page_viewed: 600, product_viewed: 200, preview_started: 12, preview_ready: 11, preview_failed: 1, product_added_to_cart: 4, checkout_started: 3, checkout_completed: 2 },
    pages: { '/': 300, '/products/a': 50 },
    sources: { google: 80, direct: 70 },
    countries: { FR: 90, US: 30 },
    revenue: { USD: 89.98 },
    orderSources: { google: 2 }
  });
  assert.deepEqual(row, {
    Day: '2026-10-24', Visitors: 120, Visits: 150, 'Visits without cookie consent': 0, 'Page views': 600, 'Product views': 200, 'Collection views': 0,
    Searches: 0, 'Cart views': 0, 'Previews started': 12, 'Previews ready': 11, 'Previews failed': 1,
    'Added to cart': 4, 'Checkouts started': 3, Orders: 2, Revenue: 89.98, Currency: 'USD',
    'Top sources': 'google (80), direct (70)', 'Orders by source': 'google (2)',
    'Top pages': '/ (300), /products/a (50)', 'Top countries': 'France (90), United States (30)'
  });
  const mixed = dailyRow({ day: '2026-10-25', visitors: 0, count: {}, pages: {}, sources: {}, countries: {}, revenue: { USD: 10, EUR: 5 }, orderSources: {} });
  assert.equal(mixed.Revenue, '10 USD + 5 EUR');
  assert.equal(mixed.Currency, 'USD, EUR');
});

test('preview page follow-ups become sheet fields', () => {
  assert.deepEqual(previewFollowUp({ action: 'occasion', generation_id: 'k3x9p2m7q1', occasion: 'A birthday' }),
    { value: { generationId: 'k3x9p2m7q1', details: '', variant: '', fields: { Occasion: 'A birthday' } } });
  assert.deepEqual(previewFollowUp({ action: 'occasion', generation_id: 'k3x9p2m7q1', occasion: '' }).value.fields,
    { Occasion: '' }, 'clearing the chip clears the cell');
  assert.deepEqual(previewFollowUp({ action: 'cart', generation_id: 'k3x9p2m7q1', occasion: 'A new baby', variant: 'Hardcover' }).value.fields,
    { Occasion: 'A new baby', 'Added to cart': 'Hardcover' });
  assert.deepEqual(previewFollowUp({ action: 'cart', generation_id: 'k3x9p2m7q1', variant: 'Softcover' }).value.fields,
    { 'Added to cart': 'Softcover' }, 'a cart without an occasion leaves the answer alone');
  assert.deepEqual(previewFollowUp({ action: 'cart', generation_id: 'k3x9p2m7q1' }).value.fields, { 'Added to cart': 'Yes' });
});

test('extra details become a one-line sheet field', () => {
  assert.deepEqual(previewFollowUp({ action: 'details', generation_id: 'k3x9p2m7q1', details: '  Loves dinosaurs,\n a dog called Biscuit ' }).value.fields,
    { 'Extra details': 'Loves dinosaurs, a dog called Biscuit' });
  assert.deepEqual(previewFollowUp({ action: 'details', generation_id: 'k3x9p2m7q1', details: '' }).value.fields,
    { 'Extra details': '' }, 'emptying the field clears the cell');
  const cart = previewFollowUp({ action: 'cart', generation_id: 'k3x9p2m7q1', details: 'Has a big sister', variant: 'Hardcover' }).value;
  assert.deepEqual(cart.fields, { 'Extra details': 'Has a big sister', 'Added to cart': 'Hardcover' });
  assert.equal(cart.details, 'Has a big sister', 'kept for the #previews card');
  assert.equal(cart.variant, 'Hardcover');
  assert.equal(previewFollowUp({ action: 'details', generation_id: 'k3x9p2m7q1', details: 'x'.repeat(500) }).value.fields['Extra details'].length, 400);
});

test('follow-ups with anything off the list are refused', () => {
  assert.equal(previewFollowUp({ action: 'delete', generation_id: 'k3x9p2m7q1' }).error, 'bad-action');
  assert.equal(previewFollowUp({ action: 'occasion', generation_id: '../x', occasion: 'A birthday' }).error, 'bad-generation-id');
  assert.equal(previewFollowUp({ action: 'occasion', generation_id: 'k3x9p2m7q1', occasion: '=HYPERLINK("x")' }).error, 'bad-occasion');
  assert.equal(previewFollowUp(null).error, 'bad-action');
});

test('does nothing until both the URL and the secret are set', async (t) => {
  withSheet(t, URL_, undefined);
  const calls = stubFetch(t, () => new Response('{"ok":true}'));
  assert.equal(sheetConfigured(), false);
  assert.equal(await appendRows(TABS.visits, [{ Source: 'google' }]), false);
  assert.equal(await updateRow(TABS.previews, 'k3x9p2m7q1', { Occasion: 'A birthday' }), false);
  assert.equal(calls.length, 0);
});

test('rows go to their tab with the shared secret', async (t) => {
  withSheet(t, URL_, 's3cret');
  const calls = stubFetch(t, () => new Response('{"ok":true}'));
  assert.equal(await appendRows(TABS.orders, [{ Book: 'A' }, { Book: 'B' }]), true);
  assert.equal(await appendRows(TABS.orders, []), false, 'nothing to send');
  assert.deepEqual(calls, [{ url: URL_, method: 'POST', body: { secret: 's3cret', tab: 'Orders', rows: [{ Book: 'A' }, { Book: 'B' }] } }]);
});

test('lost rows are reported to #logs once per tab per 10 minutes', async (t) => {
  withSheet(t, URL_, 's3cret');
  withLogs(t);
  const warn = t.mock.method(console, 'warn', () => {});
  const calls = stubFetch(t, (url) => (url.startsWith('https://discord.com')
    ? new Response(null, { status: 204 })
    : new Response('{"ok":false,"error":"forbidden"}')));

  assert.equal(await appendRows(TABS.carts, [{ Book: 'A' }]), false);
  assert.equal(await appendRows(TABS.carts, [{ Book: 'B' }]), false);
  const reports = toDiscord(calls);
  assert.equal(reports.length, 1, 'the second loss is only logged');
  assert.equal(warn.mock.calls.length, 2);
  const embed = reports[0].body.embeds[0];
  assert.equal(embed.title, '⚠️ Rows not added to the requests sheet');
  assert.match(embed.description, /sheet answered 200 forbidden/);
  assert.deepEqual(embed.fields.map((f) => [f.name, f.value]), [['Tab', 'Carts']]);
});

test('a lost cover row names its generation but never the child', async (t) => {
  withSheet(t, URL_, 's3cret');
  withLogs(t);
  t.mock.method(console, 'warn', () => {});
  const calls = stubFetch(t, (url) => (url.startsWith('https://discord.com')
    ? new Response(null, { status: 204 })
    : new Response('<html>Error</html>', { status: 500 })));

  assert.equal(await appendRows(TABS.previews, [previewRow(req, book(), { coverUrl: COVER, prompt: 'Paint Emma' })]), false);
  const report = toDiscord(calls)[0];
  assert.deepEqual(report.body.embeds[0].fields.map((f) => [f.name, f.value]), [['Tab', 'Book previews'], ['Generation', '`k3x9p2m7q1`']]);
  const sent = JSON.stringify(report.body);
  assert.ok(!sent.includes('Emma') && !sent.includes(PHOTO), 'no name, photo or prompt in #logs');
});

test('an outage resolves false and never throws', async (t) => {
  withSheet(t, URL_, 's3cret');
  t.mock.method(console, 'warn', () => {});
  stubFetch(t, () => { throw new TypeError('fetch failed'); });
  assert.equal(await appendRows(TABS.checkouts, [{ Total: 1 }]), false);
});

test('an update names the tab, the generation and the fields to set', async (t) => {
  withSheet(t, URL_, 's3cret');
  const calls = stubFetch(t, () => new Response('{"ok":true}'));
  assert.equal(await updateRow(TABS.previews, 'k3x9p2m7q1', { Occasion: 'A birthday' }), true);
  assert.deepEqual(calls.map((c) => c.body), [{ secret: 's3cret', tab: 'Book previews', update: { generation: 'k3x9p2m7q1', set: { Occasion: 'A birthday' } } }]);
});

test('an update that beats its row waits and tries once more', async (t) => {
  withSheet(t, URL_, 's3cret');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const answers = ['{"ok":false,"error":"not-found"}', '{"ok":true}'];
  const calls = stubFetch(t, () => new Response(answers.shift()));

  const done = updateRow(TABS.custom, 'k3x9p2m7q1', { 'Added to cart': 'Hardcover' });
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

  const done = updateRow(TABS.previews, 'old-preview', { Occasion: 'A birthday' });
  await settle();
  t.mock.timers.tick(5000);
  assert.equal(await done, false);
  assert.equal(toDiscord(calls).length, 0);
  assert.equal(info.mock.calls.length, 1);
});

test('an update the sheet refuses is reported to #logs', async (t) => {
  withSheet(t, URL_, 's3cret');
  withLogs(t);
  t.mock.method(console, 'warn', () => {});
  const calls = stubFetch(t, (url) => (url.startsWith('https://discord.com')
    ? new Response(null, { status: 204 })
    : new Response('{"ok":false,"error":"bad-update"}')));

  assert.equal(await updateRow(TABS.daily, 'k3x9p2m7q1', { Occasion: 'A birthday' }), false);
  const embed = toDiscord(calls)[0].body.embeds[0];
  assert.equal(embed.title, '⚠️ Row not updated in the requests sheet');
  assert.deepEqual(embed.fields.map((f) => f.name), ['Tab', 'Generation']);
});
