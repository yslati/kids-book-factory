import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { parseVisitorId, visitorId } from '../lib/visitor-id.js';
import { Step, lastStep, logGenerationStep, logStep, readTimeline } from '../lib/visitor-log.js';
import { COMMAND, runCommand, validInteraction } from '../lib/btk-bot.js';

process.env.CRON_SECRET = 'test-secret';

// Enough of Upstash for lib/visitor-log.js.
function fakeRedis() {
  const strings = new Map();
  const lists = new Map();
  const hashes = new Map();
  const ops = {
    set(k, v) { strings.set(k, v); return 'OK'; },
    get(k) { return strings.has(k) ? strings.get(k) : null; },
    lpush(k, v) { const l = lists.get(k) || []; l.unshift(v); lists.set(k, l); return l.length; },
    ltrim(k, start, stop) { lists.set(k, (lists.get(k) || []).slice(start, stop + 1)); return 'OK'; },
    lrange(k, start, stop) { return (lists.get(k) || []).slice(start, stop + 1); },
    expire() { return 1; },
    hset(k, o) { hashes.set(k, { ...(hashes.get(k) || {}), ...o }); return 1; },
    hsetnx(k, f, v) { const h = hashes.get(k) || {}; if (f in h) return 0; h[f] = v; hashes.set(k, h); return 1; },
    hgetall(k) { return hashes.get(k) || null; }
  };
  return {
    ...ops,
    pipeline() {
      const steps = [];
      const p = new Proxy({}, {
        get: (t, name) => (name === 'exec' ? async () => steps.map((s) => s()) : (...args) => { steps.push(() => ops[name](...args)); return p; })
      });
      return p;
    }
  };
}

const visitor = { id: '', ip: '203.0.113.9', country: 'US', region: 'NC', city: 'Mint Hill', timezone: 'America/New_York', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)' };

test('the Visitor ID is stable for a Shopify id and differs per visitor', () => {
  const a = visitorId({ key: '2bd80319-59e3-49b8-bf4d-1455476a5264', ip: '1.1.1.1' });
  assert.match(a, /^V-[0-9a-f]{8}$/);
  assert.equal(visitorId({ key: '2bd80319-59e3-49b8-bf4d-1455476a5264', ip: '2.2.2.2' }), a);
  assert.notEqual(visitorId({ key: 'aaaaaaaa-59e3-49b8-bf4d-1455476a5264' }), a);
});

test('without a Shopify id, the IP and user agent of the day stand in', () => {
  const day = new Date('2026-11-18T10:00:00Z');
  const same = visitorId({ ip: '1.1.1.1', userAgent: 'x' }, day);
  assert.equal(visitorId({ ip: '1.1.1.1', userAgent: 'x' }, new Date('2026-11-18T23:00:00Z')), same);
  assert.notEqual(visitorId({ ip: '1.1.1.1', userAgent: 'x' }, new Date('2026-11-19T01:00:00Z')), same);
  assert.equal(visitorId({ ip: 'unknown' }), '');
  assert.equal(visitorId({ key: 'bad id with spaces', ip: '' }), '');
});

test('a typed Visitor ID is read in any case and with backticks', () => {
  assert.equal(parseVisitorId(' `v-3F9A2C1D` '), 'V-3f9a2c1d');
  assert.equal(parseVisitorId('V-3f9a2c1'), '');
  assert.equal(parseVisitorId('X-3f9a2c1d'), '');
});

test('interactions are accepted only with Discord\'s signature', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const hex = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
  const raw = Buffer.from('{"type":1}');
  const ts = '1795012414';
  const sig = sign(null, Buffer.concat([Buffer.from(ts), raw]), privateKey).toString('hex');
  assert.equal(validInteraction(raw, sig, ts, hex), true);
  assert.equal(validInteraction(Buffer.from('{"type":2}'), sig, ts, hex), false);
  assert.equal(validInteraction(raw, sig, '1795012415', hex), false);
  assert.equal(validInteraction(raw, 'zz', ts, hex), false);
  assert.equal(validInteraction(raw, sig, ts, ''), false);
});

test('/btk lists customer with its id parameter', () => {
  const sub = COMMAND.options.find((o) => o.name === 'customer');
  assert.equal(COMMAND.name, 'btk');
  assert.equal(sub.type, 1);
  assert.deepEqual(sub.options.map((o) => [o.name, o.required]), [['id', true]]);
});

