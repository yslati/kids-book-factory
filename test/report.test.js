// #logs reporting: request capture (withReporting), embed layouts and
// storefront report validation, with Discord's webhook stubbed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { apiEmbed, normaliseClientEvent, reportClientEvent, webEmbed, withReporting } from '../lib/report.js';
import { resetDiscordThrottle, setDiscordOutbox } from '../lib/discord.js';

function captureDiscord(t) {
  const originalUrl = process.env.DISCORD_WEBHOOK_LOGS;
  const originalFetch = globalThis.fetch;
  process.env.DISCORD_WEBHOOK_LOGS = 'https://discord.com/api/webhooks/1/test-token';
  resetDiscordThrottle();
  setDiscordOutbox(null);
  const posts = [];
  globalThis.fetch = async (url, init = {}) => {
    posts.push(JSON.parse(init.body).embeds[0]);
    return new Response(null, { status: 204 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.DISCORD_WEBHOOK_LOGS;
    else process.env.DISCORD_WEBHOOK_LOGS = originalUrl;
    resetDiscordThrottle();
  setDiscordOutbox(null);
  });
  return posts;
}

// withReporting, then one more turn of the event loop: posts are queued per
// channel, so they reach fetch just after the handler returns.
function reported(handler) {
  const wrapped = withReporting(handler);
  return async (req, res) => {
    await wrapped(req, res);
    await new Promise((resolve) => setImmediate(resolve));
  };
}

function mockReq({ method = 'POST', url = '/api/preview', headers = {}, body, query = {} } = {}) {
  return {
    method,
    url,
    headers: {
      'x-forwarded-for': '203.0.113.7',
      'x-vercel-ip-country': 'FR',
      'x-vercel-ip-city': 'S%C3%A3o%20Paulo',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      origin: 'https://booktokids.com',
      ...headers
    },
    body,
    query
  };
}

function mockRes() {
  return {
    statusCode: 200,
    headersSent: false,
    body: undefined,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.headersSent = true; return this; },
    end() { this.headersSent = true; return this; }
  };
}

function fieldsOf(embed) {
  return Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
}

test('a clean success is not reported', async (t) => {
  const posts = captureDiscord(t);
  const handler = reported(async (req, res) => {
    console.log('[generate] cover by higgsfield marketing-studio/image/flare medium');
    return res.status(200).json({ preview_url: 'https://example.com/x.jpg' });
  });
  await handler(mockReq(), mockRes());
  assert.equal(posts.length, 0);
});

test('a success that logged a warning is reported with its timeline', async (t) => {
  const posts = captureDiscord(t);
  const handler = reported(async (req, res) => {
    console.warn('[generate] higgsfield marketing-studio/image/flare medium failed:', 'higgsfield-timeout');
    console.log('[generate] cover by higgsfield marketing-studio/image/flare low');
    return res.status(200).json({ preview_url: 'https://example.com/x.jpg' });
  });
  await handler(mockReq({ body: { theme_id: 'the-winning-goal', generation_id: 'k3x9p2m7q1', language: 'en' } }), mockRes());

  assert.equal(posts.length, 1);
  assert.equal(posts[0].title, '🟠 200');
  assert.match(posts[0].description, /WARN  \[generate\] higgsfield marketing-studio\/image\/flare medium failed: higgsfield-timeout/);
  assert.match(posts[0].description, /INFO  \[generate\] cover by higgsfield marketing-studio\/image\/flare low/);
  const fields = fieldsOf(posts[0]);
  assert.equal(fields.Book, '`the-winning-goal`');
  assert.equal(fields.Generation, '`k3x9p2m7q1`');
  assert.equal(fields.Visitor, '🇫🇷 France · São Paulo');
  assert.equal(fields.Customer, 'anonymous');
});

test('a 4xx is reported as a warning with its error code', async (t) => {
  const posts = captureDiscord(t);
  const handler = reported(async (req, res) => res.status(403).json({ error: 'forbidden-origin' }));
  const res = mockRes();
  await handler(mockReq({ url: '/upload-url' }), res);

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'forbidden-origin' });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].title, '🟠 403 forbidden-origin');
  assert.equal(posts[0].color, 0xf0b232);
  assert.match(posts[0].author.name, /POST \/upload-url$/);
});

