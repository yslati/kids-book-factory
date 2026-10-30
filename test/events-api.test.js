// The /api/events intake and the daily-summary cron's guard.

import test from 'node:test';
import assert from 'node:assert/strict';
import events from '../api/events.js';
import summary from '../api/cron/daily-summary.js';

function res() {
  return {
    statusCode: 200, body: undefined, headersSent: false,
    setHeader() {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; },
    end() { this.headersSent = true; return this; }
  };
}
const req = (body, ip = '203.0.113.7', method = 'POST') => ({ method, url: '/events', headers: { 'x-forwarded-for': ip, origin: 'null' }, body, query: {} });
const page = JSON.stringify({ event: 'page_viewed', clientId: 'c1', path: '/' });

test('events: accepted with 204, junk refused, wrong method refused', async () => {
  let r = res();
  await events(req(page), r);
  assert.equal(r.statusCode, 204);
  r = res();
  await events(req(JSON.stringify({ event: 'checkout_completed', clientId: '', path: '/checkouts/x/thank-you' })), r);
  assert.equal(r.statusCode, 204, 'no client id: a visitor without analytics consent');
  r = res();
  await events(req('{"event":"nope"}'), r);
  assert.equal(r.statusCode, 400);
  r = res();
  await events(req('not json'), r);
  assert.equal(r.statusCode, 400);
  r = res();
  await events(req(page, '203.0.113.7', 'GET'), r);
  assert.equal(r.statusCode, 405);
});

test('events: one IP is capped, others are not', async () => {
  let last;
  for (let i = 0; i < 301; i++) {
    last = res();
    await events(req(page, '198.51.100.9'), last);
  }
  assert.equal(last.statusCode, 429);
  const other = res();
  await events(req(page, '198.51.100.10'), other);
  assert.equal(other.statusCode, 204);
});

test('daily summary: refuses requests without the cron secret', async (t) => {
  const saved = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'test-secret';
  t.after(() => { if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved; });
  const call = async (authorization) => {
    const r = res();
    await summary({ method: 'GET', url: '/api/cron/daily-summary', headers: authorization ? { authorization } : {}, query: {} }, r);
    return r.statusCode;
  };
  assert.equal(await call(), 401);
  assert.equal(await call('Bearer wrong'), 401);
  assert.equal(await call('Bearer test-secret'), 503, 'authorised; no Upstash in tests');
});
