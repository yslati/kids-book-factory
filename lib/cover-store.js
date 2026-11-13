// Keeps every generated cover. The order carries the cover's URL, so a cover
// that isn't kept can't be printed.
//
// 1. The cover is read from the provider (a fetch, retried, or a data: URL),
//    re-encoded (lib/cover-image.js) and put in R2, retried with backoff.
// 2. If R2 still refuses it, the bytes go to Upstash (kbf:cover:unsaved:<key>,
//    30 days, listed in kbf:cover:unsaved) and the cover's URL is
//    /api/cover?key=<key> on this backend: it serves the bytes from Upstash
//    until flushPendingCovers moves them to R2, then redirects there. The URL
//    handed to the parent, the cart and the order never changes.
// 3. Only when Upstash fails too does it fall back to the provider's own
//    https URL (Higgsfield keeps it about 7 days). OpenAI returns no URL, so a
//    cover from it that neither R2 nor Upstash would take throws
//    'cover-not-stored'.
// Every step past the first is logged as an error, so it reaches #logs.

import { publicUrl, putObject } from './r2.js';
import { coverForStorage } from './cover-image.js';

const PENDING_KEY = 'kbf:cover:unsaved:';
const PENDING_SET = 'kbf:cover:unsaved';
const PENDING_SECONDS = 30 * 24 * 60 * 60;
// Waits before each try: R2 and provider CDNs fail in short blips.
const BACKOFF_MS = [0, 600, 2000];
const FETCH_TIMEOUT_MS = 15000;
// What /api/cover accepts: an R2 cover key from lib/object-names.js.
export const COVER_KEY = /^previews\/[A-Za-z0-9_.-]{1,200}\.(jpg|png)$/;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function message(err) {
  return String((err && err.message) || err);
}

export async function withRetries(fn, { waits = BACKOFF_MS, label = 'step' } = {}) {
  let last;
  for (let i = 0; i < waits.length; i++) {
    if (waits[i]) await sleep(waits[i]);
    try {
      return await fn();
    } catch (err) {
      last = err;
      console.warn('[cover] ' + label + ' failed (try ' + (i + 1) + ' of ' + waits.length + '):', message(err));
    }
  }
  throw last;
}

// { buf, contentType } of a generated cover, from a data: URL or a fetch.
export async function coverBytes(url, { waits } = {}) {
  const data = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (data) return { buf: Buffer.from(data[2], 'base64'), contentType: data[1] };
  return withRetries(async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error('cover-fetch-' + res.status);
    return { buf: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') };
  }, { waits, label: 'reading the generated cover' });
}

// This backend's public origin, for /api/cover links. Vercel sets the
// production domain on every deployment; '' when unknown (local runs).
export function backendOrigin(env = process.env) {
  const host = String(env.VERCEL_PROJECT_PRODUCTION_URL || '').trim();
  return host ? 'https://' + host.replace(/^https?:\/\//, '').replace(/\/+$/, '') : '';
}

export function pendingCoverUrl(origin, key) {
  return origin + '/api/cover?key=' + encodeURIComponent(key);
}

function providerFallback(url) {
  if (/^https:\/\//.test(url)) return { url, stored: 'provider' };
  throw new Error('cover-not-stored');
}

// Keeps a generated cover. keyFor(ext) names it in R2; put is the R2 upload
// (replaced in tests). Resolves { url,
// stored, key? }: stored is 'r2' (permanent), 'pending' (in Upstash, served
// by /api/cover, moved to R2 later) or 'provider' (the provider's temporary
// link). Throws 'cover-not-stored' when nothing could keep it.
export async function storeCover(generatedUrl, keyFor, { redis, origin = backendOrigin(), waits, put = putObject } = {}) {
  let cover;
  try {
    const raw = await coverBytes(generatedUrl, { waits });
    cover = await coverForStorage(raw.buf, raw.contentType);
  } catch (err) {
    console.error('[cover] generated cover unreadable, keeping the provider link:', message(err));
    return providerFallback(generatedUrl);
  }

  const key = keyFor(cover.ext);
  try {
    const url = await withRetries(() => put(key, cover.body, cover.contentType), { waits, label: 'saving to R2' });
    return { url, stored: 'r2', key };
  } catch (err) {
    console.error('[cover] R2 refused the cover after every try, keeping it in Upstash:', message(err));
  }

  if (redis && origin) {
    try {
      await redis.pipeline()
        .set(PENDING_KEY + key, { b64: cover.body.toString('base64'), type: cover.contentType }, { ex: PENDING_SECONDS })
        .sadd(PENDING_SET, key)
        .exec();
      return { url: pendingCoverUrl(origin, key), stored: 'pending', key };
    } catch (err) {
      console.error('[cover] Upstash refused the cover too:', message(err));
    }
  } else {
    console.error('[cover] no Upstash or backend origin to keep the cover in');
  }
  return providerFallback(generatedUrl);
}

// { body, contentType } of a cover still waiting for R2, or null.
export async function readPendingCover(redis, key) {
  const saved = await redis.get(PENDING_KEY + key);
  if (!saved || !saved.b64) return null;
  return { body: Buffer.from(saved.b64, 'base64'), contentType: saved.type || 'image/jpeg' };
}

// Moves covers kept in Upstash to R2 (all of them, or only keys). Resolves
// { saved, left }. A cover moves at most once: it leaves Upstash only after
// R2 has it.
export async function flushPendingCovers(redis, { keys = null, waits = [0], put = putObject } = {}) {
  const todo = keys || (await redis.smembers(PENDING_SET)) || [];
  let saved = 0;
  let left = 0;
  for (const key of todo) {
    const cover = await readPendingCover(redis, key);
    if (!cover) {
      await redis.srem(PENDING_SET, key);
      continue;
    }
    try {
      await withRetries(() => put(key, cover.body, cover.contentType), { waits, label: 'moving a kept cover to R2' });
      await redis.pipeline().del(PENDING_KEY + key).srem(PENDING_SET, key).exec();
      saved++;
      console.log('[cover] kept cover moved to R2: ' + publicUrl(key).replace(/\/previews\/.*/, '/previews/…'));
    } catch (err) {
      left++;
    }
  }
  if (left) console.error('[cover] ' + left + ' kept cover(s) still not in R2');
  return { saved, left };
}
