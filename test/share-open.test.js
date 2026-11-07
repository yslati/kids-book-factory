// Opening a short share link: the redirect is tagged as a share, and each open
// is counted and posted, with Upstash and Discord stubbed over fetch.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ALLOWED_ORIGIN = 'https://booktokids.com';
process.env.SHARE_BASE_URL = 'https://s.booktokids.com';
process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
process.env.DISCORD_WEBHOOK_PREVIEWS = 'https://discord.com/api/webhooks/5/previews-token';

const { default: handler } = await import('../api/share.js');
const { resetDiscordThrottle, setDiscordOutbox } = await import('../lib/discord.js');

const S = Buffer.from(JSON.stringify({ n: 'Lina', u: '' })).toString('base64url');
const TARGET = 'https://booktokids.com/pages/create-your-book?b=the-dragon-rider&s=' + S;

function stub(t) {
  resetDiscordThrottle();
  setDiscordOutbox(null);
  const original = globalThis.fetch;
  const opens = new Map();
  const calls = { redis: [], discord: [] };
  const run = ([cmd, key]) => {
    calls.redis.push([cmd, key]);
    if (cmd === 'get') return key === 'kbf:share:lina-x7k2pq' ? JSON.stringify({ url: TARGET, childName: 'Lina', coverUrl: '' }) : null;
    if (cmd === 'incr') {
      opens.set(key, (opens.get(key) || 0) + 1);
      return opens.get(key);
    }
    return 1;
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://upstash.test')) {
      const body = JSON.parse(init.body);
      const result = u.endsWith('/pipeline') ? body.map((c) => ({ result: run(c) })) : { result: run(body) };
      return new Response(JSON.stringify(result), { status: 200 });
    }
    if (u.startsWith('https://discord.com')) {
      calls.discord.push(JSON.parse(init.body).embeds[0]);
      return new Response(null, { status: 204 });
    }
    return new Response('{}', { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = original;
    resetDiscordThrottle();
  });
  return calls;
}

function request(userAgent) {
  return { method: 'GET', query: { id: 'lina-x7k2pq' }, headers: { 'user-agent': userAgent, 'x-vercel-ip-country': 'GB' } };
}

function response() {
  const res = { headers: {}, statusCode: 200 };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.send = (body) => { res.body = body; return res; };
  res.redirect = (code, location) => { res.statusCode = code; res.location = location; return res; };
  return res;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test('a person opening a shared link lands tagged as a share, and the open is counted and posted', async (t) => {
  const calls = stub(t);
  const res = response();
  await handler(request('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1'), res);
  await settle();
  assert.equal(res.statusCode, 302);
  const landing = new URL(res.location);
  assert.equal(landing.searchParams.get('utm_source'), 'share');
  assert.equal(landing.searchParams.get('utm_medium'), 'link');
  assert.equal(landing.searchParams.get('s'), S);
  assert.ok(calls.redis.some(([cmd, key]) => cmd === 'incr' && key === 'kbf:share-opens:lina-x7k2pq'));
  assert.ok(calls.redis.some(([cmd, key]) => cmd === 'hincrby' && /count$/.test(key)));
  assert.equal(calls.discord.length, 1);
  assert.equal(calls.discord[0].title, '👀 Lina · the-dragon-rider');
  assert.equal(calls.discord[0].fields.find((f) => f.name === 'Opens').value, '1st open of this link');
});

test('a chat app fetching the link only counts as a chat preview', async (t) => {
  const calls = stub(t);
  const res = response();
  await handler(request('WhatsApp/2.23.20.0'), res);
  await settle();
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /og:/);
  assert.equal(calls.redis.some(([cmd]) => cmd === 'incr'), false);
  assert.equal(calls.discord.length, 0);
});
