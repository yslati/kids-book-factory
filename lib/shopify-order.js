// Orders from Shopify's "Order creation" webhook (api/shopify-webhook.js),
// turned into the pixel's checkout_completed shape (lib/storefront-events.js)
// so #events, the Orders tab and the daily totals treat them alike. The event
// keeps only titles, prices, quantities, discount codes, the landing page's
// campaign tags, the referring site, the order's country and the browser:
// never names, contacts, addresses or line item properties (the child's name).
// The buyer's name and email are kept apart, for the private sheet only.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { adminGraphQL, shopifyConfigured } from './shopify.js';
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

const ORDER_COUNT = `
  query CustomerOrderCount($id: ID!) {
    customer(id: $id) { numberOfOrders }
  }`;

// Whether this is the customer's first order, from their order count in
// Shopify (which includes the new order); null when it can't be told. Newer
// webhook payloads leave orders_count out, so the count is asked for here.
export async function isFirstOrder(customerId, query = adminGraphQL) {
  if (!/^\d{1,20}$/.test(String(customerId || '')) || !shopifyConfigured()) return null;
  try {
    const data = await query(ORDER_COUNT, { id: 'gid://shopify/Customer/' + customerId });
    const count = Number(data && data.customer && data.customer.numberOfOrders);
    return Number.isFinite(count) && count > 0 ? count <= 1 : null;
  } catch (e) {
    console.error('[shopify-order] order count for customer ' + customerId + ' failed:', (e && e.message) || e);
    return null;
  }
}

function landing(order) {
  try {
    return new URL(String(order.landing_site || '/'), 'https://store.invalid');
  } catch (e) {
    return new URL('https://store.invalid/');
  }
}

function buyerName(order, customer) {
  const named = [customer.first_name, customer.last_name].filter(Boolean).join(' ');
  const address = order.billing_address || order.shipping_address || {};
  return String(named || address.name || '').trim();
}

// { id, test, event, visitor, buyer } for an order payload, or null when it isn't one.
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
    customerId: /^\d{1,20}$/.test(String(customer.id || '')) ? String(customer.id) : '',
    test: order.test === true,
    buyer: {
      name: buyerName(order, customer),
      email: String(order.email || order.contact_email || customer.email || '').trim()
    },
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
