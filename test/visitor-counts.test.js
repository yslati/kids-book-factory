// Per-visitor upload and preview counts, against an in-memory stand-in for
// Upstash's pipeline.

import test from 'node:test';
import assert from 'node:assert/strict';
import { countPreview, countUpload } from '../lib/visitor-counts.js';

function fakeRedis({ fail = false } = {}) {
  const values = new Map();
  const expiries = new Map();
  return {
    values,
    expiries,
    pipeline() {
      const steps = [];
      const p = {
        incr(key) { steps.push(() => { values.set(key, (values.get(key) || 0) + 1); return values.get(key); }); return p; },
        expire(key, seconds) { steps.push(() => { expiries.set(key, seconds); return 1; }); return p; },
        get(key) { steps.push(() => (values.has(key) ? values.get(key) : null)); return p; },
        async exec() {
          if (fail) throw new Error('upstash down');
          return steps.map((step) => step());
        }
      };
      return p;
    }
  };
}

const req = (ip) => ({ headers: { 'x-forwarded-for': ip } });

test('uploads and previews count per visitor, by IP', async () => {
  const redis = fakeRedis();
  assert.equal(await countUpload(redis, req('203.0.113.7'), null), 1);
  assert.deepEqual(await countPreview(redis, req('203.0.113.7'), null), { preview: 1, upload: 1, by: 'ip' });
  assert.equal(await countUpload(redis, req('203.0.113.7'), null), 2);
  assert.equal(await countUpload(redis, req('203.0.113.7'), null), 3, 'an upload that never became a preview');
  assert.deepEqual(await countPreview(redis, req('203.0.113.7'), null), { preview: 2, upload: 3, by: 'ip' });
  assert.deepEqual(await countPreview(redis, req('198.51.100.1'), null), { preview: 1, upload: null, by: 'ip' }, 'another visitor starts at 1');
  assert.equal(redis.values.get('kbf:count:upload:ip:203.0.113.7'), 3);
});

test('a signed-in customer counts by account, wherever they connect from', async () => {
  const redis = fakeRedis();
  redis.values.set('kbf:count:upload:ip:203.0.113.7', 5);
  await countUpload(redis, req('203.0.113.7'), '7212345678');
  assert.deepEqual(await countPreview(redis, req('198.51.100.1'), '7212345678'), { preview: 1, upload: 1, by: 'customer' });
  assert.equal(redis.values.get('kbf:count:preview:customer:7212345678'), 1);
});

test('each counter is kept 30 days after its last increment', async () => {
  const redis = fakeRedis();
  await countUpload(redis, req('203.0.113.7'), null);
  await countPreview(redis, req('203.0.113.7'), null);
  assert.equal(redis.expiries.get('kbf:count:upload:ip:203.0.113.7'), 30 * 24 * 60 * 60);
  assert.equal(redis.expiries.get('kbf:count:preview:ip:203.0.113.7'), 30 * 24 * 60 * 60);
});

test('no Redis or a Redis error means no count, never an exception', async () => {
  assert.equal(await countUpload(null, req('203.0.113.7'), null), null);
  assert.equal(await countPreview(null, req('203.0.113.7'), null), null);
  assert.equal(await countUpload(fakeRedis({ fail: true }), req('203.0.113.7'), null), null);
  assert.equal(await countPreview(fakeRedis({ fail: true }), req('203.0.113.7'), null), null);
});
