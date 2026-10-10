// fal balance lookup, against a stubbed fetch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { falBalance, resetFalBalanceCache } from '../lib/fal-balance.js';

function stubFetch(t, handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

function withBillingKey(t, value) {
  const original = process.env.FAL_BILLING_KEY;
  if (value === undefined) delete process.env.FAL_BILLING_KEY;
  else process.env.FAL_BILLING_KEY = value;
  resetFalBalanceCache();
  t.after(() => {
    if (original === undefined) delete process.env.FAL_BILLING_KEY;
    else process.env.FAL_BILLING_KEY = original;
    resetFalBalanceCache();
  });
}

test('unknown (null) without a billing key, and never calls fal', async (t) => {
  withBillingKey(t, undefined);
  const calls = stubFetch(t, () => { throw new Error('should not fetch'); });
  assert.equal(await falBalance(), null);
  assert.equal(calls.length, 0);
});

test('reads credits.current_balance and caches it', async (t) => {
  withBillingKey(t, 'billing-key');
  const calls = stubFetch(t, () => new Response(JSON.stringify({
    username: 'kids-book',
    credits: { current_balance: 0.07, currency: 'USD' }
  }), { status: 200 }));

  assert.equal(await falBalance(), 0.07);
  assert.equal(await falBalance(), 0.07);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.fal.ai/v1/account/billing?expand=credits');
  assert.equal(calls[0].init.headers.Authorization, 'Key billing-key');
});

test('a key without billing permission (403) reads as unknown', async (t) => {
  withBillingKey(t, 'inference-only-key');
  stubFetch(t, () => new Response(JSON.stringify({
    error: { type: 'authorization_error', message: 'This API key is not permitted to perform this action.' }
  }), { status: 403 }));
  assert.equal(await falBalance(), null);
});

test('a network failure reads as unknown', async (t) => {
  withBillingKey(t, 'billing-key');
  stubFetch(t, () => { throw new TypeError('fetch failed'); });
  assert.equal(await falBalance(), null);
});
