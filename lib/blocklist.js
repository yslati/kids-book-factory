// Visitors blocked from generating covers (/btk block, lib/btk-bot.js).
// A block covers the visitor's Visitor ID, their last IP and, when known,
// their Shopify customer id, so a new day, device or account on the same
// network stays blocked. Blocked visitors get the usual "no previews left"
// answer. Keys expire with the block; the Visitor ID's key holds the rest,
// so unblocking clears the IP and customer keys too.

const PREFIX = 'kbf:block:';
export const DEFAULT_BLOCK_DAYS = 30;
export const MAX_BLOCK_DAYS = 365;

function keysOf({ id = '', ip = '', customer = '' }) {
  const keys = [];
  if (id) keys.push(PREFIX + 'v:' + id);
  if (ip && ip !== 'unknown') keys.push(PREFIX + 'ip:' + ip);
  if (customer) keys.push(PREFIX + 'cust:' + customer);
  return keys;
}

// Blocks for `days` days; resolves the record stored on the Visitor ID.
export async function blockVisitor(redis, { id, ip = '', customer = '' }, { by = '', days = DEFAULT_BLOCK_DAYS, now = Date.now() } = {}) {
  const ex = Math.round(days * 24 * 3600);
  const record = { ip: ip === 'unknown' ? '' : ip, customer: customer || '', by, at: now, until: now + ex * 1000 };
  const value = JSON.stringify(record);
  await Promise.all(keysOf({ id, ...record }).map((k) => redis.set(k, value, { ex })));
  return record;
}

// The block on this Visitor ID, or null.
export async function blockOf(redis, id) {
  if (!redis || !id) return null;
  const raw = await redis.get(PREFIX + 'v:' + id);
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    return {};
  }
}

// Lifts the block on this Visitor ID and the IP and customer it covered.
// Resolves false when there was none.
export async function unblockVisitor(redis, id) {
  const record = await blockOf(redis, id);
  if (!record) return false;
  await redis.del(...keysOf({ id, ip: record.ip, customer: record.customer }));
  return true;
}

// True when the visitor, their IP or their customer id is blocked. Fails
// open, so a Redis error never stops a paying parent.
export async function isBlocked(redis, { id = '', ip = '', customer = '' }) {
  const keys = keysOf({ id, ip, customer });
  if (!redis || !keys.length) return false;
  try {
    const found = await redis.mget(...keys);
    return found.some((v) => v != null);
  } catch (e) {
    console.warn('[blocklist] check failed, allowing the request:', (e && e.message) || e);
    return false;
  }
}
