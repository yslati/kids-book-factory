// The small record each product-page cover leaves in Upstash, so the preview
// page's add-to-cart follow-up can post the parent's extra details to
// #previews without trusting the browser for the child or the book.

// Long enough for an add to cart days later from a saved preview; matches
// how long R2 keeps the photo and cover.
const RECORD_DAYS = 30;
const RECORD_KEY = 'kbf:preview:';

// record: { childName, age, bookTitle, coverUrl, link }.
export async function savePreviewRecord(redis, generationId, record) {
  if (!redis) return;
  await redis.set(RECORD_KEY + generationId, record, { ex: RECORD_DAYS * 86400 });
}

export async function readPreviewRecord(redis, generationId) {
  if (!redis) return null;
  return (await redis.get(RECORD_KEY + generationId)) || null;
}

// true the first time a generation's details card is claimed, so a second
// add to cart doesn't post it again.
export async function claimDetailsPost(redis, generationId) {
  if (!redis) return true;
  return (await redis.set(RECORD_KEY + 'details:' + generationId, 1, { nx: true, ex: RECORD_DAYS * 86400 })) === 'OK';
}
