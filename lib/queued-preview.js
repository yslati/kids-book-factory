// Product-page covers whose Higgsfield job was still queued or running when
// /preview reached its budget. /preview answers { status: 'queued' } and
// leaves what finishing needs in Upstash; the storefront then polls
// /preview-status/<id>, and each poll looks at the job once. The poll that
// sees it end runs the finish step (lib/preview-finish.js) under a lock, so
// it runs once however many polls overlap, and later polls read its outcome.
//
// While the job waits for a Higgsfield slot, polls also answer the visitor's
// place in line among the queued covers this backend knows of, oldest first.
// Higgsfield gives no position itself and jobs still inside /preview's wait
// aren't counted, so it can only be lower than the real one, never higher.
//
// Upstash: kbf:queued:<id> holds the entry, then { status: 'ready',
// previewUrl } or { status: 'failed' }; kbf:queued:lock:<id> is the lock.
// Both expire, so nothing about the child stays longer than an hour.
// kbf:queued:line orders the waiting ids by submit time, and
// kbf:queued:seen:<id> marks the ones still polled, so a visitor who left
// stops counting as ahead within LINE_SEEN_SECONDS.

const KEY = 'kbf:queued:';
const LOCK_KEY = 'kbf:queued:lock:';
const LINE_KEY = 'kbf:queued:line';
const SEEN_KEY = 'kbf:queued:seen:';
const KEEP_SECONDS = 60 * 60;
// Longer than a finish can take (api/preview-status/[id].js maxDuration).
const LOCK_SECONDS = 60;
// A few of the storefront's 3s polls.
const LINE_SEEN_SECONDS = 15;
// The storefront keeps polling this long from the request. A job still not
// done by then is given up on (cancelled if still queued, so it isn't charged).
export const QUEUE_WAIT_MS = 10 * 60 * 1000;

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
// pending the job (lib/generate.js err.pending). Resolves { queue_position }
// when the job waits for a slot, else {}.
export async function queuePreview(redis, req, p, { book, prompt, link, counts, pending, now = Date.now }) {
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
  return placeInLine(redis, p.generationId, pending, now());
}

// Where a queued preview stands: { status: 'ready', preview_url },
// { status: 'pending', queue_position? } or { status: 'failed' }. On each call:
//   check(pending) → { url } once done, else { queued }; throws on failure
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
      const job = await check(entry.pending);
      url = job.url || null;
      if (!url) return { status: 'pending', ...await placeInLine(redis, generationId, { ...entry.pending, queued: job.queued }, now()) };
    } catch (err) {
      error = (err && err.message) || 'higgsfield-failed';
    }
  }

  // One poll finishes; the others keep polling until it has.
  if ((await redis.set(LOCK_KEY + generationId, 1, { nx: true, ex: LOCK_SECONDS })) !== 'OK') return { status: 'pending' };
  // A poll that took the lock after an earlier one's expired.
  const again = outcomeOf(await redis.get(KEY + generationId));
  if (again) return again;
  await leaveLine(redis, generationId);

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

// { queue_position } for a job waiting for a slot (pending.queued true),
// {} once it runs (false) or when unknown. The position is a nicety: a Redis
// error only leaves it out.
async function placeInLine(redis, id, pending, now) {
  try {
    if (pending.queued === false) {
      await leaveLine(redis, id);
      return {};
    }
    await redis.zremrangebyscore(LINE_KEY, 0, now - QUEUE_WAIT_MS);
    if (pending.queued) {
      await redis.zadd(LINE_KEY, { nx: true }, { score: pending.startedAt, member: id });
      await redis.set(SEEN_KEY + id, 1, { ex: LINE_SEEN_SECONDS });
    }
    const rank = await redis.zrank(LINE_KEY, id);
    if (rank === null || rank === undefined) return {};
    const ahead = rank ? await redis.zrange(LINE_KEY, 0, rank - 1) : [];
    const seen = ahead.length ? await redis.mget(...ahead.map((other) => SEEN_KEY + other)) : [];
    return { queue_position: 1 + seen.filter((v) => v !== null && v !== undefined).length };
  } catch (err) {
    return {};
  }
}

async function leaveLine(redis, id) {
  try {
    await redis.zrem(LINE_KEY, id);
    await redis.del(SEEN_KEY + id);
  } catch (err) { /* expires with the line's pruning */ }
}

// An unknown id (never queued, or expired) counts as failed so the
// storefront stops polling.
function outcomeOf(entry) {
  if (!entry) return { status: 'failed' };
  if (entry.status === 'ready') return { status: 'ready', preview_url: entry.previewUrl };
  if (entry.status === 'failed') return { status: 'failed' };
  return null;
}
