// Each visitor's timeline in Upstash, for /btk customer (lib/btk-commands.js):
// page views, searches, previews, ratings, carts, checkouts, chats and the
// errors and limits they hit, newest first, keyed by Visitor ID
// (lib/visitor-id.js). A cover's generation id points back to its visitor,
// so follow-ups that only carry the generation (rating, cart, a queued cover
// finishing) land on the right timeline.
//
// Logging is a side effect: it never throws or delays a response.

import { deviceSummary, place } from './discord.js';
import { VISITOR_ID_PATTERN } from './visitor-id.js';

const PREFIX = 'kbf:who:';
const KEEP_STEPS = 200;
const KEEP_SECONDS = 90 * 24 * 3600;
const MAX_TEXT = 160;

export const Step = {
  page: 'page',
  search: 'search',
  preview: 'preview',
  cover: 'cover',
  failed: 'failed',
  limit: 'limit',
  rating: 'rating',
  fix: 'fix',
  share: 'share',
  cart: 'cart',
  checkout: 'checkout',
  order: 'order',
  chat: 'chat',
  custom: 'custom',
  error: 'error',
  gift: 'gift',
  reset: 'reset'
};

function clean(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

function genKey(generationId) {
  return PREFIX + 'gen:' + generationId;
}

function orderKey(order) {
  return PREFIX + 'order:' + String(order).replace(/^#/, '').trim().toLowerCase();
}

function validGeneration(id) {
  return /^[A-Za-z0-9-]{1,64}$/.test(String(id || ''));
}

function entry(kind, text, generation, url) {
  const step = { at: Date.now(), kind, text: clean(text) };
  if (generation) step.gen = generation;
  if (/^https:\/\/\S{1,300}$/.test(url || '')) step.url = url;
  return JSON.stringify(step);
}

// Adds one step to this visitor's timeline and refreshes where they are.
// generation links that cover to them; url is a link to show with the step.
export async function logStep(redis, visitor, { kind, text = '', generation = '', url = '' }) {
  const id = visitor && visitor.id;
  if (!redis || !id || !kind) return;
  try {
    const key = PREFIX + id;
    const now = Date.now();
    const pipe = redis.pipeline()
      .lpush(key, entry(kind, text, generation, url))
      .ltrim(key, 0, KEEP_STEPS - 1)
      .expire(key, KEEP_SECONDS)
      .hset(key + ':info', {
        place: place(visitor), device: deviceSummary(visitor.userAgent), ip: visitor.ip || '', last: now,
        // Shopify's visitor id, which the storefront also gives Clarity.
        ...(visitor.key ? { key: visitor.key } : {})
      })
      .hsetnx(key + ':info', 'first', now)
      .expire(key + ':info', KEEP_SECONDS);
    if (generation && validGeneration(generation)) pipe.set(genKey(generation), id, { ex: KEEP_SECONDS });
    await pipe.exec();
  } catch (e) {
    console.warn('[visitor-log] step not saved:', (e && e.message) || e);
  }
}

// Adds a step to a known visitor's timeline without touching where they are
// (the step didn't come from their browser).
export async function addStep(redis, id, { kind, text = '', generation = '', url = '' }) {
  if (!redis || !VISITOR_ID_PATTERN.test(id || '')) return;
  try {
    const key = PREFIX + id;
    await redis.pipeline()
      .lpush(key, entry(kind, text, generation, url))
      .ltrim(key, 0, KEEP_STEPS - 1)
      .expire(key, KEEP_SECONDS)
      .exec();
  } catch (e) {
    console.warn('[visitor-log] step not saved:', (e && e.message) || e);
  }
}

// Adds a step to the timeline of whoever made this cover, if known.
export async function logGenerationStep(redis, generationId, step) {
  if (!redis || !validGeneration(generationId)) return;
  try {
    const id = await redis.get(genKey(generationId));
    if (id) await addStep(redis, String(id), { ...step, generation: generationId });
  } catch (e) {
    console.warn('[visitor-log] step not saved:', (e && e.message) || e);
  }
}

// The newest step of this kind on a visitor's timeline, or null.
export async function lastStep(redis, id, kind) {
  if (!redis || !VISITOR_ID_PATTERN.test(id || '')) return null;
  try {
    const timeline = await readTimeline(redis, id);
    return (timeline && timeline.steps.find((s) => s.kind === kind)) || null;
  } catch (e) {
    return null;
  }
}

// Points an order's name ("#btk-1234") and id at its buyer.
export async function linkOrder(redis, id, orders) {
  if (!redis || !VISITOR_ID_PATTERN.test(id || '')) return;
  try {
    const pipe = redis.pipeline();
    for (const order of orders.filter(Boolean)) pipe.set(orderKey(order), id, { ex: KEEP_SECONDS });
    await pipe.exec();
  } catch (e) {
    console.warn('[visitor-log] order not linked:', (e && e.message) || e);
  }
}

// The buyer of an order, by name ("#btk-1234", "btk-1234") or id, or ''.
export async function visitorOfOrder(redis, order) {
  if (!redis || !/^#?[\w-]{1,40}$/.test(String(order || '').trim())) return '';
  const id = await redis.get(orderKey(order));
  return id ? String(id) : '';
}

// The visitor a cover belongs to, or ''.
export async function visitorOfGeneration(redis, generationId) {
  if (!redis || !validGeneration(generationId)) return '';
  const id = await redis.get(genKey(generationId));
  return id ? String(id) : '';
}

// { id, info, steps } for a Visitor ID (newest step first), or null when
// nothing is stored for it.
export async function readTimeline(redis, id) {
  if (!redis || !VISITOR_ID_PATTERN.test(id)) return null;
  const key = PREFIX + id;
  const [raw, info] = await Promise.all([redis.lrange(key, 0, KEEP_STEPS - 1), redis.hgetall(key + ':info')]);
  const steps = (raw || []).map((entry) => {
    if (entry && typeof entry === 'object') return entry;
    try { return JSON.parse(entry); } catch (e) { return null; }
  }).filter(Boolean);
  if (!steps.length && !info) return null;
  return { id, info: info || {}, steps };
}
