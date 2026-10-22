// URLs arrive from the browser and come back out as redirects and HTML, so
// validation and escaping are the parts that matter here.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isShareSlug, newShareSlug, parseShareTarget, renderExpiredPage, renderSharePage
} from '../lib/share-link.js';

const STORE = 'https://booktokids.com';
const BUCKET = 'https://pub-abc.r2.dev';
const OPTS = { allowedOrigins: [STORE, 'http://127.0.0.1:9292'], coverBase: BUCKET };

function payload(fields) {
  return Buffer.from(JSON.stringify(fields)).toString('base64url');
}

const S = payload({
  t: 'the-winning-goal', pt: 'The Winning Goal', n: 'Emma', a: '5', l: 'en',
  u: BUCKET + '/previews/emma_5_en_the-winning-goal_k3x9p2m7q1.jpg', g: 'k3x9p2m7q1'
});
const GOOD = STORE + '/pages/create-your-book?b=the-winning-goal&s=' + S;

test('keeps a preview URL with only its b and s parameters', () => {
  const t = parseShareTarget(GOOD + '&utm_source=x&k=local', OPTS);
  assert.equal(t.url, GOOD);
  assert.equal(t.childName, 'Emma');
  assert.equal(t.coverUrl, BUCKET + '/previews/emma_5_en_the-winning-goal_k3x9p2m7q1.jpg');
});

test('accepts a market prefix and a dev-store origin', () => {
  assert.ok(parseShareTarget(STORE + '/fr/pages/create-your-book?s=' + S, OPTS));
  assert.ok(parseShareTarget('http://127.0.0.1:9292/pages/create-your-book?s=' + S, OPTS));
});

test('rejects anything that would make it an open redirect', () => {
  assert.equal(parseShareTarget('https://evil.example/pages/create-your-book?s=' + S, OPTS), null);
  assert.equal(parseShareTarget(STORE + '/account/login?s=' + S, OPTS), null);
  assert.equal(parseShareTarget('javascript:alert(1)', OPTS), null);
  assert.equal(parseShareTarget('//evil.example/pages/create-your-book?s=' + S, OPTS), null);
  assert.equal(parseShareTarget(GOOD, { ...OPTS, allowedOrigins: [] }), null);
});

test('rejects a missing, malformed or oversized payload', () => {
  assert.equal(parseShareTarget(STORE + '/pages/create-your-book?b=x', OPTS), null);
  assert.equal(parseShareTarget(STORE + '/pages/create-your-book?s=not*base64', OPTS), null);
  assert.equal(parseShareTarget(STORE + '/pages/create-your-book?s=' + payload([1, 2]), OPTS), null);
  assert.equal(parseShareTarget(GOOD + '&pad=' + 'x'.repeat(2000), OPTS), null);
  assert.equal(parseShareTarget(undefined, OPTS), null);
});

test('only uses a cover from our own bucket as the preview image', () => {
  const foreign = payload({ n: 'Emma', u: 'https://tracker.example/previews/a.jpg' });
  const t = parseShareTarget(STORE + '/pages/create-your-book?s=' + foreign, OPTS);
  assert.equal(t.coverUrl, '');
  assert.equal(parseShareTarget(GOOD, { ...OPTS, coverBase: '' }).coverUrl, '');
});

test('slugs read as name-code and fall back to a longer bare code', () => {
  assert.match(newShareSlug('Emma'), /^emma-[a-z2-9]{6}$/);
  assert.match(newShareSlug('Zoé Marie'), /^zoe-marie-[a-z2-9]{6}$/);
  assert.match(newShareSlug('محمد'), /^[a-z2-9]{8}$/);
  assert.match(newShareSlug(''), /^[a-z2-9]{8}$/);
  assert.notEqual(newShareSlug('Emma'), newShareSlug('Emma'));
  assert.ok(isShareSlug(newShareSlug('A very long child name indeed')));
});

test('recognises only well-formed slugs', () => {
  assert.ok(isShareSlug('emma-x7k2pq'));
  assert.equal(isShareSlug('Emma-x7k2pq'), false);
  assert.equal(isShareSlug('../etc'), false);
  assert.equal(isShareSlug('a'.repeat(41)), false);
  assert.equal(isShareSlug(null), false);
});

test('the bot page escapes the name and carries the cover as og:image', () => {
  const { status, html } = renderSharePage({
    shortUrl: 'https://s.booktokids.com/emma-x7k2pq',
    target: GOOD,
    childName: '<script>"x"</script>',
    coverUrl: BUCKET + '/previews/a.jpg'
  });
  assert.equal(status, 200);
  assert.ok(!html.includes('<script>"x"'));
  assert.ok(html.includes('&lt;script&gt;&quot;x&quot;&lt;/script&gt;&#39;s personalised book'));
  assert.ok(html.includes('<meta property="og:image" content="' + BUCKET + '/previews/a.jpg">'));
  assert.ok(html.includes('<meta property="og:url" content="https://s.booktokids.com/emma-x7k2pq">'));
  assert.ok(html.includes('summary_large_image'));
});

test('the bot page leaves out og:image when there is no cover', () => {
  const { html } = renderSharePage({ shortUrl: 'https://s.booktokids.com/x', target: GOOD, childName: '', coverUrl: '' });
  assert.ok(!html.includes('og:image'));
  assert.ok(html.includes('A personalised book'));
});

test('the expired page links back to the store', () => {
  const { status, html } = renderExpiredPage({ storeUrl: STORE });
  assert.equal(status, 410);
  assert.ok(html.includes('href="' + STORE + '"'));
  assert.equal(renderExpiredPage({ storeUrl: STORE, status: 503 }).status, 503);
});
