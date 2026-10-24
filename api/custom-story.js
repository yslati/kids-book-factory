// POST /api/custom-story  (synchronous)
// A cover for a story the catalog doesn't have: the parent describes it, and
// the cover is painted from their idea, the child's photo and one of our
// covers, used for its style and layout only. Also takes the follow-up when
// they add the custom book to the cart. Both live in one function, since
// Vercel's Hobby plan caps a deployment at 12.
//
// Generate body: { photo_key, generation_id, reference, world, gender,
//   child_name, age?, occasion?, brief, turnstile_token?, customer_id?,
//   token_date?, customer_token? }
//   → { preview_url, generation_id, status: 'ready' }
//   429 → { error: 'rate-limited', login_required, remaining: 0 }
// Cart body: { action: 'cart', generation_id, variant, price } → 204
//
// Generate flow:
//   1. Verify origin + the one-time pass from /upload-url (else Turnstile) +
//      the custom-story rate limit and the shared per-IP backstop.
//   2. Read the reference cover from Shopify by its product handle, and
//      shrink a full-size photo (lib/child-photo.js).
//   3. Generate through the same model chain as previews (lib/generate.js)
//      with the custom prompt (lib/custom-prompt.js).
//   4. Re-encode and store the cover in R2 as
//      previews/<name>_<age>_en_custom-<world>_<id>.jpg.
// Everything the parent sent, then the cover or the error, goes to Discord's
// #custom-generation channel (lib/custom-feed.js) and to the requests sheet
// (lib/sheet.js).

import { waitUntil } from '@vercel/functions';
import { applyCors, isOriginAllowed } from '../lib/cors.js';
import { verifyTurnstile } from '../lib/turnstile.js';
import { redeemPreviewPass } from '../lib/preview-pass.js';
import { getRedis } from '../lib/redis.js';
import { checkRateLimit, clientIp } from '../lib/ratelimit.js';
import { publicUrl, putObject, r2Configured } from '../lib/r2.js';
import { resolveBook, shopifyConfigured } from '../lib/shopify.js';
import { generateCover, generationConfigured } from '../lib/generate.js';
import { WORLDS, buildCustomPrompt } from '../lib/custom-prompt.js';
import { childPhotoUrl } from '../lib/child-photo.js';
import { verifyCustomerToken } from '../lib/customer-token.js';
import { previewKey } from '../lib/object-names.js';
import { coverForStorage } from '../lib/cover-image.js';
import { withReporting } from '../lib/report.js';
import { announceCustomStory, postCustomCart } from '../lib/custom-feed.js';
import { appendRow, requestRow, updateRow } from '../lib/sheet.js';
import { claimCartPost, normaliseCart, normaliseGenerate, readCustomStory, saveCustomStory } from '../lib/custom-story.js';

// vercel.json gives this function 60s; generation must finish within 50s.
const GENERATION_BUDGET_MS = 50000;

export default withReporting(handler);

