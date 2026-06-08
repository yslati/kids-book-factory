// POST /api/upload-url
// Verifies the request (origin, Turnstile, rate limit), validates the file
// metadata, and returns a presigned R2 PUT URL the browser uses to upload the
// child's photo directly to storage.
//
// Body: { filename, content_type, size, theme_id, turnstile_token }
// → { presigned_put_url, photo_key, generation_id }

import { applyCors, isOriginAllowed } from '../lib/cors.js';
import { verifyTurnstile } from '../lib/turnstile.js';
import { checkRateLimit, clientIp } from '../lib/ratelimit.js';
import { presignPut, r2Configured } from '../lib/r2.js';
import { randomUUID } from 'node:crypto';

const MAX_MB = parseInt(process.env.MAX_UPLOAD_MB || '10', 10);
const ALLOWED_TYPES = ['image/jpeg', 'image/png'];

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed' });
  if (!isOriginAllowed(req)) return res.status(403).json({ error: 'forbidden-origin' });

  if (!r2Configured()) return res.status(503).json({ error: 'storage-not-configured' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const ok = await verifyTurnstile(body.turnstile_token, clientIp(req));
  if (!ok) return res.status(403).json({ error: 'challenge-failed' });

  const rl = await checkRateLimit(req, 'upload');
  if (!rl.success) return res.status(429).json({ error: 'rate-limited' });

  const contentType = String(body.content_type || '');
  const size = Number(body.size || 0);
  if (ALLOWED_TYPES.indexOf(contentType) === -1) {
    return res.status(400).json({ error: 'bad-type' });
  }
  if (!size || size > MAX_MB * 1024 * 1024) {
    return res.status(400).json({ error: 'too-large' });
  }

  const generationId = randomUUID();
  const ext = contentType === 'image/png' ? 'png' : 'jpg';
  const photoKey = `photos/${generationId}.${ext}`;

  try {
    const presignedPutUrl = await presignPut(photoKey, contentType);
    return res.status(200).json({
      presigned_put_url: presignedPutUrl,
      photo_key: photoKey,
      generation_id: generationId
    });
  } catch (e) {
    return res.status(500).json({ error: 'presign-failed' });
  }
}
