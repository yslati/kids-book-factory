// Shopify's order webhook: signature, what's kept from an order, and the intake.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import webhook from '../api/shopify-webhook.js';
import { orderFromWebhook, validSignature } from '../lib/shopify-order.js';

const SECRET = 'test-webhook-secret';
const sign = (body, secret = SECRET) => createHmac('sha256', secret).update(body).digest('base64');

const ORDER = {
  id: 6812345678901,
  name: '#btk-1009',
  test: false,
  currency: 'USD',
  total_price: '50.18',
  email: 'parent@example.com',
  landing_site: '/products/the-ice-hockey-comeback?utm_source=google&utm_medium=product_sync&name=Emma',
  referring_site: 'https://www.google.com/search?q=hockey+book',
  customer: { first_name: 'Ann', email: 'parent@example.com', orders_count: 1 },
  shipping_address: { first_name: 'Ann', address1: '1 Rue X', city: 'Lyon', country_code: 'fr' },
  client_details: { browser_ip: '203.0.113.7', user_agent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36' },
  discount_codes: [{ code: 'WELCOME10', amount: '5.00', type: 'percentage' }],
  line_items: [{ title: 'The Ice Hockey Comeback', variant_title: 'Hardcover', quantity: 1, price: '44.99', properties: [{ name: "Child's name", value: 'Emma' }] }]
};

test('signature: the base64 HMAC-SHA256 of the raw body with the store key', () => {
  const body = Buffer.from(JSON.stringify(ORDER));
  assert.equal(validSignature(body, sign(body), SECRET), true);
  assert.equal(validSignature(body, sign(body, 'other'), SECRET), false);
  assert.equal(validSignature(Buffer.from(body.toString() + ' '), sign(body), SECRET), false);
  assert.equal(validSignature(body, '', SECRET), false);
  assert.equal(validSignature(body, sign(body), ''), false, 'no key, nothing passes');
});

test('an order keeps books, prices, codes, campaign tags, country and browser; never people', () => {
  const order = orderFromWebhook(ORDER);
  assert.equal(order.id, '6812345678901');
  assert.equal(order.test, false);
  assert.deepEqual(order.event.checkout, {
    orderId: '#btk-1009',
    firstOrder: true,
    total: { amount: 50.18, currency: 'USD' },
    items: [{ title: 'The Ice Hockey Comeback', variant: 'Hardcover', quantity: 1, price: { amount: 44.99, currency: 'USD' } }],
    discounts: ['WELCOME10']
  });
  assert.equal(order.event.name, 'checkout_completed');
  assert.equal(order.event.path, '/products/the-ice-hockey-comeback');
  assert.deepEqual(order.event.params, { utm_source: 'google', utm_medium: 'product_sync' });
  assert.equal(order.event.referrer, 'https://www.google.com');
  assert.equal(order.visitor.country, 'FR');
  assert.equal(order.visitor.city, '');
  assert.equal(order.visitor.ip, '');
  assert.ok(!/Emma|Ann|parent@|Lyon|Rue|203\.0\.113/.test(JSON.stringify(order)));
});

test('an order without a landing page, customer or address still works', () => {
  const order = orderFromWebhook({ id: 1, name: '#btk-1', currency: 'USD', total_price: '0.00', line_items: [] });
  assert.equal(order.event.path, '/');
  assert.equal(order.event.checkout.firstOrder, null);
  assert.equal(order.visitor.country, '');
  assert.equal(orderFromWebhook(null), null);
  assert.equal(orderFromWebhook({ name: 'no id' }), null);
});

function res() {
  return {
    statusCode: 200, body: undefined,
    setHeader() {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; }
  };
}
function req(body, headers = {}) {
  const raw = Buffer.from(body);
  const r = Readable.from([raw.subarray(0, 10), raw.subarray(10)]);
  r.method = 'POST';
  r.url = '/api/shopify-webhook';
  r.headers = { 'content-type': 'application/json', 'x-shopify-topic': 'orders/create', 'x-shopify-hmac-sha256': sign(raw), ...headers };
  return r;
}

// What @vercel/node's helpers (3.x, restoreBody) leave behind: the request
// already read, its body replayed to 'data' and 'end' listeners only.
function readByVercel(r, raw) {
  const replay = new PassThrough();
  const on = replay.on.bind(replay);
  const originalOn = r.on.bind(r);
  r.read = replay.read.bind(replay);
  r.on = r.addListener = (name, cb) => (name === 'data' || name === 'end' ? on(name, cb) : originalOn(name, cb));
  replay.write(raw);
  replay.end();
  return r;
}

test('intake: signed orders get 200, anything else 401, wrong method 405', async (t) => {
  const saved = process.env.SHOPIFY_WEBHOOK_SECRET;
  process.env.SHOPIFY_WEBHOOK_SECRET = SECRET;
  t.after(() => { if (saved === undefined) delete process.env.SHOPIFY_WEBHOOK_SECRET; else process.env.SHOPIFY_WEBHOOK_SECRET = saved; });
  const logs = [];
  t.mock.method(console, 'log', (...a) => logs.push(a.join(' ')));

  let r = res();
  await webhook(req(JSON.stringify({ ...ORDER, test: true })), r);
  assert.equal(r.statusCode, 200);
  assert.ok(logs.some((l) => l.includes('test order #btk-1009 left out')));

  r = res();
  await webhook(req(JSON.stringify(ORDER)), r);
  assert.equal(r.statusCode, 200, 'a real order');

  const body = JSON.stringify(ORDER);
  const drained = req(body);
  drained.resume();
  await new Promise((done) => drained.on('end', done));
  r = res();
  await webhook(readByVercel(drained, Buffer.from(body)), r);
  assert.equal(r.statusCode, 200, 'the body as Vercel hands it over');

  r = res();
  await webhook(req(JSON.stringify(ORDER), { 'x-shopify-hmac-sha256': sign('{}') }), r);
  assert.equal(r.statusCode, 401);

  r = res();
  await webhook(req('not json'), r);
  assert.equal(r.statusCode, 200, 'signed but unreadable: acknowledged so Shopify stops retrying');

  const get = req('{}');
  get.method = 'GET';
  r = res();
  await webhook(get, r);
  assert.equal(r.statusCode, 405);
});
