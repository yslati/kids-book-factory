// The child's photo as the generator receives it: upright, at most 1024px,
// and, when FACE_CROP=on, cropped to head and shoulders when a face is found
// (lib/face-crop.js). The crop is cut from the photo at up to 2048px, so a
// small face in a full-length shot keeps its detail. The face is found and
// measured either way, for the too-small check. The prepared copy sits next to the
// original in R2 and the generator is pointed at it.
//
// Every failure falls back to the original URL: a crop or resize problem
// must never block a preview.

import { publicUrl, putObject } from './r2.js';
import { cropBox, detectFace } from './face-crop.js';

export const MAX_PX = 1024;
// The largest copy a crop is cut from.
export const SOURCE_PX = 2048;
// A face shorter than this, in the photo the generator gets, is too small for a likeness.
export const MIN_FACE_PX = 56;
// The head-and-shoulders crop is off unless FACE_CROP=on: a close crop makes
// the model paint the head too big for the cover's body.
export const FACE_CROP = process.env.FACE_CROP === 'on';
// The presigned PUT does not enforce the declared size, so cap what is read.
const MAX_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;

// photos/emma_5_en_k3x9p2m7q1.png → photos/emma_5_en_k3x9p2m7q1_1024.jpg
export function resizedKey(key) {
  return key.replace(/\.(jpg|png)$/, '_' + MAX_PX + '.jpg');
}

// photos/emma_5_en_k3x9p2m7q1.png → photos/emma_5_en_k3x9p2m7q1_face.jpg
export function faceKey(key) {
  return key.replace(/\.(jpg|png)$/, '_face.jpg');
}

// A JPEG ready for the generator, or null when the photo is already fine as
// it is (JPEG or PNG, upright, within MAX_PX).
export async function shrinkPhoto(buf) {
  const { default: sharp } = await import('sharp');
  // failOn 'none' still decodes slightly truncated phone JPEGs.
  const image = sharp(buf, { failOn: 'none' });
  const meta = await image.metadata();
  const fits = Math.max(meta.width || 0, meta.height || 0) <= MAX_PX;
  const upright = !meta.orientation || meta.orientation === 1;
  if (fits && upright && (meta.format === 'jpeg' || meta.format === 'png')) return null;

  // rotate() with no angle applies the EXIF orientation; output drops all
  // metadata and is converted to sRGB.
  return image
    .rotate()
    .resize(MAX_PX, MAX_PX, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 90 })
    .toBuffer();
}

// The photo upright as a JPEG of at most px on its long edge.
async function uprightJpeg(sharp, buf, px) {
  return sharp(buf, { failOn: 'none' })
    .rotate()
    .resize(px, px, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 90 })
    .toBuffer();
}

// { image, faceHeightPx } for a photo with a face, or null when none was
// found. image is the head-and-shoulders crop as a JPEG, or null when the
// photo is already a portrait; faceHeightPx the face's height in the photo
// the generator gets. detect is the face finder (tests pass their own); with
// crop false the face is only measured.
export async function cropToFace(buf, { detect = detectFace, crop = FACE_CROP } = {}) {
  const { default: sharp } = await import('sharp');
  const small = await uprightJpeg(sharp, buf, MAX_PX);
  const face = await detect(small);
  if (!face) return null;
  if (!crop) {
    const smallMeta = await sharp(small).metadata();
    return { image: null, faceHeightPx: Math.round(face.h * smallMeta.height) };
  }
  const full = await uprightJpeg(sharp, buf, SOURCE_PX);
  const meta = await sharp(full).metadata();
  const box = cropBox(face, meta);
  if (!box) {
    const smallMeta = await sharp(small).metadata();
    return { image: null, faceHeightPx: Math.round(face.h * smallMeta.height) };
  }
  const scale = Math.min(1, MAX_PX / Math.max(box.width, box.height));
  const image = await sharp(full)
    .extract(box)
    .resize(MAX_PX, MAX_PX, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
  return { image, faceHeightPx: Math.round(face.h * meta.height * scale) };
}

// The photo to send to the generator: { url, image, faceHeightPx }, where url
// is public, image the same bytes (for lib/face-check.js; null when the photo
// could not be fetched) and faceHeightPx the face's height, or null when no
// face was measured.
export async function prepareChildPhoto(key) {
  const original = publicUrl(key);
  let buf;
  try {
    const res = await fetch(original, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error('photo-fetch-' + res.status);
    if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error('photo-too-large');
    buf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.warn('[photo] using the original, fetch failed:', (err && err.message) || err);
    return { url: original, image: null, faceHeightPx: null };
  }

  let faceHeightPx = null;
  try {
    const found = await cropToFace(buf);
    if (found) faceHeightPx = found.faceHeightPx;
    if (found && found.image) {
      const url = await putObject(faceKey(key), found.image, 'image/jpeg');
      console.log('[photo] sent a head-and-shoulders crop to the generator');
      return { url, image: found.image, faceHeightPx };
    }
  } catch (err) {
    console.warn('[photo] face crop failed:', (err && err.message) || err);
  }

  try {
    const shrunk = await shrinkPhoto(buf);
    if (!shrunk) return { url: original, image: buf, faceHeightPx };
    const url = await putObject(resizedKey(key), shrunk, 'image/jpeg');
    console.log('[photo] sent a ' + MAX_PX + 'px copy to the generator');
    return { url, image: shrunk, faceHeightPx };
  } catch (err) {
    console.warn('[photo] using the original, resize failed:', (err && err.message) || err);
    return { url: original, image: buf, faceHeightPx };
  }
}

// true when the measured face is too small to paint a likeness from.
export function faceTooSmall(photo) {
  return typeof photo.faceHeightPx === 'number' && photo.faceHeightPx < MIN_FACE_PX;
}

// Public URL of the photo to send to the generator.
export async function childPhotoUrl(key) {
  return (await prepareChildPhoto(key)).url;
}
