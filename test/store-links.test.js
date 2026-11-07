// Storefront links in Discord posts: book titles by handle, safe fallbacks.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bookLink, orderLink, pageLink, setBookTitles, storeOrigin } from '../lib/store-links.js';
import { postLiveEvent, summaryEmbed } from '../lib/event-feed.js';
import { resetDiscordThrottle, setDiscordOutbox } from '../lib/discord.js';

const STORE = 'https://booktokids.com';
const titles = new Map([['the-midnight-elf-workshop-personalized-christmas-book-for-girls', 'The Midnight Elf Workshop']]);
const HANDLE = 'the-midnight-elf-workshop-personalized-christmas-book-for-girls';

function withStore(t) {
  const saved = process.env.STORE_URL;
  process.env.STORE_URL = STORE;
  t.after(() => {
    if (saved === undefined) delete process.env.STORE_URL;
    else process.env.STORE_URL = saved;
  });
}

test('product pages show the book title, linked to the page the visitor saw', (t) => {
  withStore(t);
  assert.equal(storeOrigin(), STORE);
  assert.equal(pageLink('/products/' + HANDLE, titles), '[The Midnight Elf Workshop](' + STORE + '/products/' + HANDLE + ')');
  assert.equal(pageLink('/fr/products/' + HANDLE, titles), '[The Midnight Elf Workshop · fr](' + STORE + '/fr/products/' + HANDLE + ')');
  assert.equal(pageLink('/collections/all', titles), '[/collections/all](' + STORE + '/collections/all)');
  assert.equal(pageLink('/products/unknown-book', titles), '[/products/unknown-book](' + STORE + '/products/unknown-book)');
  assert.equal(bookLink('unknown-book', titles), '[unknown-book](' + STORE + '/products/unknown-book)');
  assert.equal(pageLink('/', titles), '[Home](' + STORE + '/)');
  assert.equal(pageLink('/de', titles), '[Home · de](' + STORE + '/de)');
});

test('orders link to Shopify admin: by id, or a search for their name', (t) => {
  const saved = process.env.SHOPIFY_SHOP;
  process.env.SHOPIFY_SHOP = 'book-to-kids.myshopify.com';
  t.after(() => {
    if (saved === undefined) delete process.env.SHOPIFY_SHOP;
    else process.env.SHOPIFY_SHOP = saved;
  });
  assert.equal(orderLink('5870000000001'), '[5870000000001](https://book-to-kids.myshopify.com/admin/orders/5870000000001)');
  assert.equal(orderLink('#btk-1009'), '[#btk-1009](https://book-to-kids.myshopify.com/admin/orders?query=%23btk-1009)');
  assert.equal(orderLink('x)[evil](https://evil.example'), '`x)[evil](https://evil.example`');
  process.env.SHOPIFY_SHOP = '';
  assert.equal(orderLink('#btk-1009'), '`#btk-1009`');
});

test('paths that would break a link, or hide a token, stay plain code', (t) => {
  withStore(t);
  assert.equal(pageLink('/checkouts/:id/thank-you', titles), '`/checkouts/:id/thank-you`');
  assert.equal(pageLink('/x)[evil](https://evil.example', titles), '`/x)[evil](https://evil.example`');
  assert.equal(pageLink('/products/' + HANDLE, titles, { origin: 'null' }), '`/products/' + HANDLE + '`');
  assert.equal(bookLink('x)[evil](https://evil.example', titles), '`x)[evil](https://evil.example`');
});

test('the visit card and the daily summary link pages by book title', async (t) => {
  withStore(t);
  setBookTitles(titles);
  const saved = process.env.DISCORD_WEBHOOK_VISITS;
  process.env.DISCORD_WEBHOOK_VISITS = 'https://discord.com/api/webhooks/4/visits-token';
  resetDiscordThrottle();
  setDiscordOutbox(null);
  const original = globalThis.fetch;
  const posts = [];
  globalThis.fetch = async (url, init = {}) => {
    posts.push(JSON.parse(init.body).embeds[0]);
    return new Response(null, { status: 204 });
  };
  t.after(() => {
    globalThis.fetch = original;
    if (saved === undefined) delete process.env.DISCORD_WEBHOOK_VISITS;
    else process.env.DISCORD_WEBHOOK_VISITS = saved;
    setBookTitles(new Map());
    resetDiscordThrottle();
  });

  const page = { name: 'page_viewed', clientId: 'c1', path: '/products/' + HANDLE, params: {}, referrer: '' };
  await postLiveEvent(page, { visit: 3, source: { label: 'chatgpt.com', campaign: '' } }, { userAgent: '', requestId: 'x' });
  const landing = posts[0].fields.find((f) => f.name === 'Landing page').value;
  assert.equal(landing, '[The Midnight Elf Workshop](' + STORE + '/products/' + HANDLE + ')');

  const pages = Object.fromEntries(Array.from({ length: 6 }, (_, i) => ['/products/' + HANDLE + '-' + 'x'.repeat(120) + i, 10 - i]));
  const embed = summaryEmbed({ day: '2026-10-19', visitors: 1, count: {}, pages, sources: {}, countries: {}, revenue: {}, orderSources: {} }, titles);
  const top = embed.fields.find((f) => f.name === 'Top pages').value;
  assert.ok(top.length <= 1024);
  assert.ok(top.split('\n').every((line) => /^\[[^\]]+\]\(https:\/\/booktokids\.com\/products\/[^)]+\) · \d+$/.test(line)), 'no line is cut mid-link');
});
