// Discord toolkit: formatting pieces and per-channel delivery, against a
// stubbed fetch.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  code, deviceSummary, discordConfigured, finish, messageLink, place, plain, postToDiscord, redact,
  resetDiscordThrottle, setDiscordOutbox
} from '../lib/discord.js';

const LOGS = 'https://discord.com/api/webhooks/1/logs-token';
const PREVIEWS = 'https://discord.com/api/webhooks/2/previews-token';

function stubFetch(t, handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    return handler(String(url), init);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

function withWebhooks(t, hooks) {
  const keys = ['DISCORD_WEBHOOK_LOGS', 'DISCORD_WEBHOOK_PREVIEWS'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, hooks);
  resetDiscordThrottle();
  setDiscordOutbox(null);
  t.after(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetDiscordThrottle();
    setDiscordOutbox(null);
  });
}

// Enough of Upstash's client for the outbox: lists, a lock, a pipeline.
function fakeRedis() {
  const lists = new Map();
  const keys = new Map();
  const ops = [];
  const copy = (v) => JSON.parse(JSON.stringify(v));
  const list = (k) => {
    if (!lists.has(k)) lists.set(k, []);
    return lists.get(k);
  };
  const redis = {
    lists,
    keys,
    ops,
    async lrange(k, start, stop) {
      ops.push(['lrange', k]);
      return list(k).slice(start, stop === -1 ? undefined : stop + 1).map(copy);
    },
    async lpop(k) {
      ops.push(['lpop', k]);
      return list(k).shift() || null;
    },
    async set(k, v, opts = {}) {
      ops.push(['set', k, opts]);
      if (opts.nx && keys.has(k)) return null;
      keys.set(k, v);
      return 'OK';
    },
    async del(k) {
      ops.push(['del', k]);
      keys.delete(k);
      return 1;
    },
    pipeline() {
      const steps = [];
      const p = {
        rpush(k, v) { ops.push(['rpush', k]); steps.push(() => list(k).push(copy(v))); return p; },
        ltrim(k, start, stop) { ops.push(['ltrim', k, start, stop]); return p; },
        expire(k, seconds) { ops.push(['expire', k, seconds]); return p; },
        async exec() { steps.forEach((step) => step()); return []; }
      };
      return p;
    }
  };
  return redis;
}

const message = (title = 'x') => ({ embeds: [finish({ title, fields: [], footer: { text: 'production · iad1' } })] });

