// Daily storefront analytics in Upstash, read by the #events summary
// (lib/event-feed.js, api/cron/daily-summary.js).
//
// Per UTC day (kbf:ev:<day>:...): unique visitors (a HyperLogLog of Shopify
// client ids), a hash of counters (each event name, visits, previews), and
// hashes of page views by path, visits by source and country, orders by
// source and revenue by currency. Day keys are kept 40 days.
//
// A visit starts with a page view after 30 minutes without one. Its source
// is remembered as the visitor's first (30 days), so their later cart,
// checkout and order events can be attributed to it. Functions take the
// Redis client (lib/redis.js) so tests can pass a fake.

import { trafficSource } from './traffic-source.js';

const PREFIX = 'kbf:ev:';
const DAY_KEY_SECONDS = 40 * 24 * 60 * 60;
const VISIT_GAP_SECONDS = 30 * 60;
const VISITOR_SECONDS = 30 * 24 * 60 * 60;

// Events posted live, which need the visitor's source.
const ATTRIBUTED = ['product_added_to_cart', 'checkout_started', 'checkout_completed'];

// Day keys this instance has already set to expire.
const expiring = new Set();

export function dayOf(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function dayKey(day, name) {
  return PREFIX + day + ':' + name;
}

// Records one normalised event (lib/storefront-events.js). Resolves to
// { visit, source }: the visitor's visit number when this page view started
// a visit (else null), and that visit's source or, for cart, checkout and
// order events, the visitor's first one. null without Redis or on a Redis
// error.
export async function recordEvent(redis, event, { country = '', ownHosts = [] } = {}) {
  if (!redis) return null;
  const day = dayOf();
  const visitKey = PREFIX + 'visit:' + event.clientId;
  const firstSourceKey = PREFIX + 'source:' + event.clientId;
  try {
    let started = false;
    let source = null;
    if (event.name === 'page_viewed') {
      started = Boolean(await redis.set(visitKey, 1, { nx: true, ex: VISIT_GAP_SECONDS }));
      if (started) source = trafficSource({ params: event.params, referrer: event.referrer, ownHosts });
    } else if (ATTRIBUTED.includes(event.name)) {
      const first = await redis.get(firstSourceKey);
      source = { label: first ? String(first) : 'unknown', campaign: '' };
    }

    const ops = [];
    const touched = new Set(['visitors', 'count']);
    const add = (method, ...args) => ops.push([method, args]) - 1;

    add('pfadd', dayKey(day, 'visitors'), event.clientId);
    add('hincrby', dayKey(day, 'count'), event.name, 1);
    if (event.name === 'page_viewed') {
      touched.add('pages');
      add('hincrby', dayKey(day, 'pages'), event.path, 1);
      if (!started) add('expire', visitKey, VISIT_GAP_SECONDS);
    }

    let visitOp = -1;
    if (started) {
      touched.add('sources');
      add('hincrby', dayKey(day, 'count'), 'visits', 1);
      add('hincrby', dayKey(day, 'sources'), source.label, 1);
      if (/^[A-Z]{2}$/.test(country)) {
        touched.add('countries');
        add('hincrby', dayKey(day, 'countries'), country, 1);
      }
      add('set', firstSourceKey, source.label, { nx: true, ex: VISITOR_SECONDS });
      visitOp = add('incr', PREFIX + 'visits:' + event.clientId);
      add('expire', PREFIX + 'visits:' + event.clientId, VISITOR_SECONDS);
    }

    if (event.name === 'checkout_completed' && event.checkout) {
      touched.add('order-sources');
      add('hincrby', dayKey(day, 'order-sources'), source.label, 1);
      if (event.checkout.total) {
        touched.add('revenue');
        add('hincrbyfloat', dayKey(day, 'revenue'), event.checkout.total.currency, event.checkout.total.amount);
      }
    }

    for (const name of touched) {
      const key = dayKey(day, name);
      if (!expiring.has(key)) {
        add('expire', key, DAY_KEY_SECONDS);
        expiring.add(key);
      }
    }

    const pipe = redis.pipeline();
    for (const [method, args] of ops) pipe[method](...args);
    const results = await pipe.exec();
    return { visit: visitOp >= 0 ? Number(results[visitOp]) || null : null, source };
  } catch (e) {
    console.warn('[event-stats] ' + event.name + ' not recorded:', (e && e.message) || e);
    return null;
  }
}

// Counts a backend event (preview_started, preview_ready, preview_failed) in
// today's totals. Never throws.
export async function countEvent(redis, name) {
  if (!redis) return;
  const key = dayKey(dayOf(), 'count');
  try {
    const pipe = redis.pipeline().hincrby(key, name, 1);
    if (!expiring.has(key)) {
      pipe.expire(key, DAY_KEY_SECONDS);
      expiring.add(key);
    }
    await pipe.exec();
  } catch (e) {
    console.warn('[event-stats] ' + name + ' not counted:', (e && e.message) || e);
  }
}

// A day's totals: { day, visitors, count, pages, sources, countries, revenue,
// orderSources }, each hash as { key: number }.
export async function readDay(redis, day) {
  const hashes = ['count', 'pages', 'sources', 'countries', 'revenue', 'order-sources'];
  const pipe = redis.pipeline().pfcount(dayKey(day, 'visitors'));
  for (const name of hashes) pipe.hgetall(dayKey(day, name));
  const [visitors, ...values] = await pipe.exec();
  const numbers = (h) => Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k, Number(v) || 0]));
  const [count, pages, sources, countries, revenue, orderSources] = values.map(numbers);
  return { day, visitors: Number(visitors) || 0, count, pages, sources, countries, revenue, orderSources };
}
