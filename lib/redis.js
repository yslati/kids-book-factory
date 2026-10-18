// The Upstash Redis client, or null when UPSTASH_* is unset so callers can skip
// or fall back (local dev, or a deploy before Redis is configured).

import { Redis } from '@upstash/redis';

let client = null;

export function getRedis() {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null;
  if (!client) client = Redis.fromEnv();
  return client;
}
