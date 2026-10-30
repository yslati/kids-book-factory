// POST /api/events
// Storefront analytics from the Shopify custom pixel (pixel/custom-pixel.js):
// page, product and collection views, searches, cart and checkout steps, and
// orders, from every visitor: those without analytics consent come without a
// client id and get a cookieless one. Counts them for the daily summary
// (lib/event-stats.js), posts visits to #visits and add-to-carts, checkouts
// and orders to #events (lib/event-feed.js) and adds them to the requests
// sheet (lib/sheet.js).
//
// Body: text/plain JSON, shaped as lib/storefront-events.js describes → 204,
// sent before any counting or posting, which run after the response.
//
// The pixel runs in Shopify's sandbox, so the origin isn't checked: payloads
// are validated, and each IP is capped per instance. Not wrapped in
// withReporting, so junk requests can't flood #logs.

import { waitUntil } from '@vercel/functions';
import { allowedHosts, applyCors } from '../lib/cors.js';
import { getRedis } from '../lib/redis.js';
import { visitorOf } from '../lib/discord.js';
import { normaliseEvent } from '../lib/storefront-events.js';
import { cookielessId, recordEvent } from '../lib/event-stats.js';
import { postLiveEvent } from '../lib/event-feed.js';
import { appendRows, storefrontRows } from '../lib/sheet.js';
import { orderWebhookOn } from '../lib/shopify-order.js';

// A visitor sends a few events per page; this only stops a flood.
const LIMIT_WINDOW_MS = 10 * 60 * 1000;
const LIMIT_EVENTS = 300;
const recent = new Map();

const OWN_HOSTS = allowedHosts();

function overLimit(ip) {
  const now = Date.now();
  const entry = recent.get(ip);
  if (!entry || now >= entry.resetAt) {
    if (recent.size > 10000) {
      for (const [key, value] of recent) if (now >= value.resetAt) recent.delete(key);
    }
    recent.set(ip, { count: 1, resetAt: now + LIMIT_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > LIMIT_EVENTS;
}

async function record(event, visitor) {
  // Shopify's order webhook (api/shopify-webhook.js) reports every order,
  // signed; the pixel's can be missed or faked.
  if (event.name === 'checkout_completed' && orderWebhookOn()) return;
  try {
    const redis = getRedis();
    if (!event.consented) event.clientId = await cookielessId(redis, visitor);
    const recorded = event.clientId ? await recordEvent(redis, event, { country: visitor.country, ownHosts: OWN_HOSTS }) : null;
    const sheet = storefrontRows(event, recorded, visitor);
    await Promise.all([
      postLiveEvent(event, recorded, visitor),
      sheet && appendRows(sheet.tab, sheet.rows)
    ]);
  } catch (e) {
    console.error('[events] ' + event.name + ' failed:', (e && e.stack) || e);
  }
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  const event = normaliseEvent(body);
  if (!event) return res.status(400).json({ error: 'bad-event' });

  const visitor = visitorOf(req);
  if (overLimit(visitor.ip)) return res.status(429).json({ error: 'rate-limited' });

  res.status(204).end();
  waitUntil(record(event, visitor));
}
