// POST /api/preview  (synchronous, resilient)
// Generates the personalised cover and returns its permanent URL.
//
// Body: { theme_id, photo_key, generation_id, child_name, age, language, locale?,
//         turnstile_token?, customer_id?, token_date?, customer_token? }
// → { preview_url, generation_id, status: 'ready', remaining, fix_options }
//   fix_options: [{ id, label?, spotted }], the fix buttons for this cover
//   (lib/fix-options.js)
// → { generation_id, status: 'queued', remaining, queue_position? } when the
//   Higgsfield job is still running at the budget, or still waiting for a
//   slot after a few seconds (queue_position is then its place in line);
//   GET /preview-status/<id> then finishes it (lib/queued-preview.js)
// 429 → { error: 'rate-limited', login_required, remaining: 0 }
// 422 → { error: 'face-not-clear', reason, tip } when the face is covered,
//   turned away, blurred, dark, too small, one of several or missing
//   (lib/face-check.js); tip says what is wrong in the page's language. That
//   costs no generation
//
// A free fix of a cover the parent reported (preview page, once per cover).
// It counts as a generation like a preview, and is made at high quality.
// Everything but the problem comes from that cover's record
// (lib/preview-record.js), not from the browser:
//   { fix_of: generation_id, fix_reasons: [id], fix_note?, fix_name?, fix_rating?,
//     fix_id?, locale?, customer_id?, token_date?, customer_token? }
// fix_reasons holds ids from fix_options. Small corrections (glasses,
// headwear, hair, skin, name) are made on the finished cover; the others
// paint the cover again.
// fix_id is the id the page wants for the fixed cover (10-64 letters and
// digits), so it can recover the cover from /preview-status if the answer
// is lost.
// fix_name, with the reason 'name', is the name the cover should read.
//   → { preview_url, generation_id, status: 'ready' }
//   404 fix-unavailable (no record, e.g. an older cover), 409 fix-used,
//   429 rate-limited as above
//
// Also takes the preview page's follow-ups for the requests sheet, here
// rather than in their own function since Vercel's Hobby plan caps a
// deployment at 12:
//   { action: 'occasion', generation_id, occasion }            → 204
//   { action: 'details', generation_id, details }              → 204
//   { action: 'cart', generation_id, occasion?, details?,
//     variant }                                                → 204
//   { action: 'problem', generation_id, reason, note? }        → 204
//   { action: 'rating', generation_id, rating }                → 204
//
// Flow:
//   1. Verify origin + the one-time preview pass from /upload-url (else a
//      Turnstile token).
//   2. Resolve cover + prompt SERVER-SIDE from Shopify by theme_id (anti-tamper),
//      crop the photo to the face (lib/child-photo.js), refuse a covered face
//      (lib/face-check.js), then charge the allowance (lib/ratelimit.js
//      chargeGeneration: 4 a day per IP, 2 more once signed in).
//   3. Generate ([cover, child] + prompt) via lib/generate.js, which tries an
//      ordered chain of models until one returns a cover.
//   4. Re-encode the cover as a JPEG (lib/cover-image.js) and persist it to R2
//      (provider URLs are temporary), named
//      previews/<name>_<age>_<language>_<book>_<id>.<ext> (lib/object-names.js),
//      then record it (lib/preview-finish.js).
//   5. Return the permanent R2 url, or 'queued' as above.
// The photo, then the cover or the error, also go to Discord's #previews
// channel (lib/preview-feed.js), and the answers, prompt and outcome to the
// requests sheet's Book previews tab (lib/sheet.js).

