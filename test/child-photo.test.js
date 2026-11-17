// Shrinking and face-cropping the child's photo for the generator, on small
// generated images.

import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { MAX_PX, MIN_FACE_PX, cropToFace, faceKey, faceTooSmall, resizedKey, shrinkPhoto } from '../lib/child-photo.js';
import { PORTRAIT_FACE_H, cropBox, plausibleFace } from '../lib/face-crop.js';

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

test('the copies sit next to the original under their own names', () => {
  assert.equal(resizedKey('photos/emma_5_en_k3x9p2m7q1.png'), 'photos/emma_5_en_k3x9p2m7q1_1024.jpg');
  assert.equal(resizedKey('photos/emma_5_en_k3x9p2m7q1.jpg'), 'photos/emma_5_en_k3x9p2m7q1_1024.jpg');
  assert.equal(faceKey('photos/emma_5_en_k3x9p2m7q1.png'), 'photos/emma_5_en_k3x9p2m7q1_face.jpg');
});

test('a small face in a full-length photo gets a head-and-shoulders crop', () => {
  // A 10% tall face a third of the way down a 768x1024 portrait photo.
  const face = { x: 0.45, y: 0.3, w: 0.1, h: 0.1 };
  const box = cropBox(face, { width: 768, height: 1024 });
  assert.ok(box.height > 102 * 3 && box.height < 102 * 3.5, `height ${box.height}`);
  assert.ok(box.width >= box.height * 0.8, 'at least 4:5');
  // The face sits in the upper part of the crop, with hair room above it.
  assert.ok(box.top < 0.3 * 1024 && box.top > 0.3 * 1024 - box.height * 0.5);
  assert.ok(box.left >= 0 && box.left + box.width <= 768);
  assert.ok(box.top + box.height <= 1024);
});

test('a crop near the edge stays inside the photo', () => {
  const box = cropBox({ x: 0.02, y: 0.01, w: 0.1, h: 0.1 }, { width: 1000, height: 1000 });
  assert.equal(box.left, 0);
  assert.equal(box.top, 0);
  assert.ok(box.width <= 1000 && box.height <= 1000);
});

test('a portrait that already fills the frame is not cropped', () => {
  assert.equal(cropBox({ x: 0.3, y: 0.2, w: 0.4, h: PORTRAIT_FACE_H }, { width: 800, height: 1000 }), null);
  assert.equal(cropBox(null, { width: 800, height: 1000 }), null);
});

test('only a face of a believable size counts, clamped to the image', () => {
  assert.deepEqual(plausibleFace({ x: 0.4, y: 0.2, w: 0.2, h: 0.2 }), { x: 0.4, y: 0.2, w: 0.2, h: 0.2 });
  // BlazeFace boxes can reach a little past the edge.
  const edge = plausibleFace({ x: -0.02, y: 0.9, w: 0.2, h: 0.2 });
  assert.equal(edge.x, 0);
  assert.ok(Math.abs(edge.w - 0.18) < 1e-9 && Math.abs(edge.h - 0.1) < 1e-9);
  assert.equal(plausibleFace({ x: 0.4, y: 0.2, w: 0.01, h: 0.01 }), null);
  assert.equal(plausibleFace({ x: 0.05, y: 0.05, w: 0.95, h: 0.95 }), null);
  assert.equal(plausibleFace({ x: 'a', y: 0.2, w: 0.3, h: 0.2 }), null);
  assert.equal(plausibleFace(null), null);
  assert.equal(plausibleFace(undefined), null);
});

test('cropToFace cuts the detected region out of the upright photo', async () => {
  // Stored landscape with orientation 6: upright it is 600 wide, 800 tall.
  const buf = await photo(800, 600, { orientation: 6 });
  let seen = null;
  const detect = async (jpeg) => {
    seen = await sharp(jpeg).metadata();
    return { x: 0.4, y: 0.25, w: 0.2, h: 0.15 };
  };
  const out = await cropToFace(buf, { detect });
  assert.deepEqual([seen.width, seen.height], [600, 800], 'the detector sees the upright photo');
  const meta = await sharp(out.image).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.ok(meta.height < 800 && meta.height > 120 * 3, `crop height ${meta.height}`);
  assert.ok(meta.width <= 600);
  assert.equal(out.faceHeightPx, 120);
});

test('a small face in a large photo is cropped from the 2048px copy, so it keeps its detail', async () => {
  // A face 6% of a 3000x4000 photo: 61px in the 1024px copy, 123px in the 2048px one.
  const out = await cropToFace(await photo(3000, 4000), { detect: async () => ({ x: 0.47, y: 0.3, w: 0.06, h: 0.06 }) });
  const meta = await sharp(out.image).metadata();
  assert.ok(meta.height > 400 && meta.height <= MAX_PX, `crop height ${meta.height}`);
  assert.equal(out.faceHeightPx, 123);
});

test('a portrait is measured but not cropped', async () => {
  const out = await cropToFace(await photo(600, 800), { detect: async () => ({ x: 0.3, y: 0.2, w: 0.4, h: 0.4 }) });
  assert.deepEqual(out, { image: null, faceHeightPx: 320 });
});

test('cropToFace gives null when no face is found, so the caller falls back', async () => {
  assert.equal(await cropToFace(await photo(600, 800), { detect: async () => null }), null);
});

test('only a measured face under the minimum is too small', () => {
  assert.equal(faceTooSmall({ faceHeightPx: MIN_FACE_PX - 1 }), true);
  assert.equal(faceTooSmall({ faceHeightPx: MIN_FACE_PX }), false);
  assert.equal(faceTooSmall({ faceHeightPx: null }), false);
});
