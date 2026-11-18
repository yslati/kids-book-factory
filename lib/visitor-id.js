// The short Visitor ID ("V-3f9a2c1d") every Discord card and sheet row shows,
// so one person's visits, previews, carts and errors can be tied together
// (and looked up with /btk customer, lib/btk-commands.js).
//
// It comes from Shopify's visitor id: the pixel's clientId, or the same value
// the storefront sends as `visitor` (ShopifyAnalytics uniqToken) when the
// visitor allows analytics. Without it, the IP and user agent of that UTC day
// stand in, like the cookieless id in lib/event-stats.js. Either way it is a
// keyed hash, so the raw id never reaches Discord or the sheet.

import { createHmac } from 'node:crypto';

const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;
export const VISITOR_ID_PATTERN = /^V-[0-9a-f]{8}$/;

// Shopify's id as sent, or '' when missing or malformed.
export function visitorKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  return KEY_PATTERN.test(key) ? key : '';
}

// '' when nothing identifies the visitor or no secret is set.
export function visitorId({ key = '', ip = '', userAgent = '' } = {}, now = new Date()) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return '';
  let source = '';
  if (visitorKey(key)) source = 'shopify|' + key;
  else if (ip && ip !== 'unknown') source = 'anon|' + now.toISOString().slice(0, 10) + '|' + ip + '|' + userAgent;
  if (!source) return '';
  return 'V-' + createHmac('sha256', secret).update('visitor-id|' + source).digest('hex').slice(0, 8);
}

// "v-3F9A2C1D " or "`V-3f9a2c1d`" as typed → "V-3f9a2c1d", else ''.
export function parseVisitorId(text) {
  const id = String(text || '').replace(/[`\s]/g, '');
  const normal = id.length === 10 ? 'V-' + id.slice(2).toLowerCase() : '';
  return VISITOR_ID_PATTERN.test(normal) && /^v-/i.test(id) ? normal : '';
}