test('a crash answers 500 in JSON and is reported with its stack', async (t) => {
  const posts = captureDiscord(t);
  const handler = reported(async () => { throw new Error('boom'); });
  const res = mockRes();
  await handler(mockReq(), res);

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'internal-error' });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].title, '🔴 500 internal-error');
  assert.equal(posts[0].color, 0xed4245);
  assert.match(posts[0].description, /ERROR \[api\] unhandled: Error: boom\n\s+at /);
});

test('the platform\'s invalid-JSON error keeps its 400', async (t) => {
  const posts = captureDiscord(t);
  const handler = reported(async () => {
    throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 });
  });
  const res = mockRes();
  await handler(mockReq(), res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'bad-request' });
  assert.equal(posts[0].title, '🟠 400 bad-request');
});

test('reports never carry the child\'s name, the photo key or tokens', async (t) => {
  const posts = captureDiscord(t);
  const handler = reported(async (req, res) => {
    console.error('[preview] failed:', new Error('NoSuchKey: ' + JSON.parse(req.body).photo_key));
    return res.status(502).json({ error: 'generation-failed' });
  });
  await handler(mockReq({
    body: JSON.stringify({
      theme_id: 'the-winning-goal',
      photo_key: 'photos/emma_5_en_k3x9p2m7q1.jpg',
      generation_id: 'k3x9p2m7q1',
      child_name: 'Emma',
      age: '5',
      turnstile_token: 'turnstile-secret-token',
      customer_token: 'f'.repeat(64)
    })
  }), mockRes());

  const posted = JSON.stringify(posts);
  assert.equal(posts.length, 1);
  assert.ok(!/emma/i.test(posted), posted);
  assert.ok(!posted.includes('turnstile-secret-token'));
  assert.ok(!posted.includes('f'.repeat(64)));
  assert.ok(posted.includes('photos/…'));
});

test('a GET reports its path without the query, and verifies the customer', async (t) => {
  const posts = captureDiscord(t);
  const originalSecret = process.env.PREVIEW_TOKEN_SECRET;
  process.env.PREVIEW_TOKEN_SECRET = 'test-secret';
  t.after(() => {
    if (originalSecret === undefined) delete process.env.PREVIEW_TOKEN_SECRET;
    else process.env.PREVIEW_TOKEN_SECRET = originalSecret;
  });

  const date = new Date().toISOString().slice(0, 10);
  const token = createHmac('sha256', 'test-secret').update('7212345678:' + date).digest('hex');
  const handler = reported(async (req, res) => res.status(503).json({ error: 'storage-not-configured' }));

  await handler(mockReq({
    method: 'GET',
    url: '/me/previews?customer_id=7212345678&token_date=' + date + '&customer_token=' + token,
    query: { customer_id: '7212345678', token_date: date, customer_token: token }
  }), mockRes());
  await handler(mockReq({
    method: 'GET',
    url: '/me/previews',
    query: { customer_id: '7212345678', token_date: date, customer_token: 'a'.repeat(64) }
  }), mockRes());

  assert.match(posts[0].author.name, /GET \/me\/previews$/);
  assert.ok(!JSON.stringify(posts).includes(token));
  assert.equal(fieldsOf(posts[0]).Customer, 'signed in · 7212345678');
  assert.equal(fieldsOf(posts[1]).Customer, 'anonymous · token rejected');
  assert.equal(posts[0].color, 0xed4245, '5xx is an error');
});

test('concurrent requests keep their own log lines', async (t) => {
  const posts = captureDiscord(t);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const handler = reported(async (req, res) => {
    await sleep(req.body.wait);
    console.warn('[test] line from ' + req.url);
    await sleep(5);
    return res.status(400).json({ error: 'bad' });
  });

  await Promise.all([
    handler(mockReq({ url: '/a', body: { wait: 10 } }), mockRes()),
    handler(mockReq({ url: '/b', body: { wait: 1 } }), mockRes())
  ]);

  assert.equal(posts.length, 2);
  for (const post of posts) {
    const path = post.author.name.split(' ').pop();
    assert.match(post.description, new RegExp('line from ' + path));
    assert.equal((post.description.match(/line from/g) || []).length, 1);
  }
});

test('a report that fails to build never fails the request', async (t) => {
  const posts = captureDiscord(t);
  const body = Object.defineProperty({}, 'error', { enumerable: true, get() { throw new Error('bad getter'); } });
  const res = mockRes();
  await reported(async (req, r) => r.status(500).json(body))(mockReq(), res);
  assert.equal(res.statusCode, 500);
  assert.equal(posts.length, 0);
});

