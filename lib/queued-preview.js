// Product-page covers whose Higgsfield job was still queued or running when
// /preview reached its budget. /preview answers { status: 'queued' } and
// leaves what finishing needs in Upstash; the storefront then polls
// /preview-status/<id>, and each poll looks at the job once. The poll that
// sees it end runs the finish step (lib/preview-finish.js) under a lock, so
// it runs once however many polls overlap, and later polls read its outcome.
//
// Upstash: kbf:queued:<id> holds the entry, then { status: 'ready',
// previewUrl } or { status: 'failed' }; kbf:queued:lock:<id> is the lock.
// Both expire, so nothing about the child stays longer than an hour.

const KEY = 'kbf:queued:';
const LOCK_KEY = 'kbf:queued:lock:';
const KEEP_SECONDS = 60 * 60;
// Longer than a finish can take (api/preview-status/[id].js maxDuration).
const LOCK_SECONDS = 60;
// From the request: the storefront polls for 45s after the 70s it waits for
// /preview. A job still not done after this is given up on.
export const QUEUE_WAIT_MS = 3 * 60 * 1000;

// The headers lib/discord.js visitorOf reads, so the finish step names the
// parent's visit rather than the poll's.
const VISITOR_HEADERS = [
  'x-forwarded-for', 'x-vercel-ip-country', 'x-vercel-ip-country-region', 'x-vercel-ip-city',
  'x-vercel-ip-timezone', 'accept-language', 'user-agent', 'origin', 'x-vercel-id'
];

function savedRequest(req) {
  const headers = {};
  for (const name of VISITOR_HEADERS) {
    const value = req.headers && req.headers[name];
    if (value) headers[name] = Array.isArray(value) ? value[0] : String(value);
  }
  return { headers };
}

// Stores a preview to finish later. p is the preview (lib/preview-finish.js),
// book { title }, link and counts what its #previews photo post resolved to,
// pending the job (lib/generate.js err.pending).
export async function queuePreview(redis, req, p, { book, prompt, link, counts, pending }) {
  await redis.set(KEY + p.generationId, {
    status: 'pending',
    request: savedRequest(req),
    preview: { ...p, customer: { valid: Boolean(p.customer.valid), customerId: p.customer.customerId || null } },
    book: { title: book.title || '' },
    prompt,
    link,
    counts,
    pending
  }, { ex: KEEP_SECONDS });
}

// Where a queued preview stands: { status: 'ready', preview_url },
// { status: 'pending' } or { status: 'failed' }. On each call:
//   check(pending) → the cover's URL, null while the job runs; throws on failure
//   finish(entry, url) → the stored cover's URL
//   fail(entry, error) → records the failure; error is 'higgsfield-expired'
//     when the job ran past QUEUE_WAIT_MS
export async function settleQueuedPreview(redis, generationId, { check, finish, fail, now = Date.now }) {
  const entry = await redis.get(KEY + generationId);
  const settled = outcomeOf(entry);
  if (settled) return settled;

  let url = null;
  let error = '';
  if (now() - entry.preview.startedAt > QUEUE_WAIT_MS) {
    error = 'higgsfield-expired';
  } else {
    try {
      url = await check(entry.pending);
      if (!url) return { status: 'pending' };
    } catch (err) {
      error = (err && err.message) || 'higgsfield-failed';
    }
  }

  // One poll finishes; the others keep polling until it has.
  if ((await redis.set(LOCK_KEY + generationId, 1, { nx: true, ex: LOCK_SECONDS })) !== 'OK') return { status: 'pending' };
  // A poll that took the lock after an earlier one's expired.
  const again = outcomeOf(await redis.get(KEY + generationId));
  if (again) return again;

  try {
    if (url) {
      const previewUrl = await finish(entry, url);
      await redis.set(KEY + generationId, { status: 'ready', previewUrl }, { ex: KEEP_SECONDS });
      return { status: 'ready', preview_url: previewUrl };
    }
    await fail(entry, error);
    await redis.set(KEY + generationId, { status: 'failed' }, { ex: KEEP_SECONDS });
    return { status: 'failed' };
  } catch (err) {
    // Let the next poll try again.
    await redis.del(LOCK_KEY + generationId);
    throw err;
  }
}

// An unknown id (never queued, or expired) counts as failed so the
// storefront stops polling.
function outcomeOf(entry) {
  if (!entry) return { status: 'failed' };
  if (entry.status === 'ready') return { status: 'ready', preview_url: entry.previewUrl };
  if (entry.status === 'failed') return { status: 'failed' };
  return null;
}
