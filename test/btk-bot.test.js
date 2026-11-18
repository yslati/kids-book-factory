import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { parseVisitorId, visitorId } from '../lib/visitor-id.js';
import { Step, lastStep, logGenerationStep, logStep, readTimeline } from '../lib/visitor-log.js';
import { COMMAND, clarityUrl, isAdmin, respond, validInteraction } from '../lib/btk-bot.js';

const run = async (data, deps, extra = {}) => (await respond({ type: 2, data, ...extra }, deps)).data;

process.env.CRON_SECRET = 'test-secret';

// Enough of Upstash for lib/visitor-log.js.
function fakeRedis() {
  const strings = new Map();
  const lists = new Map();
  const hashes = new Map();
  const sets = new Map();
  const ops = {
    set(k, v) { strings.set(k, v); return 'OK'; },
    get(k) { return strings.has(k) ? strings.get(k) : null; },
    lpush(k, v) { const l = lists.get(k) || []; l.unshift(v); lists.set(k, l); return l.length; },
    ltrim(k, start, stop) { lists.set(k, (lists.get(k) || []).slice(start, stop + 1)); return 'OK'; },
    lrange(k, start, stop) { return (lists.get(k) || []).slice(start, stop + 1); },
    expire() { return 1; },
    hset(k, o) { hashes.set(k, { ...(hashes.get(k) || {}), ...o }); return 1; },
    hsetnx(k, f, v) { const h = hashes.get(k) || {}; if (f in h) return 0; h[f] = v; hashes.set(k, h); return 1; },
    hgetall(k) { return hashes.get(k) || null; },
    hget(k, f) { const h = hashes.get(k); return h && f in h ? h[f] : null; },
    sadd(k, v) { const set = sets.get(k) || new Set(); set.add(v); sets.set(k, set); return 1; },
    smembers(k) { return [...(sets.get(k) || [])]; }
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
  const byId = await run(data(v.id.toLowerCase()), { redis, giftedPreviews: async () => 0 });
  const embed = byId.embeds[0];
  assert.equal(embed.title, '👤 Visitor ' + v.id);
  const lines = embed.description.split('\n');
  assert.match(lines[0], /📄 Page: \//);
  assert.match(lines[2], /🖼️ Cover ready: Christmas Star Rescue \[cover\]\(https:\/\/cdn\.example\/c\.jpg\)/);
  assert.match(lines[3], /🛒 Added to cart/);
  assert.ok(embed.fields.some((f) => f.name === 'Totals' && f.value === '1 pages · 1 covers · 1 carts · 0 orders'));
  assert.ok(embed.fields.some((f) => f.name === 'Where' && f.value.includes(v.id)));

  const byGen = await run(data('gen-123'), { redis, giftedPreviews: async () => 0 });
  assert.equal(byGen.embeds[0].title, '👤 Visitor ' + v.id);
  assert.ok(byGen.embeds[0].fields.some((f) => f.name === 'Found from' && f.value.includes('gen-123')));

  const unknown = await run(data('nope'), { redis });
  assert.match(unknown.content, /No visitor found/);
  assert.match((await run({ name: 'btk', options: [{ name: 'other' }] }, { redis })).content, /Unknown command/);
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

const ADMIN = { member: { permissions: String(1 << 3), user: { username: 'shark' } } };
const MEMBER = { member: { permissions: '0', user: { username: 'guest' } } };

async function seeded(steps = 3) {
  const redis = fakeRedis();
  const v = { ...visitor, id: visitorId({ key: '2bd80319-59e3-49b8-bf4d-1455476a5264' }), key: '2bd80319-59e3-49b8-bf4d-1455476a5264' };
  for (let i = 0; i < steps; i++) await logStep(redis, v, { kind: Step.page, text: '/p' + i });
  return { redis, v };
}

test('only Administrator or Manage Server counts as admin', () => {
  assert.equal(isAdmin(ADMIN), true);
  assert.equal(isAdmin({ member: { permissions: String(1 << 5) } }), true);
  assert.equal(isAdmin(MEMBER), false);
  assert.equal(isAdmin({}), false);
});

test('a long timeline pages with Older and Newer buttons, and links Clarity', async () => {
  const { redis, v } = await seeded(30);
  const deps = { redis, giftedPreviews: async () => 0 };
  const first = await run({ name: 'btk', options: [{ name: 'customer', options: [{ name: 'id', value: v.id }] }] }, deps);
  const labels = first.components[0].components.map((b) => b.label);
  assert.deepEqual(labels, ['Older steps', 'Gift previews', 'Reset uploads', 'Clarity recordings']);
  assert.match(first.embeds[0].footer.text, /Steps 1–25 of 30/);
  assert.equal(first.components[0].components[3].url, clarityUrl(v.key));
  assert.match(clarityUrl(v.key), /CustomUserId=is%3B2bd80319-59e3-49b8-bf4d-1455476a5264$/);

  const older = await respond({ type: 3, data: { custom_id: 'btk:page:' + v.id + ':25' }, ...MEMBER }, deps);
  assert.equal(older.type, 7);
  assert.match(older.data.embeds[0].footer.text, /Steps 26–30 of 30/);
  assert.deepEqual(older.data.components[0].components.map((b) => b.label).slice(0, 1), ['Newer steps']);
  assert.match(older.data.embeds[0].description.split('\n').pop(), /\/p4$/);
});

test('gifts need an admin, go to the visitor\'s last IP and join their timeline', async () => {
  const { redis, v } = await seeded();
  const given = [];
  const deps = { redis, giftPreviews: async (ip, n) => { given.push([ip, n]); return n; }, giftedPreviews: async () => 0 };
  const gift = (extra, count = 3) => run({ name: 'btk', options: [{ name: 'gift', options: [{ name: 'id', value: v.id }, { name: 'count', value: count }] }] }, deps, extra);

  assert.match((await gift(MEMBER)).content, /Only server admins/);
  assert.match((await gift(ADMIN, 50)).content, /from 1 to 20/);
  assert.match((await gift(ADMIN)).content, /Gifted 3 previews/);
  assert.deepEqual(given, [['203.0.113.9', 3]]);
  const timeline = await readTimeline(redis, v.id);
  assert.equal(timeline.steps[0].kind, Step.gift);
  assert.match(timeline.steps[0].text, /3 previews by shark/);
});

test('the gift button opens a form, and its answer gifts that many', async () => {
  const { redis, v } = await seeded();
  const given = [];
  const deps = { redis, giftPreviews: async (ip, n) => { given.push(n); return n; } };
  assert.match((await respond({ type: 3, data: { custom_id: 'btk:gift:' + v.id }, ...MEMBER }, deps)).data.content, /Only server admins/);
  const modal = await respond({ type: 3, data: { custom_id: 'btk:gift:' + v.id }, ...ADMIN }, deps);
  assert.equal(modal.type, 9);
  assert.equal(modal.data.custom_id, 'btk:giftform:' + v.id);
  const submitted = await respond({ type: 5, data: { custom_id: 'btk:giftform:' + v.id, components: [{ type: 1, components: [{ custom_id: 'count', value: '4' }] }] }, ...ADMIN }, deps);
  assert.equal(submitted.data.flags, 64);
  assert.match(submitted.data.content, /Gifted 4 previews/);
  assert.deepEqual(given, [4]);
});

test('upload reset works from the command and the button, for admins only', async () => {
  const { redis, v } = await seeded();
  const reset = [];
  const deps = { redis, resetUploads: async (ip) => { reset.push(ip); } };
  const cmd = await run({ name: 'btk', options: [{ name: 'upload-reset', options: [{ name: 'id', value: v.id }] }] }, deps, ADMIN);
  assert.match(cmd.content, /can upload photos again/);
  const denied = await respond({ type: 3, data: { custom_id: 'btk:reset:' + v.id }, ...MEMBER }, deps);
  assert.match(denied.data.content, /Only server admins/);
  assert.deepEqual(reset, ['203.0.113.9']);
});

test('an order number finds its buyer', async () => {
  const { linkOrder } = await import('../lib/visitor-log.js');
  const { redis, v } = await seeded();
  await linkOrder(redis, v.id, ['#btk-1234', '6512345678']);
  const deps = { redis, giftedPreviews: async () => 0 };
  const order = (number) => run({ name: 'btk', options: [{ name: 'order', options: [{ name: 'number', value: number }] }] }, deps);
  for (const number of ['#btk-1234', 'BTK-1234', '6512345678']) assert.equal((await order(number)).embeds[0].title, '👤 Visitor ' + v.id);
  assert.match((await order('#btk-9')).content, /No buyer found/);
});

test('today and balance answer with their cards', async () => {
  const redis = fakeRedis();
  redis.pfcount = () => 7;
  const day = { day: '2026-11-18', visitors: 7, count: { visits: 9, preview_started: 3, preview_ready: 2, checkout_completed: 1 }, revenue: { USD: 71.99 }, sources: { Google: 5, Instagram: 2 }, countries: { US: 4 } };
  const { todayEmbed, balanceEmbed } = await import('../lib/btk-bot.js');
  const today = todayEmbed(day);
  assert.ok(today.fields.some((f) => f.name === 'Previews' && f.value === '3 started · 2 ready · 0 failed'));
  assert.ok(today.fields.some((f) => f.name === 'Revenue' && f.value === '71.99 USD'));

  const deps = { redis, falBalance: async () => 12.5 };
  const card = (await run({ name: 'btk', options: [{ name: 'balance' }] }, deps)).embeds[0];
  assert.match(card.fields[0].value, /\$12\.50/);
  assert.match(card.fields[1].value, /No balance API/);
  assert.match(card.fields[2].value, /No balance API/);
  assert.match(balanceEmbed({ fal: null }).fields[0].value, /Could not read it/);
});

test('a verified customer joins the timeline once and finds the visitor by admin link', async () => {
  process.env.SHOPIFY_SHOP = 'eytisc-0a.myshopify.com';
  const { linkCustomer } = await import('../lib/visitor-log.js');
  const { redis, v } = await seeded();
  const phone = { ...visitor, id: visitorId({ key: 'aaaaaaaa-59e3-49b8-bf4d-1455476a5264' }), userAgent: 'Android' };
  await logStep(redis, phone, { kind: Step.page, text: '/' });
  await linkCustomer(redis, v.id, '31427367502074', 'signed in');
  await linkCustomer(redis, v.id, '31427367502074', 'signed in');
  await linkCustomer(redis, phone.id, '31427367502074', 'ordered');
  await linkCustomer(redis, v.id, 'not-a-number', 'signed in');

  const steps = (await readTimeline(redis, v.id)).steps.filter((st) => st.kind === Step.account);
  assert.deepEqual(steps.map((st) => st.text), ['signed in · customer 31427367502074']);

  // The phone was seen last, so the admin link opens its timeline, naming the other device.
  await redis.hset('kbf:who:' + phone.id + ':info', { last: Date.now() + 1000 });
  const deps = { redis, giftedPreviews: async () => 0 };
  const find = (value) => run({ name: 'btk', options: [{ name: 'customer', options: [{ name: 'id', value }] }] }, deps);
  const byLink = (await find('https://admin.shopify.com/store/eytisc-0a/customers/31427367502074')).embeds[0];
  assert.equal(byLink.title, '👤 Visitor ' + phone.id);
  const field = (name) => (byLink.fields.find((f) => f.name === name) || {}).value;
  assert.equal(field('Shopify customer'), '[31427367502074](https://admin.shopify.com/store/eytisc-0a/customers/31427367502074)');
  assert.equal(field('Same customer'), '`' + v.id + '`');
  assert.match(field('Found from'), /customer 31427367502074/);
  assert.equal((await find('customer 31427367502074')).embeds[0].title, '👤 Visitor ' + phone.id);
  assert.equal((await find('31427367502074')).embeds[0].title, '👤 Visitor ' + phone.id);
  assert.match((await find('https://admin.shopify.com/store/eytisc-0a/customers/999')).content, /No visitor found/);
});
