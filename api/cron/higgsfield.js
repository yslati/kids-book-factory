// GET /api/cron/higgsfield
// Vercel cron (vercel.json): once a day, between 07:00 and 07:59 UTC, checks
// the Higgsfield account and posts the result to #higgsfield
// (lib/higgsfield-feed.js). A repeated run the same UTC day posts nothing.
// Vercel sends "Authorization: Bearer $CRON_SECRET"; with that header,
// ?force=1 runs the check again.

import { getRedis } from '../../lib/redis.js';
import { higgsfieldConfigured } from '../../lib/higgsfield.js';
import { higgsfieldChannelOn, runHiggsfieldCheck } from '../../lib/higgsfield-feed.js';
import { higgsfieldChain } from '../../lib/generate.js';
import { withReporting } from '../../lib/report.js';
import { cronAuthorized } from '../../lib/cron-auth.js';

export default withReporting(handler);

async function handler(req, res) {
  if (!cronAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'storage-not-configured' });
  if (!higgsfieldChannelOn()) return res.status(503).json({ error: 'discord-not-configured' });
  if (!higgsfieldConfigured()) return res.status(503).json({ error: 'higgsfield-not-configured' });

  const force = String((req.query && req.query.force) || '') === '1';
  const result = await runHiggsfieldCheck(redis, higgsfieldChain(), { force });
  if (!result) {
    console.log('[higgsfield-check] already ran today; this run stops');
    return res.status(200).json({ skipped: 'already-ran' });
  }
  if (!result.posted) console.warn('[higgsfield-check] not every message went out right away; they are sent later');
  return res.status(result.posted ? 200 : 502).json(result);
}
