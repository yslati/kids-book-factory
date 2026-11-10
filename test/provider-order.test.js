// Which attempts in the model chain run, and what happens when one fails.
// Imports lib/provider-order.js rather than lib/generate.js so the suite runs
// without @fal-ai/client installed, matching the other tests here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { attemptLabel, usableAttempts, runAttempts, FAL_LOW_BALANCE_USD } from '../lib/provider-order.js';

const FLARE_MEDIUM = { provider: 'higgsfield', model: 'marketing-studio/image/flare', quality: 'medium' };
const FLARE_LOW = { provider: 'higgsfield', model: 'marketing-studio/image/flare', quality: 'low' };
const STUDIO_LOW = { provider: 'higgsfield', model: 'marketing-studio/image', quality: 'low' };
const FAL = { provider: 'fal' };
const CHAIN = [FLARE_MEDIUM, FLARE_LOW, STUDIO_LOW, FAL];
const OPTS = { hedgeMs: 28000, minAttemptMs: 15000 };

test('labels name the provider, model and quality that are set', () => {
  assert.equal(attemptLabel(FLARE_MEDIUM), 'higgsfield marketing-studio/image/flare medium');
  assert.equal(attemptLabel(FAL), 'fal');
});

test('keeps chain order and drops providers without credentials', () => {
  assert.deepEqual(usableAttempts(CHAIN, { configured: { higgsfield: true, fal: false } }),
    [FLARE_MEDIUM, FLARE_LOW, STUDIO_LOW]);
  assert.deepEqual(usableAttempts(CHAIN, { configured: { higgsfield: false, fal: true } }), [FAL]);
  assert.deepEqual(usableAttempts(CHAIN, { configured: {} }), []);
});

test('skips fal at or below $0.10, keeps it above or when the balance is unknown', () => {
  const configured = { higgsfield: true, fal: true };
  assert.equal(FAL_LOW_BALANCE_USD, 0.1);
  assert.ok(!usableAttempts(CHAIN, { configured, falBalance: 0.1 }).includes(FAL));
  assert.ok(!usableAttempts(CHAIN, { configured, falBalance: 0 }).includes(FAL));
  assert.ok(usableAttempts(CHAIN, { configured, falBalance: 0.11 }).includes(FAL));
  assert.ok(usableAttempts(CHAIN, { configured, falBalance: null }).includes(FAL));
});

// A fake clock: each run advances it by the attempt's simulated duration.
function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('stops at the first attempt that succeeds', async () => {
  const seen = [];
  const result = await runAttempts([FLARE_MEDIUM, FLARE_LOW], async (attempt) => {
    seen.push(attempt);
    return 'https://cdn.example.com/cover.png';
  }, { ...OPTS, deadline: Date.now() + 50000 });

  assert.deepEqual(seen, [FLARE_MEDIUM]);
  assert.deepEqual(result, { url: 'https://cdn.example.com/cover.png', attempt: FLARE_MEDIUM });
});

test('falls down the chain in order until an attempt succeeds', async () => {
  const seen = [];
  const result = await runAttempts([FLARE_MEDIUM, FLARE_LOW, STUDIO_LOW], async (attempt) => {
    seen.push(attempt);
    if (attempt !== STUDIO_LOW) throw new Error('higgsfield-nsfw');
    return 'https://cdn.example.com/studio.png';
  }, { ...OPTS, deadline: Date.now() + 50000 });

  assert.deepEqual(seen, [FLARE_MEDIUM, FLARE_LOW, STUDIO_LOW]);
  assert.equal(result.attempt, STUDIO_LOW);
});

test('every attempt may run until the deadline', async () => {
  const c = clock();
  const timeouts = [];
  await assert.rejects(runAttempts([FLARE_MEDIUM, FLARE_LOW, STUDIO_LOW], async (attempt, timeoutMs) => {
    timeouts.push(timeoutMs);
    c.advance(1000);
    throw new Error('higgsfield-submit-503');
  }, { ...OPTS, deadline: 50000, now: c.now }), /higgsfield-submit-503/);

  assert.deepEqual(timeouts, [50000, 49000, 48000]);
});

test('a slow attempt keeps running beside the next, and its cover wins if it comes first', async () => {
  const signals = {};
  const started = [];
  const result = await runAttempts([FLARE_MEDIUM, FLARE_LOW], (attempt, timeoutMs, signal) => {
    started.push(attempt);
    signals[attempt.quality] = signal;
    return new Promise((resolve) => setTimeout(resolve, attempt === FLARE_MEDIUM ? 60 : 200, 'https://cdn.example.com/' + attempt.quality + '.png'));
  }, { ...OPTS, hedgeMs: 20, deadline: Date.now() + 50000 });

  assert.deepEqual(started, [FLARE_MEDIUM, FLARE_LOW]);
  assert.equal(result.attempt, FLARE_MEDIUM);
  assert.equal(signals.low.aborted, true, 'the attempt that lost is told to stop');
});

test('the next attempt wins when the slow one is still going', async () => {
  const result = await runAttempts([FLARE_MEDIUM, FLARE_LOW], (attempt) =>
    new Promise((resolve) => setTimeout(resolve, attempt === FLARE_MEDIUM ? 300 : 20, attempt.quality)),
  { ...OPTS, hedgeMs: 20, deadline: Date.now() + 50000 });

  assert.equal(result.attempt, FLARE_LOW);
});

test('does not start an attempt that could not finish in time', async () => {
  const c = clock();
  const seen = [];
  await assert.rejects(
    runAttempts([FLARE_MEDIUM, FLARE_LOW, STUDIO_LOW], async (attempt) => {
      seen.push(attempt);
      c.advance(40000);
      throw new Error('higgsfield-timeout');
    }, { ...OPTS, deadline: 50000, now: c.now }),
    /higgsfield-timeout/
  );
  // 40s for the first leaves 10s, under the 15s minimum.
  assert.deepEqual(seen, [FLARE_MEDIUM]);
});

test('fails with the last error once every attempt has failed', async () => {
  const result = runAttempts([FLARE_MEDIUM, FLARE_LOW], (attempt) =>
    new Promise((resolve, reject) => setTimeout(reject, attempt === FLARE_MEDIUM ? 80 : 30, new Error(attempt.quality + '-failed'))),
  { ...OPTS, hedgeMs: 20, deadline: Date.now() + 50000 });

  await assert.rejects(result, /medium-failed/);
});

test('reports running out of time when even the first attempt cannot start', async () => {
  await assert.rejects(
    runAttempts([FLARE_MEDIUM], async () => 'never', { ...OPTS, deadline: 10000, now: () => 0 }),
    /generation-out-of-time/
  );
});

test('throws when there is nothing to try', async () => {
  await assert.rejects(
    runAttempts([], async () => 'never', { ...OPTS, deadline: Date.now() + 50000 }),
    /no-provider-configured/
  );
});
