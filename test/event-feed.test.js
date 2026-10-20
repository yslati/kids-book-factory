// #events live posts and the daily summary, with Discord stubbed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { postLiveEvent, postSummary, summaryEmbed } from '../lib/event-feed.js';
import { resetDiscordThrottle, setDiscordOutbox } from '../lib/discord.js';

const WEBHOOK = 'https://discord.com/api/webhooks/3/events-token';

function stubDiscord(t) {
  const saved = process.env.DISCORD_WEBHOOK_EVENTS;
  process.env.DISCORD_WEBHOOK_EVENTS = WEBHOOK;
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
    if (saved === undefined) delete process.env.DISCORD_WEBHOOK_EVENTS;
    else process.env.DISCORD_WEBHOOK_EVENTS = saved;
    resetDiscordThrottle();
  });
  return posts;
}

const visitor = {
  ip: '203.0.113.7', country: 'FR', region: 'IDF', city: 'Paris', timezone: 'Europe/Paris', language: 'fr-FR',
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 389.0.0.29.81 (iPhone15,2; iOS 17_6; fr_FR)',
  origin: 'null', requestId: 'cdg1::iad1::abc'
};
const fieldsOf = (embed) => Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));

test('a page view that starts a visit posts the visit; other views only count', async (t) => {
  const posts = stubDiscord(t);
  const page = { name: 'page_viewed', clientId: 'c1', path: '/products/the-winning-goal', params: {}, referrer: '' };
  await postLiveEvent(page, { visit: 3, source: { label: 'instagram / paid', campaign: 'spring · reel-2' } }, visitor);
  await postLiveEvent(page, { visit: null, source: null }, visitor);
  await postLiveEvent({ ...page, name: 'product_viewed' }, { visit: null, source: null }, visitor);

  assert.equal(posts.length, 1);
  assert.equal(posts[0].title, '🆕 instagram / paid');
  const f = fieldsOf(posts[0]);
  assert.equal(f.Count, '3rd visit from this browser');
  assert.equal(f['Landing page'], '`/products/the-winning-goal`');
  assert.equal(f.Campaign, '`spring · reel-2`');
  assert.equal(f.Device, 'iPhone · iOS 17.6 · Instagram 389\n`fr-FR`');
  assert.equal(f.Origin, undefined, 'the pixel\'s origin says nothing');
});

test('add-to-cart, checkout and order cards', async (t) => {
  const posts = stubDiscord(t);
  const source = { label: 'tiktok ads', campaign: '' };
  await postLiveEvent({ name: 'product_added_to_cart', clientId: 'c1', path: '/products/x', params: {}, referrer: '', product: { title: 'The Winning Goal', variant: 'Hardcover', quantity: 1, price: { amount: 34.99, currency: 'EUR' }, total: { amount: 34.99, currency: 'EUR' } } }, { visit: null, source }, visitor);
  const checkout = { orderId: '5870000000001', firstOrder: true, total: { amount: 59.98, currency: 'EUR' }, items: [{ title: 'The Winning Goal', variant: 'Hardcover', quantity: 1 }, { title: 'Lina', variant: 'Softcover', quantity: 1 }], discounts: ['WELCOME10'] };
  await postLiveEvent({ name: 'checkout_started', clientId: 'c1', path: '/checkouts/:id', params: {}, referrer: '', checkout: { ...checkout, orderId: '' } }, { visit: null, source }, visitor);
  await postLiveEvent({ name: 'checkout_completed', clientId: 'c1', path: '/checkouts/:id/thank-you', params: {}, referrer: '', checkout }, null, visitor);

  assert.equal(posts[0].title, '🛒 The Winning Goal · €34.99');
  assert.equal(fieldsOf(posts[0]).Source, '`tiktok ads`');
  assert.equal(posts[1].title, '💳 Checkout · €59.98 · 2 items');
  assert.equal(posts[2].title, '💰 Order · €59.98 · 2 items');
  assert.equal(posts[2].color, 0x57f287);
  const order = fieldsOf(posts[2]);
  assert.equal(order.Order, '`5870000000001`');
  assert.equal(order.Customer, 'first order');
  assert.equal(order.Items, 'The Winning Goal · Hardcover ×1\nLina · Softcover ×1');
  assert.equal(order['Discount codes'], '`WELCOME10`');
  assert.equal(order.Source, undefined, 'no source without Redis');
});

test('the daily summary: headline, funnel, conversion and top lists', async (t) => {
  const embed = summaryEmbed({
    day: '2026-10-19',
    visitors: 312,
    count: { visits: 401, page_viewed: 1240, product_viewed: 520, preview_started: 48, preview_ready: 45, preview_failed: 3, product_added_to_cart: 12, checkout_started: 7, checkout_completed: 3, collection_viewed: 90, search_submitted: 4, cart_viewed: 20 },
    pages: { '/': 180, '/products/the-winning-goal': 230, '/collections/girls': 90 },
    sources: { 'instagram / paid': 180, direct: 95, 'google.com': 60 },
    countries: { FR: 150, MA: 80 },
    revenue: { EUR: 104.97 },
    orderSources: { 'instagram / paid': 2, direct: 1 }
  });
  assert.match(embed.title, /^📊 Monday,? 19 October 2026 \(UTC\)$/);
  assert.equal(embed.description, '**312** visitors · **401** visits · **1,240** page views');
  const f = fieldsOf(embed);
  assert.equal(f.Previews, '48 started\n45 ready · 3 failed');
  assert.equal(f.Orders, '3\n€104.97');
  assert.equal(f.Conversion, '0.7% of visits ordered\n26.7% of previews reached the cart');
  assert.equal(f['Top sources'], '`instagram / paid` · 180\n`direct` · 95\n`google.com` · 60');
  assert.equal(f['Top pages'].split('\n')[0], '`/products/the-winning-goal` · 230');
  assert.equal(f['Top countries'], '🇫🇷 France · 150\n🇲🇦 Morocco · 80');
  assert.equal(f['Orders by source'], '`instagram / paid` · 2\n`direct` · 1');

  const empty = fieldsOf(summaryEmbed({ day: '2026-10-19', visitors: 0, count: {}, pages: {}, sources: {}, countries: {}, revenue: {}, orderSources: {} }));
  assert.equal(empty['Top sources'], '—');
  assert.equal(empty.Conversion, '— of visits ordered\n— of previews reached the cart');
  assert.equal(empty['Orders by source'], undefined);

  const posts = stubDiscord(t);
  assert.equal(await postSummary({ day: '2026-10-19', visitors: 1, count: {}, pages: {}, sources: {}, countries: {}, revenue: {}, orderSources: {} }), true);
  assert.equal(posts.length, 1);
});