test('nothing is posted without a webhook, and the response is unchanged', async (t) => {
  const originalUrl = process.env.DISCORD_WEBHOOK_LOGS;
  delete process.env.DISCORD_WEBHOOK_LOGS;
  t.after(() => { if (originalUrl !== undefined) process.env.DISCORD_WEBHOOK_LOGS = originalUrl; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('should not fetch'); };
  t.after(() => { globalThis.fetch = originalFetch; });

  const res = mockRes();
  await reported(async (req, r) => r.status(502).json({ error: 'generation-failed' }))(mockReq(), res);
  assert.equal(res.statusCode, 502);
});

test('storefront reports: shape, limits and rejects', () => {
  assert.equal(normaliseClientEvent(null), null);
  assert.equal(normaliseClientEvent([]), null);
  assert.equal(normaliseClientEvent({ message: 'no code' }), null);
  assert.equal(normaliseClientEvent({ code: 'Has Spaces' }), null);
  assert.equal(normaliseClientEvent({ code: '<script>' }), null);

  const event = normaliseClientEvent({
    level: 'warn',
    code: 'Turnstile-Error',
    message: 'x'.repeat(900),
    stack: 'y'.repeat(5000),
    page: '/pages/create-your-book?b=emma-the-goal&k=kb-book-1#top',
    context: {
      step: 'preview',
      status: 502,
      signed_in: false,
      'Bad Key': 'dropped',
      nested: { a: 1 },
      empty: '   ',
      long: 'z'.repeat(400)
    }
  });
  assert.equal(event.level, 'warn');
  assert.equal(event.code, 'turnstile-error');
  assert.equal(event.message.length, 500);
  assert.equal(event.stack.length, 2000);
  assert.equal(event.page, '/pages/create-your-book');
  assert.deepEqual(Object.keys(event.context), ['step', 'status', 'signed_in', 'long']);
  assert.equal(event.context.status, '502');
  assert.equal(event.context.signed_in, 'false');
  assert.equal(event.context.long.length, 160);

  assert.equal(normaliseClientEvent({ code: 'js-error', level: 'fatal' }).level, 'error');
  assert.equal(normaliseClientEvent({ code: 'js-error', page: 'https://evil.example/' }).page, '');
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => ['k' + i, 'v']));
  assert.equal(Object.keys(normaliseClientEvent({ code: 'js-error', context: many }).context).length, 16);
});