async function handler(req, res) {
  const startedAt = Date.now();
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed' });
  if (!isOriginAllowed(req)) {
    console.warn('[custom-story] 403 forbidden-origin:', req.headers.origin || '(none)');
    return res.status(403).json({ error: 'forbidden-origin' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  if (body.action === 'cart') return cart(req, res, body);
  return generate(req, res, body, startedAt);
}

async function cart(req, res, body) {
  const { value, error } = normaliseCart(body);
  if (error) return res.status(400).json({ error });

  const limited = await checkRateLimit(req, 'custom-cart');
  if (!limited.success) return res.status(429).json({ error: 'rate-limited' });

  // Only a cover this backend generated gets a card, and only once.
  const redis = getRedis();
  const record = await readCustomStory(redis, value.generationId);
  if (!record) return res.status(404).json({ error: 'unknown-generation' });
  res.status(204).end();
  waitUntil(updateRow(value.generationId, { 'Added to cart': value.variant || 'Yes' }));
  if (await claimCartPost(redis, value.generationId)) waitUntil(postCustomCart(req, record, value));
}

async function generate(req, res, body, startedAt) {
  if (!r2Configured()) return res.status(503).json({ error: 'storage-not-configured' });
  if (!shopifyConfigured()) return res.status(503).json({ error: 'shopify-not-configured' });
  if (!generationConfigured()) return res.status(503).json({ error: 'generation-not-configured' });

  const { value: r, error } = normaliseGenerate(body);
  if (error) return res.status(400).json({ error });

  const verified = (await redeemPreviewPass(getRedis(), r.generationId))
    || (await verifyTurnstile(body.turnstile_token, clientIp(req)));
  if (!verified) {
    console.warn('[custom-story] 403 challenge-failed:', body.turnstile_token ? 'token rejected' : 'no pass or token');
    return res.status(403).json({ error: 'challenge-failed' });
  }

  // Its own daily allowance, so trying an idea doesn't use up the product
  // previews, plus the per-IP backstop shared with /preview, which caps what
  // one machine can spend on both together.
  const customer = verifyCustomerToken(body);
  const rl = await checkRateLimit(req, customer.valid ? 'custom-cust' : 'custom', customer.valid ? customer.customerId : null);
  const capped = await checkRateLimit(req, 'preview-ip-cap');
  if (!rl.success || !capped.success) {
    return res.status(429).json({ error: 'rate-limited', login_required: !customer.valid, remaining: 0 });
  }

  const photoUrl = publicUrl(r.photoKey);
  const feed = announceCustomStory(req, {
    ...r,
    photoUrl,
    customerId: customer.valid ? customer.customerId : null,
    startedAt
  });
  const record = (outcome) => waitUntil(appendRow(requestRow(req, {
    form: 'Custom story',
    book: WORLDS[r.world],
    hero: r.gender === 'girl' ? 'Girl' : 'Boy',
    childName: r.childName,
    age: r.age,
    language: 'English',
    occasion: r.occasion,
    brief: r.brief,
    photoUrl,
    customerId: customer.valid ? customer.customerId : null,
    generationId: r.generationId,
    startedAt
  }, outcome)));

  try {
    const [book, childUrl] = await Promise.all([resolveBook(r.reference), childPhotoUrl(r.photoKey)]);
    const prompt = buildCustomPrompt(r);
    const generated = await generateCover(book.coverUrl, childUrl, prompt, {
      coverAspect: book.coverAspect,
      deadline: startedAt + GENERATION_BUDGET_MS
    });

    // Provider URLs are temporary; keep the provider's link only when the
    // copy to R2 fails, so the parent still sees their cover.
    let coverUrl = generated.url;
    try {
      const imgRes = await fetch(generated.url);
      if (!imgRes.ok) throw new Error('cover-fetch-' + imgRes.status);
      const cover = await coverForStorage(Buffer.from(await imgRes.arrayBuffer()), imgRes.headers.get('content-type'));
      const key = previewKey({
        childName: r.childName,
        age: r.age,
        language: 'en',
        bookTitle: 'custom ' + r.world,
        themeId: 'custom',
        id: r.generationId,
        ext: cover.ext
      });
      coverUrl = await putObject(key, cover.body, cover.contentType);
    } catch (storeErr) {
      console.warn('[custom-story] cover not stored, returning the provider URL:', (storeErr && storeErr.message) || storeErr);
    }

    // The add-to-cart card reads this; a Redis problem must never fail a paid cover.
    waitUntil(feed.link
      .then((link) => saveCustomStory(getRedis(), r.generationId, {
        childName: r.childName, age: r.age, gender: r.gender, world: r.world, photoUrl, coverUrl, link
      }))
      .catch((e) => console.warn('[custom-story] record not saved:', (e && e.message) || e)));
    feed.done({ coverUrl, attempt: generated.attempt, temporary: coverUrl === generated.url });
    record({ coverUrl });

    return res.status(200).json({ preview_url: coverUrl, generation_id: r.generationId, status: 'ready' });
  } catch (err) {
    console.error('[custom-story] failed:', err && err.stack ? err.stack : err);
    const detail = String((err && err.message) || err);
    feed.done({ error: detail });
    record({ error: detail });
    if (detail === 'product-not-found' || detail === 'cover-missing') {
      return res.status(422).json({ error: detail, status: 'failed' });
    }
    return res.status(502).json({ error: 'generation-failed', status: 'failed' });
  }
}
