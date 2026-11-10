// The cover-preview prompt and the per-order lines appended to it.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PREVIEW_PROMPT, FIX_REASONS, MAX_FIX_NOTE_CHARS, MAX_HERO_POSE_CHARS, buildPreviewPrompt, withFix, withHeroPose
} from '../lib/prompt.js';
import { BOOK_LANGUAGES, resolveBookLanguage } from '../lib/book-languages.js';

// Higgsfield's Marketing Studio endpoints reject longer prompts.
const PROVIDER_PROMPT_LIMIT = 5000;

test('the default prompt asks for 75% real child, 25% cover style', () => {
  assert.match(DEFAULT_PREVIEW_PROMPT, /75% the real child and 25% the cover's animation style/);
  assert.doesNotMatch(DEFAULT_PREVIEW_PROMPT, /85%/);
});

test('the default prompt takes pose and expression from the cover, not the photo', () => {
  assert.match(DEFAULT_PREVIEW_PROMPT, /in the original hero's exact pose, head angle, gaze, expression and outfit/);
  assert.match(DEFAULT_PREVIEW_PROMPT, /EXPRESSION COMES FROM THE COVER, NEVER FROM THE PHOTO/);
  assert.match(DEFAULT_PREVIEW_PROMPT, /even if the photo is neutral, serious, sleepy, surprised or open-mouthed/);
  assert.doesNotMatch(DEFAULT_PREVIEW_PROMPT, /which teeth show/);
});

test('the default prompt keeps the hero\'s headwear and everyone else\'s faces', () => {
  assert.match(DEFAULT_PREVIEW_PROMPT, /If the hero wears a helmet, hat, crown or hood, the child wears that same one/);
  assert.match(DEFAULT_PREVIEW_PROMPT, /Never give anyone else the child's face, hair or age/);
});

test('appends the language, the name with its no-leftover-letters rule, and the age', () => {
  const prompt = buildPreviewPrompt('BASE', {
    language: resolveBookLanguage('fr'),
    childName: 'James',
    age: '7'
  });
  assert.ok(prompt.startsWith('BASE\n\n'));
  assert.match(prompt, /Book language: French \(fr\)\./);
  assert.match(prompt, /the child's first name is "James"/);
  assert.match(prompt, /Replace every one of them with "James"/);
  assert.match(prompt, /cap, jersey or clothing, signs, banners, scoreboards and labels/);
  assert.match(prompt, /No letter of the old name may remain anywhere/);
  assert.match(prompt, /The child is 7 years old\./);
});

test('leaves out the name and age lines when they are empty', () => {
  const prompt = buildPreviewPrompt('BASE', { language: resolveBookLanguage('en'), childName: '', age: '' });
  assert.match(prompt, /Book language: English \(en\)\./);
  assert.doesNotMatch(prompt, /first name/);
  assert.doesNotMatch(prompt, /years old/);
});

test('the longest default prompt an order can produce fits the provider limit', () => {
  const longestLanguage = Object.keys(BOOK_LANGUAGES)
    .map(resolveBookLanguage)
    .sort((a, b) => b.name.length - a.name.length)[0];
  // api/preview.js caps names at 40 characters and ages at 18.
  const prompt = buildPreviewPrompt(withHeroPose(DEFAULT_PREVIEW_PROMPT, 'x'.repeat(MAX_HERO_POSE_CHARS + 50)), {
    language: longestLanguage,
    childName: 'x'.repeat(40),
    age: '18'
  });
  assert.ok(prompt.length <= PROVIDER_PROMPT_LIMIT, `prompt is ${prompt.length} characters`);
  // A free fix adds its line on top, with or without the parent's words.
  for (const reason of Object.keys(FIX_REASONS)) {
    for (const note of ['', 'n'.repeat(MAX_FIX_NOTE_CHARS)]) {
      const fixed = withFix(prompt, { reason, note }, 'x'.repeat(40));
      assert.ok(fixed.length <= PROVIDER_PROMPT_LIMIT, `${reason} fix is ${fixed.length} characters`);
    }
  }
});

test('a free fix puts the reported problem first', () => {
  assert.equal(withFix('BASE', { reason: 'name', note: '' }, 'Jack'),
    'FIX: the name was wrong last time. Write "Jack" exactly, letter for letter, with no apostrophe or extra letters.\n\nBASE');
  assert.match(withFix('BASE', { reason: 'hair_skin', note: 'his hair is "dark"\nbrown' }, 'Jack'),
    /^FIX: the hair or skin was wrong.* The parent adds: "his hair is dark brown"\n\nBASE$/);
  assert.match(withFix('BASE', { reason: 'other', note: 'the dog is missing' }, 'Jack'),
    /^FIX: the parent says the last cover was wrong: "the dog is missing"\. Look again and fix what does not match the photo\.\n\nBASE$/);
  assert.match(withFix('BASE', { reason: 'other', note: '' }, 'Jack'), /^FIX: .*fix what does not match the photo\.\n\nBASE$/);
  assert.equal(withFix('BASE', { reason: 'nope' }, 'Jack'), 'BASE');
  // A name fix generates with the corrected name and repeats it as the note.
  assert.match(withFix('BASE', { reason: 'name', note: 'should be "Jakob"' }, 'Jakob'),
    /^FIX: .*Write "Jakob" exactly.* The parent adds: "should be Jakob"\n\nBASE$/);
});

test('puts the book\'s hero pose first and caps its length', () => {
  const prompt = withHeroPose('BASE', '  The hero looks\n straight at the reader.  ');
  assert.ok(prompt.startsWith('THE HERO\'S HEAD ON THIS COVER - The hero looks straight at the reader. '));
  assert.ok(prompt.endsWith('\n\nBASE'));
  const long = withHeroPose('BASE', 'q'.repeat(MAX_HERO_POSE_CHARS + 50));
  assert.equal(long.split('q').length - 1, MAX_HERO_POSE_CHARS);
});

test('leaves the prompt alone when the book has no hero pose', () => {
  assert.equal(withHeroPose('BASE', ''), 'BASE');
  assert.equal(withHeroPose('BASE', null), 'BASE');
});
