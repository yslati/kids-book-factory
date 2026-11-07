// Daily storefront analytics in Upstash, read by the #events summary
// (lib/event-feed.js, api/cron/daily-summary.js).
//
// Per UTC day (kbf:ev:<day>:...): unique visitors (a HyperLogLog of Shopify
// client ids), a hash of counters (each event name, visits, previews,
// shares), and hashes of page views by path, visits by source and country,
// orders by source, revenue by currency, searches by term and each book's
// funnel ("views:<handle>", "previews:<handle>", "carts:<title>",
// "orders:<title>"). Day keys are kept 40 days.
//
// A visit starts with a page view after 30 minutes without one. Its source
// is remembered as the visitor's first (30 days), so their later cart,
// checkout and order events can be attributed to it. Functions take the
// Redis client (lib/redis.js) so tests can pass a fake.

import { createHash, randomBytes } from 'node:crypto';
import { productHandle, shortTitle } from './store-links.js';
import { trafficSource } from './traffic-source.js';

const PREFIX = 'kbf:ev:';
const DAY_KEY_SECONDS = 40 * 24 * 60 * 60;
const VISIT_GAP_SECONDS = 30 * 60;
const VISITOR_SECONDS = 30 * 24 * 60 * 60;
const SALT_SECONDS = 2 * 24 * 60 * 60;
const JOURNEY_SECONDS = 24 * 60 * 60;

// Events posted live or saved to the sheet, which need the visitor's source.
const ATTRIBUTED = ['search_submitted', 'product_added_to_cart', 'checkout_started', 'checkout_completed'];

// Day keys this instance has already set to expire.
const expiring = new Set();
// Today's cookieless salt, once this instance has read it.
const salts = new Map();

