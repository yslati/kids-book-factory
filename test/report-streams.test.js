// Where a report goes: #logs for people, the bot report stream for bots and
// crawlers, the third-party stream for errors in other people's scripts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseClientEvent, reportClientEvent, streamFor, thirdPartyCause, withReporting } from '../lib/report.js';
import { resetDiscordThrottle, setDiscordOutbox } from '../lib/discord.js';
import { Audience, CrawlerKind, Verification } from '../lib/audience.js';
import { TABS } from '../lib/sheet.js';

const HOOKS = {
  LOGS: 'https://discord.com/api/webhooks/1/logs',
  BOT_REPORTS: 'https://discord.com/api/webhooks/2/bot-reports',
  THIRD_PARTY: 'https://discord.com/api/webhooks/3/third-party'
};

function captureStreams(t, hooks = HOOKS) {
  const saved = {};
  for (const name of Object.keys(HOOKS)) {
    saved[name] = process.env['DISCORD_WEBHOOK_' + name];
    if (hooks[name]) process.env['DISCORD_WEBHOOK_' + name] = hooks[name];
    else delete process.env['DISCORD_WEBHOOK_' + name];
  }
  resetDiscordThrottle();
  setDiscordOutbox(null);
  const originalFetch = globalThis.fetch;
  const posts = [];
  globalThis.fetch = async (url, init = {}) => {
    const stream = Object.keys(HOOKS).find((name) => String(url).startsWith(HOOKS[name]));
    posts.push({ stream, embed: JSON.parse(init.body).embeds[0] });
    return new Response(null, { status: 204 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const name of Object.keys(HOOKS)) {
      if (saved[name] === undefined) delete process.env['DISCORD_WEBHOOK_' + name];
      else process.env['DISCORD_WEBHOOK_' + name] = saved[name];
    }
    resetDiscordThrottle();
    setDiscordOutbox(null);
  });
  return posts;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const PERSON = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const RENDERER = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Reflectionbot/1.0;';
const CLAUDEBOT = 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)';

function req(userAgent, body) {
  return {
    method: 'POST', url: '/api/preview', query: {}, body,
    headers: { 'x-forwarded-for': '203.0.113.7', 'x-vercel-ip-country': 'US', 'user-agent': userAgent, origin: 'https://booktokids.com' }
  };
}

function res() {
  return {
    statusCode: 200, headersSent: false, body: undefined,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.headersSent = true; return this; },
    end() { this.headersSent = true; return this; }
  };
}

const fieldsOf = (embed) => Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));

test('streamFor: people to #logs, bots and crawlers to bot reports, third-party errors to their stream', () => {
  const person = { audience: Audience.human, name: '', kind: null, verification: Verification.unverifiable };
  const bot = { audience: Audience.bot, name: 'Headless', kind: null, verification: Verification.unverifiable };
  const crawler = { audience: Audience.crawler, name: 'Bingbot', kind: CrawlerKind.search, verification: Verification.verified };
  assert.deepEqual(streamFor(person, 'js-error'), { channel: 'logs', tab: TABS.logs });
  assert.deepEqual(streamFor(person, 'third-party-rejection'), { channel: 'third_party', tab: TABS.thirdParty });
  assert.deepEqual(streamFor(person, 'third-party-error'), { channel: 'third_party', tab: TABS.thirdParty });
  assert.deepEqual(streamFor(bot, 'third-party-rejection'), { channel: 'bot_reports', tab: TABS.botReports });
  assert.deepEqual(streamFor(crawler, ''), { channel: 'bot_reports', tab: TABS.botReports });
});

test('a storefront error from a bot posts to the bot report stream, naming the agent', async (t) => {
  const posts = captureStreams(t);
  reportClientEvent(req(RENDERER), { level: 'warn', code: 'third-party-rejection', message: 'Failed to fetch', stack: '', page: '/', context: {} });
  await settle();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].stream, 'BOT_REPORTS');
  assert.equal(fieldsOf(posts[0].embed).Agent, 'Reflectionbot/1.0; · bot');
});

