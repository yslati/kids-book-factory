// lib/openai.js: output size, cost from token usage, embedded images and the
// request shape (with fetch stubbed, so no OpenAI call is made).

import test from 'node:test';
import assert from 'node:assert/strict';
import { costOf, embedImage, generateWithOpenAI, nearestSize, OPENAI_PRICES_PER_M } from '../lib/openai.js';

test('picks the fixed output size nearest the cover, square when unknown', () => {
  assert.equal(nearestSize(1), '1024x1024');
  assert.equal(nearestSize(null), '1024x1024');
  assert.equal(nearestSize(0.7), '1024x1536');
  assert.equal(nearestSize(1.4), '1536x1024');
});

test('cost comes from the token usage at the published rates', () => {
  assert.deepEqual(OPENAI_PRICES_PER_M, { textInput: 5, imageInput: 8, imageOutput: 30 });
  const usage = { input_tokens: 2400, input_tokens_details: { text_tokens: 1200, image_tokens: 1200 }, output_tokens: 1056 };
  // 1200 × $5 + 1200 × $8 + 1056 × $30, per million.
  assert.equal(Math.round(costOf(usage) * 1e6), 47280);
  assert.equal(costOf(null), null);
  assert.equal(costOf({}), null);
});

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

// Stubs fetch: the two image URLs answer with `images`, OpenAI with an image.
function stubFetch(t, images) {
  const calls = { openai: null, images: [] };
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (String(url).startsWith('https://api.openai.com/')) {
      calls.openai = { url, body: JSON.parse(init.body), auth: init.headers.Authorization };
      return new Response(JSON.stringify({
        data: [{ b64_json: 'AAAA' }],
        output_format: 'jpeg',
        usage: { input_tokens_details: { text_tokens: 1000, image_tokens: 1000 }, output_tokens: 1000 }
      }), { status: 200 });
    }
    calls.images.push(String(url));
    const answer = images[String(url)];
    return typeof answer === 'function' ? answer() : answer;
  });
  return calls;
}

const COVER = 'https://cdn.example.com/cover.png?width=1024';
const PHOTO = 'https://r2.example.com/photo.jpg';

test('sends both images embedded as data URLs and returns a data URL with the cost', async (t) => {
  process.env.OPENAI_KEY = 'sk-test';
  const calls = stubFetch(t, {
    [COVER]: () => new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    [PHOTO]: () => new Response(JPEG, { status: 200, headers: { 'content-type': 'image/png' } })
  });

  const out = await generateWithOpenAI(COVER, PHOTO, 'Make the child the hero.', {
    model: 'gpt-image-2.5-sunburst', quality: 'medium', coverAspect: 1, timeoutMs: 5000
  });

  assert.deepEqual(calls.images.sort(), [COVER, PHOTO].sort());
  assert.equal(calls.openai.url, 'https://api.openai.com/v1/images/edits');
  assert.equal(calls.openai.auth, 'Bearer sk-test');
  assert.deepEqual(calls.openai.body.images, [
    { image_url: 'data:image/jpeg;base64,/9j/2Q==' },
    { image_url: 'data:image/png;base64,/9j/2Q==' }
  ]);
  assert.equal(calls.openai.body.model, 'gpt-image-2.5-sunburst');
  assert.equal(calls.openai.body.quality, 'medium');
  assert.equal(calls.openai.body.size, '1024x1024');
  assert.equal(calls.openai.body.output_format, 'jpeg');
  assert.equal(out.url, 'data:image/jpeg;base64,AAAA');
  assert.equal(Math.round(out.cost * 1e6), 43000);
});

test('an image that cannot be embedded is sent as its link, without logging the URL', async (t) => {
  process.env.OPENAI_KEY = 'sk-test';
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const calls = stubFetch(t, {
    [COVER]: () => new Response('slow down', { status: 429 }),
    [PHOTO]: () => { throw new TypeError('fetch failed'); }
  });

  await generateWithOpenAI(COVER, PHOTO, 'prompt', { timeoutMs: 5000 });

  assert.deepEqual(calls.openai.body.images, [{ image_url: COVER }, { image_url: PHOTO }]);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((w) => w.includes('cover') && w.includes('HTTP 429')));
  assert.ok(warnings.every((w) => !w.includes('example.com')));
});

test('embedImage keeps types OpenAI refuses, and data URLs, as they are', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => new Response('<svg/>', { status: 200, headers: { 'content-type': 'image/svg+xml' } }));
  assert.equal(await embedImage('https://cdn.example.com/a.svg', 'cover'), 'https://cdn.example.com/a.svg');
  assert.equal(await embedImage('data:image/jpeg;base64,AAAA', 'cover'), 'data:image/jpeg;base64,AAAA');
});

test('a refusal throws openai-<status> with the error code', async (t) => {
  process.env.OPENAI_KEY = 'sk-test';
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } }), { status: 429 }));
  t.mock.method(console, 'warn', () => {});
  await assert.rejects(generateWithOpenAI('a', 'b', 'prompt', { timeoutMs: 5000 }), (err) => err.message === 'openai-429' && err.code === 'insufficient_quota');
});
