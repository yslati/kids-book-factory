// Orders from Shopify's "Order creation" webhook (api/shopify-webhook.js),
// turned into the pixel's checkout_completed shape (lib/storefront-events.js)
// so #events, the Orders tab and the daily totals treat them alike. Only
// titles, prices, quantities, discount codes, the landing page's campaign
// tags, the referring site, the order's country and the browser are kept:
// never names, contacts, addresses or line item properties (the child's name).

import { createHmac, timingSafeEqual } from 'node:crypto';
import { normaliseEvent } from './storefront-events.js';
import { SOURCE_PARAMS } from './traffic-source.js';

// The key Shopify signs store webhooks with (Settings → Notifications →
// Webhooks); while it's set, orders come from the webhook and the pixel's are
// ignored.
export function orderWebhookOn() {
  return Boolean(process.env.SHOPIFY_WEBHOOK_SECRET);
}

// Whether X-Shopify-Hmac-Sha256 is the base64 HMAC-SHA256 of the raw body.
export function validSignature(raw, header, secret = process.env.SHOPIFY_WEBHOOK_SECRET) {
  if (!secret || typeof header !== 'string' || !header) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  const given = Buffer.from(header, 'base64');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function landing(order) {
  try {
    return new URL(String(order.landing_site || '/'), 'https://store.invalid');
  } catch (e) {
    return new URL('https://store.invalid/');
  }
}

// { id, test, event, visitor } for an order payload, or null when it isn't one.
export function orderFromWebhook(order) {
  if (!order || typeof order !== 'object' || !order.id) return null;
  const page = landing(order);
  const params = {};
  for (const key of SOURCE_PARAMS) {
    const value = page.searchParams.get(key);
    if (value) params[key] = value;
  }
  const customer = order.customer || {};
  const event = normaliseEvent({
    event: 'checkout_completed',
    clientId: '',
    path: page.pathname,
    params,
    referrer: order.referring_site || '',
    checkout: {
      orderId: order.name || String(order.id),
      firstOrder: typeof customer.orders_count === 'number' ? customer.orders_count <= 1 : null,
      total: { amount: order.total_price, currency: order.currency },
      items: (order.line_items || []).map((item) => ({
        title: item.title,
        variant: item.variant_title,
        quantity: item.quantity,
        price: { amount: item.price, currency: order.currency }
      })),
      discounts: (order.discount_codes || []).map((d) => d && d.code)
    }
  });
  const address = order.shipping_address || order.billing_address || {};
  const client = order.client_details || {};
  return {
    id: String(order.id),
    test: order.test === true,
    event,
    visitor: {
      ip: '',
      country: String(address.country_code || '').toUpperCase(),
      region: '',
      city: '',
      timezone: '',
      language: '',
      userAgent: String(client.user_agent || ''),
      origin: '',
      requestId: ''
    }
  };
}
