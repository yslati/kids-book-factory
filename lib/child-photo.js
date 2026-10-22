// The child's photo as the generator receives it. The theme shrinks photos to
// 1024px before upload, but an old cached script, a photo the browser could not
// decode, or a direct API call can still leave a full-size original in R2
// (12 MP phone photos have failed at Higgsfield). Those get a 1024px sRGB JPEG
// copy next to the original, with EXIF orientation applied, and the generator
// is pointed at the copy.
//
// Every failure falls back to the original URL: a resize problem must never
// block a preview.

import { publicUrl, putObject } from './r2.js';

export const MAX_PX = 1024;
// The presigned PUT does not enforce the declared size, so cap what is read.
const MAX_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;

// photos/emma_5_en_k3x9p2m7q1.png → photos/emma_5_en_k3x9p2m7q1_1024.jpg
export function resizedKey(key) {
  return key.replace(/\.(jpg|png)$/, '_' + MAX_PX + '.jpg');
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

// Public URL of the photo to send to the generator.
export async function childPhotoUrl(key) {
  const original = publicUrl(key);
  try {
    const res = await fetch(original, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error('photo-fetch-' + res.status);
    if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error('photo-too-large');
    const shrunk = await shrinkPhoto(Buffer.from(await res.arrayBuffer()));
    if (!shrunk) return original;
    const url = await putObject(resizedKey(key), shrunk, 'image/jpeg');
    console.log('[photo] sent a ' + MAX_PX + 'px copy to the generator');
    return url;
  } catch (err) {
    console.warn('[photo] using the original, resize failed:', (err && err.message) || err);
    return original;
  }
}
