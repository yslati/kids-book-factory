// The shared generation allowance (chargeGeneration), with Upstash replaced
// by in-memory windows.

import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, chargeGeneration, minRemaining } from '../lib/ratelimit.js';

// checkRateLimit stand-in: a counter per bucket+key, sized like LIMITS.
function windows() {
  const used = new Map();
  const calls = [];
  const check = async (req, bucket, identifier) => {
    const key = bucket + ':' + (identifier || req.ip);
    calls.push(key);
    const n = used.get(key) || 0;
    const limit = LIMITS[bucket].tokens;
    if (n >= limit) return { success: false, remaining: 0 };
    used.set(key, n + 1);
    return { success: true, remaining: limit - n - 1 };
  };
  return { check, calls };
}

const guest = { valid: false };
const signedIn = { valid: true, customerId: '42' };

async function spend(times, req, customer, check) {
  const out = [];
  for (let i = 0; i < times; i++) out.push((await chargeGeneration(req, customer, { check })).success);
  return out;
}

test('the allowance is 4 a day, 2 more once signed in, and 2 custom stories', () => {
  assert.equal(LIMITS.preview.tokens, 4);
  assert.equal(LIMITS['preview-bonus'].tokens, 2);
  assert.equal(LIMITS.custom.tokens, 2);
  assert.equal(LIMITS['custom-cust'].tokens, 2);
  assert.equal(LIMITS['preview-cust'], undefined);
});

test('a guest gets 4 generations, previews and fixes alike', async () => {
  const { check } = windows();
  assert.deepEqual(await spend(5, { ip: '1.1.1.1' }, guest, check), [true, true, true, true, false]);
});

test('signing in after the 4 adds 2, not a fresh allowance', async () => {
  const { check } = windows();
  const req = { ip: '1.1.1.1' };
  await spend(4, req, guest, check);
  assert.deepEqual(await spend(3, req, signedIn, check), [true, true, false]);
});

test('a signed-in parent spends the shared 4 first, then their own 2', async () => {
  const { check, calls } = windows();
  const req = { ip: '2.2.2.2' };
  assert.deepEqual(await spend(7, req, signedIn, check), [true, true, true, true, true, true, false]);
  // The bonus window is only touched once the IP window is spent.
  assert.ok(!calls.slice(0, 8).some((k) => k.startsWith('preview-bonus')));
});

test('the per-IP backstop stops throwaway accounts on one machine', async () => {
  const { check } = windows();
  const req = { ip: '3.3.3.3' };
  let granted = 0;
  for (let id = 1; id <= 5; id++) {
    for (const ok of await spend(6, req, { valid: true, customerId: String(id) }, check)) if (ok) granted++;
  }
  // 4 shared + 2 per account, until the backstop's 10 runs out (it is also
  // charged by refused attempts, so a little under 10).
  assert.ok(granted <= LIMITS['preview-ip-cap'].tokens, `granted ${granted}`);
  assert.ok(granted >= 6);
});

test('with limiting off every generation is allowed and remaining is null', async () => {
  const off = async () => ({ success: true, remaining: null });
  assert.deepEqual(await chargeGeneration({}, guest, { check: off }), { success: true, remaining: null });
});

test('minRemaining compares only real numbers', () => {
  assert.equal(minRemaining(3, 7), 3);
  assert.equal(minRemaining(null, 7), 7);
  assert.equal(minRemaining(3, null), 3);
  assert.equal(minRemaining(null, null), null);
});

test('gifted previews are used only once the free ones are spent', async () => {
  const { check } = windows();
  let gifts = 2;
  const takeGift = async () => (gifts > 0 ? --gifts : -1);
  const req = { ip: '1.2.3.4' };
  const out = [];
  for (let i = 0; i < 7; i++) out.push(await chargeGeneration(req, guest, { check, takeGift }));
  assert.deepEqual(out.map((r) => r.success), [true, true, true, true, true, true, false]);
  assert.deepEqual(out.slice(4, 6).map((r) => r.remaining), [1, 0]);
  assert.equal(gifts, 0);
});

test('a gift adds up to the cap and lasts a day', async () => {
  const { giftPreviews, MAX_GIFT } = await import('../lib/ratelimit.js');
  const store = new Map();
  const ttl = new Map();
  const redis = {
    incrby: async (k, n) => { store.set(k, (store.get(k) || 0) + n); return store.get(k); },
    set: async (k, v, o) => { store.set(k, v); ttl.set(k, o.ex); },
    expire: async (k, s) => { ttl.set(k, s); }
  };
  assert.equal(await giftPreviews('1.2.3.4', 3, redis), 3);
  assert.equal(ttl.get('kbf:gift:1.2.3.4'), 86400);
  assert.equal(await giftPreviews('1.2.3.4', 30, redis), MAX_GIFT);
  await assert.rejects(giftPreviews('unknown', 1, redis));
});
