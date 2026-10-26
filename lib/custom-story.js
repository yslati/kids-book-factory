// Custom story requests (api/custom-story.js): validating what the storefront
// sends, and the small record each generated cover leaves in Upstash so the
// add-to-cart follow-up can refer to it without trusting the browser.

import { MIN_BRIEF, OCCASIONS, WORLDS, cleanBrief } from './custom-prompt.js';
import { cleanDetails } from './sheet.js';

// Long enough for the cart follow-up, which can come days later from a
// saved cart; matches how long R2 keeps the photo.
const RECORD_DAYS = 30;
const RECORD_KEY = 'kbf:custom:';

function oneLine(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// { value } with the request in a fixed shape, or { error } for a 400.
export function normaliseGenerate(body) {
  const b = body && typeof body === 'object' ? body : {};
  const photoKey = oneLine(b.photo_key, 200);
  const generationId = oneLine(b.generation_id, 64);
  const reference = oneLine(b.reference, 255);
  const world = oneLine(b.world, 20);
  const gender = oneLine(b.gender, 10);
  const childName = oneLine(b.child_name, 24);
  const ageNum = parseInt(b.age, 10);
  const occasion = oneLine(b.occasion, 40);
  const brief = cleanBrief(b.brief);

  if (!photoKey || !generationId || !reference || !childName) return { error: 'missing-fields' };
  // photo_key must be one /upload-url issued (never an arbitrary object).
  if (!/^photos\/[A-Za-z0-9_-]+\.(jpg|png)$/.test(photoKey)) return { error: 'bad-photo-key' };
  if (!/^[A-Za-z0-9-]{1,64}$/.test(generationId)) return { error: 'bad-generation-id' };
  // A product handle: resolveBook (lib/shopify.js) reads its cover server-side.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(reference)) return { error: 'bad-reference' };
  if (!Object.prototype.hasOwnProperty.call(WORLDS, world)) return { error: 'bad-world' };
  if (gender !== 'boy' && gender !== 'girl') return { error: 'bad-gender' };
  if (occasion && !OCCASIONS.includes(occasion)) return { error: 'bad-occasion' };
  if (brief.length < MIN_BRIEF) return { error: 'brief-too-short' };

  return {
    value: {
      photoKey,
      generationId,
      reference,
      world,
      gender,
      childName,
      age: Number.isFinite(ageNum) && ageNum >= 1 && ageNum <= 18 ? String(ageNum) : '',
      occasion,
      brief
    }
  };
}

// { value } for the add-to-cart follow-up, or { error }.
export function normaliseCart(body) {
  const b = body && typeof body === 'object' ? body : {};
  const generationId = oneLine(b.generation_id, 64);
  if (!/^[A-Za-z0-9-]{1,64}$/.test(generationId)) return { error: 'bad-generation-id' };
  return {
    value: {
      generationId,
      variant: oneLine(b.variant, 40),
      price: oneLine(b.price, 20),
      details: cleanDetails(b.details)
    }
  };
}

// record: { childName, age, gender, world, photoUrl, coverUrl, link }.
export async function saveCustomStory(redis, generationId, record) {
  if (!redis) return;
  await redis.set(RECORD_KEY + generationId, record, { ex: RECORD_DAYS * 86400 });
}

export async function readCustomStory(redis, generationId) {
  if (!redis) return null;
  return (await redis.get(RECORD_KEY + generationId)) || null;
}

// true the first time a generation's add-to-cart is claimed, so a page
// reload or a second click doesn't post the card again.
export async function claimCartPost(redis, generationId) {
  if (!redis) return true;
  return (await redis.set(RECORD_KEY + 'cart:' + generationId, 1, { nx: true, ex: RECORD_DAYS * 86400 })) === 'OK';
}