export function dayOf(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function dayKey(day, name) {
  return PREFIX + day + ':' + name;
}

// A search as counted: lower case, single spaces.
export function searchTerm(query) {
  return String(query || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60);
}

// hincrby ops for each book of an order, by title and quantity.
function orderBooks(items) {
  return (items || []).map((i) => ['orders:' + shortTitle(i.title), i.quantity || 1]).filter(([field]) => field !== 'orders:');
}

// A visitor id for events without Shopify's client id (no analytics consent):
// a hash of the IP and user agent with a random salt that changes each UTC
// day and is deleted after two. Nothing is stored on the visitor's device,
// and once the salt is gone the id can't be traced back or matched to another
// day. Resolves to '' without Redis or on a Redis error.
export async function cookielessId(redis, { ip = '', userAgent = '' } = {}) {
  if (!redis) return '';
  const day = dayOf();
  try {
    let salt = salts.get(day);
    if (!salt) {
      const key = PREFIX + 'salt:' + day;
      await redis.set(key, randomBytes(16).toString('base64url'), { nx: true, ex: SALT_SECONDS });
      const value = await redis.get(key);
      if (!value) return '';
      salt = String(value);
      salts.clear();
      salts.set(day, salt);
    }
    return 'anon:' + createHash('sha256').update(salt + '|' + ip + '|' + userAgent).digest('hex').slice(0, 32);
  } catch (e) {
    console.warn('[event-stats] no cookieless id:', (e && e.message) || e);
    return '';
  }
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
    if (event.name === 'product_viewed' && productHandle(event.path)) {
      touched.add('books');
      add('hincrby', dayKey(day, 'books'), 'views:' + productHandle(event.path), 1);
    }
    if (event.name === 'product_added_to_cart' && event.product && shortTitle(event.product.title)) {
      touched.add('books');
      add('hincrby', dayKey(day, 'books'), 'carts:' + shortTitle(event.product.title), 1);
    }
    if (event.name === 'search_submitted' && event.search && searchTerm(event.search.query)) {
      touched.add('searches');
      add('hincrby', dayKey(day, 'searches'), searchTerm(event.search.query), 1);
    }

    let visitOp = -1;
    if (started) {
      touched.add('sources');
      add('hincrby', dayKey(day, 'count'), 'visits', 1);
      if (event.consented === false) add('hincrby', dayKey(day, 'count'), 'cookieless_visits', 1);
      add('hincrby', dayKey(day, 'sources'), source.label, 1);
      if (/^[A-Z]{2}$/.test(country)) {
        touched.add('countries');
        add('hincrby', dayKey(day, 'countries'), country, 1);
      }
      add('set', firstSourceKey, source.label, { nx: true, ex: VISITOR_SECONDS });
      add('set', PREFIX + 'first:' + event.clientId, Date.now(), { nx: true, ex: VISITOR_SECONDS });
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
      for (const [field, n] of orderBooks(event.checkout.items)) {
        touched.add('books');
        add('hincrby', dayKey(day, 'books'), field, n);
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

// Counts an order from Shopify's order webhook (api/shopify-webhook.js) in
// the day's totals, with its source and revenue. Each Shopify order id counts
// once (kbf:ev:order:<id>, kept 40 days), since Shopify can deliver a webhook
// twice. Resolves to true when counted, false for an order already counted,
// and null without Redis or on a Redis error.
export async function recordOrder(redis, orderId, event, source) {
  if (!redis) return null;
  const day = dayOf();
  try {
    if (!(await redis.set(PREFIX + 'order:' + orderId, 1, { nx: true, ex: DAY_KEY_SECONDS }))) return false;
    const pipe = redis.pipeline()
      .hincrby(dayKey(day, 'count'), 'checkout_completed', 1)
      .hincrby(dayKey(day, 'order-sources'), source.label, 1);
    const touched = ['count', 'order-sources'];
    const total = event.checkout && event.checkout.total;
    if (total) {
      pipe.hincrbyfloat(dayKey(day, 'revenue'), total.currency, total.amount);
      touched.push('revenue');
    }
    const books = orderBooks(event.checkout && event.checkout.items);
    for (const [field, n] of books) pipe.hincrby(dayKey(day, 'books'), field, n);
    if (books.length) touched.push('books');
    for (const name of touched) {
      const key = dayKey(day, name);
      if (!expiring.has(key)) {
        pipe.expire(key, DAY_KEY_SECONDS);
        expiring.add(key);
      }
    }
    await pipe.exec();
    return true;
  } catch (e) {
    console.warn('[event-stats] order ' + orderId + ' not recorded:', (e && e.message) || e);
    return null;
  }
}

// Counts a backend event (preview_started, preview_ready, preview_failed,
// share_clicked, share_opened, share_unfurled) in today's totals; with a book
// handle, a preview_ready also counts in that book's funnel. Never throws.
export async function countEvent(redis, name, book = '') {
  if (!redis) return;
  const key = dayKey(dayOf(), 'count');
  const booksKey = dayKey(dayOf(), 'books');
  try {
    const pipe = redis.pipeline().hincrby(key, name, 1);
    if (book && name === 'preview_ready') pipe.hincrby(booksKey, 'previews:' + book, 1);
    for (const k of book ? [key, booksKey] : [key]) {
      if (!expiring.has(k)) {
        pipe.expire(k, DAY_KEY_SECONDS);
        expiring.add(k);
      }
    }
    await pipe.exec();
  } catch (e) {
    console.warn('[event-stats] ' + name + ' not counted:', (e && e.message) || e);
  }
}

// Of the given days, those with any totals recorded (every event counts in
// the day's count hash).
export async function recordedDays(redis, days) {
  if (!days.length) return [];
  const pipe = redis.pipeline();
  for (const day of days) pipe.exists(dayKey(day, 'count'));
  const found = await pipe.exec();
  return days.filter((day, i) => Number(found[i]) > 0);
}

// A day's totals: { day, visitors, count, pages, sources, countries, revenue,
// orderSources, books, searches }, each hash as { key: number }.
export async function readDay(redis, day) {
  const hashes = ['count', 'pages', 'sources', 'countries', 'revenue', 'order-sources', 'books', 'searches'];
  const pipe = redis.pipeline().pfcount(dayKey(day, 'visitors'));
  for (const name of hashes) pipe.hgetall(dayKey(day, name));
  const [visitors, ...values] = await pipe.exec();
  const numbers = (h) => Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k, Number(v) || 0]));
  const [count, pages, sources, countries, revenue, orderSources, books, searches] = values.map(numbers);
  return { day, visitors: Number(visitors) || 0, count, pages, sources, countries, revenue, orderSources, books, searches };
}

// Unique visitors over several days (a union of the days' HyperLogLogs).
export async function countVisitors(redis, days) {
  const [visitors] = await redis.pipeline().pfcount(...days.map((day) => dayKey(day, 'visitors'))).exec();
  return Number(visitors) || 0;
}

// Saves where an order's buyer came from, when the pixel reports the order:
// { visits, firstAt, firstSource } for the Shopify order id, kept a day for
// the order webhook's card (readJourney). Never throws.
export async function saveJourney(redis, orderId, clientId) {
  if (!redis || !orderId || !clientId) return;
  try {
    const [visits, firstAt, firstSource] = await redis.pipeline()
      .get(PREFIX + 'visits:' + clientId)
      .get(PREFIX + 'first:' + clientId)
      .get(PREFIX + 'source:' + clientId)
      .exec();
    const journey = { visits: Number(visits) || null, firstAt: Number(firstAt) || null, firstSource: firstSource ? String(firstSource) : '' };
    await redis.set(PREFIX + 'journey:' + orderId, JSON.stringify(journey), { ex: JOURNEY_SECONDS });
  } catch (e) {
    console.warn('[event-stats] journey of order ' + orderId + ' not saved:', (e && e.message) || e);
  }
}

// An order's journey (saveJourney), waiting up to waitMs for the pixel, which
// reports the order from the thank-you page at about the time Shopify sends
// the webhook. null when it doesn't come or on a Redis error.
export async function readJourney(redis, orderId, { waitMs = 6000, everyMs = 1000 } = {}) {
  if (!redis || !orderId) return null;
  const until = Date.now() + waitMs;
  try {
    for (;;) {
      const row = await redis.get(PREFIX + 'journey:' + orderId);
      if (row) return typeof row === 'string' ? JSON.parse(row) : row;
      if (Date.now() + everyMs > until) return null;
      await new Promise((resolve) => setTimeout(resolve, everyMs));
    }
  } catch (e) {
    console.warn('[event-stats] journey of order ' + orderId + ' not read:', (e && e.message) || e);
    return null;
  }
}

// Several days from readDay added up: { from, to, visitors, count, pages,
// sources, countries, revenue, orderSources, books, searches }. visitors is
// the days' unique count (countVisitors), not a sum.
export function sumDays(days, visitors) {
  const hashes = ['count', 'pages', 'sources', 'countries', 'revenue', 'orderSources', 'books', 'searches'];
  const total = { from: days[0].day, to: days[days.length - 1].day, visitors };
  for (const name of hashes) {
    total[name] = {};
    for (const day of days) {
      for (const [key, n] of Object.entries(day[name] || {})) total[name][key] = (total[name][key] || 0) + n;
    }
  }
  return total;
}
