// POST /api/preview  (synchronous, resilient)
// Generates the personalised cover and returns its permanent URL.
//
// Body: { theme_id, photo_key, generation_id, child_name, age, language, turnstile_token?,
//         customer_id?, token_date?, customer_token? }
// → { preview_url, generation_id, status: 'ready', remaining }
// 429 → { error: 'rate-limited', login_required, remaining: 0 }
//
// Also takes the preview page's follow-ups for the requests sheet, here
// rather than in their own function since Vercel's Hobby plan caps a
// deployment at 12:
//   { action: 'occasion', generation_id, occasion }            → 204
//   { action: 'details', generation_id, details }              → 204
//   { action: 'cart', generation_id, occasion?, details?,
//     variant }                                                → 204
//
// Flow:
//   1. Verify origin + the one-time preview pass from /upload-url (else a
//      Turnstile token) + rate limit (per-customer tier when signed in).
//   2. Resolve cover + prompt SERVER-SIDE from Shopify by theme_id (anti-tamper),
//      and shrink a full-size photo to 1024px (lib/child-photo.js).
//   3. Generate ([cover, child] + prompt) via lib/generate.js, which tries an
//      ordered chain of models until one returns a cover.
//   4. Re-encode the cover as a JPEG (lib/cover-image.js) and persist it to R2
//      (provider URLs are temporary), named
//      previews/<name>_<age>_<language>_<book>_<id>.<ext> (lib/object-names.js).
//   5. Return the permanent R2 url.
// The photo, then the cover or the error, also go to Discord's #previews
// channel (lib/preview-feed.js), and the answers, prompt and outcome to the
// requests sheet's Book previews tab (lib/sheet.js).

import { applyCors, isOriginAllowed } from '../lib/cors.js';
import { verifyTurnstile } from '../lib/turnstile.js';
import { redeemPreviewPass } from '../lib/preview-pass.js';
import { getRedis } from '../lib/redis.js';
import { checkRateLimit, clientIp } from '../lib/ratelimit.js';
import { publicUrl, putObject, r2Configured } from '../lib/r2.js';
import { resolveBook, shopifyConfigured } from '../lib/shopify.js';
import { generateCover, generationConfigured } from '../lib/generate.js';
import { buildPreviewPrompt } from '../lib/prompt.js';
import { childPhotoUrl } from '../lib/child-photo.js';
import { resolveBookLanguage } from '../lib/book-languages.js';
import { verifyCustomerToken } from '../lib/customer-token.js';
import { tagCustomerPreviewLimit } from '../lib/customer-tag.js';
import { savePreviews } from '../lib/user-previews.js';
import { previewKey } from '../lib/object-names.js';
import { coverForStorage } from '../lib/cover-image.js';
import { withReporting } from '../lib/report.js';
import { announcePreview, postPreviewDetails } from '../lib/preview-feed.js';
import { appendRows, previewFollowUp, previewRow, TABS, updateRow } from '../lib/sheet.js';
import { claimDetailsPost, readPreviewRecord, savePreviewRecord } from '../lib/preview-record.js';
import { countPreview } from '../lib/visitor-counts.js';
import { countEvent } from '../lib/event-stats.js';
import { waitUntil } from '@vercel/functions';

// vercel.json gives this function 60s. Generation must finish within 50s of
// the request arriving, leaving time to copy the cover to R2 and respond.
const GENERATION_BUDGET_MS = 50000;

// Both limiters return null when limiting is disabled; only compare real numbers.
function minRemaining(a, b) {
  if (typeof a !== 'number') return typeof b === 'number' ? b : null;
  if (typeof b !== 'number') return a;
  return Math.min(a, b);
}

export default withReporting(handler);

// The preview page's follow-up: answered at once, then the sheet fills in the
// row it already has for this generation (and changes nothing otherwise).
async function followUp(req, res, body) {
  const { value, error } = previewFollowUp(body);
  if (error) return res.status(400).json({ error });
  const limited = await checkRateLimit(req, 'preview-follow-up');
  if (!limited.success) return res.status(429).json({ error: 'rate-limited' });
  res.status(204).end();
  waitUntil(updateRow(TABS.previews, value.generationId, value.fields));
  if (body.action === 'cart' && value.details) waitUntil(postDetails(req, value));
}

// The extra details card in #previews: only for a cover this backend made,
// and only once per generation.
async function postDetails(req, value) {
  try {
    const redis = getRedis();
    const record = await readPreviewRecord(redis, value.generationId);
    if (!record || !(await claimDetailsPost(redis, value.generationId))) return;
    await postPreviewDetails(req, record, value);
  } catch (e) {
    console.warn('[preview] details card not posted:', (e && e.message) || e);
  }
}