test('/btk customer shows a visitor\'s timeline, found by Visitor ID or generation', async () => {
  const redis = fakeRedis();
  const v = { ...visitor, id: visitorId({ key: '2bd80319-59e3-49b8-bf4d-1455476a5264' }) };
  await logStep(redis, v, { kind: Step.page, text: '/' });
  await logStep(redis, v, { kind: Step.preview, text: 'christmas-star-rescue', generation: 'gen-123' });
  await logGenerationStep(redis, 'gen-123', { kind: Step.cover, text: 'Christmas Star Rescue', url: 'https://cdn.example/c.jpg' });
  await logStep(redis, v, { kind: Step.cart, text: 'Christmas Star Rescue · Hardcover' });

  const timeline = await readTimeline(redis, v.id);
  assert.deepEqual(timeline.steps.map((s) => s.kind), ['cart', 'cover', 'preview', 'page']);
  assert.equal((await lastStep(redis, v.id, Step.cover)).url, 'https://cdn.example/c.jpg');

  const data = (value) => ({ name: 'btk', options: [{ type: 1, name: 'customer', options: [{ name: 'id', value }] }] });
  const byId = await runCommand(data(v.id.toLowerCase()), { redis });
  const embed = byId.embeds[0];
  assert.equal(embed.title, '👤 Visitor ' + v.id);
  const lines = embed.description.split('\n');
  assert.match(lines[0], /📄 Page: \//);
  assert.match(lines[2], /🖼️ Cover ready: Christmas Star Rescue \[cover\]\(https:\/\/cdn\.example\/c\.jpg\)/);
  assert.match(lines[3], /🛒 Added to cart/);
  assert.ok(embed.fields.some((f) => f.name === 'Totals' && f.value === '1 pages · 1 covers · 1 carts · 0 orders'));
  assert.ok(embed.fields.some((f) => f.name === 'Where' && f.value.includes(v.id)));

  const byGen = await runCommand(data('gen-123'), { redis });
  assert.equal(byGen.embeds[0].title, '👤 Visitor ' + v.id);
  assert.ok(byGen.embeds[0].fields.some((f) => f.name === 'Found from' && f.value.includes('gen-123')));

  const unknown = await runCommand(data('nope'), { redis });
  assert.match(unknown.content, /No visitor found/);
  assert.match((await runCommand({ name: 'btk', options: [{ name: 'other' }] }, { redis })).content, /Unknown command/);
});

test('a visitor without an id is never logged', async () => {
  const redis = fakeRedis();
  await logStep(redis, { ...visitor, id: '' }, { kind: Step.page, text: '/' });
  assert.equal(await readTimeline(redis, 'V-00000000'), null);
});

test('a request\'s visitor carries the ID from the body\'s Shopify id, shown under the place', async () => {
  const { visitorOf, place } = await import('../lib/discord.js');
  const headers = { 'x-forwarded-for': '203.0.113.9', 'x-vercel-ip-country': 'US', 'user-agent': 'UA' };
  const shopifyId = '2bd80319-59e3-49b8-bf4d-1455476a5264';
  const fromJson = visitorOf({ headers, body: { visitor: shopifyId } });
  const fromText = visitorOf({ headers, body: JSON.stringify({ visitor: shopifyId }) });
  assert.equal(fromJson.id, visitorId({ key: shopifyId }));
  assert.equal(fromText.id, fromJson.id);
  assert.equal(visitorOf({ headers }).id, visitorId({ ip: '203.0.113.9', userAgent: 'UA' }));
  assert.ok(place(fromJson).endsWith('\n`' + fromJson.id + '`'));
});

test('a /btk command is answered in the response itself, not by a later edit', async () => {
  const { PassThrough } = await import('node:stream');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DISCORD_PUBLIC_KEY = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
  process.env.DISCORD_GUILD_ID = '42';
  const { default: handler } = await import('../api/discord.js');
  const body = JSON.stringify({ type: 2, guild_id: '42', application_id: '1', token: 't', data: { name: 'btk', options: [{ type: 1, name: 'customer', options: [{ name: 'id', value: 'V-3f9a2c1d' }] }] } });
  const ts = '1795012414';
  const req = new PassThrough();
  req.method = 'POST';
  req.headers = { 'x-signature-ed25519': sign(null, Buffer.from(ts + body), privateKey).toString('hex'), 'x-signature-timestamp': ts };
  req.end(body);
  const sent = {};
  const res = { status(code) { sent.status = code; return this; }, json(payload) { sent.body = payload; return this; } };
  await handler(req, res);
  assert.equal(sent.status, 200);
  assert.equal(sent.body.type, 4);
  assert.match(sent.body.data.content, /Redis is not configured/);
  assert.deepEqual(sent.body.data.allowed_mentions, { parse: [] });
});
