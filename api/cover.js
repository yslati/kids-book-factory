// GET /api/cover?key=previews/<name>.jpg
// A cover R2 refused when it was made (lib/cover-store.js): served from
// Upstash while it waits there, then a permanent redirect to its R2 copy.
// Its link is what the cart and the order hold, so it must keep working.
// No origin check: <img> tags, Discord, the sheet and the print team load it.

import { publicUrl } from '../lib/r2.js';
import { getRedis } from '../lib/redis.js';
import { COVER_KEY, readPendingCover } from '../lib/cover-store.js';
import { withReporting } from '../lib/report.js';

export default withReporting(handler);

async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).json({ error: 'method-not-allowed' });
  const key = String((req.query && req.query.key) || '');
  if (!COVER_KEY.test(key)) return res.status(400).json({ error: 'bad-key' });

  const redis = getRedis();
  const cover = redis ? await readPendingCover(redis, key) : null;
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (cover) {
    // Short, so browsers pick up the R2 copy once it exists.
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Content-Type', cover.contentType);
    return res.status(200).send(cover.body);
  }
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Location', publicUrl(key));
  return res.status(302).end();
}
