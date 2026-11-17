// Bot and crawler visits: which stream they take, what the post and the sheet
// row say, and how /events and the share link route them away from #visits.

import test from 'node:test';
import assert from 'node:assert/strict';
import { botVisitEmbed, botVisitRow, botStreamFor, postBotVisit } from '../lib/bot-feed.js';
import { Audience, CrawlerKind, Verification } from '../lib/audience.js';
import { TABS } from '../lib/sheet.js';
import { resetDiscordThrottle, setDiscordOutbox } from '../lib/discord.js';
import events from '../api/events.js';

const HOOKS = {
  VISITS: 'https://discord.com/api/webhooks/1/visits',
  BOTS: 'https://discord.com/api/webhooks/2/bots',
  CRAWLERS: 'https://discord.com/api/webhooks/3/crawlers'
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
const fieldsOf = (embed) => Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));

const GOOGLEBOT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/120.0.0.0 Safari/537.36';
const HEADLESS = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36';
const PERSON = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const crawler = { audience: Audience.crawler, name: 'Googlebot', kind: CrawlerKind.search, verification: Verification.verified };
const bot = { audience: Audience.bot, name: 'Headless', kind: null, verification: Verification.unverifiable };
const visitor = { ip: '66.249.66.1', country: 'US', region: 'CA', city: 'Mountain View', timezone: 'America/Los_Angeles', userAgent: GOOGLEBOT, language: '', origin: '', requestId: 'iad1::abc' };

test('botStreamFor: crawlers and bots each have a channel, a tab and a daily counter', () => {
  assert.deepEqual(botStreamFor(crawler), { channel: 'crawlers', tab: TABS.crawlerVisits, counter: 'crawler_visits' });
  assert.deepEqual(botStreamFor(bot), { channel: 'bots', tab: TABS.botVisits, counter: 'bot_visits' });
});

test('a crawler visit embed names the agent, the page and where it came from', () => {
  const embed = botVisitEmbed(crawler, visitor, { page: '/products/the-dragon-rider', referrer: 'https://www.google.com' });
  assert.equal(embed.author.name, 'Crawler visit');
  assert.equal(embed.title, '🕷️ Googlebot · search engine · verified');
  const f = fieldsOf(embed);
  assert.match(f.Page, /the-dragon-rider/);
  assert.equal(f.Referrer, '`https://www.google.com`');
  assert.match(f.Visitor, /United States/);
  assert.equal(f.IP, '`66.249.66.1`');
  assert.match(f['User agent'], /Googlebot/);
});

test('a bot visit embed is marked as a bot', () => {
  const embed = botVisitEmbed(bot, { ...visitor, userAgent: HEADLESS }, { page: '/' });
  assert.equal(embed.author.name, 'Bot visit');
  assert.equal(embed.title, '🤖 Headless · bot');
  assert.equal(fieldsOf(embed).Referrer, undefined);
});

test('a bot visit row has the agent, the page, the IP and the place', () => {
  const row = botVisitRow(crawler, visitor, { page: '/collections/girls', referrer: 'https://www.bing.com' });
  assert.ok(row.Date);
  assert.equal(row.Agent, 'Googlebot · search engine · verified');
  assert.match(row.Page, /\/collections\/girls$/);
  assert.equal(row.Referrer, 'https://www.bing.com');
  assert.equal(row.IP, '66.249.66.1');
  assert.equal(row.Country, 'United States');
  assert.equal(row.City, 'Mountain View');
  assert.match(row.Device, /🤖/);
});

test('postBotVisit posts to the stream, or to #visits while the stream has no webhook', async (t) => {
  const posts = captureStreams(t, { VISITS: HOOKS.VISITS, CRAWLERS: HOOKS.CRAWLERS });
  await postBotVisit(crawler, visitor, { page: '/' });
  await postBotVisit(bot, visitor, { page: '/' });
  assert.deepEqual(posts.map((p) => p.stream), ['CRAWLERS', 'VISITS']);
});

function res() {
  return {
    statusCode: 200, body: undefined, headersSent: false,
    setHeader() {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; },
    end() { this.headersSent = true; return this; }
  };
}

function req(body, userAgent, ip = '203.0.113.7') {
  return { method: 'POST', url: '/events', headers: { 'x-forwarded-for': ip, 'x-vercel-ip-country': 'US', origin: 'null', 'user-agent': userAgent }, body: JSON.stringify(body), query: {} };
}

test('/events: a page view from a bot posts to the bot stream, never to #visits', async (t) => {
  const posts = captureStreams(t);
  const r = res();
  await events(req({ event: 'page_viewed', clientId: 'c-bot', path: '/products/the-dragon-rider' }, HEADLESS), r);
  assert.equal(r.statusCode, 204);
  await settle();
  assert.deepEqual(posts.map((p) => p.stream), ['BOTS']);
  assert.equal(posts[0].embed.title, '🤖 Headless · bot');
});

test('/events: the theme beacon counts for a bot and is ignored for a person', async (t) => {
  const posts = captureStreams(t);
  let r = res();
  await events(req({ event: 'crawler_seen', path: '/pages/custom-story', referrer: 'https://www.google.com/' }, HEADLESS, '198.51.100.3'), r);
  assert.equal(r.statusCode, 204);
  r = res();
  await events(req({ event: 'crawler_seen', path: '/pages/custom-story' }, PERSON, '198.51.100.4'), r);
  assert.equal(r.statusCode, 204);
  await settle();
  assert.deepEqual(posts.map((p) => p.stream), ['BOTS']);
  assert.match(fieldsOf(posts[0].embed).Page, /custom-story/);
});

test('/events: other pixel events from a bot are not posted', async (t) => {
  const posts = captureStreams(t);
  await events(req({ event: 'product_viewed', clientId: 'c-bot', path: '/products/x', product: { title: 'X' } }, HEADLESS, '198.51.100.5'), res());
  await events(req({ event: 'search_submitted', clientId: 'c-bot', path: '/search', search: { query: 'dragon', results: 3 } }, HEADLESS, '198.51.100.5'), res());
  await settle();
  assert.deepEqual(posts, []);
});
