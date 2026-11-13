// GET /api/cron/fal
// Vercel cron (vercel.json): once a day, between 07:00 and 07:59 UTC, checks
// the fal account and posts the result to #fal (lib/fal-feed.js). A repeated
// run the same UTC day posts nothing. Vercel sends "Authorization: Bearer
// $CRON_SECRET"; with that header, ?force=1 runs the check again.

import { getRedis } from '../redis.js';
import { falConfigured } from '../fal.js';
import { falChannelOn, runFalCheck } from '../fal-feed.js';
import { falInChain } from '../generate.js';
import { cronAuthorized } from '../cron-auth.js';

// Run by api/cron/[job].js, which reports it.

export async function handler(req, res) {
  if (!cronAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'storage-not-configured' });
  if (!falChannelOn()) return res.status(503).json({ error: 'discord-not-configured' });
  if (!falConfigured()) return res.status(503).json({ error: 'fal-not-configured' });

  const force = String((req.query && req.query.force) || '') === '1';
  const result = await runFalCheck(redis, { inChain: falInChain(), force });
  if (!result) {
    console.log('[fal-check] already ran today; this run stops');
    return res.status(200).json({ skipped: 'already-ran' });
  }
  if (!result.posted) console.warn('[fal-check] the message did not go out right away; it is sent later');
  return res.status(200).json(result);
}
