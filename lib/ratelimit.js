// Rate limiting via Upstash Redis. No-ops (allows everything) when the Upstash
// env vars are absent so local dev / pre-config still works - but set them in
// production to cap abuse of the paid generation endpoint.
//
// Three tiers, all 24h sliding windows:
//   anonymous (keyed by IP)          preview 3   upload 6
//   verified customer (keyed by id)  preview 3   upload 8
//   backstop (keyed by IP, always)   preview-ip-cap 8
//   custom story covers              custom 3 (by IP), custom-cust 3 (by id)
//
// The backstop applies to logged-in shoppers too, so a single machine cannot
// mint a stack of throwaway accounts and multiply the free previews.

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// Per-bucket limits. 'preview*' buckets gate the paid fal.ai call - keep them
// tight. 'upload*' is cheap (presign only) but looser so a user can retry a
// bad photo without burning a preview.
const LIMITS = {
  preview: { tokens: 3, window: '24 h' },
  upload: { tokens: 6, window: '24 h' },
  'preview-cust': { tokens: 3, window: '24 h' },
  'upload-cust': { tokens: 8, window: '24 h' },
  'preview-ip-cap': { tokens: 8, window: '24 h' },
  // Custom story covers (api/custom-story.js): their own allowance, also
  // held by the preview-ip-cap backstop above.
  custom: { tokens: 3, window: '24 h' },
  'custom-cust': { tokens: 3, window: '24 h' },
  // Its add-to-cart follow-up only posts to Discord, once per cover.
  'custom-cart': { tokens: 20, window: '1 h' },
  // The preview page's occasion and add-to-cart updates (api/preview.js),
  // which only change an existing row in the requests sheet.
  'preview-follow-up': { tokens: 30, window: '1 h' },
  // Storefront error reports (api/log.js): caps what one visitor can post to
  // the Discord channel.
  log: { tokens: 120, window: '1 h' },
  // Short links (api/share.js): one per preview page view, deduplicated by URL.
  share: { tokens: 30, window: '1 h' }
};

const limiters = {};

function getLimiter(bucket) {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return null;
  }
  if (limiters[bucket]) return limiters[bucket];
  const cfg = LIMITS[bucket] || { tokens: 10, window: '1 h' };
  limiters[bucket] = new Ratelimit({
    redis: Redis.fromEnv(),
    limiter: Ratelimit.slidingWindow(cfg.tokens, cfg.window),
    prefix: 'kbf:' + bucket
  });
  return limiters[bucket];
}

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown';
}

// Returns { success: boolean, remaining: number|null }.
// Allows the request when limiting is disabled.
//
// `identifier` overrides the default per-IP key - pass a customer id for the
// '-cust' buckets so the allowance follows the account, not the network.
export async function checkRateLimit(req, bucket, identifier) {
  const name = bucket || 'default';
  const rl = getLimiter(name);
  if (!rl) return { success: true, remaining: null };
  const key = identifier ? String(identifier) : clientIp(req);
  try {
    const { success, remaining } = await rl.limit(name + ':' + key);
    return { success, remaining };
  } catch (e) {
    // Fail open on limiter errors so a Redis outage doesn't break checkout.
    console.warn('[ratelimit] ' + name + ' check failed, allowing the request:', (e && e.message) || e);
    return { success: true, remaining: null };
  }
}
