// Validation of custom story requests and the record the cart card reads.

import test from 'node:test';
import assert from 'node:assert/strict';
import { claimCartPost, normaliseCart, normaliseGenerate, readCustomStory, saveCustomStory } from '../lib/custom-story.js';

const body = {
  photo_key: 'photos/lina_5_en_k3x9p2m7q1.jpg',
  generation_id: 'k3x9p2m7q1',
  reference: 'the-kindness-parade',
  world: 'bedtime',
  gender: 'girl',
  child_name: '  Lina ',
  age: '5',
  occasion: 'A new baby',
  brief: 'Lina throws a kindness parade\nfor the new girl next door.'
};

test('accepts a complete request in a fixed shape', () => {
  assert.deepEqual(normaliseGenerate(body).value, {
    photoKey: 'photos/lina_5_en_k3x9p2m7q1.jpg',
    generationId: 'k3x9p2m7q1',
    reference: 'the-kindness-parade',
    world: 'bedtime',
    gender: 'girl',
    childName: 'Lina',
    age: '5',
    occasion: 'A new baby',
    brief: 'Lina throws a kindness parade for the new girl next door.'
  });
});

test('age and occasion are optional; an odd age is dropped', () => {
  const { value } = normaliseGenerate({ ...body, age: 'old', occasion: '' });
  assert.equal(value.age, '');
  assert.equal(value.occasion, '');
});

test('rejects what the page never sends', () => {
  const error = (patch) => normaliseGenerate({ ...body, ...patch }).error;
  assert.equal(error({ child_name: '' }), 'missing-fields');
  assert.equal(error({ photo_key: 'previews/other.jpg' }), 'bad-photo-key');
  assert.equal(error({ generation_id: '../x' }), 'bad-generation-id');
  assert.equal(error({ reference: 'https://evil.example/cover.jpg' }), 'bad-reference');
  assert.equal(error({ world: 'horror' }), 'bad-world');
  assert.equal(error({ gender: 'robot' }), 'bad-gender');
  assert.equal(error({ occasion: 'Payday' }), 'bad-occasion');
  assert.equal(error({ brief: 'too short' }), 'brief-too-short');
  assert.equal(normaliseGenerate(null).error, 'missing-fields');
});

test('the cart follow-up needs a generation id', () => {
  assert.deepEqual(normaliseCart({ generation_id: 'k3x9p2m7q1', variant: 'Hardcover', price: '$44.99' }).value,
    { generationId: 'k3x9p2m7q1', variant: 'Hardcover', price: '$44.99', details: '' });
  assert.deepEqual(normaliseCart({ generation_id: 'k3x9p2m7q1', details: 'Has a cat,\nMilo' }).value,
    { generationId: 'k3x9p2m7q1', variant: '', price: '', details: 'Has a cat, Milo' });
  assert.equal(normaliseCart({ generation_id: '' }).error, 'bad-generation-id');
});

function memoryRedis() {
  const store = new Map();
  return {
    store,
    async set(key, value, opts = {}) {
      if (opts.nx && store.has(key)) return null;
      store.set(key, { value, opts });
      return 'OK';
    },
    async get(key) {
      return store.has(key) ? store.get(key).value : null;
    }
  };
}

test('keeps the record for 30 days and claims the cart card once', async () => {
  const redis = memoryRedis();
  await saveCustomStory(redis, 'k3x9p2m7q1', { childName: 'Lina' });
  assert.deepEqual(await readCustomStory(redis, 'k3x9p2m7q1'), { childName: 'Lina' });
  assert.equal(redis.store.get('kbf:custom:k3x9p2m7q1').opts.ex, 30 * 86400);
  assert.equal(await readCustomStory(redis, 'unknown'), null);

  assert.equal(await claimCartPost(redis, 'k3x9p2m7q1'), true);
  assert.equal(await claimCartPost(redis, 'k3x9p2m7q1'), false);
});

test('without Redis there is no record, and the claim is allowed', async () => {
  assert.equal(await readCustomStory(null, 'k3x9p2m7q1'), null);
  assert.equal(await claimCartPost(null, 'k3x9p2m7q1'), true);
});

test('a product-page cover keeps its record 30 days and claims the details card once', async () => {
  const { claimDetailsPost, readPreviewRecord, savePreviewRecord } = await import('../lib/preview-record.js');
  const redis = memoryRedis();
  await savePreviewRecord(redis, 'k3x9p2m7q1', { childName: 'Emma' });
  assert.deepEqual(await readPreviewRecord(redis, 'k3x9p2m7q1'), { childName: 'Emma' });
  assert.equal(redis.store.get('kbf:preview:k3x9p2m7q1').opts.ex, 30 * 86400);
  assert.equal(await readPreviewRecord(redis, 'unknown'), null);
  assert.equal(await claimDetailsPost(redis, 'k3x9p2m7q1'), true);
  assert.equal(await claimDetailsPost(redis, 'k3x9p2m7q1'), false);
  assert.equal(await readPreviewRecord(null, 'k3x9p2m7q1'), null);
});