test('a third-party error from a person posts to the third-party stream; our own errors stay in #logs', async (t) => {
  const posts = captureStreams(t);
  reportClientEvent(req(PERSON), { level: 'warn', code: 'third-party-rejection', message: 'Failed to fetch', stack: '', page: '/', context: {} });
  reportClientEvent(req(PERSON), { level: 'error', code: 'js-error', message: 'boom', stack: '', page: '/', context: {} });
  await settle();
  assert.deepEqual(posts.map((p) => p.stream), ['THIRD_PARTY', 'LOGS']);
  assert.equal(fieldsOf(posts[1].embed).Agent, undefined, 'a person needs no agent field');
});

test('a failed API request from a crawler posts to the bot report stream', async (t) => {
  const posts = captureStreams(t);
  const handler = withReporting(async (request, response) => response.status(403).json({ error: 'forbidden-origin' }));
  await handler(req(CLAUDEBOT, {}), res());
  await settle();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].stream, 'BOT_REPORTS');
  assert.equal(fieldsOf(posts[0].embed).Agent, 'ClaudeBot · AI crawler');
});

test('a stream without a webhook falls back to #logs, so nothing is lost before the variables exist', async (t) => {
  const posts = captureStreams(t, { LOGS: HOOKS.LOGS });
  reportClientEvent(req(RENDERER), { level: 'warn', code: 'third-party-rejection', message: 'Failed to fetch', stack: '', page: '/', context: {} });
  reportClientEvent(req(PERSON), { level: 'warn', code: 'third-party-error', message: 'x', stack: '', page: '/', context: {} });
  await settle();
  assert.deepEqual(posts.map((p) => p.stream), ['LOGS', 'LOGS']);
});

test('third-party reports and their repeat summary are info, with the likely cause', async (t) => {
  const posts = captureStreams(t);
  const shopify = normaliseClientEvent({
    level: 'warn', code: 'third-party-rejection', message: 'Failed to fetch',
    stack: 'TypeError: Failed to fetch\n    at b.exportTo (https://cdn.shopify.com/shopifycloud/shop-js/modules/v2/chunk.utils.esm.js:1:6141)'
  });
  const summary = normaliseClientEvent({ level: 'warn', code: 'third-party-summary', message: '×3 Failed to fetch', context: { script: '/cdn/wpm/b154515.js' } });
  assert.equal(shopify.level, 'info');
  assert.equal(summary.level, 'info');
  assert.match(shopify.cause, /^Shopify's own analytics or pixel script lost a network request/);
  assert.match(summary.cause, /^Shopify's own analytics/);
  assert.equal(normaliseClientEvent({ level: 'warn', code: 'page-summary', message: '×2 boom' }).cause, undefined);

  reportClientEvent(req(PERSON), shopify);
  reportClientEvent(req(PERSON), summary);
  await settle();
  assert.deepEqual(posts.map((p) => p.stream), ['THIRD_PARTY', 'THIRD_PARTY']);
  assert.equal(posts[0].embed.title, 'ℹ️ third-party-rejection');
  assert.equal(posts[0].embed.fields[0].name, 'Cause');
});

test('the cause tells network failures from script errors, and Shopify from other scripts', () => {
  assert.match(thirdPartyCause({ message: 'Load failed' }), /^A script that isn't the theme's .* lost a network request/);
  assert.match(thirdPartyCause({ message: 't.entries.at is not a function', stack: 'at https://booktokids.com/cdn/shopifycloud/perf-kit/shopify-perf-kit-3.16.1.min.js:1:94620' }), /^An error inside Shopify's own scripts/);
  assert.match(thirdPartyCause({ message: 'x is undefined' }), /^An error in a script that isn't the theme's/);
});
