// The cover-preview prompt and the per-order lines appended to it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PREVIEW_PROMPT, buildPreviewPrompt } from '../lib/prompt.js';
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
  assert.match(prompt, /replace the whole name with "James"/);
  assert.match(prompt, /No letter of the old name may remain/);
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
  const prompt = buildPreviewPrompt(DEFAULT_PREVIEW_PROMPT, {
    language: longestLanguage,
    childName: 'x'.repeat(40),
    age: '18'
  });
  assert.ok(prompt.length <= PROVIDER_PROMPT_LIMIT, `prompt is ${prompt.length} characters`);
});
