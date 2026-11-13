// lib/openai.js: output size, cost from token usage, and the request shape
// (with fetch stubbed, so no OpenAI call is made).

import test from 'node:test';
import assert from 'node:assert/strict';
import { costOf, generateWithOpenAI, nearestSize, OPENAI_PRICES_PER_M } from '../lib/openai.js';

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

test('sends both image URLs as JSON and returns a data URL with the cost', async (t) => {
  process.env.OPENAI_KEY = 'sk-test';
  let seen;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen = { url, body: JSON.parse(init.body), auth: init.headers.Authorization };
    return new Response(JSON.stringify({
      data: [{ b64_json: 'AAAA' }],
      output_format: 'jpeg',
      usage: { input_tokens_details: { text_tokens: 1000, image_tokens: 1000 }, output_tokens: 1000 }
    }), { status: 200 });
  });

  const out = await generateWithOpenAI('https://cdn.example.com/cover.jpg', 'https://r2.example.com/photo.jpg', 'Make the child the hero.', {
    model: 'gpt-image-2.5-sunburst', quality: 'medium', coverAspect: 1, timeoutMs: 5000
  });

  assert.equal(seen.url, 'https://api.openai.com/v1/images/edits');
  assert.equal(seen.auth, 'Bearer sk-test');
  assert.deepEqual(seen.body.images, [{ image_url: 'https://cdn.example.com/cover.jpg' }, { image_url: 'https://r2.example.com/photo.jpg' }]);
  assert.equal(seen.body.model, 'gpt-image-2.5-sunburst');
  assert.equal(seen.body.quality, 'medium');
  assert.equal(seen.body.size, '1024x1024');
  assert.equal(seen.body.output_format, 'jpeg');
  assert.equal(out.url, 'data:image/jpeg;base64,AAAA');
  assert.equal(Math.round(out.cost * 1e6), 43000);
});

test('a refusal throws openai-<status> with the error code', async (t) => {
  process.env.OPENAI_KEY = 'sk-test';
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } }), { status: 429 }));
  t.mock.method(console, 'warn', () => {});
  await assert.rejects(generateWithOpenAI('a', 'b', 'prompt', { timeoutMs: 5000 }), (err) => err.message === 'openai-429' && err.code === 'insufficient_quota');
});
