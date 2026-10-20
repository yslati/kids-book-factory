// POST /api/events
// Storefront analytics from the Shopify custom pixel (pixel/custom-pixel.js):
// page, product and collection views, searches, cart and checkout steps, and
// orders. Counts them for the daily summary (lib/event-stats.js) and posts
// visits, add-to-carts, checkouts and orders to #events (lib/event-feed.js).
//
// Body: text/plain JSON, shaped as lib/storefront-events.js describes → 204,
// sent before any counting or posting, which run after the response.
//
// The pixel runs in Shopify's sandbox, so the origin isn't checked: payloads
// are validated, and each IP is capped per instance. Not wrapped in
// withReporting, so junk requests can't flood #logs.

import { waitUntil } from '@vercel/functions';
import { applyCors } from '../lib/cors.js';
import { getRedis } from '../lib/redis.js';
import { visitorOf } from '../lib/discord.js';
import { normaliseEvent } from '../lib/storefront-events.js';
import { recordEvent } from '../lib/event-stats.js';
import { postLiveEvent } from '../lib/event-feed.js';

// A visitor sends a few events per page; this only stops a flood.
const LIMIT_WINDOW_MS = 10 * 60 * 1000;
const LIMIT_EVENTS = 300;
const recent = new Map();

// The storefront's own domains, whose referrals aren't a traffic source.
const OWN_HOSTS = (process.env.ALLOWED_ORIGIN || '').split(',').map((origin) => {
  try { return new URL(origin.trim()).hostname; } catch (e) { return ''; }
}).filter(Boolean);

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
  try {
    const recorded = await recordEvent(getRedis(), event, { country: visitor.country, ownHosts: OWN_HOSTS });
    await postLiveEvent(event, recorded, visitor);
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
