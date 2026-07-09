// Per-IP rate limiting via Upstash Redis. No-ops (allows everything) when the
// Upstash env vars are absent so local dev / pre-config still works - but set
// them in production to cap abuse of the paid generation endpoint.

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

let limiter = null;

function getLimiter() {
  if (limiter) return limiter;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return null;
  }
  limiter = new Ratelimit({
    redis: Redis.fromEnv(),
    // 10 preview generations per IP per hour - generous for a real shopper,
    // tight enough to blunt scripted abuse of the $0.04/call endpoint.
    limiter: Ratelimit.slidingWindow(10, '1 h'),
    prefix: 'kbf:preview'
  });
  return limiter;
}

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown';
}

// Returns { success: boolean }. Allows the request when limiting is disabled.
export async function checkRateLimit(req, bucket) {
  const rl = getLimiter();
  if (!rl) return { success: true };
  const ip = clientIp(req);
  try {
    const { success } = await rl.limit((bucket || 'default') + ':' + ip);
    return { success };
  } catch (e) {
    // Fail open on limiter errors so a Redis outage doesn't break checkout.
    return { success: true };
  }
}
