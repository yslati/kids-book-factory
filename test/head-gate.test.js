// The head-size gate: one retry when the painted head is far bigger than the
// hero's, the better cover kept, and no failure ever losing a cover.

import test from 'node:test';
import assert from 'node:assert/strict';
import { HEAD_RETRY_RATIO, withHeadGate } from '../lib/head-gate.js';

// A measure stub fed from a list of ratios, one per generated cover.
function measuring(ratios) {
  const seen = [];
  return {
    seen,
    measure: async (coverUrl, url) => {
      seen.push(url);
      return ratios[seen.length - 1];
    }
  };
}

function maker() {
  let n = 0;
  const generate = async () => ({ url: 'cover-' + ++n, cost: 0.06 });
  return generate;
}

test('a cover with a normal head goes straight through', async () => {
  const { measure, seen } = measuring([1.1]);
  const out = await withHeadGate(maker(), { coverUrl: 'c', measure });
  assert.equal(out.url, 'cover-1');
  assert.equal(out.headRetried, undefined);
  assert.deepEqual(seen, ['cover-1']);
});

test('an unmeasurable cover (no face found) is kept without a retry', async () => {
  const { measure } = measuring([null]);
  const out = await withHeadGate(maker(), { coverUrl: 'c', measure });
  assert.equal(out.url, 'cover-1');
});

test('an oversized head gets one retry and the better cover wins', async () => {
  const { measure } = measuring([1.6, 1.05]);
  const out = await withHeadGate(maker(), { coverUrl: 'c', measure });
  assert.equal(out.url, 'cover-2');
  assert.equal(out.headRetried, true);
  assert.equal(out.headRatio, 1.05);
});

test('a retry that comes out even bigger loses to the first cover', async () => {
  const { measure } = measuring([1.4, 1.9]);
  const out = await withHeadGate(maker(), { coverUrl: 'c', measure });
  assert.equal(out.url, 'cover-1');
  assert.equal(out.headRatio, 1.4);
});

test('a retry that fails (e.g. out of time) keeps the first cover', async () => {
  const { measure } = measuring([1.5]);
  let calls = 0;
  const generate = async () => { calls++; return { url: 'cover-1' }; };
  const retry = async () => { throw new Error('generation-out-of-time'); };
  const out = await withHeadGate(generate, { coverUrl: 'c', measure, retry });
  assert.equal(out.url, 'cover-1');
  assert.equal(calls, 1);
});

test('the ratio limit sits where today\'s oversized covers were', () => {
  assert.equal(HEAD_RETRY_RATIO, 1.3);
});
