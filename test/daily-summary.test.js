// The daily summary's catch-up and duplicate-run guard, against an in-memory
// stand-in for Upstash, with Discord stubbed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { postDueSummaries } from '../lib/daily-summary.js';
import { resetDiscordThrottle, setDiscordOutbox } from '../lib/discord.js';

const NOW = new Date('2026-10-21T06:30:00Z');
const LAST = 'kbf:ev:summary:last';
const LOCK = 'kbf:ev:summary:lock';

function fakeRedis({ failOn = '' } = {}) {
  const strings = new Map();
  const hashes = new Map();
  const ops = {
    exists: (k) => (hashes.has(k) ? 1 : 0),
    pfcount(k) {
      if (failOn && k.includes(failOn)) throw new Error('upstash down');
      return 0;
    },
    hgetall: (k) => (hashes.has(k) ? { ...hashes.get(k) } : null)
  };
  return {
    strings,
    hashes,
    async set(k, v, o = {}) {
      if (o.nx && strings.has(k)) return null;
      strings.set(k, v);
      return 'OK';
    },
    async get(k) { return strings.has(k) ? strings.get(k) : null; },
    async del(k) { return strings.delete(k) ? 1 : 0; },
    pipeline() {
      const steps = [];
      const p = new Proxy({}, {
        get: (target, name) => (name === 'exec'
          ? async () => steps.map((step) => step())
          : (...args) => { steps.push(() => ops[name](...args)); return p; })
      });
      return p;
    }
  };
}

const recorded = (redis, day) => redis.hashes.set('kbf:ev:' + day + ':count', { page_viewed: 1 });

function stubDiscord(t, status = 204) {
  const saved = process.env.DISCORD_WEBHOOK_EVENTS;
  process.env.DISCORD_WEBHOOK_EVENTS = 'https://discord.com/api/webhooks/3/events-token';
  resetDiscordThrottle();
  setDiscordOutbox(null);
  const original = globalThis.fetch;
  const titles = [];
  globalThis.fetch = async (url, init = {}) => {
    titles.push(JSON.parse(init.body).embeds[0].title);
    return new Response(null, { status });
  };
  t.after(() => {
    globalThis.fetch = original;
    if (saved === undefined) delete process.env.DISCORD_WEBHOOK_EVENTS;
    else process.env.DISCORD_WEBHOOK_EVENTS = saved;
    resetDiscordThrottle();
  });
  return titles;
}

test('the first run posts from the earliest day with totals through yesterday, oldest first', async (t) => {
  const titles = stubDiscord(t);
  const redis = fakeRedis();
  recorded(redis, '2026-10-18');
  recorded(redis, '2026-10-20');
  const days = await postDueSummaries(redis, NOW);
  assert.deepEqual(days.map((d) => d.day), ['2026-10-18', '2026-10-19', '2026-10-20']);
  assert.ok(days.every((d) => d.sent));
  assert.deepEqual(titles.map((title) => title.match(/\d+ October/)[0]), ['18 October', '19 October', '20 October']);
  assert.equal(redis.strings.get(LAST), '2026-10-20');
  assert.equal(redis.strings.has(LOCK), false, 'the lock is released');
});

test('the first run with no totals at all posts yesterday', async (t) => {
  stubDiscord(t);
  const days = await postDueSummaries(fakeRedis(), NOW);
  assert.deepEqual(days, [{ day: '2026-10-20', sent: true }]);
});

test('a repeated run posts nothing', async (t) => {
  const titles = stubDiscord(t);
  const redis = fakeRedis();
  await postDueSummaries(redis, NOW);
  assert.deepEqual(await postDueSummaries(redis, new Date('2026-10-21T06:45:00Z')), []);
  assert.equal(titles.length, 1);
});

test('a run that overlaps another posts nothing', async (t) => {
  const titles = stubDiscord(t);
  const redis = fakeRedis();
  redis.strings.set(LOCK, 1);
  assert.equal(await postDueSummaries(redis, NOW), null);
  assert.equal(titles.length, 0);
  assert.equal(redis.strings.has(LAST), false);
});

test('days a skipped run missed are posted by the next one', async (t) => {
  stubDiscord(t);
  const redis = fakeRedis();
  redis.strings.set(LAST, '2026-10-17');
  const days = await postDueSummaries(redis, NOW);
  assert.deepEqual(days.map((d) => d.day), ['2026-10-18', '2026-10-19', '2026-10-20']);
  assert.equal(redis.strings.get(LAST), '2026-10-20');
});

test('catch-up stops 30 days back', async (t) => {
  stubDiscord(t);
  const redis = fakeRedis();
  redis.strings.set(LAST, '2026-08-01');
  const days = await postDueSummaries(redis, NOW);
  assert.equal(days.length, 30);
  assert.equal(days[0].day, '2026-09-21');
  assert.equal(days[29].day, '2026-10-20');
});

test('a Redis error leaves the remaining days for the next run', async (t) => {
  stubDiscord(t);
  const redis = fakeRedis({ failOn: '2026-10-19' });
  redis.strings.set(LAST, '2026-10-17');
  await assert.rejects(postDueSummaries(redis, NOW), /upstash down/);
  assert.equal(redis.strings.get(LAST), '2026-10-18', 'the day before the failure counts as posted');
  assert.equal(redis.strings.has(LOCK), false, 'the lock is released');
});

test("a summary Discord didn't take right away isn't posted again", async (t) => {
  const titles = stubDiscord(t, 500);
  const redis = fakeRedis();
  assert.deepEqual(await postDueSummaries(redis, NOW), [{ day: '2026-10-20', sent: false }]);
  assert.equal(redis.strings.get(LAST), '2026-10-20');
  assert.deepEqual(await postDueSummaries(redis, NOW), []);
  assert.equal(titles.length, 1);
});
