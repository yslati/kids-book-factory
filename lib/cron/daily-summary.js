// GET /api/cron/daily-summary
// Vercel cron (vercel.json): once a day, between 06:00 and 06:59 UTC, posts
// yesterday's storefront totals (UTC day) to #events, after any earlier days
// a skipped run missed. A repeated run posts nothing (lib/daily-summary.js).
// Vercel sends "Authorization: Bearer $CRON_SECRET"; with that header,
// ?day=YYYY-MM-DD posts that day again, whether or not it went out already.

import { getRedis } from '../redis.js';
import { readDay } from '../event-stats.js';
import { eventsChannelOn, postSummary } from '../event-feed.js';
import { postDueSummaries } from '../daily-summary.js';
import { cronAuthorized } from '../cron-auth.js';

// Run by api/cron/[job].js, which reports it.

export async function handler(req, res) {
  if (!cronAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
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
  // A post Discord didn't take in time is saved and sent later (lib/discord.js).
  for (const d of days.filter((d) => !d.sent)) console.warn('[daily-summary] ' + d.day + ' not sent right away (see above); it goes out later');
  return res.status(200).json({ days });
}
