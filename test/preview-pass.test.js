// One-time preview passes, against an in-memory stand-in for Upstash.
// Imports lib/preview-pass.js rather than lib/redis.js so the suite runs
// without @upstash/redis installed, matching the other tests here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { grantPreviewPass, redeemPreviewPass } from '../lib/preview-pass.js';

const GENERATION = 'k3x9p2m7q1';

// Just the two commands passes use, with Redis semantics: GETDEL returns the
// value (null when absent) and removes it in the same step.
function fakeRedis() {
  const store = new Map();
  return {
    store,
    async set(key, value, opts) {
      store.set(key, { value, opts });
      return 'OK';
    },
    async getdel(key) {
      if (!store.has(key)) return null;
      const { value } = store.get(key);
      store.delete(key);
      return value;
    }
  };
}

function failingRedis() {
  const fail = async () => { throw new Error('connection reset'); };
  return { set: fail, getdel: fail };
}

test('a granted pass redeems exactly once', async () => {
  const redis = fakeRedis();
  assert.equal(await grantPreviewPass(redis, GENERATION), true);
  assert.equal(await redeemPreviewPass(redis, GENERATION), true);
  assert.equal(await redeemPreviewPass(redis, GENERATION), false);
});

test('concurrent redemptions of one pass let exactly one through', async () => {
  const redis = fakeRedis();
  await grantPreviewPass(redis, GENERATION);
  const results = await Promise.all([
    redeemPreviewPass(redis, GENERATION),
    redeemPreviewPass(redis, GENERATION)
  ]);
  assert.deepEqual(results.sort(), [false, true]);
});

test('a pass only covers the generation it was granted for', async () => {
  const redis = fakeRedis();
  await grantPreviewPass(redis, GENERATION);
  assert.equal(await redeemPreviewPass(redis, 'aaaaaaaaaa'), false);
  assert.equal(await redeemPreviewPass(redis, GENERATION), true);
});

test('a pass is stored with an expiry', async () => {
  const redis = fakeRedis();
  await grantPreviewPass(redis, GENERATION);
  const [{ opts }] = redis.store.values();
  assert.ok(opts.ex > 0);
});

test('without Redis nothing is granted or redeemed', async () => {
  assert.equal(await grantPreviewPass(null, GENERATION), false);
  assert.equal(await redeemPreviewPass(null, GENERATION), false);
});

test('a Redis error fails closed instead of throwing', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  assert.equal(await grantPreviewPass(failingRedis(), GENERATION), false);
  assert.equal(await redeemPreviewPass(failingRedis(), GENERATION), false);
  assert.equal(logged.mock.callCount(), 2);
});
