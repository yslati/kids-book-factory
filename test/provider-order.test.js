// Which provider generates a cover, and what happens when one fails. Imports
// lib/provider-order.js rather than lib/generate.js so the suite runs without
// @fal-ai/client installed, matching the other tests here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { providerOrder, generateWithFallback, FAL_LOW_BALANCE_USD } from '../lib/provider-order.js';

const BOTH = { falReady: true, higgsfieldReady: true };

test('fal goes first when its balance is unknown or above the threshold', () => {
  assert.deepEqual(providerOrder({ ...BOTH, balance: null }), ['fal', 'higgsfield']);
  assert.deepEqual(providerOrder({ ...BOTH, balance: 0.11 }), ['fal', 'higgsfield']);
  assert.deepEqual(providerOrder({ ...BOTH, balance: 25 }), ['fal', 'higgsfield']);
});

test('Higgsfield goes first when fal is at or below $0.10', () => {
  assert.equal(FAL_LOW_BALANCE_USD, 0.1);
  assert.deepEqual(providerOrder({ ...BOTH, balance: 0.1 }), ['higgsfield', 'fal']);
  assert.deepEqual(providerOrder({ ...BOTH, balance: 0.04 }), ['higgsfield', 'fal']);
  assert.deepEqual(providerOrder({ ...BOTH, balance: 0 }), ['higgsfield', 'fal']);
});

test('only configured providers are used', () => {
  assert.deepEqual(providerOrder({ falReady: true, higgsfieldReady: false, balance: 0 }), ['fal']);
  assert.deepEqual(providerOrder({ falReady: false, higgsfieldReady: true, balance: null }), ['higgsfield']);
  assert.deepEqual(providerOrder({ falReady: false, higgsfieldReady: false, balance: null }), []);
});

// A fake clock: each run advances it by the attempt's simulated duration.
function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('falls back to the second provider when the first fails', async () => {
  const c = clock();
  const calls = [];
  const result = await generateWithFallback(['fal', 'higgsfield'], async (provider) => {
    calls.push(provider);
    c.advance(1000);
    if (provider === 'fal') throw new Error('fal-locked');
    return 'https://cdn.example.com/cover.png';
  }, { deadline: 50000, firstAttemptMs: 30000, now: c.now });

  assert.deepEqual(calls, ['fal', 'higgsfield']);
  assert.deepEqual(result, { url: 'https://cdn.example.com/cover.png', provider: 'higgsfield' });
});

test('stops at the first provider that succeeds', async () => {
  const calls = [];
  const result = await generateWithFallback(['higgsfield', 'fal'], async (provider) => {
    calls.push(provider);
    return 'https://cdn.example.com/' + provider + '.png';
  }, { deadline: Date.now() + 50000, firstAttemptMs: 30000 });

  assert.deepEqual(calls, ['higgsfield']);
  assert.equal(result.provider, 'higgsfield');
});

test('caps the first attempt only when a different provider is waiting', async () => {
  const timeouts = [];
  await assert.rejects(generateWithFallback(['fal', 'higgsfield'], async (provider, timeoutMs) => {
    timeouts.push(timeoutMs);
    throw new Error('down');
  }, { deadline: 50000, firstAttemptMs: 30000, now: () => 0 }));
  // First capped at 30s; the backup gets everything left.
  assert.deepEqual(timeouts, [30000, 50000]);
});

test('a lone provider gets one retry, uncapped, like before the fallback', async () => {
  const c = clock();
  const seen = [];
  const result = await generateWithFallback(['fal'], async (provider, timeoutMs) => {
    seen.push([provider, timeoutMs]);
    c.advance(10000);
    if (seen.length === 1) throw new Error('transient');
    return 'https://cdn.example.com/retry.jpg';
  }, { deadline: 50000, firstAttemptMs: 30000, now: c.now });

  assert.deepEqual(seen, [['fal', 50000], ['fal', 40000]]);
  assert.equal(result.url, 'https://cdn.example.com/retry.jpg');
});

test('skips the backup when too little time is left, and throws the real error', async () => {
  const c = clock();
  const calls = [];
  await assert.rejects(
    generateWithFallback(['fal', 'higgsfield'], async (provider) => {
      calls.push(provider);
      c.advance(48000);
      throw new Error('fal-timeout');
    }, { deadline: 50000, firstAttemptMs: 30000, now: c.now }),
    /fal-timeout/
  );
  assert.deepEqual(calls, ['fal']);
});

test('throws when no provider is configured', async () => {
  await assert.rejects(
    generateWithFallback([], async () => 'never', { deadline: Date.now() + 50000, firstAttemptMs: 30000 }),
    /no-provider-configured/
  );
});
