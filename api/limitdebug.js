// TEMPORARY diagnostic - delete after debugging the rate limiter.
// Reports whether the limiter is wired up, without revealing any secret VALUES.
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

export default async function handler(req, res) {
  const out = {
    has_url: Boolean(process.env.UPSTASH_REDIS_REST_URL),
    url_len: (process.env.UPSTASH_REDIS_REST_URL || '').length,
    url_scheme: (process.env.UPSTASH_REDIS_REST_URL || '').slice(0, 8),
    has_token: Boolean(process.env.UPSTASH_REDIS_REST_TOKEN),
    token_len: (process.env.UPSTASH_REDIS_REST_TOKEN || '').length,
    has_preview_secret: Boolean(process.env.PREVIEW_TOKEN_SECRET),
    ping: null,
    limit_probe: null,
    error: null
  };
  try {
    const redis = Redis.fromEnv();
    out.ping = await redis.ping();
    const rl = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(2, '24 h'),
      prefix: 'kbf:_debug'
    });
    const r = await rl.limit('probe');
    out.limit_probe = { success: r.success, remaining: r.remaining };
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  res.status(200).json(out);
}
