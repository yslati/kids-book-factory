// POST /api/custom-story  (synchronous)
// A cover for a story the catalog doesn't have: the parent describes it, and
// the cover is painted from their idea, the child's photo and one of our
// covers, used for its style and layout only. Also takes the follow-up when
// they add the custom book to the cart. Both live in one function, since
// Vercel's Hobby plan caps a deployment at 12.
//
// Generate body: { photo_key, generation_id, reference, world, gender,
//   child_name, age?, occasion?, language?, locale?, brief, turnstile_token?, customer_id?,
//   token_date?, customer_token? }
//   → { preview_url, generation_id, status: 'ready' }
//   429 → { error: 'rate-limited', login_required, remaining: 0 }
//   422 → { error: 'face-not-clear', reason, tip } (costs no generation)
// Cart body: { action: 'cart', generation_id, variant, price, details? } → 204
//
// Generate flow:
//   1. Verify origin + the one-time pass from /upload-url (else Turnstile).
//   2. Read the reference cover from Shopify by its product handle, crop the
//      photo to the face (lib/child-photo.js) and refuse a covered face
//      (lib/face-check.js), then charge the custom-story limit (2 a day) and
//      the shared per-IP backstop.
//   3. Generate through the same model chain as previews (lib/generate.js)
//      with the custom prompt (lib/custom-prompt.js).
//   4. Re-encode and store the cover in R2 as
//      previews/<name>_<age>_<language>_custom-<world>_<id>.jpg.
// Everything the parent sent, then the cover or the error, goes to Discord's
// #custom-generation channel (lib/custom-feed.js) and, with the prompt, to
// the requests sheet's Custom stories tab (lib/sheet.js).

import { waitUntil } from '@vercel/functions';
import { visitorOf } from '../lib/discord.js';
import { Step, linkCustomer, logStep } from '../lib/visitor-log.js';
import { applyCors, isOriginAllowed } from '../lib/cors.js';
import { verifyTurnstile } from '../lib/turnstile.js';
import { redeemPreviewPass } from '../lib/preview-pass.js';
import { getRedis } from '../lib/redis.js';
import { checkRateLimit, clientIp } from '../lib/ratelimit.js';
import { publicUrl, r2Configured } from '../lib/r2.js';
import { flushPendingCovers, storeCover } from '../lib/cover-store.js';
import { resolveBook, shopifyConfigured } from '../lib/shopify.js';
import { generateCover, generationConfigured } from '../lib/generate.js';
import { buildCustomPrompt } from '../lib/custom-prompt.js';
import { HEAD_AND_SKIN, MAX_PROMPT_CHARS, Scene, withFaceDescription, withPhotoTraits } from '../lib/prompt.js';
import { faceTooSmall, prepareChildPhoto } from '../lib/child-photo.js';
import { NO_TRAITS, checkFace, faceCheckError } from '../lib/face-check.js';
import { verifyCustomerToken } from '../lib/customer-token.js';
import { previewKey } from '../lib/object-names.js';
import { withReporting } from '../lib/report.js';
import { announceCustomStory, postCustomCart } from '../lib/custom-feed.js';
import { appendRows, customRow, TABS, updateRow } from '../lib/sheet.js';
import { claimCartPost, normaliseCart, normaliseGenerate, readCustomStory, saveCustomStory } from '../lib/custom-story.js';

