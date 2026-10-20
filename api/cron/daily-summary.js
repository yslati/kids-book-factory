// GET /api/cron/daily-summary
// Vercel cron (vercel.json): once a day, between 06:00 and 06:59 UTC, posts
// yesterday's storefront totals (UTC day) to #events, after any earlier days
// a skipped run missed. A repeated run posts nothing (lib/daily-summary.js).
// Vercel sends "Authorization: Bearer $CRON_SECRET"; with that header,
// ?day=YYYY-MM-DD posts that day again, whether or not it went out already.

import { timingSafeEqual } from 'node:crypto';
import { getRedis } from '../../lib/redis.js';
import { readDay } from '../../lib/event-stats.js';
import { eventsChannelOn, postSummary } from '../../lib/event-feed.js';
import { postDueSummaries } from '../../lib/daily-summary.js';
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
  // Before anything counts as summarised.
  if (!eventsChannelOn()) return res.status(503).json({ error: 'discord-not-configured' });

  const asked = String((req.query && req.query.day) || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(asked)) {
    const posted = Boolean(await postSummary(await readDay(redis, asked)));
    if (!posted) console.warn('[daily-summary] ' + asked + ' not posted');
    return res.status(posted ? 200 : 502).json({ day: asked, posted });
  }

  const days = await postDueSummaries(redis);
  if (!days) {
    console.log('[daily-summary] another run is posting; this one stops');
    return res.status(200).json({ days: [], skipped: 'already-running' });
  }
  if (!days.length) console.log('[daily-summary] nothing due: already posted');
  const late = days.filter((d) => !d.sent);
  for (const d of late) console.warn('[daily-summary] ' + d.day + ' not sent right away (see above); it is not posted again');
  return res.status(late.length ? 502 : 200).json({ days });
}
