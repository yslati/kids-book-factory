// What happens once a product-page cover has been generated, or has failed:
// the R2 copy, the account history, the preview record, the #previews
// follow-up, the requests sheet row and the funnel count. api/preview.js runs
// it for a cover made within its budget; api/preview-status/[id].js for one
// that was still queued or running then (lib/queued-preview.js).
//
// p is the preview: { themeId, photoKey, generationId, childName, ageText,
// language: { code, name }, customer: { valid, customerId }, startedAt, fix? },
// where fix is { of, reason, note, rating, link } for a free fix. req only
// needs the headers lib/discord.js visitorOf reads.

import { waitUntil } from '@vercel/functions';
import { getRedis } from './redis.js';
import { publicUrl, putObject } from './r2.js';
import { coverForStorage } from './cover-image.js';
import { previewKey } from './object-names.js';
import { savePreviews } from './user-previews.js';
import { savePreviewRecord } from './preview-record.js';
import { appendRows, previewRow, problemText, TABS, updateRow } from './sheet.js';
import { countEvent } from './event-stats.js';

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
    fix: p.fix ? { of: p.fix.of, problem: problemText(p.fix.reason, p.fix.note), rating: p.fix.rating, link: p.fix.link } : null
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

// Copies the cover to R2 and records it. book is { title }, generated
// { url, attempt }, feed what announcePreview or resumePreviewFeed returned.
// Resolves the cover's permanent URL, or the provider's temporary one when
// the copy failed.
export async function finishPreview(req, p, { book, generated, prompt, feed }) {
  const { themeId, generationId, childName, ageText, language, customer, fix } = p;
  const generatedUrl = generated.url;

  // Persist the generated cover to R2 (permanent).
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

  // The extra details card and the free fix read this; a Redis problem must
  // never fail a paid cover.
  waitUntil(Promise.resolve(feed.link)
    .then((link) => savePreviewRecord(getRedis(), generationId, {
      childName, age: ageText, bookTitle: book.title || '', coverUrl: previewUrl, link: link || '',
      themeId, photoKey: p.photoKey, language: language.code, fixOf: fix ? fix.of : ''
    }))
    .catch((e) => console.warn('[preview] record not saved:', (e && e.message) || e)));
  feed.done({ coverUrl: previewUrl, bookTitle: book.title, attempt: generated.attempt, temporary: previewUrl === generatedUrl });
  // The first cover's row points at its fix.
  if (fix) waitUntil(updateRow(TABS.previews, fix.of, { 'Fixed cover': previewUrl }));
  recordRow(req, p, { coverUrl: previewUrl, bookTitle: book.title, attempt: generated.attempt, prompt });
  waitUntil(countEvent(getRedis(), 'preview_ready', themeId));
  return previewUrl;
}

// Records a cover that failed: error is the reason shown in #previews and
// the sheet.
export function failPreview(req, p, { error, prompt, feed }) {
  feed.done({ error });
  recordRow(req, p, { error, prompt });
  waitUntil(countEvent(getRedis(), 'preview_failed'));
}
