// Daily storefront counters, against an in-memory stand-in for Upstash.

import test from 'node:test';
import assert from 'node:assert/strict';
import { cookielessId, countEvent, dayOf, readDay, recordEvent, recordOrder } from '../lib/event-stats.js';

function fakeRedis({ fail = false } = {}) {
  const strings = new Map();
  const hashes = new Map();
  const sets = new Map();
  const ttls = new Map();
  const hash = (k) => {
    if (!hashes.has(k)) hashes.set(k, {});
    return hashes.get(k);
  };
  const ops = {
    set(k, v, o = {}) {
      if (o.nx && strings.has(k)) return null;
      strings.set(k, v);
      if (o.ex) ttls.set(k, o.ex);
      return 'OK';
    },
    get: (k) => (strings.has(k) ? strings.get(k) : null),
    incr(k) { strings.set(k, (Number(strings.get(k)) || 0) + 1); return strings.get(k); },
    expire(k, s) { ttls.set(k, s); return 1; },
    pfadd(k, ...members) {
      if (!sets.has(k)) sets.set(k, new Set());
      members.forEach((m) => sets.get(k).add(m));
      return 1;
    },
    pfcount: (k) => (sets.has(k) ? sets.get(k).size : 0),
    hincrby(k, f, n) { const h = hash(k); h[f] = (h[f] || 0) + n; return h[f]; },
    hincrbyfloat(k, f, n) { const h = hash(k); h[f] = Math.round(((h[f] || 0) + n) * 100) / 100; return h[f]; },
    hgetall: (k) => (hashes.has(k) ? { ...hashes.get(k) } : null)
  };
  return {
    strings,
    hashes,
    ttls,
    async set(...a) { if (fail) throw new Error('upstash down'); return ops.set(...a); },
    async get(...a) { if (fail) throw new Error('upstash down'); return ops.get(...a); },
    pipeline() {
      const steps = [];
      const p = new Proxy({}, {
        get: (target, name) => (name === 'exec'
          ? async () => { if (fail) throw new Error('upstash down'); return steps.map((step) => step()); }
          : (...args) => { steps.push(() => ops[name](...args)); return p; })
      });
      return p;
    }
  };
}

const day = dayOf();
const key = (name) => 'kbf:ev:' + day + ':' + name;
const page = (clientId, path, extra = {}) => ({ name: 'page_viewed', clientId, path, params: {}, referrer: '', ...extra });

test('a first page view starts a visit with its source; the next ones only count', async () => {
  const redis = fakeRedis();
  const first = await recordEvent(redis, page('c1', '/', { params: { utm_source: 'instagram', utm_medium: 'paid', utm_campaign: 'spring' } }), { country: 'FR' });
  assert.deepEqual(first, { visit: 1, source: { label: 'instagram / paid', campaign: 'spring' } });
  assert.deepEqual(await recordEvent(redis, page('c1', '/products/book'), { country: 'FR' }), { visit: null, source: null });

  assert.deepEqual(redis.hashes.get(key('count')), { page_viewed: 2, visits: 1 });
  assert.deepEqual(redis.hashes.get(key('pages')), { '/': 1, '/products/book': 1 });
  assert.deepEqual(redis.hashes.get(key('sources')), { 'instagram / paid': 1 });
  assert.deepEqual(redis.hashes.get(key('countries')), { FR: 1 });
  assert.equal(redis.ttls.get('kbf:ev:visit:c1'), 30 * 60, 'the visit stays open 30 minutes after the last page view');
  assert.equal(redis.ttls.get(key('count')), 40 * 24 * 60 * 60, 'day keys are kept 40 days');
});

test('a later visit counts again, but the visitor keeps their first source', async () => {
  const redis = fakeRedis();
  await recordEvent(redis, page('c2', '/', { params: { gclid: 'x' } }));
  redis.strings.delete('kbf:ev:visit:c2');
  const second = await recordEvent(redis, page('c2', '/', { referrer: 'https://www.google.com' }));
  assert.deepEqual(second, { visit: 2, source: { label: 'google.com', campaign: '' } });
  assert.equal(redis.strings.get('kbf:ev:source:c2'), 'google ads');
});