test('device labels: phones, in-app browsers, desktops and bots', () => {
  assert.equal(deviceSummary('Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'), 'iPhone · iOS 18.5 · Mobile Safari 18');
  assert.equal(deviceSummary('Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 389.0.0.29.81 (iPhone15,2; iOS 17_6; fr_FR)'), 'iPhone · iOS 17.6 · Instagram 389');
  assert.equal(deviceSummary('Mozilla/5.0 (Linux; Android 13; SM-A536B Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.100 Mobile Safari/537.36 trill_370103 AppName/musical_ly app_version/37.1.3 BytedanceWebview/d8a21c6'), 'SM-A536B · Android 13 · TikTok 37');
  assert.equal(deviceSummary('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'), 'Android · Chrome 141', 'frozen Android version and model are dropped');
  assert.equal(deviceSummary('Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36'), 'SM-S918B · Android 14 · Samsung Internet 28');
  assert.equal(deviceSummary('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0'), 'Windows · Edge 141');
  assert.equal(deviceSummary('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0'), 'Mac OS · Firefox 144', 'frozen desktop OS version is dropped');
  assert.equal(deviceSummary('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), '🤖 Google');
  assert.equal(deviceSummary('curl/8.7.1'), '🤖 curl/8.7.1');
  assert.equal(deviceSummary('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36'), '🤖 Headless');
  // A phone brand with "bot" in its name is still a phone.
  assert.equal(deviceSummary('Mozilla/5.0 (Linux; Android 12; Cubot KingKong Power) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'), 'Cubot KingKong Power · Android 12 · Chrome 130');
  assert.equal(deviceSummary(''), 'unknown');
});

test('redacts object keys and URL parameters that carry a name or token', () => {
  assert.equal(
    redact('Key: photos/emma_5_en_k3x9p2m7q1.jpg and https://pub.r2.dev/previews/emma_5_en_the-goal_k3x9p2m7q1.jpg'),
    'Key: photos/… and https://pub.r2.dev/previews/…'
  );
  assert.equal(
    redact('/pages/create-your-book?b=emma-the-goal&k=kb-book-1 /me/previews?customer_id=1&customer_token=abc&name=Emma'),
    '/pages/create-your-book?b=…&k=kb-book-1 /me/previews?customer_id=1&customer_token=…&name=…'
  );
  // Source paths that only look similar are left alone.
  assert.equal(redact('at /var/task/lib/user-previews.js:58'), 'at /var/task/lib/user-previews.js:58');
});

test('code spans and titles neutralise markdown and mentions', () => {
  assert.equal(code('a`b'), '`aˋb`');
  assert.equal(code('[click](https://evil.example) @everyone'), '`[click](https://evil.example) @everyone`');
  assert.equal(code(''), '—');
  assert.equal(plain('**Emma** [x](https://evil.example) @everyone'), 'Emma x(https://evil.example) everyone');
  assert.equal(plain('The Winning Goal (Hardcover)'), 'The Winning Goal (Hardcover)');
});

test('visitor place: flag, country, region, city and time zone', () => {
  assert.equal(place({ country: 'FR', region: 'IDF', city: 'Paris', timezone: 'Europe/Paris' }), '🇫🇷 France · IDF · Paris\nEurope/Paris');
  assert.equal(place({ country: 'BR', region: 'SP', city: 'São Paulo', timezone: '' }), '🇧🇷 Brazil · SP · São Paulo');
  assert.equal(place({ country: '', region: '', city: '', timezone: '' }), 'unknown');
  assert.match(place({ country: 'US', region: 'NY', city: '[x](https://evil.example)', timezone: '' }), /`\[x\]\(https:\/\/evil\.example\)`/);
});

test('embeds stay inside Discord limits', () => {
  const embed = finish({
    title: 't'.repeat(400),
    author: { name: 'a'.repeat(400) },
    description: '```\n' + 'd'.repeat(5000) + '\n```',
    fields: Array.from({ length: 30 }, (_, i) => ({ name: 'f' + i, value: 'v'.repeat(300), inline: true })),
    footer: { text: '' }
  });
  const total = [embed.title, embed.description || '', embed.author.name]
    .concat(embed.fields.map((f) => f.name + f.value))
    .reduce((n, s) => n + s.length, 0);
  assert.equal(embed.title.length, 256);
  assert.equal(embed.author.name.length, 256);
  assert.ok(embed.fields.length <= 25);
  assert.equal(embed.footer, undefined, 'no empty footer');
  assert.ok(total <= 6000, 'total ' + total);
});

test('each channel reads its own webhook variable', (t) => {
  withWebhooks(t, { DISCORD_WEBHOOK_LOGS: LOGS });
  assert.equal(discordConfigured('logs'), true);
  assert.equal(discordConfigured('previews'), false);
});

test('nothing is sent to a channel without a webhook', async (t) => {
  withWebhooks(t, {});
  const calls = stubFetch(t, () => { throw new Error('should not fetch'); });
  assert.equal(await postToDiscord('logs', message()), null);
  assert.equal(calls.length, 0);
});

test('posts to the named channel with mentions disabled', async (t) => {
  withWebhooks(t, { DISCORD_WEBHOOK_LOGS: LOGS, DISCORD_WEBHOOK_PREVIEWS: PREVIEWS });
  const calls = stubFetch(t, () => new Response(null, { status: 204 }));
  const msg = message('hello');
  assert.equal(await postToDiscord('previews', msg), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, PREVIEWS);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(calls[0].body.allowed_mentions, { parse: [] });
  assert.deepEqual(calls[0].body.embeds, msg.embeds);
});

test('with wait, returns the created message', async (t) => {
  withWebhooks(t, { DISCORD_WEBHOOK_PREVIEWS: PREVIEWS });
  const calls = stubFetch(t, () => new Response(JSON.stringify({ id: '111', channel_id: '222' }), { status: 200 }));
  assert.deepEqual(await postToDiscord('previews', message(), { wait: true }), { id: '111', channel_id: '222' });
  assert.equal(calls[0].url, PREVIEWS + '?wait=true');
});

// Discord's rate-limit headers, as it sends them on every response.
function limited(status, { remaining = 4, resetAfter = 1, body = null } = {}) {
  return new Response(body && JSON.stringify(body), {
    status,
    headers: { 'x-ratelimit-limit': '5', 'x-ratelimit-remaining': String(remaining), 'x-ratelimit-reset-after': String(resetAfter) }
  });
}

test('no fixed cap: posts go out while Discord reports room', async (t) => {
  withWebhooks(t, { DISCORD_WEBHOOK_LOGS: LOGS });
  const calls = stubFetch(t, () => limited(204));
  for (let i = 0; i < 40; i++) assert.equal(await postToDiscord('logs', message()), true);
  assert.equal(calls.length, 40);
});

test('when the window is full, the next post waits for it to reopen', async (t) => {
  withWebhooks(t, { DISCORD_WEBHOOK_LOGS: LOGS });
  const calls = stubFetch(t, () => limited(204, { remaining: 0, resetAfter: 0.08 }));
  await postToDiscord('logs', message());
  const started = Date.now();
  assert.equal(await postToDiscord('logs', message()), true);
  assert.ok(Date.now() - started >= 60, 'waited ' + (Date.now() - started) + ' ms');
  assert.equal(calls.length, 2);
});

test('a 429 waits for retry_after and retries; other channels keep posting', async (t) => {
  withWebhooks(t, { DISCORD_WEBHOOK_LOGS: LOGS, DISCORD_WEBHOOK_PREVIEWS: PREVIEWS });
  let logsCalls = 0;
  const calls = stubFetch(t, (url) => {
    if (url === PREVIEWS) return limited(204);
    logsCalls++;
    return logsCalls === 1
      ? limited(429, { remaining: 0, body: { message: 'You are being rate limited.', retry_after: 0.05, global: false } })
      : limited(204);
  });

  const logs = postToDiscord('logs', message());
  assert.equal(await postToDiscord('previews', message()), true, 'other channels are not held up');
  assert.equal(await logs, true);
  assert.equal(calls.filter((c) => c.url === LOGS).length, 2);
});

// Vercel's per-invocation deadline, as @vercel/functions getDeadline() reads it.
function withDeadline(t, msFromNow) {
  const key = Symbol.for('@vercel/request-context');
  const saved = globalThis[key];
  globalThis[key] = { get: () => ({ deadline: Date.now() + msFromNow, waitUntil() {} }) };
  t.after(() => {
    if (saved === undefined) delete globalThis[key];
    else globalThis[key] = saved;
  });
}

// A webhook that allows `limit` posts per `windowMs`, like Discord's.
function discordWindow({ limit = 5, windowMs = 120 } = {}) {
  let start = 0;
  let used = 0;
  return () => {
    const now = Date.now();
    if (now - start >= windowMs) {
      start = now;
      used = 0;
    }
    const resetAfter = (start + windowMs - now) / 1000;
    if (used >= limit) return limited(429, { remaining: 0, resetAfter, body: { message: 'You are being rate limited.', retry_after: resetAfter, global: false } });
    used++;
    return limited(204, { remaining: limit - used, resetAfter });
  };
}

test('a burst queues for the window: every post arrives, in order, with no 429', async (t) => {
  withWebhooks(t, { DISCORD_WEBHOOK_LOGS: LOGS });
  const respond = discordWindow();
  const statuses = [];
  const calls = stubFetch(t, () => {
    const res = respond();
    statuses.push(res.status);
    return res;
  });
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => postToDiscord('logs', message('post ' + (i + 1)))));
  assert.deepEqual(results, Array(12).fill(true));
  assert.deepEqual(calls.map((c) => c.body.embeds[0].title), Array.from({ length: 12 }, (_, i) => 'post ' + (i + 1)));
  assert.ok(!statuses.includes(429), statuses.join(','));
});

