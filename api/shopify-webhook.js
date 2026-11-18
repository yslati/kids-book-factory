// POST /api/shopify-webhook
// Shopify's "Order creation" store webhook (Settings → Notifications →
// Webhooks, JSON): every order, whatever the buyer's browser blocked or
// consented to. Posts it to #events, adds it to the Orders tab and counts it
// in the daily totals, once per order (lib/shopify-order.js).
//
// Signed with SHOPIFY_WEBHOOK_SECRET over the raw body → 401 when the
// signature doesn't match, else 200 before any posting, which Shopify needs
// within 5 s. Test orders and repeat deliveries are left out.

import { waitUntil } from '@vercel/functions';
import { allowedHosts } from '../lib/cors.js';
import { getRedis } from '../lib/redis.js';
import { readJourney, recordOrder } from '../lib/event-stats.js';
import { postLiveEvent } from '../lib/event-feed.js';
import { appendRows, storefrontRows } from '../lib/sheet.js';
import { orderFromWebhook, validSignature } from '../lib/shopify-order.js';
import { trafficSource } from '../lib/traffic-source.js';
import { rawBody } from '../lib/raw-body.js';
import { Step, addStep, linkOrder } from '../lib/visitor-log.js';

// The signature covers the exact bytes Shopify sent (lib/raw-body.js).
export const config = { api: { bodyParser: false } };

const OWN_HOSTS = allowedHosts();

async function record(order, requestId) {
  try {
    const { event } = order;
    const source = trafficSource({ params: event.params, referrer: event.referrer, ownHosts: OWN_HOSTS });
    const redis = getRedis();
    const counted = await recordOrder(redis, order.id, event, source);
    if (counted === false) return;
    const journey = await readJourney(redis, order.id);
    const visitor = { ...order.visitor, requestId, id: (journey && journey.visitorId) || '' };
    if (visitor.id) {
      const { orderId, total } = event.checkout;
      await Promise.all([
        linkOrder(redis, visitor.id, [orderId, order.id]),
        addStep(redis, visitor.id, { kind: Step.order, text: orderId + (total ? ' · ' + total.amount + ' ' + total.currency : '') })
      ]);
    }
    const recorded = { visit: null, source, journey };
    const sheet = storefrontRows(event, recorded, visitor);
    await Promise.all([
      postLiveEvent(event, recorded, visitor),
      sheet && appendRows(sheet.tab, sheet.rows)
    ]);
  } catch (e) {
    console.error('[shopify-webhook] order ' + order.id + ' failed:', (e && e.stack) || e);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed' });
  const raw = await rawBody(req);
  if (!validSignature(raw, req.headers['x-shopify-hmac-sha256'])) return res.status(401).json({ error: 'bad-signature' });

  let order = null;
  try { order = orderFromWebhook(JSON.parse(raw.toString('utf8'))); } catch (e) { order = null; }
  res.status(200).end();
  if (!order || req.headers['x-shopify-topic'] !== 'orders/create') return;
  if (order.test) {
    console.log('[shopify-webhook] test order ' + order.event.checkout.orderId + ' left out');
    return;
  }
  waitUntil(record(order, req.headers['x-vercel-id'] || ''));
}
