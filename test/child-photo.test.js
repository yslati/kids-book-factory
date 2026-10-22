// Shrinking the child's photo for the generator, on small generated images.

import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { MAX_PX, resizedKey, shrinkPhoto } from '../lib/child-photo.js';

function photo(width, height, { format = 'jpeg', orientation } = {}) {
  let image = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 80 } } });
  if (orientation) image = image.withMetadata({ orientation });
  return image[format]().toBuffer();
}

test('a photo already within the limit and upright is left alone', async () => {
  assert.equal(await shrinkPhoto(await photo(MAX_PX, 800)), null);
  assert.equal(await shrinkPhoto(await photo(500, 700, { format: 'png' })), null);
});

test('a full-size phone photo becomes a 1024px JPEG with its shape kept', async () => {
  const out = await shrinkPhoto(await photo(3024, 4032));
  const meta = await sharp(out).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.deepEqual([meta.width, meta.height], [768, 1024]);
  assert.equal(meta.exif, undefined);
  assert.equal(meta.icc, undefined);
});

test('a small photo with an EXIF rotation is turned upright', async () => {
  // Orientation 6: stored landscape, displayed rotated 90° into portrait.
  const out = await shrinkPhoto(await photo(400, 300, { orientation: 6 }));
  const meta = await sharp(out).metadata();
  assert.deepEqual([meta.width, meta.height], [300, 400]);
  assert.equal(meta.orientation, undefined);
});

test('a format the generator may not take is converted to JPEG', async () => {
  const out = await shrinkPhoto(await photo(400, 300, { format: 'webp' }));
  assert.equal((await sharp(out).metadata()).format, 'jpeg');
});

test('bytes that are not an image throw, for the caller to fall back on', async () => {
  await assert.rejects(shrinkPhoto(Buffer.from('not an image')));
});

test('the copy sits next to the original under its own name', () => {
  assert.equal(resizedKey('photos/emma_5_en_k3x9p2m7q1.png'), 'photos/emma_5_en_k3x9p2m7q1_1024.jpg');
  assert.equal(resizedKey('photos/emma_5_en_k3x9p2m7q1.jpg'), 'photos/emma_5_en_k3x9p2m7q1_1024.jpg');
});
