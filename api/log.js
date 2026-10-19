// POST /api/log
// Storefront error reports. The theme's reporter (snippets/kb-error-reporter.liquid)
// posts uncaught errors from the theme's own scripts and the failures its
// flows report; this adds who sent it (IP, country, device) and forwards it
// to Discord (lib/report.js), so the webhook URL never reaches the browser.
//
// Body: { level: 'error' | 'warn', code, message?, stack?, page?, context? }
// sent as text/plain JSON, which a beacon can post with no CORS preflight.
// → 204. Rejected reports get 400/403/429 and go no further.
//
// Not wrapped in withReporting: a rejected report would otherwise post a
// report of its own.

import { applyCors, isOriginAllowed } from '../lib/cors.js';
import { checkRateLimit } from '../lib/ratelimit.js';
import { normaliseClientEvent, reportClientEvent } from '../lib/report.js';

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed' });
  if (!isOriginAllowed(req)) return res.status(403).json({ error: 'forbidden-origin' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }

  const event = normaliseClientEvent(body);
  if (!event) return res.status(400).json({ error: 'bad-event' });

  const rl = await checkRateLimit(req, 'log');
  if (!rl.success) return res.status(429).json({ error: 'rate-limited' });

  reportClientEvent(req, event);
  return res.status(204).end();
}
