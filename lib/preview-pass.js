// One-time passes that spare /preview a second Turnstile challenge.
//
// Turnstile tokens are single-use, and /upload-url spends the visitor's. Once
// it has, /upload-url grants a pass for the generation_id it issues and
// /preview redeems that pass instead of asking for a fresh token
// mid-generation, when the widget sits behind the loader and an interactive
// challenge can't be seen. GETDEL reads and deletes in one atomic step, so a
// pass works once and one solve still buys exactly one preview.
//
// Keyed by generation_id rather than photo_key, which carries the child's name
// and age, so no personal data lands in Redis or in a logged Redis error.
//
// Both functions take the Redis client (lib/redis.js) so the suite can run
// against a fake. With no client, or on a Redis error, nothing is granted or
// redeemed and /preview verifies a Turnstile token instead.

const KEY_PREFIX = 'kbf:preview-pass:';

// Covers the photo upload on a slow connection; an unused pass just expires.
const TTL_SECONDS = 15 * 60;

// Returns true when the pass was stored.
export async function grantPreviewPass(redis, generationId) {
  if (!redis) return false;
  try {
    await redis.set(KEY_PREFIX + generationId, 1, { ex: TTL_SECONDS });
    return true;
  } catch (e) {
    console.error('[preview-pass] grant failed:', (e && e.message) || e);
    return false;
  }
}

// Returns true at most once per granted pass.
export async function redeemPreviewPass(redis, generationId) {
  if (!redis) return false;
  try {
    return (await redis.getdel(KEY_PREFIX + generationId)) !== null;
  } catch (e) {
    console.error('[preview-pass] redeem failed:', (e && e.message) || e);
    return false;
  }
}
