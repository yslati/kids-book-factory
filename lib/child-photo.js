// The child's photo as the generator receives it: upright, at most 1024px,
// and cropped to head and shoulders when a face is found (lib/face-crop.js).
// A full-length photo leaves the face a few percent of the image and the
// likeness suffers; the crop makes it most of what the model sees.
//
// The theme shrinks photos to 1024px before upload, but an old cached script,
// a photo the browser could not decode, or a direct API call can still leave
// a full-size original in R2 (12 MP phone photos have failed at Higgsfield),
// so the size is checked here too. The prepared copy sits next to the
// original in R2 and the generator is pointed at it.
//
// Every failure falls back to the original URL: a crop or resize problem
// must never block a preview.

import { publicUrl, putObject } from './r2.js';
import { cropBox, detectFace } from './face-crop.js';

export const MAX_PX = 1024;
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

// The photo cropped to the child's head and shoulders as a JPEG, or null when
// no face was found or the photo is already a portrait. detect is the face
// finder (tests pass their own).
export async function cropToFace(buf, { detect = detectFace } = {}) {
  const { default: sharp } = await import('sharp');
  // Upright and within MAX_PX, the same frame the generator would get.
  const upright = await sharp(buf, { failOn: 'none' })
    .rotate()
    .resize(MAX_PX, MAX_PX, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 90 })
    .toBuffer();
  const face = await detect(upright);
  if (!face) return null;
  const meta = await sharp(upright).metadata();
  const box = cropBox(face, meta);
  if (!box) return null;
  return sharp(upright).extract(box).jpeg({ quality: 90 }).toBuffer();
}

// The photo to send to the generator: { url, image }, where url is public and
// image the same bytes (for lib/face-check.js), or null when the photo could
// not be fetched and the generator gets the original URL blind.
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
    return { url: original, image: null };
  }

  try {
    const cropped = await cropToFace(buf);
    if (cropped) {
      const url = await putObject(faceKey(key), cropped, 'image/jpeg');
      console.log('[photo] sent a head-and-shoulders crop to the generator');
      return { url, image: cropped };
    }
  } catch (err) {
    console.warn('[photo] face crop failed:', (err && err.message) || err);
  }

  try {
    const shrunk = await shrinkPhoto(buf);
    if (!shrunk) return { url: original, image: buf };
    const url = await putObject(resizedKey(key), shrunk, 'image/jpeg');
    console.log('[photo] sent a ' + MAX_PX + 'px copy to the generator');
    return { url, image: shrunk };
  } catch (err) {
    console.warn('[photo] using the original, resize failed:', (err && err.message) || err);
    return { url: original, image: buf };
  }
}

// Public URL of the photo to send to the generator.
export async function childPhotoUrl(key) {
  return (await prepareChildPhoto(key)).url;
}
