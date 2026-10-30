// Pixel event validation: whitelisted fields only, no tokens or child names.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normaliseEvent, pagePath } from '../lib/storefront-events.js';
import { SOURCE_PARAMS } from '../lib/traffic-source.js';

test('rejects unknown events', () => {
  assert.equal(normaliseEvent(null), null);
  assert.equal(normaliseEvent([]), null);
  assert.equal(normaliseEvent({ event: 'checkout_hacked', clientId: 'c1' }), null);
});

test('keeps events without a client id (no analytics consent), marked as such', () => {
  assert.deepEqual(normaliseEvent({ event: 'page_viewed', clientId: '', path: '/' }), {
    name: 'page_viewed', clientId: '', consented: false, path: '/', params: {}, referrer: ''
  });
  assert.equal(normaliseEvent({ event: 'checkout_completed' }).consented, false);
  assert.equal(normaliseEvent({ event: 'page_viewed', clientId: 'c1' }).consented, true);
});

test('keeps campaign tags only, and the referrer\'s origin', () => {
  const e = normaliseEvent({
    event: 'page_viewed',
    clientId: 'c1',
    path: '/pages/create-your-book?b=emma-the-winning-goal&k=kb-book-1',
    params: { utm_source: 'instagram', name: 'Emma', b: 'emma-the-goal', gclid: 'x'.repeat(500) },
    referrer: 'https://www.booktokids.com/products/x?name=Emma'
  });
  assert.deepEqual(e, {
    name: 'page_viewed',
    clientId: 'c1',
    consented: true,
    path: '/pages/create-your-book',
    params: { utm_source: 'instagram', gclid: 'x'.repeat(100) },
    referrer: 'https://www.booktokids.com'
  });
  assert.ok(!/emma/i.test(JSON.stringify(e)));
});

test('checkout tokens and ids in paths become :id', () => {
  assert.equal(pagePath('/checkouts/cn/Z2NwLWV1cm9wZS13ZXN0NDowMUpCQ1Y1RjFH/thank-you'), '/checkouts/cn/:id/thank-you');
  assert.equal(pagePath('/orders/3f2b8c1e-1a2b-4c3d-9e8f-001122334455'), '/orders/:id');
  assert.equal(pagePath('/products/the-movie-makers-personalized-film-director-book-for-girls'), '/products/the-movie-makers-personalized-film-director-book-for-girls');
  assert.equal(pagePath('javascript:alert(1)'), '/');
});

test('orders keep titles, quantities, prices and codes, never line item properties', () => {
  const e = normaliseEvent({
    event: 'checkout_completed',
    clientId: 'c1',
    path: '/checkouts/c/abc123def456ghi789jkl/thank-you',
    checkout: {
      orderId: 'gid://shopify/OrderIdentity/5870000000001',
      firstOrder: true,
      total: { amount: 34.991, currency: 'eur' },
      items: [{ title: 'The Winning Goal', variant: 'Hardcover', quantity: 1, price: { amount: 34.99, currency: 'EUR' }, properties: [{ key: "Child's name", value: 'Emma' }] }],
      discounts: ['WELCOME10'],
      email: 'parent@example.com',
      shippingAddress: { firstName: 'Ann' }
    }
  });
  assert.deepEqual(e.checkout, {
    orderId: '5870000000001',
    firstOrder: true,
    total: { amount: 34.99, currency: 'EUR' },
    items: [{ title: 'The Winning Goal', variant: 'Hardcover', quantity: 1, price: { amount: 34.99, currency: 'EUR' } }],
    discounts: ['WELCOME10']
  });
  assert.ok(!/emma|parent@|Ann/.test(JSON.stringify(e)));
});

test('bad money and quantities are cleaned up', () => {
  const e = normaliseEvent({ event: 'product_added_to_cart', clientId: 'c1', product: { title: 'Book', price: { amount: 'x', currency: 'EUR' }, total: { amount: 5, currency: 'euros' }, quantity: 500 } });
  assert.equal(e.product.price, null);
  assert.equal(e.product.total, null);
  assert.equal(e.product.quantity, 99);
});

test('the pixel sends the same campaign parameters the backend keeps', () => {
  const pixel = fs.readFileSync(new URL('../pixel/custom-pixel.js', import.meta.url), 'utf8');
  const list = JSON.parse(pixel.match(/const SOURCE_PARAMS = (\[[^\]]+\])/)[1].replace(/'/g, '"'));
  assert.deepEqual(list, SOURCE_PARAMS);
});
