import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { verifyCustomerToken, utcDateString, customerTokensEnabled } from '../lib/customer-token.js';

const SECRET = 'test-shared-secret';

// Mirrors what the theme's Liquid `hmac_sha256` filter produces.
function signAs(customerId, date, secret) {
  return createHmac('sha256', secret || SECRET)
    .update(customerId + ':' + date, 'utf8')
    .digest('hex');
}

function tokenFor(customerId, date, secret) {
  return { customer_id: customerId, token_date: date, customer_token: signAs(customerId, date, secret) };
}

function withSecret(secret, fn) {
  const prev = process.env.PREVIEW_TOKEN_SECRET;
  if (secret === null) delete process.env.PREVIEW_TOKEN_SECRET;
  else process.env.PREVIEW_TOKEN_SECRET = secret;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PREVIEW_TOKEN_SECRET;
    else process.env.PREVIEW_TOKEN_SECRET = prev;
  }
}

function daysAgo(n) {
  return utcDateString(new Date(Date.now() - n * 24 * 60 * 60 * 1000));
}

test('accepts a token signed with the shared secret for today', () => {
  withSecret(SECRET, () => {
    const result = verifyCustomerToken(tokenFor('7712345', daysAgo(0)));
    assert.deepEqual(result, { valid: true, customerId: '7712345' });
  });
});

test('accepts one day either side to absorb timezone edges', () => {
  withSecret(SECRET, () => {
    // Yesterday: page rendered before midnight rolled over.
    assert.equal(verifyCustomerToken(tokenFor('7712345', daysAgo(1))).valid, true);
    // Tomorrow: shop timezone runs ahead of UTC.
    assert.equal(verifyCustomerToken(tokenFor('7712345', daysAgo(-1))).valid, true);
  });
});

test('rejects dates beyond the one-day tolerance', () => {
  withSecret(SECRET, () => {
    assert.equal(verifyCustomerToken(tokenFor('7712345', daysAgo(2))).valid, false);
    assert.equal(verifyCustomerToken(tokenFor('7712345', daysAgo(-2))).valid, false);
  });
});

test('rejects a token signed with the wrong secret', () => {
  withSecret(SECRET, () => {
    const forged = tokenFor('7712345', daysAgo(0), 'not-the-real-secret');
    assert.deepEqual(verifyCustomerToken(forged), { valid: false, customerId: null });
  });
});

test('rejects a valid signature replayed against a different customer id', () => {
  withSecret(SECRET, () => {
    const stolen = tokenFor('7712345', daysAgo(0));
    stolen.customer_id = '9999999';
    assert.equal(verifyCustomerToken(stolen).valid, false);
  });
});

test('rejects malformed payloads without throwing', () => {
  withSecret(SECRET, () => {
    const today = daysAgo(0);
    const bad = [
      undefined,
      {},
      { customer_id: '7712345' },
      { customer_id: '7712345', token_date: today },
      { customer_id: '', token_date: today, customer_token: signAs('', today) },
      // non-numeric id
      { customer_id: 'abc', token_date: today, customer_token: signAs('abc', today) },
      // malformed date
      { customer_id: '7712345', token_date: '2026/08/30', customer_token: signAs('7712345', '2026/08/30') },
      // digest that isn't 64 hex chars
      { customer_id: '7712345', token_date: today, customer_token: 'deadbeef' },
      { customer_id: '7712345', token_date: today, customer_token: 'z'.repeat(64) }
    ];
    for (const body of bad) {
      assert.deepEqual(verifyCustomerToken(body), { valid: false, customerId: null });
    }
  });
});

test('treats every token as invalid when the secret is unset (feature off)', () => {
  const valid = withSecret(SECRET, () => tokenFor('7712345', daysAgo(0)));
  withSecret(null, () => {
    assert.equal(customerTokensEnabled(), false);
    assert.deepEqual(verifyCustomerToken(valid), { valid: false, customerId: null });
  });
});

test('accepts an uppercase digest (hex case is not significant)', () => {
  withSecret(SECRET, () => {
    const t = tokenFor('7712345', daysAgo(0));
    t.customer_token = t.customer_token.toUpperCase();
    assert.equal(verifyCustomerToken(t).valid, true);
  });
});
