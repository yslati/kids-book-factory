// Finishing a queued cover from the storefront's polls, against an in-memory
// stand-in for Upstash. The Higgsfield check and the finish step are stubs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { QUEUE_WAIT_MS, queuePreview, settleQueuedPreview } from '../lib/queued-preview.js';

const GENERATION = 'k3x9p2m7q1';
const PENDING = { attempt: { provider: 'higgsfield', model: 'marketing-studio/image/sunburst', quality: 'medium' }, statusUrl: 'https://api.higgsfield.ai/requests/r/status', cancelUrl: 'https://api.higgsfield.ai/requests/r/cancel', startedAt: 1000 };
const PREVIEW = {
  themeId: 'the-kindness-parade', photoKey: 'photos/jack_3_en_abc.jpg', generationId: GENERATION, childName: 'Jack', ageText: '3',
  language: { code: 'en', name: 'English' }, customer: { valid: false }, startedAt: 1000, remaining: 4
};
const REQ = { headers: { 'x-forwarded-for': '203.0.113.7', 'user-agent': 'Test', cookie: 'secret=1' } };

// GET, DEL and SET with NX and EX, as Upstash does them. Values are copied
// the way Upstash's JSON round trip would.
function fakeRedis() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? JSON.parse(store.get(key)) : null;
    },
    async set(key, value, opts = {}) {
      if (opts.nx && store.has(key)) return null;
      store.set(key, JSON.stringify(value));
      return 'OK';
    },
    async del(key) {
      store.delete(key);
    }
  };
}

async function queued() {
  const redis = fakeRedis();
  await queuePreview(redis, REQ, PREVIEW, { book: { title: 'The Kindness Parade' }, prompt: 'p', link: 'https://discord/m', counts: { preview: 1 }, pending: PENDING });
  return redis;
}

function steps({ url = null, error = null } = {}) {
  const calls = { check: 0, finish: [], fail: [] };
  return {
    calls,
    check: async () => {
      calls.check++;
      if (error) throw new Error(error);
      return url;
    },
    finish: async (entry, coverUrl) => {
      calls.finish.push({ entry, coverUrl });
      await new Promise((r) => setTimeout(r, 10));
      return 'https://r2/previews/jack.jpg';
    },
    fail: async (entry, reason) => {
      calls.fail.push(reason);
    },
    now: () => 30000
  };
}

test('stores only the visitor headers of the request', async () => {
  const redis = await queued();
  const entry = await redis.get('kbf:queued:' + GENERATION);
  assert.deepEqual(entry.request, { headers: { 'x-forwarded-for': '203.0.113.7', 'user-agent': 'Test' } });
  assert.equal(entry.status, 'pending');
  assert.deepEqual(entry.pending, PENDING);
});

test('pending while the job runs, then ready with the stored cover once it completes', async () => {
  const redis = await queued();
  const running = steps();
  assert.deepEqual(await settleQueuedPreview(redis, GENERATION, running), { status: 'pending' });
  assert.equal(running.calls.finish.length, 0);

  const done = steps({ url: 'https://cdn/cover.png' });
  assert.deepEqual(await settleQueuedPreview(redis, GENERATION, done), { status: 'ready', preview_url: 'https://r2/previews/jack.jpg' });
  assert.equal(done.calls.finish.length, 1);
  assert.equal(done.calls.finish[0].coverUrl, 'https://cdn/cover.png');
  assert.equal(done.calls.finish[0].entry.preview.childName, 'Jack');

  // Later polls read the outcome without asking Higgsfield again.
  const later = steps({ url: 'https://cdn/cover.png' });
  assert.deepEqual(await settleQueuedPreview(redis, GENERATION, later), { status: 'ready', preview_url: 'https://r2/previews/jack.jpg' });
  assert.equal(later.calls.check, 0);
  assert.equal(later.calls.finish.length, 0);
});

test('overlapping polls that both see the job done finish it once', async () => {
  const redis = await queued();
  const done = steps({ url: 'https://cdn/cover.png' });
  const results = await Promise.all([
    settleQueuedPreview(redis, GENERATION, done),
    settleQueuedPreview(redis, GENERATION, done),
    settleQueuedPreview(redis, GENERATION, done)
  ]);
  assert.equal(done.calls.finish.length, 1);
  assert.equal(results.filter((r) => r.status === 'ready').length, 1);
  assert.equal(results.filter((r) => r.status === 'pending').length, 2);
  assert.equal((await settleQueuedPreview(redis, GENERATION, done)).status, 'ready');
  assert.equal(done.calls.finish.length, 1);
});

test('a poll taking the lock after it expired still does not finish twice', async () => {
  const redis = await queued();
  const done = steps({ url: 'https://cdn/cover.png' });
  await settleQueuedPreview(redis, GENERATION, done);
  await redis.del('kbf:queued:lock:' + GENERATION);
  assert.equal((await settleQueuedPreview(redis, GENERATION, done)).status, 'ready');
  assert.equal(done.calls.finish.length, 1);
});

test('a job past the wait is given up on once, without asking Higgsfield', async () => {
  const redis = await queued();
  const late = { ...steps({ url: 'https://cdn/cover.png' }), now: () => PREVIEW.startedAt + QUEUE_WAIT_MS + 1 };
  assert.deepEqual(await settleQueuedPreview(redis, GENERATION, late), { status: 'failed' });
  assert.equal(late.calls.check, 0);
  assert.deepEqual(late.calls.fail, ['higgsfield-expired']);
  assert.deepEqual(await settleQueuedPreview(redis, GENERATION, late), { status: 'failed' });
  assert.deepEqual(late.calls.fail, ['higgsfield-expired']);
});

test('a job Higgsfield failed is recorded as failed with its reason', async () => {
  const redis = await queued();
  const failed = steps({ error: 'higgsfield-nsfw' });
  assert.deepEqual(await settleQueuedPreview(redis, GENERATION, failed), { status: 'failed' });
  assert.deepEqual(failed.calls.fail, ['higgsfield-nsfw']);
  assert.equal(failed.calls.finish.length, 0);
});

test('an unknown or expired id is failed, so the storefront stops polling', async () => {
  const s = steps();
  assert.deepEqual(await settleQueuedPreview(fakeRedis(), 'nope', s), { status: 'failed' });
  assert.equal(s.calls.check, 0);
});

test('a finish that throws frees the lock for the next poll', async () => {
  const redis = await queued();
  const broken = { ...steps({ url: 'https://cdn/cover.png' }), finish: async () => { throw new Error('r2-down'); } };
  await assert.rejects(settleQueuedPreview(redis, GENERATION, broken), /r2-down/);
  const done = steps({ url: 'https://cdn/cover.png' });
  assert.equal((await settleQueuedPreview(redis, GENERATION, done)).status, 'ready');
  assert.equal(done.calls.finish.length, 1);
});
