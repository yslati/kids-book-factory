// Rate limiting via Upstash Redis. No-ops (allows everything) when the Upstash
// env vars are absent so local dev / pre-config still works - but set them in
// production to cap abuse of the paid generation endpoint.
//
// Cover generations, all 24h sliding windows (chargeGeneration below):
//   everyone (keyed by IP)            preview 4: previews and free fixes alike
//   signed in, once those are spent   preview-bonus 2 (keyed by customer id)
//   backstop (keyed by IP, always)    preview-ip-cap 10, shared with custom
//   custom story covers               custom 2 (by IP), custom-cust 2 (by id)
// Uploads: upload 10 (by IP), upload-cust 14 (by id).
//
// The backstop applies to logged-in shoppers too, so a single machine cannot
// mint a stack of throwaway accounts and multiply the free previews.
//
// Gifts (/btk gift, lib/btk-bot.js): extra previews for one IP, used once
// every window above is spent, kept 24h (kbf:gift:<ip>).

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// Per-bucket limits. 'preview*' buckets gate the paid generation call - keep
// them tight. 'upload*' is cheap (presign only) but looser so a user can retry
// a bad photo without burning a preview. Signing in adds two generations,
// since a guest who runs out is asked to.
export const LIMITS = {
  preview: { tokens: 4, window: '24 h' },
  upload: { tokens: 10, window: '24 h' },
  'preview-bonus': { tokens: 2, window: '24 h' },
  'upload-cust': { tokens: 14, window: '24 h' },
  'preview-ip-cap': { tokens: 10, window: '24 h' },
  // Custom story covers (api/custom-story.js): their own allowance, also
  // held by the preview-ip-cap backstop above.
  custom: { tokens: 2, window: '24 h' },
  'custom-cust': { tokens: 2, window: '24 h' },
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

const GIFT_KEY = 'kbf:gift:';
const GIFT_SECONDS = 24 * 60 * 60;
export const MAX_GIFT = 20;
// Takes one gifted preview if any are left: the count left, or -1.
const TAKE_GIFT = "local n = tonumber(redis.call('GET', KEYS[1]) or '0') if n > 0 then return redis.call('DECR', KEYS[1]) end return -1";

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

// Limiters return null when limiting is disabled; only compare real numbers.
export function minRemaining(a, b) {
  if (typeof a !== 'number') return typeof b === 'number' ? b : null;
  if (typeof b !== 'number') return a;
  return Math.min(a, b);
}

// Takes one product-page cover generation (a preview or a free fix) from the
// visitor's allowance. Everyone draws on the per-IP 'preview' window first,
// so signing in after spending it adds the 'preview-bonus' window on top
// rather than starting a fresh allowance. The backstop is always charged, so
// both windows stay in step. Resolves { success, remaining }; remaining is
// what is left in the window that was charged (null when limiting is off).
// check is checkRateLimit (tests pass their own).
// Once both are spent, a gifted preview (giftPreviews) is used instead.
export async function chargeGeneration(req, customer, { check = checkRateLimit, takeGift = takeGiftedPreview } = {}) {
  let tier = await check(req, 'preview');
  if (!tier.success && customer && customer.valid) {
    tier = await check(req, 'preview-bonus', customer.customerId);
  }
  const capped = await check(req, 'preview-ip-cap');
  if (!tier.success || !capped.success) {
    const left = await takeGift(req);
    return left >= 0 ? { success: true, remaining: left } : { success: false, remaining: 0 };
  }
  return { success: true, remaining: minRemaining(tier.remaining, capped.remaining) };
}

function giftRedis() {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null;
  return Redis.fromEnv();
}

// One gifted preview for this request's IP: the count left after it, or -1
// when none.
async function takeGiftedPreview(req) {
  const redis = giftRedis();
  if (!redis) return -1;
  const ip = clientIp(req);
  if (!ip || ip === 'unknown') return -1;
  try {
    return Number(await redis.eval(TAKE_GIFT, [GIFT_KEY + ip], []));
  } catch (e) {
    console.warn('[ratelimit] gift not read:', (e && e.message) || e);
    return -1;
  }
}

// Adds count gifted previews to this IP for the next 24h (at most MAX_GIFT
// waiting). Resolves the number now waiting.
export async function giftPreviews(ip, count, redis = giftRedis()) {
  if (!redis || !ip || ip === 'unknown') throw new Error('no-redis-or-ip');
  const key = GIFT_KEY + ip;
  const total = Number(await redis.incrby(key, count));
  if (total > MAX_GIFT) await redis.set(key, MAX_GIFT, { ex: GIFT_SECONDS });
  else await redis.expire(key, GIFT_SECONDS);
  return Math.min(total, MAX_GIFT);
}

// Gifted previews still waiting for this IP.
export async function giftedPreviews(ip, redis = giftRedis()) {
  if (!redis || !ip || ip === 'unknown') return 0;
  return Number(await redis.get(GIFT_KEY + ip)) || 0;
}

// Gives this IP its full photo upload allowance back.
export async function resetUploads(ip) {
  const limiter = getLimiter('upload');
  if (!limiter || !ip || ip === 'unknown') throw new Error('no-redis-or-ip');
  await limiter.resetUsedTokens('upload:' + ip);
}
