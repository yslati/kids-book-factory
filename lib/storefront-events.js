// Validates analytics events from the Shopify custom pixel
// (pixel/custom-pixel.js). Only whitelisted fields survive: never customer
// details, never line item properties (they carry the child's name), and no
// query strings or referrer paths, which can too.

import { SOURCE_PARAMS } from './traffic-source.js';

export const EVENT_NAMES = [
  'page_viewed',
  'product_viewed',
  'collection_viewed',
  'search_submitted',
  'cart_viewed',
  'product_added_to_cart',
  'checkout_started',
  'checkout_completed'
];

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function whole(value, min, max) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

function money(value) {
  if (!value || typeof value !== 'object') return null;
  const amount = Number(value.amount);
  const currency = text(value.currency, 10).toUpperCase();
  if (!Number.isFinite(amount) || amount < 0 || !/^[A-Z]{3}$/.test(currency)) return null;
  return { amount: Math.round(amount * 100) / 100, currency };
}

// A page's path without its query, with token-like segments (checkout and
// cart tokens, ids) replaced by ":id" so they aren't stored or posted.
export function pagePath(path) {
  const clean = text(path, 500).split(/[?#]/)[0];
  if (!clean.startsWith('/')) return '/';
  const token = (s) => (s.length >= 20 && /\d/.test(s) && !s.includes('-')) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s);
  return clean.split('/').map((s) => (token(s) ? ':id' : s)).join('/').slice(0, 120);
}

function referrerOrigin(referrer) {
  try {
    return new URL(text(referrer, 500)).origin;
  } catch (e) {
    return '';
  }
}

function product(raw) {
  return {
    title: text(raw.title, 120),
    variant: text(raw.variant, 80),
    price: money(raw.price),
    quantity: whole(raw.quantity, 1, 99),
    total: money(raw.total)
  };
}

function checkout(raw) {
  const items = Array.isArray(raw.items) ? raw.items : [];
  const discounts = Array.isArray(raw.discounts) ? raw.discounts : [];
  return {
    orderId: text(raw.orderId, 80).split('/').pop(),
    firstOrder: typeof raw.firstOrder === 'boolean' ? raw.firstOrder : null,
    total: money(raw.total),
    items: items.slice(0, 20)
      .filter((i) => i && typeof i === 'object')
      .map((i) => ({ title: text(i.title, 120), variant: text(i.variant, 80), quantity: whole(i.quantity, 1, 99), price: money(i.price) }))
      .filter((i) => i.title),
    discounts: discounts.slice(0, 5).map((d) => text(d, 40)).filter(Boolean)
  };
}

// Returns the event in a fixed shape, or null when unusable. Shopify still
// runs the pixel for visitors who haven't allowed analytics cookies (declined,
// or never answered the EEA/UK banner), but without a client id: those events
// come with consented false and an empty clientId.
export function normaliseEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = text(raw.event, 40);
  const clientId = text(raw.clientId, 100);
  if (!EVENT_NAMES.includes(name)) return null;

  const params = {};
  if (raw.params && typeof raw.params === 'object') {
    for (const key of SOURCE_PARAMS) {
      const value = text(raw.params[key], 100);
      if (value) params[key] = value;
    }
  }

  const event = { name, clientId, consented: Boolean(clientId), path: pagePath(raw.path), params, referrer: referrerOrigin(raw.referrer) };
  if ((name === 'product_viewed' || name === 'product_added_to_cart') && raw.product && typeof raw.product === 'object') {
    event.product = product(raw.product);
  }
  if ((name === 'checkout_started' || name === 'checkout_completed') && raw.checkout && typeof raw.checkout === 'object') {
    event.checkout = checkout(raw.checkout);
  }
  return event;
}
