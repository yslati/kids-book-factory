// GET /api/preview-status/<generation_id>
//
// The /preview endpoint is synchronous and returns the finished cover directly,
// so the client only polls this as a resilience fallback if /preview ever
// responds with status:'queued'. In the current synchronous design that does
// not happen, so this returns 'ready' if a stored preview exists, else 'pending'.
//
// Covers are now named after the child and book (lib/object-names.js), so the
// id alone only finds covers stored under the old previews/<id> names. If you
// later move generation to a queue, back this with the DB/job store.

import { applyCors, isOriginAllowed } from '../../lib/cors.js';
import { publicUrl, r2Configured } from '../../lib/r2.js';
import { withReporting } from '../../lib/report.js';

export default withReporting(handler);

async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'method-not-allowed' });
  if (!isOriginAllowed(req)) return res.status(403).json({ error: 'forbidden-origin' });
  if (!r2Configured()) return res.status(503).json({ error: 'storage-not-configured' });

  const id = String((req.query && req.query.id) || '').trim();
  if (!/^[A-Za-z0-9-]+$/.test(id)) return res.status(400).json({ error: 'bad-id' });

  // Check whether a generated preview was persisted for this id. /preview can
  // store either extension, so probe both.
  for (const ext of ['jpg', 'png']) {
    const candidate = publicUrl(`previews/${id}.${ext}`);
    try {
      const head = await fetch(candidate, { method: 'HEAD' });
      if (head.ok) return res.status(200).json({ status: 'ready', preview_url: candidate });
    } catch (e) {
      console.warn('[preview-status] HEAD failed:', (e && e.message) || e);
    }
  }

  return res.status(200).json({ status: 'pending' });
}