import { applyCors, isOriginAllowed } from '../lib/cors.js';
import { verifyTurnstile } from '../lib/turnstile.js';
import { redeemPreviewPass } from '../lib/preview-pass.js';
import { getRedis } from '../lib/redis.js';
import { chargeGeneration, checkRateLimit, clientIp } from '../lib/ratelimit.js';
import { r2Configured } from '../lib/r2.js';
import { resolveBook, shopifyConfigured } from '../lib/shopify.js';
import { abandonPendingCover, generateCover, generationConfigured } from '../lib/generate.js';
import {
  FixReason, MAX_FIX_NOTE_CHARS, MAX_PROMPT_CHARS, buildPreviewPrompt, isTouchUp, knownReasons, touchUpPrompt,
  withFaceDescription, withFix, withPhotoTraits
} from '../lib/prompt.js';
import { faceTooSmall, prepareChildPhoto } from '../lib/child-photo.js';
import { NO_TRAITS, checkFace, faceCheckError, reviewCover } from '../lib/face-check.js';
import { pickedNotes } from '../lib/fix-options.js';
import { resolveBookLanguage } from '../lib/book-languages.js';
import { verifyCustomerToken } from '../lib/customer-token.js';
import { tagCustomerPreviewLimit } from '../lib/customer-tag.js';
import { newGenerationId } from '../lib/object-names.js';
import { withReporting } from '../lib/report.js';
import { visitorOf } from '../lib/discord.js';
import { announcePreview, postPreviewDetails, postPreviewRating, postShareClick } from '../lib/preview-feed.js';
import { appendRows, previewFollowUp, problemText, shareRow, TABS, updateRow } from '../lib/sheet.js';
import { claimDetailsPost, claimFix, claimRatingPost, claimSharePost, readPreviewRecord, releaseFix } from '../lib/preview-record.js';
import { failPreview, feedPreview, finishPreview } from '../lib/preview-finish.js';
import { queuePreview } from '../lib/queued-preview.js';
import { attemptLabel } from '../lib/provider-order.js';
import { countPreview } from '../lib/visitor-counts.js';
import { countEvent } from '../lib/event-stats.js';
import { Step, lastStep, logGenerationStep, logStep } from '../lib/visitor-log.js';
import { waitUntil } from '@vercel/functions';

// vercel.json gives this function 90s. Generation must finish within 75s of
// the request arriving (a 2.6 cover takes 35-38s after ~5s of photo work, so
// OpenAI keeps its turn even when slow), leaving time to copy the cover to
// R2 and respond before the storefront stops waiting (90s).
const GENERATION_BUDGET_MS = 75000;
// The most problems one fix can name.
const MAX_FIX_REASONS = 8;
// Room kept for the corrections when the photo rules join a short prompt.
const FIX_ROOM_CHARS = 700;

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
  if (body.action === 'cart') waitUntil(postDetails(req, value));
  if (body.action === 'share') waitUntil(recordShare(req, value));
  if (body.action === 'rating') waitUntil(postRating(req, value.generationId, value.fields.Rating));
  if (body.action === 'rating') waitUntil(logGenerationStep(getRedis(), value.generationId, { kind: Step.rating, text: value.fields.Rating + '/5' }));
  if (body.action === 'share') waitUntil(logGenerationStep(getRedis(), value.generationId, { kind: Step.share, text: value.via }));
}

// The rating card in #previews: only for a cover this backend made, once per
// rating per generation.
async function postRating(req, generationId, rating) {
  try {
    const redis = getRedis();
    const record = await readPreviewRecord(redis, generationId);
    if (!record || !(await claimRatingPost(redis, generationId, rating))) return;
    await postPreviewRating(req, record, { generationId, rating });
  } catch (e) {
    console.warn('[preview] rating card not posted:', (e && e.message) || e);
  }
}

// A share button press: counted, a Shares row, and a #previews card once per
// button per generation (only for a cover this backend made).
async function recordShare(req, value) {
  try {
    const redis = getRedis();
    const record = await readPreviewRecord(redis, value.generationId);
    await Promise.all([
      countEvent(redis, 'share_clicked'),
      appendRows(TABS.shares, [shareRow({
        Event: 'Share clicked', Via: value.via, Child: (record && record.childName) || '', Book: (record && record.bookTitle) || '', Generation: value.generationId
      }, visitorOf(req))])
    ]);
    if (record && (await claimSharePost(redis, value.generationId, value.via))) await postShareClick(req, record, value);
  } catch (e) {
    console.warn('[preview] share not recorded:', (e && e.message) || e);
  }
}

