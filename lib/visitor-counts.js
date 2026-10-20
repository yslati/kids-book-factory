// How many photos and previews each visitor has made: "2nd upload", "3rd
// preview" on the #previews cards (lib/preview-feed.js).
//
// A visitor is the signed-in customer (verified Shopify id), else the IP the
// rate limiter keys on, so people sharing a network count together. Each
// count is a Redis INCR, whose result is the new number, on
// kbf:count:<upload|preview>:<customer:id|ip:address>; a key expires 30 days
// after its last increment. Functions take the Redis client (lib/redis.js) so
// tests can pass a fake, and never throw: a Redis problem just means no count.

import { clientIp } from './ratelimit.js';

const KEY = 'kbf:count:';
const TTL_SECONDS = 30 * 24 * 60 * 60;

function keyFor(kind, req, customerId) {
  return KEY + kind + ':' + (customerId ? 'customer:' + customerId : 'ip:' + clientIp(req));
}

// Counts a photo upload (api/upload-url.js). Resolves to its number, or null.
export async function countUpload(redis, req, customerId) {
  if (!redis) return null;
  const key = keyFor('upload', req, customerId);
  try {
    const [upload] = await redis.pipeline().incr(key).expire(key, TTL_SECONDS).exec();
    return Number(upload) || null;
  } catch (e) {
    console.warn('[visitor-counts] upload count failed:', (e && e.message) || e);
    return null;
  }
}

// Counts a preview as its generation starts (api/preview.js). Resolves to
// { preview, upload, by }: this preview's number, the visitor's uploads so
// far (the last being the photo it uses), and 'customer' or 'ip'. null
// without Redis or on a Redis error.
export async function countPreview(redis, req, customerId) {
  if (!redis) return null;
  const key = keyFor('preview', req, customerId);
  try {
    const [preview, , upload] = await redis.pipeline()
      .incr(key)
      .expire(key, TTL_SECONDS)
      .get(keyFor('upload', req, customerId))
      .exec();
    return { preview: Number(preview) || null, upload: Number(upload) || null, by: customerId ? 'customer' : 'ip' };
  } catch (e) {
    console.warn('[visitor-counts] preview count failed:', (e && e.message) || e);
    return null;
  }
}
