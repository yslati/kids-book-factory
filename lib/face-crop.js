// Finds the child's face in a photo so lib/child-photo.js can send the
// generator a head-and-shoulders crop instead of a full-body shot. In a
// full-length photo the face is a few percent of the image and likeness
// suffers; cropped to the upper body it is most of what the model sees.
//
// Detection runs in-process with BlazeFace (Google's small face detector,
// Apache 2.0) on TensorFlow.js's CPU backend: no network call, about 60-130
// ms per photo once the model is loaded (~0.5 s, once per warm function).
// The model files live in models/blazeface so cold starts don't depend on
// tfhub.dev. Any failure returns null and the caller keeps the photo as it
// is: the crop must never block a preview.
//
// Vision language models were tried first for this (gpt-5.4-nano/mini,
// November 2026): their boxes landed on the chest in 9 of 9 tries.

import { readFile } from 'node:fs/promises';

// How far the crop reaches beyond the face box: hair and a bit of shoulder,
// which the likeness rules in the prompt also rely on.
export const PAD_W = 2.6;
export const PAD_H = 3.2;
// Share of the vertical padding placed above the face (hair), the rest below.
const PAD_ABOVE = 0.4;
// A face already this tall (fraction of the image) is a portrait; no crop.
export const PORTRAIT_FACE_H = 0.28;
// BlazeFace's own default score threshold.
const MIN_SCORE = 0.75;

const MODEL_DIR = new URL('../models/blazeface/', import.meta.url);

let modelPromise = null;

// The BlazeFace model, loaded once from models/blazeface. tfjs-core only has
// HTTP and browser-storage loaders, so the files are read here and handed
// over in memory.
function loadModel() {
  if (!modelPromise) {
    modelPromise = (async () => {
      const [tf, blazeface] = await Promise.all([
        import('@tensorflow/tfjs-core'),
        import('@tensorflow-models/blazeface'),
        import('@tensorflow/tfjs-backend-cpu')
      ]);
      // PROD silences tfjs's console advice ("install our node backend"),
      // which logged every cold start as a warning, and skips debug checks.
      tf.env().set('PROD', true);
      await tf.setBackend('cpu');
      await tf.ready();
      const json = JSON.parse(await readFile(new URL('model.json', MODEL_DIR), 'utf8'));
      const groups = json.weightsManifest;
      const shards = await Promise.all(groups.flatMap((g) => g.paths).map((p) => readFile(new URL(p, MODEL_DIR))));
      const bytes = Buffer.concat(shards);
      const handler = {
        load: async () => ({
          modelTopology: json.modelTopology,
          weightSpecs: groups.flatMap((g) => g.weights),
          weightData: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          format: json.format,
          generatedBy: json.generatedBy,
          convertedBy: json.convertedBy
        })
      };
      return { tf, model: await blazeface.load({ modelUrl: handler, scoreThreshold: MIN_SCORE }) };
    })();
    // A failed load is retried on the next photo rather than cached.
    modelPromise.catch(() => { modelPromise = null; });
  }
  return modelPromise;
}

// The main child's face as { x, y, w, h } fractions of the image (top-left
// origin), or null when none was found or detection failed. jpeg is the photo
// as sent to the generator (upright, at most ~1024px). With several faces the
// largest one is taken as the child the photo is of.
export async function detectFace(jpeg) {
  try {
    const { default: sharp } = await import('sharp');
    const meta = await sharp(jpeg).metadata();
    const whole = await facesIn(sharp, jpeg, { left: 0, top: 0, width: meta.width, height: meta.height }, meta);
    if (whole) return whole;
    // BlazeFace looks at a 128px copy, so a small face in a wide shot can slip
    // past it. One more look at the middle of the photo, where the child
    // usually stands, doubles the face's size in that copy.
    return facesIn(sharp, jpeg, CENTRE(meta), meta);
  } catch (err) {
    console.warn('[face] detection failed:', (err && err.message) || err);
    return null;
  }
}

// The central 60% x 60% of the image, from a tenth of the way down.
const CENTRE = ({ width, height }) => ({
  left: Math.round(width * 0.2),
  top: Math.round(height * 0.1),
  width: Math.round(width * 0.6),
  height: Math.round(height * 0.6)
});

// The largest face in region (pixels) of the image, as fractions of the whole
// image, or null.
async function facesIn(sharp, jpeg, region, meta) {
  const { data, info } = await sharp(jpeg).extract(region).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { tf, model } = await loadModel();
  const input = tf.tensor3d(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), [info.height, info.width, 3], 'int32');
  let faces;
  try {
    faces = await model.estimateFaces(input, false);
  } finally {
    input.dispose();
  }
  const boxes = faces
    .map((f) => ({
      x: (region.left + f.topLeft[0]) / meta.width,
      y: (region.top + f.topLeft[1]) / meta.height,
      w: (f.bottomRight[0] - f.topLeft[0]) / meta.width,
      h: (f.bottomRight[1] - f.topLeft[1]) / meta.height,
      score: Array.isArray(f.probability) ? f.probability[0] : Number(f.probability)
    }))
    .filter((b) => b.score >= MIN_SCORE)
    .sort((a, b) => b.w * b.h - a.w * a.h);
  return plausibleFace(boxes[0]);
}

// The box when it is a face of a believable size inside the image, clamped
// to the image (BlazeFace can reach a little past the edge).
export function plausibleFace(box) {
  if (!box) return null;
  let { x, y, w, h } = box;
  if (![x, y, w, h].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  if (x < 0) { w += x; x = 0; }
  if (y < 0) { h += y; y = 0; }
  if (x + w > 1) w = 1 - x;
  if (y + h > 1) h = 1 - y;
  if (w < 0.03 || h < 0.03 || w > 0.9 || h > 0.9) return null;
  return { x, y, w, h };
}

// The pixel rectangle { left, top, width, height } to cut from a width x
// height image around face (fractions), or null when the photo is already a
// portrait and a crop would not help.
export function cropBox(face, { width, height }) {
  if (!face || !(width > 0 && height > 0)) return null;
  if (face.h >= PORTRAIT_FACE_H) return null;
  const faceW = face.w * width;
  const faceH = face.h * height;
  const h = Math.round(Math.min(height, faceH * PAD_H));
  // Never narrower than 4:5, so a thin face box still gives a natural frame.
  const w = Math.min(width, Math.ceil(Math.max(faceW * PAD_W, h * 0.8)));
  const centreX = (face.x + face.w / 2) * width;
  let left = Math.round(centreX - w / 2);
  let top = Math.round(face.y * height - (h - faceH) * PAD_ABOVE);
  left = Math.max(0, Math.min(left, width - w));
  top = Math.max(0, Math.min(top, height - h));
  return { left, top, width: w, height: h };
}
