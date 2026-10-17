import test from 'node:test';
import assert from 'node:assert/strict';

import { newGenerationId, photoKey, previewKey, slugPart } from '../lib/object-names.js';

test('generation ids are 10 random lowercase characters', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i++) {
    const id = newGenerationId();
    assert.match(id, /^[a-z0-9]{10}$/);
    ids.add(id);
  }
  assert.equal(ids.size, 200);
});

test('names the photo name_age_language_id', () => {
  assert.equal(
    photoKey({ childName: 'Emma', age: '5', language: 'en', id: 'k3x9p2m7q1', ext: 'jpg' }),
    'photos/emma_5_en_k3x9p2m7q1.jpg'
  );
});

test('names the cover name_age_language_book_id from the story part of the title', () => {
  assert.equal(
    previewKey({
      childName: 'Emma',
      age: 5,
      language: 'fr',
      bookTitle: 'The Winning Goal – Personalized Football Book for Kids',
      themeId: 'ethan-saves-the-match',
      id: 'k3x9p2m7q1',
      ext: 'png'
    }),
    'previews/emma_5_fr_the-winning-goal_k3x9p2m7q1.png'
  );
  assert.equal(
    previewKey({ childName: 'Emma', age: 5, language: 'en', bookTitle: 'The Star Painter - Personalized Creativity Book', id: 'a', ext: 'jpg' }),
    'previews/emma_5_en_the-star-painter_a.jpg'
  );
  assert.equal(
    previewKey({ childName: 'Lily', age: 4, language: 'en', bookTitle: 'The Ribbon of Light: Personalized Gymnastics Book for Girls', id: 'a', ext: 'png' }),
    'previews/lily_4_en_the-ribbon-of-light_a.png'
  );
  assert.equal(
    previewKey({ childName: 'Emma', age: 5, language: 'en', bookTitle: 'The Cloud Train — Personalized Bedtime Book', id: 'a', ext: 'jpg' }),
    'previews/emma_5_en_the-cloud-train_a.jpg'
  );
});

test('uses the whole title, cut to 40 characters, when it has no colon or spaced dash', () => {
  assert.equal(
    previewKey({ childName: 'Lily', age: 4, language: 'en', bookTitle: 'The Ribbon of Light Personalized Gymnastics Book for Girls', id: 'a', ext: 'png' }),
    'previews/lily_4_en_the-ribbon-of-light-personalized-gymnast_a.png'
  );
});

test('falls back to the product handle when the book has no title', () => {
  assert.equal(
    previewKey({ childName: 'Emma', age: 5, language: 'en', bookTitle: '', themeId: 'the-cloud-train', id: 'a', ext: 'jpg' }),
    'previews/emma_5_en_the-cloud-train_a.jpg'
  );
});

test('folds accents and spaces into plain ASCII slugs', () => {
  assert.equal(slugPart('  Zoé Anne-Marie ', 24, 'child'), 'zoe-anne-marie');
  assert.equal(slugPart("O'Brien", 24, 'child'), 'o-brien');
  assert.equal(slugPart('Maximilian-Alexander Johannes', 24, 'child'), 'maximilian-alexander-joh');
});

test('uses placeholders for missing or non-Latin details', () => {
  assert.equal(photoKey({ childName: 'Анна', age: '', language: '', id: 'a', ext: 'jpg' }), 'photos/child_na_na_a.jpg');
  assert.equal(photoKey({ childName: undefined, age: '42', language: 'nl', id: 'a', ext: 'jpg' }), 'photos/child_na_na_a.jpg');
});

test('never lets input escape the photos/ prefix or break the key format', () => {
  const key = photoKey({ childName: '../../previews/x', age: '5', language: 'en', id: 'a', ext: 'jpg' });
  assert.equal(key, 'photos/previews-x_5_en_a.jpg');
  assert.match(key, /^photos\/[A-Za-z0-9_-]+\.(jpg|png)$/);
});
