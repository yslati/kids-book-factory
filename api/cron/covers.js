// GET /api/cron/covers
// Vercel cron (vercel.json): once a day, moves covers R2 refused when they
// were made from Upstash into R2 (lib/cover-store.js). Their /api/cover links
// then redirect to R2. Vercel sends "Authorization: Bearer $CRON_SECRET".

import { getRedis } from '../../lib/redis.js';
import { flushPendingCovers } from '../../lib/cover-store.js';
import { withReporting } from '../../lib/report.js';
import { cronAuthorized } from '../../lib/cron-auth.js';

export default withReporting(handler);

async function handler(req, res) {
  if (!cronAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'storage-not-configured' });
  return res.status(200).json(await flushPendingCovers(redis, { waits: [0, 1000, 3000] }));
}
