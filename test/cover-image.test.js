// The stored-cover encoder, on small generated images.

import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { LOGO, coverForStorage } from '../lib/cover-image.js';

// Saved tagged as Display P3, so the PNG holds P3 numbers (~189, 124, 87):
// only a real conversion to sRGB gets this colour back.
const ORANGE = { r: 200, g: 120, b: 80 };

function p3PngWithExif() {
  return sharp({ create: { width: 32, height: 24, channels: 3, background: ORANGE } })
    .withIccProfile('p3')
    .withExif({ IFD0: { Copyright: 'test' } })
    .png()
    .toBuffer();
}

async function firstPixel(jpeg) {
  return Array.from((await sharp(jpeg).raw().toBuffer()).subarray(0, 3));
}

test('re-encodes a PNG cover as an sRGB JPEG with no metadata', async () => {
  const cover = await coverForStorage(await p3PngWithExif(), 'image/png');
  assert.equal(cover.contentType, 'image/jpeg');
  assert.equal(cover.ext, 'jpg');

  const meta = await sharp(cover.body).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.deepEqual([meta.width, meta.height], [32, 24]);
  assert.equal(meta.space, 'srgb');
  assert.equal(meta.chromaSubsampling, '4:4:4');
  assert.equal(meta.isProgressive, true);
  assert.equal(meta.exif, undefined);
  assert.equal(meta.icc, undefined);

  const [r, g, b] = await firstPixel(cover.body);
  for (const [got, want] of [[r, ORANGE.r], [g, ORANGE.g], [b, ORANGE.b]]) {
    assert.ok(Math.abs(got - want) <= 3, got + ' is not within 3 of ' + want);
  }
});

test('puts transparent pixels on white, since JPEG has no alpha', async () => {
  const clear = await sharp({
    create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  }).png().toBuffer();
  const cover = await coverForStorage(clear, 'image/png');
  assert.deepEqual(await firstPixel(cover.body), [255, 255, 255]);
});

test('stores the original bytes and extension when the cover cannot be converted', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const notAnImage = Buffer.from('not an image');

  const png = await coverForStorage(notAnImage, 'image/png');
  assert.equal(png.body, notAnImage);
  assert.equal(png.contentType, 'image/png');
  assert.equal(png.ext, 'png');

  assert.deepEqual(await coverForStorage(notAnImage, null),
    { body: notAnImage, contentType: 'image/jpeg', ext: 'jpg' });
  assert.equal(warn.mock.callCount(), 2);
});

async function pixelAt(jpeg, x, y) {
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return Array.from(data.subarray(i, i + 3));
}

test('adds the logo badge at the bottom centre and leaves the rest of the cover alone', async () => {
  const black = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#000' } }).png().toBuffer();
  const cover = await coverForStorage(black, 'image/png', { logo: true });

  const meta = await sharp(cover.body).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 400, 300]);
  // Just inside the badge's top edge, above the logo: the white pill.
  const badgeTop = 300 - Math.round(300 * LOGO.bottom) - 1;
  const [pill] = await pixelAt(cover.body, 200, badgeTop - 2);
  assert.ok(pill > 200, 'the bottom of the cover shows no white pill: ' + pill);
  // The corners and the top stay as painted.
  for (const [x, y] of [[5, 5], [200, 20], [5, 295], [395, 295]]) {
    const [r] = await pixelAt(cover.body, x, y);
    assert.ok(r < 20, 'pixel ' + x + ',' + y + ' changed: ' + r);
  }
});

test('leaves the logo off covers stored without it', async () => {
  const black = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#000' } }).png().toBuffer();
  const cover = await coverForStorage(black, 'image/png');
  const badgeTop = 300 - Math.round(300 * LOGO.bottom) - 1;
  const [r] = await pixelAt(cover.body, 200, badgeTop - 2);
  assert.ok(r < 20);
});