// The add-to-cart card in #previews, with the occasion and extra details:
// only for a cover this backend made, and only once per generation.
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
  if (body.fix_of !== undefined) return fixPreview(req, res, body, startedAt);

  const themeId = String(body.theme_id || '').trim();
  const photoKey = String(body.photo_key || '').trim();
  const generationId = String(body.generation_id || '').trim();
  const language = resolveBookLanguage(body.language);
  const childName = String(body.child_name || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 40);
  const ageNum = parseInt(body.age, 10);
  const ageText = Number.isFinite(ageNum) && ageNum >= 0 && ageNum <= 18 ? String(ageNum) : '';
  const locale = localeOf(body);

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

  // The allowance is charged in runPreview, once the photo has passed the
  // face check, so a refused photo costs the parent nothing.
  return runPreview(req, res, {
    themeId, photoKey, generationId, childName, ageText, language, locale,
    customer: verifyCustomerToken(body), startedAt
  });
}

// The page's language ("fr", "pt-PT"), for the texts written for the parent.
function localeOf(body) {
  const locale = String(body.locale || '');
  return /^[A-Za-z]{2}(-[A-Za-z]{2})?$/.test(locale) ? locale : 'en';
}

// The 429 for a parent who has used up their generations. `login_required`
// drives which message the theme shows. A verified customer who has run out
// is our warmest lead, so they are tagged for the follow-up email; a tagging
// failure never changes the response. Their last cover goes in the request's
// report (lib/report.js), so the 429 card shows whose limit it was.
async function refuseOverLimit(req, res, customer) {
  const visitor = visitorOf(req);
  const last = await lastStep(getRedis(), visitor.id, Step.cover);
  console.info('[limit] no previews left today' + (last ? ' · last cover ' + (last.url || last.gen) : ''));
  waitUntil(logStep(getRedis(), visitor, { kind: Step.limit, text: 'no previews left today' }));
  if (customer.valid) {
    try {
      await tagCustomerPreviewLimit(customer.customerId);
    } catch (e) { /* never surfaces */ }
  }
  res.status(429).json({ error: 'rate-limited', login_required: !customer.valid, remaining: 0 });
}

// The free fix: one per cover, its photo, book, name and age read back from
// the cover's record. The claim is given back when generation fails. It
// doesn't count against the free previews: each fix needs a cover that did.
async function fixPreview(req, res, body, startedAt) {
  const fixOf = String(body.fix_of || '').trim();
  // fix_reasons is a list; fix_reason the single one older pages send.
  const asked = (Array.isArray(body.fix_reasons) ? body.fix_reasons : [body.fix_reason]).slice(0, MAX_FIX_REASONS);
  const reasons = knownReasons(asked);
  const note = String(body.fix_note || '').replace(/\s+/g, ' ').trim().slice(0, MAX_FIX_NOTE_CHARS);
  const rating = [1, 2, 3, 4, 5].includes(body.fix_rating) ? body.fix_rating : 0;
  const fixName = reasons.includes(FixReason.NAME) ? String(body.fix_name || '').replace(/\s+/g, ' ').trim().slice(0, 40) : '';
  if (!/^[A-Za-z0-9-]{1,64}$/.test(fixOf)) return res.status(400).json({ error: 'bad-generation-id' });

  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'fix-unavailable' });
  const record = await readPreviewRecord(redis, fixOf);
  const language = record && resolveBookLanguage(record.language);
  if (!record || !record.photoKey || !record.themeId || !language) {
    return res.status(404).json({ error: 'fix-unavailable' });
  }
  // The cover review's own notes are named by id; their texts stay on the record.
  const extra = pickedNotes(asked, record.notes);
  if (!reasons.length && !extra.length) return res.status(400).json({ error: 'bad-reason' });
  // A fix's own cover can't be fixed again.
  if (record.fixOf || !(await claimFix(redis, fixOf))) return res.status(409).json({ error: 'fix-used' });

  // The corrected name goes in the problem too, so the sheet and #previews show it.
  const problem = problemText(reasons, [fixName ? 'should be "' + fixName + '"' : '', note].filter(Boolean).join(' · '), extra);
  waitUntil(updateRow(TABS.previews, fixOf, { 'Reported problem': problem }));
  const fix = { of: fixOf, reasons, extra, note, problem, rating, link: record.link || '', traits: record.traits || null };
  // Small corrections are made on the finished cover; the rest paint it again.
  if (isTouchUp(fix) && /^https:\/\//.test(record.coverUrl || '')) fix.touchUpOf = record.coverUrl;
  // The page picks the fixed cover's id, so it can ask /preview-status for
  // the cover if this answer is lost; an id already in use gets a fresh one.
  const wantedId = String(body.fix_id || '');
  const fixId = /^[A-Za-z0-9]{10,64}$/.test(wantedId) && !(await readPreviewRecord(redis, wantedId))
    ? wantedId
    : newGenerationId();
  const ok = await runPreview(req, res, {
    themeId: record.themeId,
    photoKey: record.photoKey,
    generationId: fixId,
    childName: fixName || record.childName || '',
    ageText: record.age || '',
    language,
    locale: localeOf(body),
    customer: verifyCustomerToken(body),
    startedAt,
    fix
  });
  if (!ok) {
    try { await releaseFix(redis, fixOf); } catch (e) { /* the parent just can't retry */ }
  }
}

