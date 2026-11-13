// lib/cover-store.js: a generated cover is never lost when R2 fails.
// R2 and Upstash are fakes; no network calls.

import test from 'node:test';
import assert from 'node:assert/strict';
import { backendOrigin, COVER_KEY, flushPendingCovers, readPendingCover, storeCover } from '../lib/cover-store.js';

const KEY = 'previews/emma_5_en_the-winning-goal_k3x9p2m7q1.jpg';
const keyFor = (ext) => KEY.replace(/jpg$/, ext);
// A real 1x1 JPEG, so the re-encode step runs as in production.
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=', 'base64');
const DATA_URL = 'data:image/jpeg;base64,' + JPEG.toString('base64');
const NO_WAIT = [0, 0, 0];

// Upstash stand-in: get/set/sadd/srem/smembers/del and pipelines.
function fakeRedis({ failWrites = false } = {}) {
  const kv = new Map();
  const sets = new Map();
  const ops = {
    set: (k, v) => { kv.set(k, JSON.parse(JSON.stringify(v))); },
    del: (k) => { kv.delete(k); },
    sadd: (k, m) => { (sets.get(k) || sets.set(k, new Set()).get(k)).add(m); },
    srem: (k, m) => { if (sets.has(k)) sets.get(k).delete(m); }
  };
  const redis = {
    kv, sets,
    get: async (k) => kv.get(k) || null,
    smembers: async (k) => [...(sets.get(k) || [])],
    srem: async (k, m) => ops.srem(k, m),
    pipeline() {
      const queued = [];
      const p = {};
      for (const name of Object.keys(ops)) p[name] = (...a) => { queued.push([name, a]); return p; };
      p.exec = async () => {
        if (failWrites) throw new Error('upstash down');
        for (const [name, a] of queued) ops[name](...a);
        return [];
      };
      return p;
    }
  };
  return redis;
}

function quiet(t) {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'log', () => {});
}

test('R2 working: the cover is saved there once', async (t) => {
  quiet(t);
  const puts = [];
  const kept = await storeCover(DATA_URL, keyFor, {
    redis: fakeRedis(), origin: 'https://api.example.com', waits: NO_WAIT,
    put: async (key) => { puts.push(key); return 'https://r2.example.com/' + key; }
  });
  assert.deepEqual(kept, { url: 'https://r2.example.com/' + KEY, stored: 'r2', key: KEY });
  assert.equal(puts.length, 1);
});

test('a short R2 blip is retried', async (t) => {
  quiet(t);
  let tries = 0;
  const kept = await storeCover(DATA_URL, keyFor, {
    redis: fakeRedis(), origin: 'https://api.example.com', waits: NO_WAIT,
    put: async (key) => { if (++tries < 3) throw new Error('503'); return 'https://r2.example.com/' + key; }
  });
  assert.equal(kept.stored, 'r2');
  assert.equal(tries, 3);
});

test('R2 down: the cover goes to Upstash behind a permanent backend link, then moves to R2', async (t) => {
  quiet(t);
  const redis = fakeRedis();
  const kept = await storeCover(DATA_URL, keyFor, {
    redis, origin: 'https://api.example.com', waits: NO_WAIT,
    put: async () => { throw new Error('R2 down'); }
  });
  assert.equal(kept.stored, 'pending');
  assert.equal(kept.url, 'https://api.example.com/api/cover?key=' + encodeURIComponent(KEY));
  const pending = await readPendingCover(redis, KEY);
  assert.equal(pending.contentType, 'image/jpeg');
  assert.ok(pending.body.length > 100);

  // Still down: nothing is lost.
  assert.deepEqual(await flushPendingCovers(redis, { put: async () => { throw new Error('R2 down'); } }), { saved: 0, left: 1 });
  assert.ok(await readPendingCover(redis, KEY));

  // Back up: moved to R2 and removed from Upstash.
  const moved = [];
  assert.deepEqual(await flushPendingCovers(redis, { put: async (key, body) => { moved.push([key, body.length]); } }), { saved: 1, left: 0 });
  assert.equal(moved[0][0], KEY);
  assert.equal(await readPendingCover(redis, KEY), null);
  assert.deepEqual(await redis.smembers('kbf:cover:unsaved'), []);
});

test('R2 and Upstash both down: a provider https link is kept, a data URL throws', async (t) => {
  quiet(t);
  const down = { redis: fakeRedis({ failWrites: true }), origin: 'https://api.example.com', waits: NO_WAIT, put: async () => { throw new Error('R2 down'); } };
  t.mock.method(globalThis, 'fetch', async () => new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } }));
  assert.deepEqual(await storeCover('https://cdn.higgsfield.ai/x.png', keyFor, down), { url: 'https://cdn.higgsfield.ai/x.png', stored: 'provider' });
  await assert.rejects(storeCover(DATA_URL, keyFor, down), /cover-not-stored/);
});

test('an unreadable provider link is retried, then kept as it is', async (t) => {
  quiet(t);
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async () => { fetches++; return new Response('', { status: 502 }); });
  const kept = await storeCover('https://cdn.higgsfield.ai/x.png', keyFor, { redis: fakeRedis(), origin: 'https://api.example.com', waits: NO_WAIT, put: async () => 'unused' });
  assert.deepEqual(kept, { url: 'https://cdn.higgsfield.ai/x.png', stored: 'provider' });
  assert.equal(fetches, 3);
});

test('the backend origin comes from Vercel, and /api/cover only takes cover keys', () => {
  assert.equal(backendOrigin({ VERCEL_PROJECT_PRODUCTION_URL: 'kids-book-factory.vercel.app' }), 'https://kids-book-factory.vercel.app');
  assert.equal(backendOrigin({}), '');
  assert.ok(COVER_KEY.test(KEY));
  assert.ok(!COVER_KEY.test('photos/emma_5_en_k3x9p2m7q1.jpg'));
  assert.ok(!COVER_KEY.test('previews/../photos/a.jpg'));
});
