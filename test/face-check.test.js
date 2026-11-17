// The photo check and the cover review, with OpenAI answered by a stub.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCKING_VERDICTS, NO_TRAITS, Seen, Verdict, checkFace, faceCheckError, languageOf, readReview, readTraits, reviewCover, wholeSentences
} from '../lib/face-check.js';

const jpeg = Buffer.from('not really a jpeg');

const TRAITS = {
  description: 'Round face,\n light skin.',
  glasses: 'black rectangular glasses.',
  headwear: 'tall black "chef" hat',
  headwear_label: 'toque de chef',
  hair: 'short light blond hair',
  hair_hidden: true,
  skin: 'fair skin',
  marks: ['gap between the front teeth', '', 'a', 'b', 'c', 'd']
};

// Answers each call by the name of the JSON schema it asks for; failing names one to answer 500.
function answering(answers, { failing = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const kind = body.response_format.json_schema.name;
    calls.push({ kind, body });
    if (failing === kind) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(answers[kind]) } }] }) };
  };
  return { fetchImpl, calls };
}

test('asks nano for the verdict and mini for what the photo shows, both with the photo', async () => {
  process.env.OPENAI_KEY = 'test';
  const { fetchImpl, calls } = answering({
    face_check: { verdict: 'covered', note: 'A helmet cage hides the face.', tip: 'La grille du casque cache son visage.' },
    child_traits: TRAITS
  });
  const out = await checkFace(jpeg, { fetchImpl, locale: 'fr' });
  assert.equal(out.verdict, Verdict.COVERED);
  assert.equal(out.note, 'A helmet cage hides the face.');
  assert.equal(out.tip, 'La grille du casque cache son visage.');
  assert.deepEqual(out.traits, {
    description: 'Round face, light skin.',
    glasses: 'black rectangular glasses',
    headwear: 'tall black chef hat',
    headwearLabel: 'toque de chef',
    hair: 'short light blond hair',
    hairHidden: true,
    skin: 'fair skin',
    marks: ['gap between the front teeth', 'a', 'b', 'c']
  });
  const byKind = Object.fromEntries(calls.map((c) => [c.kind, c.body]));
  assert.equal(byKind.face_check.model, 'gpt-5.4-nano');
  assert.equal(byKind.child_traits.model, 'gpt-5.4-mini');
  assert.equal(byKind.child_traits.messages[0].content[0].image_url.detail, 'high');
  const asked = byKind.child_traits.messages[0].content[1].text;
  assert.match(asked, /braces only when metal brackets are plainly visible/);
  assert.match(asked, /in French/);
  assert.match(byKind.face_check.messages[0].content[1].text, /friendly sentence in French for the parent/);
  for (const body of Object.values(byKind)) assert.match(body.messages[0].content[0].image_url.url, /^data:image\/jpeg;base64,/);
});

test('a clear photo carries no tip, and a free fix asks for the longer description', async () => {
  process.env.OPENAI_KEY = 'test';
  const { fetchImpl, calls } = answering({ face_check: { verdict: 'clear', note: 'ok', tip: 'ignored' }, child_traits: TRAITS });
  const out = await checkFace(jpeg, { fetchImpl, detailed: true });
  assert.equal(out.tip, '');
  assert.match(calls.find((c) => c.kind === 'child_traits').body.messages[0].content[1].text, /130-180 words/);
});

test('a failed description still returns the verdict, with empty traits', async () => {
  process.env.OPENAI_KEY = 'test';
  const { fetchImpl } = answering({ face_check: { verdict: 'clear', note: 'ok', tip: '' } }, { failing: 'child_traits' });
  assert.deepEqual(await checkFace(jpeg, { fetchImpl }), { verdict: 'clear', note: 'ok', tip: '', traits: NO_TRAITS });
});

test('an unknown verdict, a refusal or a thrown fetch all give null, never a block', async () => {
  process.env.OPENAI_KEY = 'test';
  assert.equal(await checkFace(jpeg, { fetchImpl: answering({ face_check: { verdict: 'maybe', note: '', tip: '' }, child_traits: TRAITS }).fetchImpl }), null);
  assert.equal(await checkFace(jpeg, { fetchImpl: answering({ child_traits: TRAITS }, { failing: 'face_check' }).fetchImpl }), null);
  assert.equal(await checkFace(jpeg, { fetchImpl: async () => { throw new Error('offline'); } }), null);
});

test('traits are cleaned: no headwear means no label and no hidden hair', () => {
  const traits = readTraits({ ...TRAITS, headwear: '', marks: 'freckles' });
  assert.equal(traits.headwearLabel, '');
  assert.equal(traits.hairHidden, false);
  assert.deepEqual(traits.marks, []);
  assert.deepEqual(readTraits(null), NO_TRAITS);
});