test('carts, checkouts and orders carry the visitor\'s first source; orders add revenue', async () => {
  const redis = fakeRedis();
  await recordEvent(redis, page('c3', '/', { params: { ttclid: 'x' } }));
  const cart = await recordEvent(redis, { name: 'product_added_to_cart', clientId: 'c3', path: '/products/book', params: {}, referrer: '' });
  assert.deepEqual(cart, { visit: null, source: { label: 'tiktok ads', campaign: '' } });
  await recordEvent(redis, { name: 'checkout_completed', clientId: 'c3', path: '/checkouts/:id/thank-you', params: {}, referrer: '', checkout: { total: { amount: 34.99, currency: 'EUR' }, items: [], discounts: [] } });
  await recordEvent(redis, { name: 'checkout_completed', clientId: 'unknown-visitor', path: '/', params: {}, referrer: '', checkout: { total: { amount: 24.99, currency: 'EUR' }, items: [], discounts: [] } });

  assert.deepEqual(redis.hashes.get(key('revenue')), { EUR: 59.98 });
  assert.deepEqual(redis.hashes.get(key('order-sources')), { 'tiktok ads': 1, unknown: 1 });
});

test('previews count from the backend, and a day reads back as numbers', async () => {
  const redis = fakeRedis();
  await recordEvent(redis, page('c4', '/'), { country: 'MA' });
  await recordEvent(redis, page('c5', '/'), { country: 'FR' });
  await countEvent(redis, 'preview_started');
  await countEvent(redis, 'preview_ready');
  const stats = await readDay(redis, day);
  assert.equal(stats.visitors, 2);
  assert.equal(stats.count.page_viewed, 2);
  assert.equal(stats.count.preview_ready, 1);
  assert.deepEqual(stats.countries, { MA: 1, FR: 1 });
  assert.deepEqual(stats.revenue, {});
});

test('without Redis, or when it fails, nothing throws', async () => {
  assert.equal(await recordEvent(null, page('c6', '/')), null);
  assert.equal(await recordEvent(fakeRedis({ fail: true }), page('c6', '/')), null);
  await countEvent(fakeRedis({ fail: true }), 'preview_started');
  await countEvent(null, 'preview_started');
});

test('cookieless ids: same IP and browser match within the day, others differ', async () => {
  const redis = fakeRedis();
  const a = await cookielessId(redis, { ip: '203.0.113.7', userAgent: 'Safari' });
  assert.match(a, /^anon:[0-9a-f]{32}$/);
  assert.equal(await cookielessId(redis, { ip: '203.0.113.7', userAgent: 'Safari' }), a);
  assert.notEqual(await cookielessId(redis, { ip: '203.0.113.8', userAgent: 'Safari' }), a);
  assert.notEqual(await cookielessId(redis, { ip: '203.0.113.7', userAgent: 'Chrome' }), a);
  assert.ok(!a.includes('203.0.113.7'));
  assert.equal(await cookielessId(null, { ip: '203.0.113.7' }), '');
});

test('a visit without cookie consent is counted as one', async () => {
  const redis = fakeRedis();
  await recordEvent(redis, page('anon:1', '/', { consented: false }));
  await recordEvent(redis, page('c9', '/', { consented: true }));
  assert.deepEqual(redis.hashes.get(key('count')), { page_viewed: 2, visits: 2, cookieless_visits: 1 });
});

test('a webhook order counts once, with its source and revenue', async () => {
  const redis = fakeRedis();
  const order = { name: 'checkout_completed', checkout: { total: { amount: 50.18, currency: 'USD' }, items: [], discounts: [] } };
  assert.equal(await recordOrder(redis, '681', order, { label: 'google / product_sync', campaign: '' }), true);
  assert.equal(await recordOrder(redis, '681', order, { label: 'google / product_sync', campaign: '' }), false, 'a repeat delivery');
  assert.deepEqual(redis.hashes.get(key('count')), { checkout_completed: 1 });
  assert.deepEqual(redis.hashes.get(key('order-sources')), { 'google / product_sync': 1 });
  assert.deepEqual(redis.hashes.get(key('revenue')), { USD: 50.18 });
  assert.equal(redis.ttls.get('kbf:ev:order:681'), 40 * 24 * 60 * 60);
  assert.equal(await recordOrder(null, '682', order, { label: 'direct' }), null);
  assert.equal(await recordOrder(fakeRedis({ fail: true }), '683', order, { label: 'direct' }), null);
});
