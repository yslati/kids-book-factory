// The size gate: after a cover is generated, the painted head is measured
// against the original hero's (BlazeFace, lib/face-crop.js) and the cover is
// regenerated once when it comes out much too big. Prompt wording cannot
// force the head size - close-up photos still produced oversized heads - but
// the detector sees it deterministically, so the worst covers get one more
// try while the better of the two is kept.
//
// Every failure falls back to the cover in hand: the gate must never cost a
// parent a finished cover.

import { detectFace } from './face-crop.js';

// Painted heads this much taller than the hero's trigger the retry. Hero
// heads measured today sit around 0.13-0.17 of the cover's height, and the
// oversized covers parents noticed read ~1.4x and up.
export const HEAD_RETRY_RATIO = 1.3;

// Hero head heights per cover URL: covers repeat across requests, so a warm
// function measures each book once.
const HERO_CACHE = new Map();
const HERO_CACHE_MAX = 200;

async function bytesOf(url, fetchImpl) {
  const data = /^data:[^;,]+;base64,(.*)$/s.exec(url);
  if (data) return Buffer.from(data[1], 'base64');
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('image-fetch-' + res.status);
  return Buffer.from(await res.arrayBuffer());
}

// The largest face's height as a fraction of the image height, or null.
async function headHeightOf(url, fetchImpl) {
  const face = await detectFace(await bytesOf(url, fetchImpl));
  return face ? face.h : null;
}

// Painted head height / hero head height, or null when either face can't be
// found (an unusual cover, a detector miss): no measurement, no retry.
export async function headRatio(coverUrl, generatedUrl, { fetchImpl = fetch } = {}) {
  try {
    if (!HERO_CACHE.has(coverUrl)) {
      if (HERO_CACHE.size >= HERO_CACHE_MAX) HERO_CACHE.clear();
      HERO_CACHE.set(coverUrl, await headHeightOf(coverUrl, fetchImpl));
    }
    const hero = HERO_CACHE.get(coverUrl);
    if (!hero) return null;
    const painted = await headHeightOf(generatedUrl, fetchImpl);
    return painted ? painted / hero : null;
  } catch (err) {
    console.warn('[head-gate] measurement failed:', (err && err.message) || err);
    return null;
  }
}

// Runs generate() once, and once more when the painted head is over
// ratioLimit times the hero's; the cover with the head closest to the hero's
// wins. retry generates the second attempt (defaults to generate; the
// preview passes one without keepPending, so a queued-job error can't
// replace a cover already in hand). A retry that fails for any reason -
// including running out of the request's time budget - keeps the first.
export async function withHeadGate(generate, { coverUrl, ratioLimit = HEAD_RETRY_RATIO, retry = generate, measure = headRatio, fetchImpl = fetch } = {}) {
  const first = await generate();
  const ratio = await measure(coverUrl, first.url, { fetchImpl });
  if (!(ratio > ratioLimit)) return first;
  console.warn('[head-gate] painted head ' + ratio.toFixed(2) + 'x the hero\'s, regenerating once');

  let second;
  try {
    second = await retry();
  } catch (err) {
    console.warn('[head-gate] retry failed, keeping the first cover:', (err && err.message) || err);
    return { ...first, headRatio: ratio };
  }
  const ratio2 = await measure(coverUrl, second.url, { fetchImpl });
  if (ratio2 !== null && ratio2 > ratio) {
    console.warn('[head-gate] retry came out worse (' + ratio2.toFixed(2) + 'x), keeping the first');
    return { ...first, headRatio: ratio };
  }
  return { ...second, headRatio: ratio2, headRetried: true };
}