test('a storefront report is posted with the sender\'s details', async (t) => {
  const posts = captureDiscord(t);
  reportClientEvent(mockReq({ url: '/log' }), normaliseClientEvent({
    code: 'cart-add-failed',
    message: 'cart',
    page: '/pages/create-your-book',
    context: { status: 422 }
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(posts.length, 1);
  assert.equal(posts[0].title, '🔴 cart-add-failed');
  assert.equal(posts[0].author.name, 'Storefront · /pages/create-your-book');
  assert.equal(fieldsOf(posts[0]).Status, '`422`');
  assert.equal(fieldsOf(posts[0]).IP, '`203.0.113.7`');
});

const VISITOR = {
  ip: '203.0.113.7',
  country: 'FR',
  region: 'IDF',
  city: 'Paris',
  timezone: 'Europe/Paris',
  language: 'fr-FR',
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  origin: 'https://booktokids.com',
  requestId: 'cdg1::iad1::abc12-1760000000000-0123456789ab'
};

function apiReport(overrides = {}) {
  return {
    level: 'error',
    method: 'POST',
    path: '/api/preview',
    status: 502,
    code: 'generation-failed',
    notes: [
      { level: 'warn', at: 28000, text: '[generate] higgsfield marketing-studio/image/flare medium failed: higgsfield-timeout' },
      { level: 'error', at: 49900, text: '[preview] failed: Error: higgsfield-timeout\n    at generateWithHiggsfield (file://' + process.cwd() + '/lib/higgsfield.js:124:9)' }
    ],
    durationMs: 50123,
    request: { book: 'the-winning-goal', generation: 'k3x9p2m7q1', language: 'en', photo: '' },
    customer: 'anonymous',
    visitor: VISITOR,
    ...overrides
  };
}

test('API embed layout: colour, title, timeline and fields', () => {
  const embed = apiEmbed(apiReport());
  assert.equal(embed.color, 0xed4245);
  assert.equal(embed.title, '🔴 502 generation-failed');
  assert.equal(embed.author.name, 'API · POST /api/preview');
  assert.match(embed.description, /^```\n\+28\.0s WARN  \[generate\] higgsfield/);
  assert.match(embed.description, /\+49\.9s ERROR \[preview\] failed/);
  assert.match(embed.description, /at generateWithHiggsfield \(lib\/higgsfield\.js:124:9\)/, 'short stack paths');

  const fields = fieldsOf(embed);
  assert.equal(fields.Visitor, '🇫🇷 France · IDF · Paris\nEurope/Paris');
  assert.equal(fields.IP, '`203.0.113.7`');
  assert.equal(fields.Device, 'iPhone · iOS 18.5 · Mobile Safari 18\n`fr-FR`');
  assert.equal(fields.Book, '`the-winning-goal`');
  assert.equal(fields.Duration, '50.1 s');
  assert.equal(fields.Photo, undefined);
  assert.equal(embed.footer.text, VISITOR.requestId);

  const warn = apiEmbed(apiReport({ level: 'warn', status: 429, code: 'rate-limited', notes: [] }));
  assert.equal(warn.color, 0xf0b232);
  assert.equal(warn.title, '🟠 429 rate-limited');
  assert.equal(warn.description, undefined);
});

test('API embed stays inside Discord limits with huge log lines', () => {
  const notes = Array.from({ length: 30 }, (_, i) => ({ level: 'error', at: i * 100, text: 'x'.repeat(4000) }));
  const embed = apiEmbed(apiReport({ notes, visitor: { ...VISITOR, userAgent: 'Mozilla/5.0 '.repeat(200) } }));
  const total = [embed.title, embed.description, embed.author.name, embed.footer.text]
    .concat(embed.fields.map((f) => f.name + f.value))
    .reduce((n, str) => n + str.length, 0);
  assert.ok(total <= 6000, 'total ' + total);
  assert.ok(embed.description.startsWith('```\n') && embed.description.endsWith('\n```'));
  for (const f of embed.fields) assert.ok(f.value.length <= 1024);
});

test('preview and development deployments are tagged, with the deployment in the footer', (t) => {
  const saved = { VERCEL_ENV: process.env.VERCEL_ENV, VERCEL_REGION: process.env.VERCEL_REGION, VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, { VERCEL_ENV: 'preview', VERCEL_REGION: 'iad1', VERCEL_GIT_COMMIT_SHA: '89841dd0123456789' });
  const embed = apiEmbed(apiReport());
  assert.equal(embed.author.name, 'API (preview) · POST /api/preview');
  assert.equal(embed.footer.text, 'preview · iad1 · 89841dd · ' + VISITOR.requestId);
  process.env.VERCEL_ENV = 'production';
  assert.equal(apiEmbed(apiReport()).author.name, 'API · POST /api/preview');
});

test('storefront embed layout: context fields, page and redacted stack', () => {
  const embed = webEmbed({
    level: 'error',
    code: 'preview-failed',
    message: 'Failed to fetch',
    stack: 'TypeError: Failed to fetch\n    at run (https://booktokids.com/cdn/shop/t/3/assets/kb-start-personalising.js?v=17:940:21)\n    at https://pub.r2.dev/previews/emma_5_en_book_abc.jpg',
    page: '/products/the-winning-goal',
    context: { step: 'preview', status: '502', elapsed: '71.2 s', signed_in: 'false' }
  }, VISITOR);

  assert.equal(embed.title, '🔴 preview-failed');
  assert.equal(embed.author.name, 'Storefront · /products/the-winning-goal');
  assert.ok(embed.description.startsWith('```\nTypeError: Failed to fetch\n'), 'message is not printed twice');
  assert.ok(embed.description.includes('at run (assets/kb-start-personalising.js:940:21)'), embed.description);
  assert.ok(embed.description.includes('previews/…'));
  assert.ok(!embed.description.includes('emma'));
  const fields = fieldsOf(embed);
  assert.equal(fields.Step, '`preview`');
  assert.equal(fields['Signed in'], '`false`');
  assert.equal(fields.IP, '`203.0.113.7`');
});
