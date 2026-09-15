// Entries arrive from the browser, so normalisation is the security-relevant
// part: it decides what we will store and later hand back to a page.
//
// Imports lib/preview-entry.js rather than lib/user-previews.js so the suite
// runs without @upstash/redis installed, matching the other tests here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseEntry, TTL_MS } from '../lib/preview-entry.js';

const GOOD = {
  k: 'gen-1',
  book: 'boy-book-7',
  bookTitle: 'Space Adventure',
  childName: 'Mia',
  age: '5',
  coverUrl: 'https://cdn.example.com/previews/gen-1.jpg',
  createdAt: '2026-01-01T00:00:00.000Z'
};

test('keeps a well-formed entry and derives expiresAt 30 days out', () => {
  const e = normaliseEntry(GOOD);
  assert.equal(e.k, 'gen-1');
  assert.equal(e.childName, 'Mia');
  assert.equal(e.coverUrl, GOOD.coverUrl);
  assert.equal(
    Date.parse(e.expiresAt) - Date.parse(e.createdAt),
    TTL_MS
  );
});

test('rejects entries with no key or no cover', () => {
  assert.equal(normaliseEntry({ ...GOOD, k: '' }), null);
  assert.equal(normaliseEntry({ ...GOOD, coverUrl: '' }), null);
});

test('rejects non-https covers, so a stored entry can never carry a script URL', () => {
  assert.equal(normaliseEntry({ ...GOOD, coverUrl: 'javascript:alert(1)' }), null);
  assert.equal(normaliseEntry({ ...GOOD, coverUrl: 'data:text/html,<script>' }), null);
  assert.equal(normaliseEntry({ ...GOOD, coverUrl: 'http://cdn.example.com/a.jpg' }), null);
});

test('rejects non-objects', () => {
  assert.equal(normaliseEntry(null), null);
  assert.equal(normaliseEntry('string'), null);
  assert.equal(normaliseEntry([GOOD]), null);
});

test('truncates oversized fields rather than storing them whole', () => {
  const e = normaliseEntry({ ...GOOD, childName: 'x'.repeat(500), bookTitle: 'y'.repeat(500) });
  assert.equal(e.childName.length, 40);
  assert.equal(e.bookTitle.length, 160);
});

test('falls back to now when createdAt is missing or unparseable', () => {
  const before = Date.now();
  const e = normaliseEntry({ ...GOOD, createdAt: 'not-a-date' });
  const created = Date.parse(e.createdAt);
  assert.ok(created >= before && created <= Date.now());
});
