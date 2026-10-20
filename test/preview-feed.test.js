// #previews feed: the photo as generation starts, then the cover or the error
// as a follow-up linked to it, against a stubbed Discord.

import test from 'node:test';
import assert from 'node:assert/strict';
import { announcePreview } from '../lib/preview-feed.js';
import { resetDiscordThrottle, setDiscordOutbox } from '../lib/discord.js';

const WEBHOOK = 'https://discord.com/api/webhooks/2/previews-token';
const PHOTO = 'https://pub.r2.dev/photos/emma_5_fr_k3x9p2m7q1.jpg';
const COVER = 'https://pub.r2.dev/previews/emma_5_fr_the-winning-goal_k3x9p2m7q1.jpg';

// Discord as the feed sees it: POST ?wait=true returns the message, a plain
// POST returns 204, and GET on the webhook returns its record.
function stubDiscord(t, { photoStatus = 200 } = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    if (call.method === 'GET') return new Response(JSON.stringify({ guild_id: '999', channel_id: '222' }), { status: 200 });
    if (call.url.endsWith('?wait=true')) {
      return photoStatus === 200
        ? new Response(JSON.stringify({ id: '111', channel_id: '222' }), { status: 200 })
        : new Response('{"message":"oops"}', { status: photoStatus });
    }
    return new Response(null, { status: 204 });
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

function withWebhook(t, value) {
  const saved = process.env.DISCORD_WEBHOOK_PREVIEWS;
  if (value === undefined) delete process.env.DISCORD_WEBHOOK_PREVIEWS;
  else process.env.DISCORD_WEBHOOK_PREVIEWS = value;
  resetDiscordThrottle();
  setDiscordOutbox(null);
  t.after(() => {
    if (saved === undefined) delete process.env.DISCORD_WEBHOOK_PREVIEWS;
    else process.env.DISCORD_WEBHOOK_PREVIEWS = saved;
    resetDiscordThrottle();
  setDiscordOutbox(null);
  });
}

const req = {
  headers: {
    origin: 'https://booktokids.com',
    'x-forwarded-for': '203.0.113.7',
    'x-vercel-ip-country': 'FR',
    'x-vercel-ip-city': 'Lyon',
    'x-vercel-id': 'cdg1::iad1::abc'
  }
};

function preview(overrides = {}) {
  return {
    photoUrl: PHOTO,
    themeId: 'the-winning-goal',
    generationId: 'k3x9p2m7q1',
    childName: 'Emma',
    age: '5',
    language: 'French',
    customerId: null,
    startedAt: Date.now() - 21400,
    ...overrides
  };
}

const fieldsOf = (embed) => Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
const posts = (calls) => calls.filter((c) => c.method === 'POST').map((c) => c.body.embeds[0]);

test('does nothing while the channel has no webhook', async (t) => {
  withWebhook(t, undefined);
  const calls = stubDiscord(t);
  const feed = announcePreview(req, preview());
  assert.equal(await feed.done({ coverUrl: COVER }), null);
  assert.equal(calls.length, 0);
});

test('posts the photo, then the cover as a follow-up linked to it', async (t) => {
  withWebhook(t, WEBHOOK);
  const calls = stubDiscord(t);
  const feed = announcePreview(req, preview({ customerId: '7212345678' }));
  await feed.done({
    coverUrl: COVER,
    bookTitle: 'The Winning Goal: Personalized Football Book',
    attempt: { provider: 'higgsfield', model: 'marketing-studio/image/flare', quality: 'medium' },
    temporary: false
  });

  const [photo, cover] = posts(calls);
  assert.equal(calls[0].url, WEBHOOK + '?wait=true', 'the photo post returns its id');
  assert.equal(photo.title, '📸 Emma, 5 · the-winning-goal');
  assert.deepEqual(photo.image, { url: PHOTO });
  assert.equal(photo.color, 0x5865f2);
  assert.deepEqual(fieldsOf(photo), {
    Book: '[the-winning-goal](https://booktokids.com/products/the-winning-goal)',
    Language: 'French',
    Customer: 'signed in · 7212345678',
    Visitor: '🇫🇷 France · Lyon',
    Generation: '`k3x9p2m7q1`'
  });
  assert.equal(photo.footer.text, 'cdg1::iad1::abc');

  const link = 'https://discord.com/channels/999/222/111';
  assert.equal(cover.title, '🎨 Emma, 5 · The Winning Goal: Personalized Football Book');
  assert.equal(cover.url, link);
  assert.equal(cover.description, '↪️ Reply to [the photo](' + link + ')');
  assert.deepEqual(cover.image, { url: COVER });
  assert.deepEqual(cover.thumbnail, { url: PHOTO });
  assert.equal(cover.color, 0x57f287);
  const fields = fieldsOf(cover);
  assert.match(fields.Time, /^21\.\d s$/);
  assert.equal(fields.Model, '`higgsfield marketing-studio/image/flare medium`');
  assert.equal(fields.Generation, '`k3x9p2m7q1`');
  assert.equal(fields.Stored, COVER, 'the direct R2 link');
  assert.deepEqual(cover.fields.map((f) => f.name), ['Time', 'Model', 'Generation', 'Stored']);
  assert.equal(cover.fields[3].inline, false, 'the link gets its own row');
});

test('a failure follows up with the error and no cover', async (t) => {
  withWebhook(t, WEBHOOK);
  const calls = stubDiscord(t);
  await announcePreview(req, preview()).done({ error: 'higgsfield-timeout' });

  const failed = posts(calls)[1];
  assert.equal(failed.title, '❌ Emma, 5 · the-winning-goal');
  assert.equal(failed.color, 0xed4245);
  assert.match(failed.description, /^↪️ Reply to \[the photo\]\(https:\/\/discord\.com\/channels\/999\/222\/111\)\n```\nhiggsfield-timeout\n```$/);
  assert.equal(failed.image, undefined);
  assert.deepEqual(failed.thumbnail, { url: PHOTO });
  assert.equal(fieldsOf(failed).Model, undefined);
});

test('a cover kept on the provider URL is flagged', async (t) => {
  withWebhook(t, WEBHOOK);
  const calls = stubDiscord(t);
  await announcePreview(req, preview()).done({ coverUrl: 'https://cdn.higgsfield.ai/x.png', temporary: true });
  assert.equal(fieldsOf(posts(calls)[1]).Stored, '⚠️ Not in R2, temporary provider link:\nhttps://cdn.higgsfield.ai/x.png');
});

test('if the photo post failed, the follow-up still goes out, unlinked', async (t) => {
  withWebhook(t, WEBHOOK);
  const calls = stubDiscord(t, { photoStatus: 500 });
  await announcePreview(req, preview()).done({ coverUrl: COVER });

  const followUp = calls.filter((c) => c.method === 'POST')[1].body.embeds[0];
  assert.equal(followUp.url, undefined);
  assert.equal(followUp.description, undefined);
  assert.deepEqual(followUp.thumbnail, { url: PHOTO });
  assert.equal(calls.filter((c) => c.method === 'GET').length, 0, 'no link to look up');
});

test('only one follow-up per preview', async (t) => {
  withWebhook(t, WEBHOOK);
  const calls = stubDiscord(t);
  const feed = announcePreview(req, preview());
  await feed.done({ coverUrl: COVER });
  await feed.done({ error: 'late failure' });
  assert.equal(posts(calls).length, 2);
});

test('names with markdown or mentions are shown as plain text', async (t) => {
  withWebhook(t, WEBHOOK);
  const calls = stubDiscord(t);
  await announcePreview(req, preview({ childName: '**Emma** @everyone [x](https://evil.example)' })).done({ coverUrl: COVER });
  const [photo] = posts(calls);
  assert.equal(photo.title, '📸 Emma everyone xhttps://evil.example, 5 · the-winning-goal');
  assert.deepEqual(calls[0].body.allowed_mentions, { parse: [] });
});

test('a broken preview object never throws into the preview request', async (t) => {
  withWebhook(t, WEBHOOK);
  const calls = stubDiscord(t);
  const feed = announcePreview({ headers: null }, Object.defineProperty({}, 'childName', { get() { throw new Error('boom'); } }));
  assert.equal(await feed.done({ coverUrl: COVER }), null);
  assert.equal(calls.length, 0);
});

test('the book link only uses a clean origin and handle', async (t) => {
  withWebhook(t, WEBHOOK);
  const calls = stubDiscord(t);
  await announcePreview({ headers: { ...req.headers, origin: '' } }, preview()).done({ coverUrl: COVER });
  await announcePreview(req, preview({ themeId: 'x)[evil](https://evil.example' })).done({ coverUrl: COVER });
  const [noOrigin, , hostile] = posts(calls);
  assert.equal(fieldsOf(noOrigin).Book, '`the-winning-goal`');
  assert.equal(fieldsOf(hostile).Book, '`x)[evil](https://evil.example`');
});

const countOf = (embed) => (embed.fields.find((f) => f.name === 'Count') || {}).value;

test('cards show the visitor\'s count as its own field', async (t) => {
  withWebhook(t, WEBHOOK);
  const calls = stubDiscord(t);
  await announcePreview(req, preview({ counts: Promise.resolve({ upload: 2, preview: 2, by: 'ip' }) })).done({ coverUrl: COVER });
  await announcePreview(req, preview({ customerId: '7212345678', counts: { upload: 1, preview: 3, by: 'customer' } })).done({ error: 'higgsfield-timeout' });

  const [photo, cover, photo2, failed] = posts(calls);
  assert.equal(countOf(photo), '2nd upload from this IP');
  assert.equal(photo.fields[0].name, 'Count', 'shown first');
  assert.equal(countOf(cover), '2nd preview from this IP');
  assert.equal(countOf(photo2), '1st upload from this customer');
  assert.equal(countOf(failed), '3rd preview from this customer');
  assert.deepEqual(posts(calls).map((e) => e.author.name), ['New preview', 'Cover ready', 'New preview', 'Preview failed']);
});

test('counts read as English ordinals', async (t) => {
  withWebhook(t, WEBHOOK);
  const calls = stubDiscord(t);
  for (const n of [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111]) {
    await announcePreview(req, preview({ counts: { upload: n, preview: n, by: 'ip' } })).done({ coverUrl: COVER });
  }
  const covers = posts(calls).filter((e) => e.author.name === 'Cover ready');
  assert.deepEqual(covers.map((e) => countOf(e).split(' ')[0]), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th']);
});

test('without a count, the cards go out without the field', async (t) => {
  withWebhook(t, WEBHOOK);
  const calls = stubDiscord(t);
  await announcePreview(req, preview({ counts: Promise.resolve(null) })).done({ coverUrl: COVER });
  await announcePreview(req, preview({ counts: Promise.reject(new Error('upstash down')) })).done({ coverUrl: COVER });
  await announcePreview(req, preview()).done({ coverUrl: COVER });
  assert.equal(posts(calls).length, 6);
  assert.ok(posts(calls).every((e) => countOf(e) === undefined));
});
