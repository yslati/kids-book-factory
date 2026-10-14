// Readable R2 object names for the child's photo and the generated cover, so
// the bucket can be browsed by child instead of by UUID:
//
//   photos/<name>_<age>_<language>_<id>.<ext>          photos/emma_5_en_k3x9p2m7q1.jpg
//   previews/<name>_<age>_<language>_<book>_<id>.<ext> previews/emma_5_en_the-winning-goal_k3x9p2m7q1.jpg
//
// `id` is the generation id. A photo and its cover share it, so the pair is easy
// to match up. It must stay random rather than a timestamp: the bucket is
// public, and these characters are all that stop someone who knows a child's
// name and age from guessing the URL of their photo.

import { randomInt } from 'node:crypto';
import { resolveBookLanguage } from './book-languages.js';

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 10; // 36^10 ≈ 3.7e15 combinations (~52 bits)

export function newGenerationId() {
  let id = '';
  for (let i = 0; i < ID_LENGTH; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return id;
}

// Lowercase ASCII with words joined by '-'. Accents are folded (Zoé → zoe); a
// value with no Latin letters or digits at all (an Arabic or Cyrillic name, say)
// becomes `fallback`, because keys stay plain ASCII.
export function slugPart(value, maxLength, fallback) {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, maxLength)
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

function agePart(age) {
  const n = parseInt(age, 10);
  return Number.isFinite(n) && n >= 0 && n <= 18 ? String(n) : 'na';
}

function languagePart(language) {
  const lang = language ? resolveBookLanguage(language) : null;
  return lang ? lang.code : 'na';
}

// Product titles read "The Winning Goal – Personalized Football Book for Kids";
// only the story name before the dash is worth keeping.
function bookPart(bookTitle, themeId) {
  const story = String(bookTitle || '').split(/\s+[–—-]\s+/)[0];
  return slugPart(story, 40, slugPart(themeId, 40, 'book'));
}

function childPart({ childName, age, language }) {
  return [slugPart(childName, 24, 'child'), agePart(age), languagePart(language)].join('_');
}

export function photoKey({ childName, age, language, id, ext }) {
  return `photos/${childPart({ childName, age, language })}_${id}.${ext}`;
}

export function previewKey({ childName, age, language, bookTitle, themeId, id, ext }) {
  const book = bookPart(bookTitle, themeId);
  return `previews/${childPart({ childName, age, language })}_${book}_${id}.${ext}`;
}