test('a long description is cut back to its last full sentence', () => {
  assert.equal(wholeSentences('One two. Three four. Five six', 22), 'One two. Three four.');
  assert.equal(wholeSentences('Short.', 100), 'Short.');
  assert.equal(wholeSentences('No full stop anywhere in this text', 10), '');
});

test('the page locale picks the language texts are written in', () => {
  assert.equal(languageOf('pt-PT'), 'Portuguese');
  assert.equal(languageOf('de'), 'German');
  assert.equal(languageOf('xx'), 'English');
  assert.equal(languageOf(undefined), 'English');
});

test('without an OpenAI key the checks are skipped', async () => {
  const saved = process.env.OPENAI_KEY;
  delete process.env.OPENAI_KEY;
  try {
    let called = false;
    const fetchImpl = async () => { called = true; };
    assert.equal(await checkFace(jpeg, { fetchImpl }), null);
    assert.equal(await reviewCover(jpeg, 'https://covers.example/a.jpg', { fetchImpl }), null);
    assert.equal(called, false);
  } finally {
    if (saved !== undefined) process.env.OPENAI_KEY = saved;
  }
});

test('an unusable face stops the preview, with the reason and the tip', () => {
  assert.deepEqual(BLOCKING_VERDICTS, ['covered', 'turned_away', 'blurry', 'dark', 'several_faces', 'no_face']);
  const err = faceCheckError({ verdict: 'covered', note: 'cage', tip: 'The cage hides the face.' });
  assert.equal(err.message, 'face-not-clear');
  assert.equal(err.reason, 'covered');
  assert.equal(err.tip, 'The cage hides the face.');
  for (const verdict of ['clear', 'too_small']) assert.equal(faceCheckError({ verdict, note: '', tip: '' }), null, verdict);
  assert.equal(faceCheckError(null), null);
});

test('a face measured as too small stops the preview whatever the verdict', () => {
  for (const result of [null, { verdict: 'clear', note: '', tip: '' }]) {
    const err = faceCheckError(result, { tooSmall: true });
    assert.equal(err.message, 'face-not-clear');
    assert.equal(err.reason, Verdict.TOO_SMALL);
  }
  // A blocking verdict keeps its own reason.
  assert.equal(faceCheckError({ verdict: 'dark', note: '', tip: '' }, { tooSmall: true }).reason, 'dark');
});

test('the cover review sends the photo and the cover and reads the answer', async () => {
  process.env.OPENAI_KEY = 'test';
  const { fetchImpl, calls } = answering({
    cover_review: {
      glasses: 'missing', headwear: 'missing', hair: 'different', skin: 'match', head_too_big: true, pasted: false,
      title_name: 'NOLAN', notes: [{ label: 'Taches de rousseur', fix: 'Add the freckles across the nose.' }, { label: '', fix: 'x' }, { label: 'a', fix: 'b' }, { label: 'c', fix: 'd' }]
    }
  });
  const review = await reviewCover(jpeg, 'data:image/jpeg;base64,AAAA', { fetchImpl, locale: 'fr', traits: { ...NO_TRAITS, headwear: 'tall black chef hat' } });
  assert.deepEqual(review, {
    glasses: Seen.MISSING, headwear: Seen.MISSING, hair: Seen.DIFFERENT, skin: Seen.MATCH, headTooBig: true, pasted: false,
    titleName: 'NOLAN', notes: [{ label: 'Taches de rousseur', fix: 'Add the freckles across the nose' }, { label: 'a', fix: 'b' }]
  });
  const content = calls[0].body.messages[0].content;
  assert.equal(content.filter((c) => c.type === 'image_url').length, 2);
  assert.equal(content[1].image_url.url, 'data:image/jpeg;base64,AAAA');
  assert.match(content[2].text, /\(tall black chef hat\)/);
  assert.match(content[2].text, /in French/);
});

test('a review that fails or answers nonsense never blocks a cover', async () => {
  process.env.OPENAI_KEY = 'test';
  assert.equal(await reviewCover(jpeg, 'https://covers.example/a.jpg', { fetchImpl: answering({}, { failing: 'cover_review' }).fetchImpl }), null);
  assert.equal(await reviewCover(null, 'https://covers.example/a.jpg', { fetchImpl: async () => { throw new Error('unused'); } }), null);
  assert.deepEqual(readReview({ glasses: 'yes', hair: 7 }), {
    glasses: Seen.NONE, headwear: Seen.NONE, hair: Seen.UNCLEAR, skin: Seen.UNCLEAR, headTooBig: false, pasted: false, titleName: '', notes: []
  });
});
