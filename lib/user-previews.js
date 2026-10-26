// Per-customer preview history, so a shopper's previews follow the account
// instead of the device.
//
// Storage is the Upstash Redis that already backs rate limiting - no new
// infrastructure. One sorted set per customer, scored by createdAt (ms), with
// the JSON entry as the member:
//
//   kbf:previews:<customer_id>  →  ZSET of JSON strings
//
// A cover expires after 30 days (the R2 lifecycle rule); the entry is kept 30
// days more so the theme can show it as expired. Removal is enforced two ways,
// because neither alone is enough:
//   - ZREMRANGEBYSCORE drops entries older than 60 days on every read/write,
//     so a stale row can never be returned.
//   - A 60-day TTL on the key itself, refreshed on write, so a customer who
//     never comes back stops costing us storage.
//
// Everything no-ops when UPSTASH_* is unset, exactly like lib/ratelimit.js, so
// local dev and a pre-config deploy still work.

import { Redis } from '@upstash/redis';
import { normaliseEntry, KEEP_DAYS, KEEP_MS, MAX_ENTRIES } from './preview-entry.js';

const KEEP_SECONDS = KEEP_DAYS * 24 * 60 * 60;

let redis = null;

export function userPreviewsEnabled() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

function getRedis() {
  if (!userPreviewsEnabled()) return null;
  if (!redis) redis = Redis.fromEnv();
  return redis;
}

function keyFor(customerId) {
  return 'kbf:previews:' + customerId;
}

// Reads a customer's previews, newest first, dropping anything past KEEP_DAYS.
export async function listPreviews(customerId) {
  const r = getRedis();
  if (!r) return [];
  const key = keyFor(customerId);

  try {
    await r.zremrangebyscore(key, 0, Date.now() - KEEP_MS);
    const rows = await r.zrange(key, 0, MAX_ENTRIES - 1, { rev: true });
    return (rows || [])
      .map((row) => {
        // Upstash may hand back an already-parsed object or a JSON string.
        if (typeof row === 'object') return normaliseEntry(row);
        try { return normaliseEntry(JSON.parse(row)); } catch (e) { return null; }
      })
      .filter(Boolean);
  } catch (e) {
    // A Redis hiccup must not break the page - the device-local list still shows.
    console.error('[user-previews] list failed:', (e && e.message) || e);
    return [];
  }
}

// Bulk upsert. De-duplicates by `k`: an entry already stored under that key is
// replaced, so re-posting the whole local list is idempotent.
export async function savePreviews(customerId, entries) {
  const r = getRedis();
  if (!r) return 0;
  if (!Array.isArray(entries) || !entries.length) return 0;

  const key = keyFor(customerId);
  const clean = entries.map((e) => normaliseEntry(e)).filter(Boolean).slice(0, MAX_ENTRIES);
  if (!clean.length) return 0;

  try {
    const existing = await listPreviews(customerId);
    const incoming = new Set(clean.map((e) => e.k));

    // Remove the previous member for each incoming k (the member is the whole
    // JSON string, so an updated entry would otherwise be stored twice).
    const stale = existing.filter((e) => incoming.has(e.k));
    for (const e of stale) {
      try { await r.zrem(key, JSON.stringify(e)); } catch (err) { /* best effort */ }
    }

    await r.zadd(
      key,
      ...clean.map((e) => ({ score: Date.parse(e.createdAt), member: JSON.stringify(e) }))
    );
    await r.zremrangebyscore(key, 0, Date.now() - KEEP_MS);
    // Keep only the newest MAX_ENTRIES (rank 0 is the oldest here).
    await r.zremrangebyrank(key, 0, -(MAX_ENTRIES + 1));
    await r.expire(key, KEEP_SECONDS);
    return clean.length;
  } catch (e) {
    console.error('[user-previews] save failed:', (e && e.message) || e);
    return 0;
  }
}
