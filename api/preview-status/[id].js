// GET /api/preview-status/<generation_id>
// → { status: 'ready', preview_url } | { status: 'pending', queue_position? }
//   | { status: 'failed' }
//
// The storefront polls this every 3s after /preview answered 'queued': the
// cover's Higgsfield job was waiting for a slot, or still running at
// /preview's budget. queue_position is there while it waits for a slot.
// Each poll looks at the job once; the one that sees it end copies the cover
// to R2 and records it like /preview does (lib/preview-finish.js), exactly
// once (lib/queued-preview.js). An unknown or expired id is 'failed'.

import { applyCors, isOriginAllowed } from '../../lib/cors.js';
import { getRedis } from '../../lib/redis.js';
import { withReporting } from '../../lib/report.js';
import { abandonPendingCover, checkPendingCover } from '../../lib/generate.js';
import { resumePreviewFeed } from '../../lib/preview-feed.js';
import { failPreview, feedPreview, finishPreview } from '../../lib/preview-finish.js';
import { settleQueuedPreview } from '../../lib/queued-preview.js';

export default withReporting(handler);

// The finish step's inputs from a queued entry.
function resume(entry) {
  const p = entry.preview;
  return { p, feed: resumePreviewFeed(entry.request, feedPreview(p, entry.counts), entry.link) };
}

async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'method-not-allowed' });
  if (!isOriginAllowed(req)) return res.status(403).json({ error: 'forbidden-origin' });

  const id = String((req.query && req.query.id) || '').trim();
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) return res.status(400).json({ error: 'bad-id' });
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'queue-not-configured' });

  const result = await settleQueuedPreview(redis, id, {
    check: checkPendingCover,
    finish(entry, url) {
      const { p, feed } = resume(entry);
      return finishPreview(entry.request, p, {
        book: entry.book, generated: { url, attempt: entry.pending.attempt }, prompt: entry.prompt, feed
      });
    },
    async fail(entry, error) {
      if (error === 'higgsfield-expired') await abandonPendingCover(entry.pending);
      console.warn('[preview-status] queued cover failed:', error);
      const { p, feed } = resume(entry);
      failPreview(entry.request, p, { error, prompt: entry.prompt, feed });
    }
  });
  return res.status(200).json(result);
}
