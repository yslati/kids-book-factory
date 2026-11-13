// GET /api/cron/<job>
// Every daily Vercel cron (vercel.json) in one function: the Hobby plan
// allows 12 functions per deployment. Each job lives in lib/cron/<job>.js and
// checks CRON_SECRET itself.

import { withReporting } from '../../lib/report.js';
import { handler as covers } from '../../lib/cron/covers.js';
import { handler as dailySummary } from '../../lib/cron/daily-summary.js';
import { handler as fal } from '../../lib/cron/fal.js';
import { handler as higgsfield } from '../../lib/cron/higgsfield.js';
import { handler as openai } from '../../lib/cron/openai.js';

const JOBS = { covers, 'daily-summary': dailySummary, fal, higgsfield, openai };

export default withReporting(async (req, res) => {
  const job = JOBS[String((req.query && req.query.job) || '')];
  if (!job) return res.status(404).json({ error: 'unknown-job' });
  return job(req, res);
});