test('without Upstash, a post that misses the deadline is lost, and the next one says so', async (t) => {
  withWebhooks(t, { DISCORD_WEBHOOK_LOGS: LOGS });
  withDeadline(t, 3000);
  let ok = false;
  const calls = stubFetch(t, () => (ok
    ? limited(204)
    : limited(429, { remaining: 0, body: { message: 'You are being rate limited.', retry_after: 1, global: false } })));

  assert.equal(await postToDiscord('logs', message()), null, 'retry_after runs past the deadline');
  assert.equal(await postToDiscord('logs', message()), null, 'window still closed');
  assert.equal(calls.length, 1);

  ok = true;
  await new Promise((resolve) => setTimeout(resolve, 1050));
  assert.equal(await postToDiscord('logs', message()), true);
  assert.match(calls[1].body.embeds[0].footer.text, /^production · iad1 · 2 earlier lost$/, 'no Upstash here, so they were lost');
  assert.equal(await postToDiscord('logs', message()), true);
  assert.equal(calls[2].body.embeds[0].footer.text, 'production · iad1', 'counted once');
});

test('a window that reopens only after the deadline drops the post at once', async (t) => {
  withWebhooks(t, { DISCORD_WEBHOOK_LOGS: LOGS });
  const calls = stubFetch(t, () => limited(204, { remaining: 0, resetAfter: 100 }));
  await postToDiscord('logs', message());
  const started = Date.now();
  assert.equal(await postToDiscord('logs', message()), null);
  assert.ok(Date.now() - started < 50);
  assert.equal(calls.length, 1);
});

test('a deleted webhook is not used again', async (t) => {
  withWebhooks(t, { DISCORD_WEBHOOK_LOGS: LOGS });
  const calls = stubFetch(t, () => new Response('{"message":"Unknown Webhook","code":10015}', { status: 404 }));
  assert.equal(await postToDiscord('logs', message()), null);
  assert.equal(await postToDiscord('logs', message()), null);
  assert.equal(calls.length, 1);
});

