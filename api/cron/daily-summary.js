// GET /api/cron/daily-summary
// Vercel cron (vercel.json): once a day, between 06:00 and 06:59 UTC, posts
// yesterday's storefront totals (UTC day) to #events. Vercel sends
// "Authorization: Bearer $CRON_SECRET"; with that header, ?day=YYYY-MM-DD
// posts any other day.

import { timingSafeEqual } from 'node:crypto';
import { getRedis } from '../../lib/redis.js';
import { dayOf, readDay } from '../../lib/event-stats.js';
import { postSummary } from '../../lib/event-feed.js';
import { withReporting } from '../../lib/report.js';

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const sent = Buffer.from(String(req.headers.authorization || ''));
  const expected = Buffer.from('Bearer ' + secret);
  return sent.length === expected.length && timingSafeEqual(sent, expected);
}

export default withReporting(handler);

async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'storage-not-configured' });

  const asked = String((req.query && req.query.day) || '');
  const day = /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : dayOf(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const posted = await postSummary(await readDay(redis, day));
  if (!posted) console.warn('[daily-summary] ' + day + ' not posted');
  return res.status(posted ? 200 : 502).json({ day, posted: Boolean(posted) });
}