// vercel.json gives this function 90s; generation must finish within 75s
// (the storefront waits 90s).
const GENERATION_BUDGET_MS = 75000;

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
  const fields = { 'Added to cart': value.variant || 'Yes' };
  if (value.details) fields['Extra details'] = value.details;
  waitUntil(updateRow(TABS.custom, value.generationId, fields));
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

  // The photo is prepared and its face checked first, so a refused photo
  // costs no generation. Then the custom story's own daily allowance (2), so
  // trying an idea doesn't use up the product previews, plus the per-IP
  // backstop shared with /preview, which caps what one machine can spend on
  // both together.
  const customer = verifyCustomerToken(body);
  const bookLoad = resolveBook(r.reference);
  bookLoad.catch(() => { /* awaited below */ });
  const photo = await prepareChildPhoto(r.photoKey);
  const locale = /^[A-Za-z]{2}(-[A-Za-z]{2})?$/.test(String(body.locale || '')) ? String(body.locale) : 'en';
  const face = photo.image ? await checkFace(photo.image, { locale }) : null;
  const refused = faceCheckError(face, { tooSmall: faceTooSmall(photo) });
  const traits = (face && face.traits) || NO_TRAITS;
  if (!refused) {
    const rl = await checkRateLimit(req, customer.valid ? 'custom-cust' : 'custom', customer.valid ? customer.customerId : null);
    const capped = await checkRateLimit(req, 'preview-ip-cap');
    if (!rl.success || !capped.success) {
      waitUntil(logStep(getRedis(), visitorOf(req), { kind: Step.limit, text: 'no custom stories left today' }));
      return res.status(429).json({ error: 'rate-limited', login_required: !customer.valid, remaining: 0 });
    }
  }

  const visitor = visitorOf(req);
  waitUntil(logStep(getRedis(), visitor, { kind: Step.custom, text: r.world + ' · ' + r.brief, generation: r.generationId }));
  if (customer.valid) waitUntil(linkCustomer(getRedis(), visitor.id, customer.customerId, 'signed in'));
  const photoUrl = publicUrl(r.photoKey);
  const feed = announceCustomStory(req, {
    ...r,
    photoUrl,
    customerId: customer.valid ? customer.customerId : null,
    startedAt
  });
  const record = (outcome) => waitUntil(appendRows(TABS.custom, [customRow(req, {
    ...r,
    photoUrl,
    customerId: customer.valid ? customer.customerId : null,
    startedAt
  }, outcome)]));

  let prompt = '';
  try {
    if (refused) throw refused;
    const book = await bookLoad;
    const childUrl = photo.url;
    const base = buildCustomPrompt(r);
    // The photo rules, head-size rule and face description where the provider's prompt limit has room.
    const short = withPhotoTraits(base, traits, { scene: Scene.NEW });
    const long = withPhotoTraits(withFaceDescription(base + '\n\n' + HEAD_AND_SKIN, traits.description), traits, { scene: Scene.NEW });
    const promptFor = (maxChars) => (maxChars > MAX_PROMPT_CHARS ? long : (short.length <= maxChars ? short : base));
    prompt = promptFor(Infinity);
    const generated = await generateCover(book.coverUrl, childUrl, promptFor, {
      coverAspect: book.coverAspect,
      deadline: startedAt + GENERATION_BUDGET_MS
    });
    prompt = generated.prompt || prompt;

    // Kept in R2, else in Upstash behind /api/cover (lib/cover-store.js).
    const redis = getRedis();
    const kept = await storeCover(generated.url, (ext) => previewKey({
      childName: r.childName,
      age: r.age,
      language: r.language.code,
      bookTitle: 'custom ' + r.world,
      themeId: 'custom',
      id: r.generationId,
      ext
    }), { redis });
    const coverUrl = kept.url;
    if (kept.stored === 'pending') waitUntil(flushPendingCovers(redis, { keys: [kept.key], waits: [3000] }).catch(() => {}));

    // The add-to-cart card and /preview-status (which hands a cover to a page
    // whose answer was lost) read this. Written at once, then again with the
    // Discord link; a Redis problem must never fail a paid cover.
    const story = { childName: r.childName, age: r.age, gender: r.gender, world: r.world, photoUrl, coverUrl, link: '' };
    waitUntil(saveCustomStory(redis, r.generationId, story)
      .then(() => feed.link)
      .then((link) => (link ? saveCustomStory(redis, r.generationId, { ...story, link }) : null))
      .catch((e) => console.warn('[custom-story] record not saved:', (e && e.message) || e)));
    feed.done({ coverUrl, attempt: generated.attempt, stored: kept.stored });
    record({ coverUrl, attempt: generated.attempt, prompt });
    waitUntil(logStep(redis, visitor, { kind: Step.cover, text: 'custom · ' + r.world, url: coverUrl }));

    return res.status(200).json({ preview_url: coverUrl, generation_id: r.generationId, status: 'ready' });
  } catch (err) {
    console.error('[custom-story] failed:', err && err.stack ? err.stack : err);
    const code = String((err && err.message) || err);
    const detail = code + (err && err.reason ? ': ' + err.reason : '');
    feed.done({ error: detail });
    record({ error: detail, prompt });
    waitUntil(logStep(getRedis(), visitor, { kind: Step.failed, text: 'custom · ' + detail }));
    if (code === 'face-not-clear') {
      return res.status(422).json({ error: code, status: 'failed', reason: err.reason, tip: err.tip || '' });
    }
    if (code === 'product-not-found' || code === 'cover-missing') {
      return res.status(422).json({ error: code, status: 'failed' });
    }
    return res.status(502).json({ error: 'generation-failed', status: 'failed' });
  }
}
