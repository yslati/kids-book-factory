// The small record each product-page cover leaves in Upstash, so the preview
// page's add-to-cart follow-up can post the parent's extra details to
// #previews, and its free fix can make a new cover, without trusting the
// browser for the child, the photo or the book.

// Long enough for an add to cart days later from a saved preview; matches
// how long R2 keeps the photo and cover.
const RECORD_DAYS = 30;
const RECORD_KEY = 'kbf:preview:';

// record: { childName, age, bookTitle, coverUrl, link, themeId, photoKey,
// language, fixOf }. language is the book language code; fixOf is set on a
// fix's own record. Records from before the fix shipped have no photoKey.
export async function savePreviewRecord(redis, generationId, record) {
  if (!redis) return;
  await redis.set(RECORD_KEY + generationId, record, { ex: RECORD_DAYS * 86400 });
}

export async function readPreviewRecord(redis, generationId) {
  if (!redis) return null;
  return (await redis.get(RECORD_KEY + generationId)) || null;
}

// true the first time this rating of a generation is claimed, so tapping the
// same face again doesn't post again.
export async function claimRatingPost(redis, generationId, rating) {
  if (!redis) return true;
  return (await redis.set(RECORD_KEY + 'rating:' + rating + ':' + generationId, 1, { nx: true, ex: RECORD_DAYS * 86400 })) === 'OK';
}

// true the first time a generation's details card is claimed, so a second
// add to cart doesn't post it again.
export async function claimDetailsPost(redis, generationId) {
  if (!redis) return true;
  return (await redis.set(RECORD_KEY + 'details:' + generationId, 1, { nx: true, ex: RECORD_DAYS * 86400 })) === 'OK';
}

// true the first time a cover's free fix is claimed: one fix per cover.
export async function claimFix(redis, generationId) {
  return (await redis.set(RECORD_KEY + 'fix:' + generationId, 1, { nx: true, ex: RECORD_DAYS * 86400 })) === 'OK';
}

// Gives the fix back when generating it failed, so the parent can try again.
export async function releaseFix(redis, generationId) {
  await redis.del(RECORD_KEY + 'fix:' + generationId);
}

// true the first time a generation's share by this button is claimed, so
// pressing it again doesn't post again.
export async function claimSharePost(redis, generationId, via) {
  if (!redis) return true;
  return (await redis.set(RECORD_KEY + 'share:' + via + ':' + generationId, 1, { nx: true, ex: RECORD_DAYS * 86400 })) === 'OK';
}