// Generates, stores and records one cover, then answers the request.
// Resolves to true when the cover is ready or queued.
async function runPreview(req, res, p) {
  const { themeId, photoKey, generationId, childName, ageText, language, locale, customer, startedAt, fix } = p;

  // 2. The cover and prompt come from the product's own metafields while the
  //    photo is cropped to the face (and shrunk if full-size). A covered or
  //    unreadable face is refused before the allowance is charged or anything
  //    is paid for; a fix keeps the photo its cover was made from, so it only
  //    takes the face description from the same look.
  const bookLoad = resolveBook(themeId);
  bookLoad.catch(() => { /* awaited below */ });
  const photo = await prepareChildPhoto(photoKey);
  const face = photo.image ? await checkFace(photo.image, { detailed: Boolean(fix), locale }) : null;
  const refused = fix ? null : faceCheckError(face, { tooSmall: faceTooSmall(photo) });
  // What the photo shows; a fix falls back on what its first cover's check read.
  const read = face && face.traits.description ? face.traits : null;
  const traits = read || (fix && fix.traits) || (face && face.traits) || NO_TRAITS;
  p.traits = { ...traits, description: '' };
  if (!refused) {
    const allowed = await chargeGeneration(req, customer);
    if (!allowed.success) {
      await refuseOverLimit(req, res, customer);
      return false;
    }
    p.remaining = allowed.remaining;
  }
  // Awaited, so this cover's later steps find whose it is.
  await logStep(getRedis(), visitorOf(req), {
    kind: fix ? Step.fix : Step.preview, text: fix ? fix.problem : themeId, generation: generationId
  });

  // Counted as generation starts, whether or not it succeeds.
  const counts = countPreview(getRedis(), req, customer.valid ? customer.customerId : null);
  waitUntil(counts);
  // The daily summary's preview funnel (lib/event-stats.js).
  waitUntil(countEvent(getRedis(), 'preview_started'));

  const feed = announcePreview(req, feedPreview(p, counts));

  let prompt = '';
  let book = null;
  try {
    if (refused) throw refused;
    book = await bookLoad;
    const childUrl = photo.url;
    const order = { language, childName, age: ageText };
    // A parent who asked for the headwear off must not get the rule that keeps it on.
    const kept = fix && fix.reasons.includes(FixReason.HEADWEAR_REMOVE) ? { ...traits, headwear: '', hairHidden: false } : traits;
    const base = buildPreviewPrompt(book.prompt, order);
    const short = withPhotoTraits(base, kept);
    const long = withPhotoTraits(withFaceDescription(buildPreviewPrompt(book.openaiPrompt || book.prompt, order), traits.description), kept);
    const ctx = { name: childName, traits };
    const touchUpOf = fix && fix.touchUpOf;
    // Sized for each provider's own prompt limit (lib/generate.js): OpenAI's
    // longer prompt with the face description, the short one with the photo
    // rules where they fit, the corrections cut to fit.
    const promptFor = (maxChars) => {
      if (touchUpOf) return touchUpPrompt(fix, ctx, { maxChars });
      const text = maxChars > MAX_PROMPT_CHARS ? long : (short.length + (fix ? FIX_ROOM_CHARS : 0) <= maxChars ? short : base);
      return fix ? withFix(text, fix, ctx, { maxChars }) : text;
    };
    prompt = promptFor(Infinity);

    // 3. Generate, falling back down the model chain on failure. Only the
    //    product page polls for a queued cover, and only with Redis to hold it.
    const generated = await generateCover(touchUpOf || book.coverUrl, childUrl, promptFor, {
      coverAspect: book.coverAspect,
      deadline: startedAt + GENERATION_BUDGET_MS,
      keepPending: !fix && Boolean(getRedis())
    });

    // 4. Persist and record it, with the prompt the cover was made from.
    //    A first cover is also compared with the photo while it is stored,
    //    which fills the page's fix buttons.
    prompt = generated.prompt;
    const review = fix ? null : reviewCover(photo.image, generated.url, { traits, locale });
    const done = await finishPreview(req, p, { book, generated, prompt, feed, review });
    res.status(200).json({
      preview_url: done.url,
      generation_id: generationId,
      status: 'ready',
      fix_options: done.fixOptions,
      // The tighter of the two windows - that's the number that will actually
      // stop them. null when rate limiting is disabled (theme hides the counter).
      remaining: p.remaining
    });
    return true;
  } catch (err) {
    if (err && err.pending) {
      // The prompt is stored once, beside the job, not inside it.
      const { prompt: sent, ...pending } = err.pending;
      prompt = sent || prompt;
      const place = await queueCover(req, p, { book, prompt, feed, counts, pending });
      if (place) {
        res.status(200).json({ generation_id: generationId, status: 'queued', remaining: p.remaining, ...place });
        return true;
      }
      err = new Error('higgsfield-timeout');
    }
    const code = (err && err.message) || 'preview-failed';
    // Log the real error to the server (vercel dev terminal) for diagnosis.
    console.error('[preview] failed:', err && err.stack ? err.stack : err);
    // A stopped photo says why ("face-not-clear: covered"), so #previews and
    // the sheet show what the parent was told.
    const detail = String((err && err.message) || err) + (err && err.reason ? ': ' + err.reason : '');
    failPreview(req, p, { error: detail, prompt, feed });
    if (code === 'face-not-clear') {
      res.status(422).json({ error: code, status: 'failed', reason: err.reason, tip: err.tip || '', remaining: p.remaining });
    } else if (code === 'product-not-found' || code === 'prompt-missing' || code === 'cover-missing') {
      res.status(422).json({ error: code, status: 'failed', detail });
    } else {
      res.status(502).json({ error: 'generation-failed', status: 'failed', detail });
    }
    return false;
  }
}

// Leaves a cover whose job is still running for /preview-status to finish.
// Resolves { queue_position? }, or null when it can't be stored: the job is
// then cancelled if still queued, and the preview fails as a timeout.
async function queueCover(req, p, { book, prompt, feed, counts, pending }) {
  try {
    const [link, n] = await Promise.all([feed.link, counts]);
    const place = await queuePreview(getRedis(), req, p, { book, prompt, link, counts: n, pending });
    console.info('[preview] queued: ' + attemptLabel(pending.attempt) + (pending.queued ? ' waiting for a slot' : ' still running at the deadline'));
    return place;
  } catch (e) {
    console.warn('[preview] could not queue the cover:', (e && e.message) || e);
    await abandonPendingCover(pending);
    return null;
  }
}
