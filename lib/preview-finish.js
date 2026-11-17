// What happens once a product-page cover has been generated, or has failed:
// the R2 copy, the account history, the preview record, the #previews
// follow-up, the requests sheet row and the funnel count. api/preview.js runs
// it for a cover made within its budget; api/preview-status/[id].js for one
// that was still queued or running then (lib/queued-preview.js).
//
// p is the preview: { themeId, photoKey, generationId, childName, ageText,
// language: { code, name }, customer: { valid, customerId }, startedAt, traits?,
// fix? }, where traits is what the photo shows (lib/face-check.js) and fix is
// { of, reasons, extra, note, problem, rating, link } for a free fix. req only
// needs the headers lib/discord.js visitorOf reads.

import { waitUntil } from '@vercel/functions';
import { getRedis } from './redis.js';
import { publicUrl } from './r2.js';
import { flushPendingCovers, storeCover } from './cover-store.js';
import { previewKey } from './object-names.js';
import { savePreviews } from './user-previews.js';
import { savePreviewRecord } from './preview-record.js';
import { mintPreviewLink } from './share-store.js';
import { appendRows, previewRow, TABS, updateRow } from './sheet.js';
import { countEvent } from './event-stats.js';
import { fixOptions, reviewSummary } from './fix-options.js';

// What announcePreview / resumePreviewFeed (lib/preview-feed.js) are given.
export function feedPreview(p, counts) {
  return {
    photoUrl: publicUrl(p.photoKey),
    themeId: p.themeId,
    generationId: p.generationId,
    childName: p.childName,
    age: p.ageText,
    language: p.language.name,
    customerId: p.customer.valid ? p.customer.customerId : null,
    startedAt: p.startedAt,
    counts,
    fix: p.fix ? { of: p.fix.of, problem: p.fix.problem, rating: p.fix.rating, link: p.fix.link } : null
  };
}

function recordRow(req, p, outcome) {
  waitUntil(appendRows(TABS.previews, [previewRow(req, {
    book: p.themeId,
    childName: p.childName,
    age: p.ageText,
    language: p.language.name,
    photoUrl: publicUrl(p.photoKey),
    customerId: p.customer.valid ? p.customer.customerId : null,
    generationId: p.generationId,
    startedAt: p.startedAt,
    fix: p.fix
  }, outcome)]));
}

// Keeps the cover (lib/cover-store.js) and records it. book is { title },
// generated { url, attempt, cost? }, feed what announcePreview or
// resumePreviewFeed returned, review the cover review or its promise
// (lib/face-check.js reviewCover; may be null). Resolves { url, fixOptions }:
// the URL the parent, cart and order get, and the fix buttons for the
// preview page. Throws 'cover-not-stored' when nothing could keep the cover.
export async function finishPreview(req, p, { book, generated, prompt, feed, review = null }) {
  const { themeId, generationId, childName, ageText, language, customer, fix } = p;

  const redis = getRedis();
  const reviewed = Promise.resolve(review).catch(() => null);
  const kept = await storeCover(generated.url, (ext) => previewKey({
    childName: childName,
    age: ageText,
    language: language.code,
    bookTitle: book.title,
    themeId: themeId,
    id: generationId,
    ext
  }), { redis });
  const previewUrl = kept.url;
  // One more try after the response; the daily cron catches the rest.
  if (kept.stored === 'pending') waitUntil(flushPendingCovers(redis, { keys: [kept.key], waits: [3000] }).catch(() => {}));

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

  // The extra details card, the free fix and /preview-status (which hands a
  // cover to a page whose answer was lost) read this. It is written at once,
  // then again with the Discord link once that post exists, so a slow
  // Discord never delays recovering the cover. A Redis problem must never
  // fail a paid cover.
  // A fix's own cover can't be fixed again, so it gets no buttons.
  const found = await reviewed;
  const options = fix ? [] : fixOptions(p.traits, found, { childName });
  const check = reviewSummary(options);
  if (check) console.log('[preview] cover check spotted: ' + check);
  const record = {
    childName, age: ageText, bookTitle: book.title || '', coverUrl: previewUrl, link: '',
    themeId, photoKey: p.photoKey, language: language.code, fixOf: fix ? fix.of : '',
    traits: p.traits || null, notes: (found && found.notes) || [], fixOptions: options
  };
  waitUntil(savePreviewRecord(redis, generationId, record)
    .then(() => feed.link)
    .then((link) => (link ? savePreviewRecord(redis, generationId, { ...record, link }) : null))
    .catch((e) => console.warn('[preview] record not saved:', (e && e.message) || e)));
  // Before the response, so the preview page asking for its link gets this one.
  const shareUrl = await mintPreviewLink(redis, {
    generationId, themeId, bookTitle: book.title || '', childName, age: ageText,
    language: language.code, coverUrl: previewUrl, photoKey: p.photoKey
  });
  feed.done({ coverUrl: previewUrl, bookTitle: book.title, attempt: generated.attempt, cost: generated.cost, stored: kept.stored, check, shareUrl });
  // The first cover's row points at its fix.
  if (fix) waitUntil(updateRow(TABS.previews, fix.of, { 'Fixed cover': previewUrl }));
  recordRow(req, p, { coverUrl: previewUrl, bookTitle: book.title, attempt: generated.attempt, cost: generated.cost, prompt, shareUrl });
  waitUntil(countEvent(getRedis(), 'preview_ready', themeId));
  return { url: previewUrl, fixOptions: options };
}

// Records a cover that failed: error is the reason shown in #previews and
// the sheet.
export function failPreview(req, p, { error, prompt, feed }) {
  feed.done({ error });
  recordRow(req, p, { error, prompt });
  waitUntil(countEvent(getRedis(), 'preview_failed'));
}
