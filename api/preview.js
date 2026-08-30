// POST /api/preview  (synchronous, resilient)
// Generates the personalised cover and returns its permanent URL.
//
// Body: { theme_id, photo_key, generation_id, child_name, age, language, turnstile_token,
//         customer_id?, token_date?, customer_token? }
// → { preview_url, generation_id, status: 'ready', remaining }
// 429 → { error: 'rate-limited', login_required, remaining: 0 }
//
// Flow:
//   1. Verify origin + Turnstile + rate limit (per-customer tier when signed in).
//   2. Resolve cover + prompt SERVER-SIDE from Shopify by theme_id (anti-tamper).
//   3. Generate via fal Kontext multi ([cover, child] + prompt), one retry.
//   4. Persist the generated cover to R2 (fal URLs are temporary).
//   5. Return the permanent R2 url.

import { applyCors, isOriginAllowed } from '../lib/cors.js';
import { verifyTurnstile } from '../lib/turnstile.js';
import { checkRateLimit, clientIp } from '../lib/ratelimit.js';
import { publicUrl, putObject, r2Configured } from '../lib/r2.js';
import { resolveBook, shopifyConfigured } from '../lib/shopify.js';
import { generateCover } from '../lib/fal.js';
import { resolveBookLanguage } from '../lib/book-languages.js';
import { verifyCustomerToken } from '../lib/customer-token.js';
import { tagCustomerPreviewLimit } from '../lib/customer-tag.js';

// Both limiters return null when limiting is disabled; only compare real numbers.
function minRemaining(a, b) {
  if (typeof a !== 'number') return typeof b === 'number' ? b : null;
  if (typeof b !== 'number') return a;
  return Math.min(a, b);
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed' });
  if (!isOriginAllowed(req)) return res.status(403).json({ error: 'forbidden-origin' });

  if (!r2Configured()) return res.status(503).json({ error: 'storage-not-configured' });
  if (!shopifyConfigured()) return res.status(503).json({ error: 'shopify-not-configured' });
  if (!process.env.FAL_KEY) return res.status(503).json({ error: 'fal-not-configured' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const themeId = String(body.theme_id || '').trim();
  const photoKey = String(body.photo_key || '').trim();
  const generationId = String(body.generation_id || '').trim();
  const language = resolveBookLanguage(body.language);
  const childName = String(body.child_name || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 40);
  const ageNum = parseInt(body.age, 10);
  const ageText = Number.isFinite(ageNum) && ageNum >= 0 && ageNum <= 18 ? String(ageNum) : '';

  if (!themeId || !photoKey || !generationId) {
    return res.status(400).json({ error: 'missing-fields' });
  }
  if (!language) {
    return res.status(400).json({ error: 'unsupported-language' });
  }
  // photo_key must be one we issued (prevents pointing us at arbitrary objects).
  if (!/^photos\/[A-Za-z0-9-]+\.(jpg|png)$/.test(photoKey)) {
    return res.status(400).json({ error: 'bad-photo-key' });
  }

  const ok = await verifyTurnstile(body.turnstile_token, clientIp(req));
  if (!ok) return res.status(403).json({ error: 'challenge-failed' });

  // Tier selection: a valid signed token buys the higher per-customer
  // allowance; everyone else gets the anonymous per-IP allowance and is
  // invited to sign in. `login_required` drives which message the theme shows.
  const customer = verifyCustomerToken(body);
  const bucket = customer.valid ? 'preview-cust' : 'preview';
  const rl = await checkRateLimit(req, bucket, customer.valid ? customer.customerId : null);

  // Per-IP backstop, enforced for everyone including verified customers, so a
  // single machine can't multiply free previews with throwaway accounts.
  // Checked even when the tier limit already denied, so both windows stay in
  // step - a denied request shouldn't leave the cap un-decremented.
  const capped = await checkRateLimit(req, 'preview-ip-cap');

  if (!rl.success || !capped.success) {
    // A verified customer who has run out - by their own allowance or by the
    // shared IP cap - is our warmest lead. Tag them for the follow-up email.
    // Fire-and-forget: a tagging failure must not change this response.
    if (customer.valid) {
      try {
        await tagCustomerPreviewLimit(customer.customerId);
      } catch (e) { /* never surfaces */ }
    }
    return res.status(429).json({
      error: 'rate-limited',
      login_required: !customer.valid,
      remaining: 0
    });
  }

  try {
    // 2. Resolve cover + prompt from the product's own metafields.
    const book = await resolveBook(themeId);
    let prompt = book.prompt;
    prompt += '\n\nBook language: ' + language.name + ' (' + language.code + '). ' +
      'Translate all visible cover text into this language while preserving the ' +
      'existing typography, layout, colours, and the child\'s name.';
    if (childName) {
      prompt += '\n\nPersonalise the cover: the child\'s first name is "' + childName +
        '". If the title shows a character or placeholder name, change it to read "' + childName +
        '" in the same font, size, colour, and position. Apart from the requested ' +
        'language translation, do not change any other words or letters.';
    }
    if (ageText) {
      prompt += '\n\nThe child is ' + ageText + ' years old; make the main character look like a child of about this age.';
    }

    const childUrl = publicUrl(photoKey);

    // 3. Generate, with one retry on transient failure.
    let falUrl;
    try {
      falUrl = await generateCover(book.coverUrl, childUrl, prompt);
    } catch (firstErr) {
      falUrl = await generateCover(book.coverUrl, childUrl, prompt);
    }

    // 4. Persist the generated cover to R2 (permanent).
    let previewUrl = falUrl;
    try {
      const imgRes = await fetch(falUrl);
      if (imgRes.ok) {
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const ct = imgRes.headers.get('content-type') || 'image/jpeg';
        const ext = ct.indexOf('png') !== -1 ? 'png' : 'jpg';
        previewUrl = await putObject(`previews/${generationId}.${ext}`, buf, ct);
      }
    } catch (storeErr) {
      // If persistence fails, fall back to the (temporary) fal URL so the user
      // still sees a preview; the order record should prefer the R2 copy.
      previewUrl = falUrl;
    }

    return res.status(200).json({
      preview_url: previewUrl,
      generation_id: generationId,
      status: 'ready',
      // The tighter of the two windows - that's the number that will actually
      // stop them. null when rate limiting is disabled (theme hides the counter).
      remaining: minRemaining(rl.remaining, capped.remaining)
    });
  } catch (err) {
    const code = (err && err.message) || 'preview-failed';
    // Log the real error to the server (vercel dev terminal) for diagnosis.
    console.error('[preview] failed:', err && err.stack ? err.stack : err);
    const detail = String((err && err.message) || err);
    if (code === 'product-not-found' || code === 'prompt-missing' || code === 'cover-missing') {
      return res.status(422).json({ error: code, status: 'failed', detail });
    }
    return res.status(502).json({ error: 'generation-failed', status: 'failed', detail });
  }
}
