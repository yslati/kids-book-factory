// The "is the face usable" check, with OpenAI answered by a stub.

import test from 'node:test';
import assert from 'node:assert/strict';
import { BLOCKING_VERDICTS, checkFace, faceCheckError, wholeSentences } from '../lib/face-check.js';

const jpeg = Buffer.from('not really a jpeg');

// Answers the verdict call (it asks for JSON) with verdict and every other
// call with description; status applies to the call kind given in failing.
function answering(verdict, description, { failing = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const kind = body.response_format ? 'verdict' : 'description';
    calls.push({ kind, body });
    if (failing === kind) return { ok: false, status: 500, json: async () => ({}) };
    const content = kind === 'verdict' ? verdict : description;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  return { fetchImpl, calls };
}

test('asks nano for the verdict and mini for the description, both with the photo', async () => {
  process.env.OPENAI_KEY = 'test';
  const { fetchImpl, calls } = answering(JSON.stringify({ verdict: 'covered', note: 'A helmet cage hides the face.' }), 'Round face,\n light skin.');
  assert.deepEqual(await checkFace(jpeg, { fetchImpl }), { verdict: 'covered', note: 'A helmet cage hides the face.', description: 'Round face, light skin.' });
  const byKind = Object.fromEntries(calls.map((c) => [c.kind, c.body]));
  assert.equal(byKind.verdict.model, 'gpt-5.4-nano');
  assert.equal(byKind.description.model, 'gpt-5.4-mini');
  assert.equal(byKind.description.messages[0].content[0].image_url.detail, 'high');
  assert.match(byKind.description.messages[0].content[1].text, /braces only when metal brackets are plainly visible/);
  for (const body of Object.values(byKind)) assert.match(body.messages[0].content[0].image_url.url, /^data:image\/jpeg;base64,/);
});

test('a free fix asks for the longer description', async () => {
  process.env.OPENAI_KEY = 'test';
  const { fetchImpl, calls } = answering(JSON.stringify({ verdict: 'clear', note: '' }), 'Oval face.');
  await checkFace(jpeg, { fetchImpl, detailed: true });
  assert.match(calls.find((c) => c.kind === 'description').body.messages[0].content[1].text, /130-180 words/);
});

test('a failed description still returns the verdict, with no description', async () => {
  process.env.OPENAI_KEY = 'test';
  const { fetchImpl } = answering(JSON.stringify({ verdict: 'clear', note: 'ok' }), 'x', { failing: 'description' });
  assert.deepEqual(await checkFace(jpeg, { fetchImpl }), { verdict: 'clear', note: 'ok', description: '' });
});

test('an unknown verdict, a refusal or a thrown fetch all give null, never a block', async () => {
  process.env.OPENAI_KEY = 'test';
  assert.equal(await checkFace(jpeg, { fetchImpl: answering(JSON.stringify({ verdict: 'maybe', note: '' }), '').fetchImpl }), null);
  assert.equal(await checkFace(jpeg, { fetchImpl: answering('{}', '', { failing: 'verdict' }).fetchImpl }), null);
  assert.equal(await checkFace(jpeg, { fetchImpl: async () => { throw new Error('offline'); } }), null);
});

test('a long description is cut back to its last full sentence', () => {
  assert.equal(wholeSentences('One two. Three four. Five six', 22), 'One two. Three four.');
  assert.equal(wholeSentences('Short.', 100), 'Short.');
  assert.equal(wholeSentences('No full stop anywhere in this text', 10), '');
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
