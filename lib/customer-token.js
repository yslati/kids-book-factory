// Verifies the logged-in-customer token the theme mints in Liquid.
//
// The theme signs "{customer_id}:{YYYY-MM-DD}" (UTC date) with a shared secret
// using Liquid's `hmac_sha256` filter and posts { customer_id, token_date,
// customer_token } alongside the normal request body. Only the digest ever
// reaches the DOM, so a visitor cannot mint a token for someone else's id -
// which is what lets us raise the rate limit for verified customers.
//
// If PREVIEW_TOKEN_SECRET is unset the feature is simply off: every token is
// invalid and everyone falls through to the anonymous per-IP tier.

import { createHmac, timingSafeEqual } from 'node:crypto';

// Liquid's hmac_sha256 emits a lowercase hex digest.
function sign(message, secret) {
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

// Constant-time compare that also tolerates length mismatches (timingSafeEqual
// throws when the buffers differ in length).
function digestsMatch(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function utcDateString(date) {
  return (date || new Date()).toISOString().slice(0, 10);
}

// Yesterday, today and tomorrow in UTC.
//
// Two things blur the date. The theme renders it when the page is served, so a
// shopper who loads just before midnight (or leaves the tab open) presents a
// date that has since rolled over. And Shopify's `date` filter emits the SHOP's
// local date, which for a shop ahead of UTC can already read as UTC-tomorrow.
// A one-day window either side absorbs both without meaningfully weakening the
// token - it is still bound to a specific customer and a specific day.
function acceptableDates(now) {
  const today = now || new Date();
  const DAY = 24 * 60 * 60 * 1000;
  return [
    utcDateString(new Date(today.getTime() - DAY)),
    utcDateString(today),
    utcDateString(new Date(today.getTime() + DAY))
  ];
}

// Returns { valid, customerId }. `customerId` is only set when valid, so
// callers can use it directly as a rate-limit key without re-checking.
export function verifyCustomerToken(body, now) {
  const secret = process.env.PREVIEW_TOKEN_SECRET;
  if (!secret) return { valid: false, customerId: null };

  const src = body || {};
  const customerId = String(src.customer_id || '').trim();
  const tokenDate = String(src.token_date || '').trim();
  const token = String(src.customer_token || '').trim().toLowerCase();

  if (!customerId || !tokenDate || !token) return { valid: false, customerId: null };
  // Shopify customer ids are numeric; reject anything else before we hash it.
  if (!/^\d+$/.test(customerId)) return { valid: false, customerId: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tokenDate)) return { valid: false, customerId: null };
  if (!/^[a-f0-9]{64}$/.test(token)) return { valid: false, customerId: null };

  if (acceptableDates(now).indexOf(tokenDate) === -1) {
    return { valid: false, customerId: null };
  }

  const expected = sign(customerId + ':' + tokenDate, secret);
  if (!digestsMatch(expected, token)) return { valid: false, customerId: null };

  return { valid: true, customerId };
}

export function customerTokensEnabled() {
  return Boolean(process.env.PREVIEW_TOKEN_SECRET);
}
