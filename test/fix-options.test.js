// The fix buttons chosen for a cover.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fixOptions, pickedNotes, reviewSummary } from '../lib/fix-options.js';
import { NO_TRAITS, Seen } from '../lib/face-check.js';

const CHEF = { ...NO_TRAITS, glasses: 'black rectangular glasses', headwear: 'tall black chef hat', headwearLabel: 'chef hat' };
const FINE = { glasses: Seen.MATCH, headwear: Seen.MATCH, hair: Seen.MATCH, skin: Seen.MATCH, headTooBig: false, pasted: false, titleName: 'NOLAN', notes: [] };

const ids = (options) => options.map((o) => o.id);

test('without a review the standard buttons show, plus what the photo has', () => {
  assert.deepEqual(ids(fixOptions(null, null)), ['likeness', 'head', 'style', 'hair', 'skin', 'name', 'other']);
  const options = fixOptions(CHEF, null, { childName: 'Nolan' });
  assert.deepEqual(ids(options), ['likeness', 'head', 'style', 'glasses', 'headwear_add', 'hair', 'skin', 'name', 'other']);
  assert.ok(options.every((o) => !o.spotted));
  assert.equal(options.find((o) => o.id === 'headwear_add').label, 'chef hat');
});

test('what the review spotted comes first', () => {
  const review = { ...FINE, glasses: Seen.MISSING, headwear: Seen.MISSING, hair: Seen.DIFFERENT, headTooBig: true, notes: [{ label: 'Missing freckles', fix: 'Add the freckles.' }] };
  const options = fixOptions(CHEF, review, { childName: 'Nolan' });
  assert.deepEqual(ids(options), ['head', 'glasses', 'headwear_add', 'hair', 'note_0', 'likeness', 'style', 'skin', 'name', 'other']);
  assert.deepEqual(options.filter((o) => o.spotted).map((o) => o.id), ['head', 'glasses', 'headwear_add', 'hair', 'note_0']);
  assert.equal(options.find((o) => o.id === 'note_0').label, 'Missing freckles');
  assert.equal(reviewSummary(options), 'head, glasses, chef hat, hair, Missing freckles');
});

test('headwear already on the cover can be taken off instead', () => {
  const options = fixOptions(CHEF, FINE, { childName: 'Nolan' });
  assert.ok(ids(options).includes('headwear_remove'));
  assert.ok(!ids(options).includes('headwear_add'));
  assert.ok(options.every((o) => !o.spotted));
  assert.equal(reviewSummary(options), '');
});

test('glasses the child does not wear are offered only when the cover added some', () => {
  assert.ok(!ids(fixOptions(NO_TRAITS, { ...FINE, glasses: Seen.NONE })).includes('glasses'));
  const added = fixOptions(NO_TRAITS, { ...FINE, glasses: Seen.DIFFERENT });
  assert.equal(added[0].id, 'glasses');
  assert.equal(added[0].spotted, true);
});

test('a title with another name is spotted, whatever its case or accents', () => {
  const spotted = (titleName, childName) => fixOptions(null, { ...FINE, titleName }, { childName }).find((o) => o.id === 'name').spotted;
  assert.equal(spotted('NOLAN', 'Nolan'), false);
  assert.equal(spotted('ZOE', 'Zoé'), false);
  assert.equal(spotted("NOLAN'S", 'Nolan'), false);
  assert.equal(spotted('MASSON', 'Nolan'), true);
  // Nothing read, nothing claimed.
  assert.equal(spotted('', 'Nolan'), false);
  assert.equal(spotted('NOLAN', ''), false);
});

test('a fix names the review notes by id, and only those kept on the record', () => {
  const notes = [{ label: 'A', fix: 'a' }, { label: 'B', fix: 'b' }];
  assert.deepEqual(pickedNotes(['glasses', 'note_1', 'note_1', 'note_7', 'note_x'], notes), [{ label: 'B', fix: 'b' }]);
  assert.deepEqual(pickedNotes(['note_0'], undefined), []);
  assert.deepEqual(pickedNotes('note_0', notes), []);
});
