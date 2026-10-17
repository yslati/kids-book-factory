// The Higgsfield client, against a stubbed fetch (no network, no credits).

import test from 'node:test';
import assert from 'node:assert/strict';
import { nearestAspectRatio, generateWithHiggsfield, higgsfieldConfigured } from '../lib/higgsfield.js';

const FLARE_MEDIUM = { model: 'marketing-studio/image/flare', quality: 'medium' };
const STATUS_URL = 'https://api.higgsfield.ai/requests/req-1/status';
const CANCEL_URL = 'https://api.higgsfield.ai/requests/req-1/cancel';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Replace global fetch for one test; `handler(url, init)` returns a Response.
function stubFetch(t, handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

function withKey(t) {
  const original = process.env.HIGGSFIELD_KEY;
  process.env.HIGGSFIELD_KEY = 'key-id:key-secret';
  t.after(() => {
    if (original === undefined) delete process.env.HIGGSFIELD_KEY;
    else process.env.HIGGSFIELD_KEY = original;
  });
}

test('picks the nearest supported aspect ratio, square when unknown', () => {
  assert.equal(nearestAspectRatio(1), '1:1');
  assert.equal(nearestAspectRatio(1173 / 1200), '1:1'); // the shop's near-square covers
  assert.equal(nearestAspectRatio(0.75), '3:4');
  assert.equal(nearestAspectRatio(2 / 3), '2:3');
  assert.equal(nearestAspectRatio(16 / 9), '16:9');
  assert.equal(nearestAspectRatio(null), '1:1');
  assert.equal(nearestAspectRatio(0), '1:1');
  assert.equal(nearestAspectRatio(NaN), '1:1');
});

test('configured only when HIGGSFIELD_KEY is set', (t) => {
  withKey(t);
  assert.equal(higgsfieldConfigured(), true);
  delete process.env.HIGGSFIELD_KEY;
  assert.equal(higgsfieldConfigured(), false);
});

test('submits [cover, child] to the chosen endpoint and quality, and returns the finished image', async (t) => {
  withKey(t);
  let polls = 0;
  const calls = stubFetch(t, (url) => {
    if (url === 'https://api.higgsfield.ai/marketing-studio/image/flare') {
      return json({ status: 'queued', request_id: 'req-1', status_url: STATUS_URL, cancel_url: CANCEL_URL });
    }
    if (url === STATUS_URL) {
      polls++;
      return polls === 1
        ? json({ status: 'in_progress', request_id: 'req-1' })
        : json({ status: 'completed', request_id: 'req-1', images: [{ url: 'https://cdn.higgsfield.ai/out.png' }] });
    }
    throw new Error('unexpected ' + url);
  });

  const url = await generateWithHiggsfield('https://cdn.shopify.com/cover.jpg', 'https://r2.example.com/photos/a.jpg',
    'Put the child on the cover.', { ...FLARE_MEDIUM, coverAspect: 0.98, timeoutMs: 20000 });

  assert.equal(url, 'https://cdn.higgsfield.ai/out.png');
  const submit = calls[0];
  assert.equal(submit.init.method, 'POST');
  assert.equal(submit.init.headers.Authorization, 'Key key-id:key-secret');
  const body = JSON.parse(submit.init.body);
  assert.deepEqual(body.image_urls, ['https://cdn.shopify.com/cover.jpg', 'https://r2.example.com/photos/a.jpg']);
  assert.equal(body.prompt, 'Put the child on the cover.');
  assert.equal(body.resolution, '1k');
  assert.equal(body.aspect_ratio, '1:1');
  assert.equal(body.quality, 'medium');
  assert.equal(body.enhance_prompt, false);
});

test('a prompt over the endpoint limit fails before any request', async (t) => {
  withKey(t);
  const calls = stubFetch(t, () => { throw new Error('should not fetch'); });
  await assert.rejects(
    generateWithHiggsfield('https://c/cover.jpg', 'https://c/child.jpg', 'x'.repeat(5001), { ...FLARE_MEDIUM, timeoutMs: 20000 }),
    /higgsfield-prompt-too-long/
  );
  assert.equal(calls.length, 0);
});

test('an out-of-credits submit (403) throws without polling', async (t) => {
  withKey(t);
  const calls = stubFetch(t, () => json({ detail: 'Insufficient credits' }, 403));
  await assert.rejects(
    generateWithHiggsfield('https://c/cover.jpg', 'https://c/child.jpg', 'p', { ...FLARE_MEDIUM, timeoutMs: 20000 }),
    /higgsfield-submit-403/
  );
  assert.equal(calls.length, 1);
});

test('a moderated (nsfw) job throws', async (t) => {
  withKey(t);
  stubFetch(t, (url) => url === STATUS_URL
    ? json({ status: 'nsfw', request_id: 'req-1' })
    : json({ status: 'queued', request_id: 'req-1', status_url: STATUS_URL, cancel_url: CANCEL_URL }));
  await assert.rejects(
    generateWithHiggsfield('https://c/cover.jpg', 'https://c/child.jpg', 'p', { ...FLARE_MEDIUM, timeoutMs: 20000 }),
    /higgsfield-nsfw/
  );
});

test('gives up at the timeout and asks Higgsfield to cancel', async (t) => {
  withKey(t);
  const calls = stubFetch(t, (url) => {
    if (url === STATUS_URL) return json({ status: 'queued', request_id: 'req-1' });
    if (url === CANCEL_URL) return new Response(null, { status: 202 });
    return json({ status: 'queued', request_id: 'req-1', status_url: STATUS_URL, cancel_url: CANCEL_URL });
  });
  await assert.rejects(
    generateWithHiggsfield('https://c/cover.jpg', 'https://c/child.jpg', 'p', { ...FLARE_MEDIUM, timeoutMs: 2000 }),
    /higgsfield-timeout/
  );
  const last = calls[calls.length - 1];
  assert.equal(last.url, CANCEL_URL);
  assert.equal(last.init.method, 'POST');
});