async function handler(req, res) {
  const startedAt = Date.now();
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed' });
  if (!isOriginAllowed(req)) {
    console.warn('[preview] 403 forbidden-origin:', req.headers.origin || '(none)');
    return res.status(403).json({ error: 'forbidden-origin' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  if (body.action) return followUp(req, res, body);

  if (!r2Configured()) return res.status(503).json({ error: 'storage-not-configured' });
  if (!shopifyConfigured()) return res.status(503).json({ error: 'shopify-not-configured' });
  if (!generationConfigured()) return res.status(503).json({ error: 'generation-not-configured' });

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
  if (!/^photos\/[A-Za-z0-9_-]+\.(jpg|png)$/.test(photoKey)) {
    return res.status(400).json({ error: 'bad-photo-key' });
  }
  // generation_id ends up in the cover's object key. Older ids are UUIDs.
  if (!/^[A-Za-z0-9-]{1,64}$/.test(generationId)) {
    return res.status(400).json({ error: 'bad-generation-id' });
  }

  // /upload-url verified Turnstile for this generation and granted a one-time
  // pass. Without one (Redis unavailable, or the pass expired or was already
  // used) the request must carry a fresh token.
  const verified = (await redeemPreviewPass(getRedis(), generationId))
    || (await verifyTurnstile(body.turnstile_token, clientIp(req)));
  if (!verified) {
    console.warn('[preview] 403 challenge-failed:', body.turnstile_token ? 'token rejected' : 'no pass or token');
    return res.status(403).json({ error: 'challenge-failed' });
  }

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

  // Counted as generation starts, whether or not it succeeds.
  const counts = countPreview(getRedis(), req, customer.valid ? customer.customerId : null);
  waitUntil(counts);
  // The daily summary's preview funnel (lib/event-stats.js).
  waitUntil(countEvent(getRedis(), 'preview_started'));

  const photoUrl = publicUrl(photoKey);
  const feed = announcePreview(req, {
    photoUrl,
    themeId,
    generationId,
    childName,
    age: ageText,
    language: language.name,
    customerId: customer.valid ? customer.customerId : null,
    startedAt,
    counts
  });
  const record = (outcome) => waitUntil(appendRows(TABS.previews, [previewRow(req, {
    book: themeId,
    childName,
    age: ageText,
    language: language.name,
    photoUrl,
    customerId: customer.valid ? customer.customerId : null,
    generationId,
    startedAt
  }, outcome)]));

  let prompt = '';
  try {
    // 2. Resolve cover + prompt from the product's own metafields, while the
    //    photo is checked (and shrunk if full-size) for the generator.
    const [book, childUrl] = await Promise.all([resolveBook(themeId), childPhotoUrl(photoKey)]);
    prompt = buildPreviewPrompt(book.prompt, { language, childName, age: ageText });

    // 3. Generate, falling back down the model chain on failure.
    const generated = await generateCover(book.coverUrl, childUrl, prompt, {
      coverAspect: book.coverAspect,
      deadline: startedAt + GENERATION_BUDGET_MS
    });
    const generatedUrl = generated.url;

    // 4. Persist the generated cover to R2 (permanent).
    let previewUrl = generatedUrl;
    try {
      const imgRes = await fetch(generatedUrl);
      if (!imgRes.ok) throw new Error('cover-fetch-' + imgRes.status);
      const cover = await coverForStorage(
        Buffer.from(await imgRes.arrayBuffer()),
        imgRes.headers.get('content-type')
      );
      const key = previewKey({
        childName: childName,
        age: ageText,
        language: language.code,
        bookTitle: book.title,
        themeId: themeId,
        id: generationId,
        ext: cover.ext
      });
      previewUrl = await putObject(key, cover.body, cover.contentType);
    } catch (storeErr) {
      // If persistence fails, fall back to the (temporary) provider URL so the
      // user still sees a preview; the order record should prefer the R2 copy.
      console.warn('[preview] cover not stored, returning the provider URL:', (storeErr && storeErr.message) || storeErr);
      previewUrl = generatedUrl;
    }

    // Record it against the account when the shopper is signed in, so their
    // previews follow them to another device. Fire-and-forget: this is a
    // convenience, and a Redis problem must never fail a paid generation.
    if (customer.valid) {
      try {
        await savePreviews(customer.customerId, [{
          // The key the theme stores this preview under, so the two merge.
          k: 'kb-book-' + generationId,
          // The product handle. The display slug that goes in ?b= is built in
          // the theme, so the client fills `book` in when it syncs.
          themeId: themeId,
          bookTitle: book.title || '',
          childName: childName,
          age: ageText,
          coverUrl: previewUrl,
          createdAt: new Date().toISOString()
        }]);
      } catch (e) { /* never surfaces */ }
    }

    // The extra details card reads this; a Redis problem must never fail a paid cover.
    if (feed.link) {
      waitUntil(feed.link
        .then((link) => savePreviewRecord(getRedis(), generationId, {
          childName, age: ageText, bookTitle: book.title || '', coverUrl: previewUrl, link
        }))
        .catch((e) => console.warn('[preview] record not saved:', (e && e.message) || e)));
    }
    feed.done({ coverUrl: previewUrl, bookTitle: book.title, attempt: generated.attempt, temporary: previewUrl === generatedUrl });
    record({ coverUrl: previewUrl, bookTitle: book.title, attempt: generated.attempt, prompt });
    waitUntil(countEvent(getRedis(), 'preview_ready'));
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
    feed.done({ error: detail });
    record({ error: detail, prompt });
    waitUntil(countEvent(getRedis(), 'preview_failed'));
    if (code === 'product-not-found' || code === 'prompt-missing' || code === 'cover-missing') {
      return res.status(422).json({ error: code, status: 'failed', detail });
    }
    return res.status(502).json({ error: 'generation-failed', status: 'failed', detail });
  }
}
