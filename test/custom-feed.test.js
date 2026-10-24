// #custom-generation feed: the request with the photo, the cover as a
// follow-up linked to it, and the add-to-cart card, against a stubbed Discord.

import test from 'node:test';
import assert from 'node:assert/strict';
import { announceCustomStory, postCustomCart } from '../lib/custom-feed.js';
import { resetDiscordThrottle, setDiscordOutbox } from '../lib/discord.js';

const WEBHOOK = 'https://discord.com/api/webhooks/3/custom-token';
const PHOTO = 'https://pub.r2.dev/photos/lina_5_en_k3x9p2m7q1.jpg';
const COVER = 'https://pub.r2.dev/previews/lina_5_en_custom-bedtime_k3x9p2m7q1.jpg';

function stubDiscord(t) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    if (call.method === 'GET') return new Response(JSON.stringify({ guild_id: '999', channel_id: '222' }), { status: 200 });
    if (call.url.endsWith('?wait=true')) return new Response(JSON.stringify({ id: '111', channel_id: '222' }), { status: 200 });
    return new Response(null, { status: 204 });
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

function withWebhook(t, value) {
  const saved = process.env.DISCORD_WEBHOOK_CUSTOM;
  if (value === undefined) delete process.env.DISCORD_WEBHOOK_CUSTOM;
  else process.env.DISCORD_WEBHOOK_CUSTOM = value;
  resetDiscordThrottle();
  setDiscordOutbox(null);
  t.after(() => {
    if (saved === undefined) delete process.env.DISCORD_WEBHOOK_CUSTOM;
    else process.env.DISCORD_WEBHOOK_CUSTOM = saved;
    resetDiscordThrottle();
    setDiscordOutbox(null);
  });
}

const req = {
  headers: {
    origin: 'https://booktokids.com',
    'x-forwarded-for': '203.0.113.7',
    'x-vercel-ip-country': 'GB',
    'x-vercel-ip-city': 'London',
    'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
    'x-vercel-id': 'lhr1::abc'
  }
};

function request(overrides = {}) {
  return {
    generationId: 'k3x9p2m7q1',
    childName: 'Lina',
    age: '5',
    gender: 'girl',
    world: 'bedtime',
    occasion: 'A new baby',
    brief: 'Lina throws a kindness parade for the new girl next door.',
    reference: 'the-kindness-parade',
    photoUrl: PHOTO,
    customerId: null,
    startedAt: Date.now() - 22400,
    ...overrides
  };
}

const fieldsOf = (embed) => Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
const posts = (calls) => calls.filter((c) => c.method === 'POST').map((c) => c.body.embeds[0]);

test('does nothing while the channel has no webhook', async (t) => {
  withWebhook(t, undefined);
  const calls = stubDiscord(t);
  const feed = announceCustomStory(req, request());
  assert.equal(await feed.link, '');
  assert.equal(await feed.done({ coverUrl: COVER }), null);
  assert.equal(await postCustomCart(req, { childName: 'Lina' }, { generationId: 'k3x9p2m7q1' }), null);
  assert.equal(calls.length, 0);
});

test('posts every answer with the photo, then the cover linked to it', async (t) => {
  withWebhook(t, WEBHOOK);
  const calls = stubDiscord(t);
  const feed = announceCustomStory(req, request());
  await feed.done({ coverUrl: COVER, attempt: { provider: 'higgsfield', model: 'marketing-studio/image/flare', quality: 'medium' }, temporary: false });

  const [ask, cover] = posts(calls);
  assert.equal(calls[0].url, WEBHOOK + '?wait=true');
  assert.equal(ask.title, '✨ Lina, 5 · girl · Bedtime & kindness');
  assert.match(ask.description, /^Their story idea:\n```\nLina throws a kindness parade/);
  assert.deepEqual(ask.image, { url: PHOTO });
  const f = fieldsOf(ask);
  assert.equal(f.World, 'Bedtime & kindness');
  assert.equal(f.Hero, 'girl');
  assert.equal(f.Name, '`Lina`');
  assert.equal(f.Age, '5');
  assert.equal(f.Occasion, 'A new baby');
  assert.equal(f['Reference cover'], '[the-kindness-parade](https://booktokids.com/products/the-kindness-parade)');
  assert.equal(f.Customer, 'anonymous');
  assert.equal(f.Generation, '`k3x9p2m7q1`');
  assert.equal(f.IP, '`203.0.113.7`');
  assert.match(f.Visitor, /United Kingdom · London/);

  const link = 'https://discord.com/channels/999/222/111';
  assert.equal(await feed.link, link);
  assert.equal(cover.title, '🎨 Lina, 5 · Bedtime & kindness');
  assert.equal(cover.url, link);
  assert.deepEqual(cover.image, { url: COVER });
  assert.deepEqual(cover.thumbnail, { url: PHOTO });
  assert.match(fieldsOf(cover).Time, /^22\.\d s$/);
  assert.equal(fieldsOf(cover).Stored, COVER);
});

test('a failed cover posts the error instead', async (t) => {
  withWebhook(t, WEBHOOK);
  const calls = stubDiscord(t);
  await announceCustomStory(req, request()).done({ error: 'higgsfield-nsfw' });
  const failed = posts(calls)[1];
  assert.equal(failed.title, '❌ Lina, 5 · Bedtime & kindness');
  assert.match(failed.description, /higgsfield-nsfw/);
  assert.equal(failed.image, undefined);
  assert.equal(fieldsOf(failed).Stored, undefined);
});

test('the add-to-cart card shows the cover option and price', async (t) => {
  withWebhook(t, WEBHOOK);
  const calls = stubDiscord(t);
  const link = 'https://discord.com/channels/999/222/111';
  await postCustomCart(req, { childName: 'Lina', age: '5', coverUrl: COVER, link }, { generationId: 'k3x9p2m7q1', variant: 'Hardcover', price: '$44.99' });
  const [card] = posts(calls);
  assert.equal(card.title, '🛒 Lina, 5 · custom storybook');
  assert.equal(card.url, link);
  assert.deepEqual(card.thumbnail, { url: COVER });
  assert.deepEqual(fieldsOf(card), { Cover: 'Hardcover', Price: '$44.99', Generation: '`k3x9p2m7q1`' });
});
