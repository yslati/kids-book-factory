// The "is the face usable" check, with OpenAI answered by a stub.

import test from 'node:test';
import assert from 'node:assert/strict';
import { BLOCKING_VERDICTS, checkFace, faceCheckError } from '../lib/face-check.js';

const jpeg = Buffer.from('not really a jpeg');

function answering(content, { status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: status === 200, status, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  return { fetchImpl, calls };
}

test('returns the model\'s verdict and note, sending the photo as a data URL', async () => {
  process.env.OPENAI_KEY = 'test';
  const { fetchImpl, calls } = answering(JSON.stringify({ verdict: 'covered', note: 'A helmet cage hides the face.' }));
  assert.deepEqual(await checkFace(jpeg, { fetchImpl }), { verdict: 'covered', note: 'A helmet cage hides the face.' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.messages[0].content[0].image_url.url, /^data:image\/jpeg;base64,/);
  assert.equal(calls[0].body.response_format.json_schema.strict, true);
});

test('an unknown verdict, a refusal or a thrown fetch all give null, never a block', async () => {
  process.env.OPENAI_KEY = 'test';
  assert.equal(await checkFace(jpeg, { fetchImpl: answering(JSON.stringify({ verdict: 'maybe', note: '' })).fetchImpl }), null);
  assert.equal(await checkFace(jpeg, { fetchImpl: answering('{}', { status: 429 }).fetchImpl }), null);
  assert.equal(await checkFace(jpeg, { fetchImpl: async () => { throw new Error('offline'); } }), null);
});

test('without an OpenAI key the check is skipped', async () => {
  const saved = process.env.OPENAI_KEY;
  delete process.env.OPENAI_KEY;
  try {
    let called = false;
    assert.equal(await checkFace(jpeg, { fetchImpl: async () => { called = true; } }), null);
    assert.equal(called, false);
  } finally {
    if (saved !== undefined) process.env.OPENAI_KEY = saved;
  }
});

test('only covered, turned-away and missing faces stop the preview', () => {
  assert.deepEqual(BLOCKING_VERDICTS, ['covered', 'turned_away', 'no_face']);
  const err = faceCheckError({ verdict: 'covered', note: 'cage' });
  assert.equal(err.message, 'face-not-clear');
  assert.equal(err.reason, 'covered');
  for (const verdict of ['clear', 'too_small', 'blurry_or_dark']) {
    assert.equal(faceCheckError({ verdict, note: '' }), null, verdict);
  }
  assert.equal(faceCheckError(null), null);
});
