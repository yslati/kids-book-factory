// A cover's share link is minted with the cover, then taken over by the
// preview page's first request, with Upstash as an in-memory map.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SHARE_BASE_URL = 'https://s.booktokids.com';
process.env.STORE_URL = 'https://booktokids.com';
process.env.R2_PUBLIC_BASE_URL = 'https://pub-abc.r2.dev';

const { claimPreviewLink, linkKey, mintPreviewLink } = await import('../lib/share-store.js');
const { parseShareTarget } = await import('../lib/share-link.js');

function memoryRedis() {
  const data = new Map();
  return {
    data,
    async get(key) { return data.has(key) ? data.get(key) : null; },
    async set(key, value, opts = {}) {
      if (opts.nx && data.has(key)) return null;
      data.set(key, value);
      return 'OK';
    }
  };
}

const COVER = 'https://pub-abc.r2.dev/previews/emma_5_en_the-winning-goal_k3x9p2m7q1.jpg';
const CARD = {
  generationId: 'k3x9p2m7q1', themeId: 'the-winning-goal', bookTitle: 'The Winning Goal',
  childName: 'Emma', age: '5', language: 'en', coverUrl: COVER, photoKey: 'photos/emma_5_en_k3x9p2m7q1.jpg'
};
const OPTS = { allowedOrigins: ['https://booktokids.com'], coverBase: 'https://pub-abc.r2.dev' };

function pageTarget(fields) {
  const s = Buffer.from(JSON.stringify(fields)).toString('base64url');
  return parseShareTarget('https://booktokids.com/fr/pages/create-your-book?b=the-winning-goal&s=' + s, OPTS);
}

test('a ready cover gets a working link at once', async () => {
  const redis = memoryRedis();
  const url = await mintPreviewLink(redis, CARD);
  assert.match(url, /^https:\/\/s\.booktokids\.com\/emma-[a-z2-9]{6}\?team=1$/, 'the team\'s uncounted copy');
  const row = JSON.parse(redis.data.get(linkKey(new URL(url).pathname.slice(1))));
  assert.equal(row.childName, 'Emma');
  assert.equal(row.coverUrl, COVER);
  assert.equal(parseShareTarget(row.url, OPTS).generationId, 'k3x9p2m7q1');
});

test('the preview page takes the minted link once, with its own URL', async () => {
  const redis = memoryRedis();
  const id = new URL(await mintPreviewLink(redis, CARD)).pathname.slice(1);
  const page = pageTarget({ t: 'the-winning-goal', n: 'Emma', u: COVER, g: 'k3x9p2m7q1', c: '2026-11-17' });
  assert.equal(await claimPreviewLink(redis, page), id);
  assert.equal(JSON.parse(redis.data.get(linkKey(id))).url, page.url);

  const other = pageTarget({ t: 'the-winning-goal', n: 'Someone else', u: COVER, g: 'k3x9p2m7q1' });
  assert.equal(await claimPreviewLink(redis, other), null, 'a second page URL gets its own link');
  assert.equal(JSON.parse(redis.data.get(linkKey(id))).url, page.url);
});

test('a page with another cover for the same generation cannot take the link', async () => {
  const redis = memoryRedis();
  await mintPreviewLink(redis, CARD);
  const forged = pageTarget({ n: 'Emma', u: 'https://pub-abc.r2.dev/previews/other.jpg', g: 'k3x9p2m7q1' });
  assert.equal(await claimPreviewLink(redis, forged), null);
  assert.equal(await claimPreviewLink(redis, pageTarget({ n: 'Emma', u: COVER })), null, 'no generation id');
});

test('no link while sharing is off, and an Upstash failure never throws', async (t) => {
  const base = process.env.SHARE_BASE_URL;
  t.after(() => { process.env.SHARE_BASE_URL = base; });
  const broken = { get: async () => { throw new Error('down'); }, set: async () => { throw new Error('down'); } };
  assert.equal(await mintPreviewLink(broken, CARD), '');
  assert.equal(await mintPreviewLink(null, CARD), '');
  process.env.SHARE_BASE_URL = '';
  assert.equal(await mintPreviewLink(memoryRedis(), CARD), '');
});