test('a failed post never throws', async (t) => {
  withWebhooks(t, { DISCORD_WEBHOOK_LOGS: LOGS });
  stubFetch(t, () => { throw new TypeError('fetch failed'); });
  assert.equal(await postToDiscord('logs', message()), null);
});

test('message links read the server id from the webhook once', async (t) => {
  withWebhooks(t, { DISCORD_WEBHOOK_PREVIEWS: PREVIEWS });
  const calls = stubFetch(t, () => new Response(JSON.stringify({ guild_id: '999', channel_id: '222' }), { status: 200 }));
  const posted = { id: '111', channel_id: '222' };
  assert.equal(await messageLink('previews', posted), 'https://discord.com/channels/999/222/111');
  assert.equal(await messageLink('previews', { id: '112', channel_id: '222' }), 'https://discord.com/channels/999/222/112');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, PREVIEWS);
  assert.equal(await messageLink('previews', null), '');
});

const OUTBOX = 'kbf:discord:outbox:logs';

test('a post Discord cannot take is saved, then sent after the next success, oldest first', async (t) => {
  withWebhooks(t, { DISCORD_WEBHOOK_LOGS: LOGS });
  const redis = fakeRedis();
  setDiscordOutbox(redis);
  let down = true;
  const calls = stubFetch(t, () => (down ? new Response('upstream error', { status: 503 }) : limited(204)));

  assert.equal(await postToDiscord('logs', message('first')), null);
  assert.equal(await postToDiscord('logs', message('second')), null);
  assert.deepEqual(redis.lists.get(OUTBOX).map((m) => m.embeds[0].title), ['first', 'second']);
  assert.ok(redis.ops.some(([op, , start, stop]) => op === 'ltrim' && start === -10000 && stop === -1), 'capped');
  assert.ok(redis.ops.some(([op, , seconds]) => op === 'expire' && seconds === 30 * 86400), 'expires in 30 days');

  down = false;
  assert.equal(await postToDiscord('logs', message('third')), true);
  assert.deepEqual(calls.slice(2).map((c) => c.body.embeds[0].title), ['third', 'first', 'second']);
  assert.equal(calls[3].body.embeds[0].footer.text, 'production · iad1 · sent late');
  assert.deepEqual(redis.lists.get(OUTBOX), []);
  assert.equal(redis.keys.size, 0, 'lock released');
});

test('a deleted webhook saves every post until a deploy fixes it', async (t) => {
  withWebhooks(t, { DISCORD_WEBHOOK_LOGS: LOGS });
  const redis = fakeRedis();
  setDiscordOutbox(redis);
  const calls = stubFetch(t, () => new Response('{"message":"Unknown Webhook","code":10015}', { status: 404 }));
  await postToDiscord('logs', message('a'));
  await postToDiscord('logs', message('b'));
  assert.equal(calls.length, 1, 'not called again');
  assert.deepEqual(redis.lists.get(OUTBOX).map((m) => m.embeds[0].title), ['a', 'b']);
});

test('a message Discord rejects outright is not saved', async (t) => {
  withWebhooks(t, { DISCORD_WEBHOOK_LOGS: LOGS });
  const redis = fakeRedis();
  setDiscordOutbox(redis);
  stubFetch(t, () => new Response('{"message":"Invalid Form Body","code":50035}', { status: 400 }));
  assert.equal(await postToDiscord('logs', message()), null);
  assert.equal(redis.lists.get(OUTBOX), undefined);
});

test('saved posts from another instance go out after this one first succeeds, checked once', async (t) => {
  withWebhooks(t, { DISCORD_WEBHOOK_LOGS: LOGS });
  const redis = fakeRedis();
  redis.lists.set(OUTBOX, [message('from yesterday')]);
  setDiscordOutbox(redis);
  const calls = stubFetch(t, () => limited(204));

  await postToDiscord('logs', message('today'));
  await postToDiscord('logs', message('later'));
  assert.deepEqual(calls.map((c) => c.body.embeds[0].title), ['today', 'from yesterday', 'later']);
  assert.equal(redis.ops.filter(([op]) => op === 'lrange').length, 3, 'one look, one read, one empty read; none after');
});

test('only one instance sends saved posts at a time', async (t) => {
  withWebhooks(t, { DISCORD_WEBHOOK_LOGS: LOGS });
  const redis = fakeRedis();
  redis.lists.set(OUTBOX, [message('saved')]);
  redis.keys.set(OUTBOX + ':lock', 1);
  setDiscordOutbox(redis);
  const calls = stubFetch(t, () => limited(204));
  await postToDiscord('logs', message('new'));
  assert.deepEqual(calls.map((c) => c.body.embeds[0].title), ['new']);
  assert.equal(redis.lists.get(OUTBOX).length, 1, 'left for the instance holding the lock');
});
