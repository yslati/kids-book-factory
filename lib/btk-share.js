// /btk share (lib/btk-bot.js): a share link for a cover made outside the
// storefront. The image posted in Discord is stored in R2 like a preview
// cover (lib/cover-image.js, previews/<name>_..._<id>.jpg), then gets the
// same short link a storefront cover gets (lib/share-store.js), opening the
// book's preview page with that cover.

import { coverForStorage } from './cover-image.js';
import { newGenerationId, previewKey } from './object-names.js';
import { publicUrl, putObject } from './r2.js';
import { TEAM_PARAM, mintPreviewLink } from './share-store.js';

const MAX_BYTES = 10 * 1024 * 1024;
const FETCH_MS = 8000;
const IMAGE_TYPES = /^image\/(jpeg|png|webp)$/;
// Discord serves attachments from its own CDN only.
const DISCORD_CDN = /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\//;

// What is wrong with a Discord attachment for a cover, or ''.
export function attachmentProblem(attachment) {
  if (!attachment || !DISCORD_CDN.test(attachment.url || '')) return 'Attach the cover image.';
  if (!IMAGE_TYPES.test(attachment.content_type || '')) return 'The cover must be a JPEG, PNG or WebP image.';
  if (!(attachment.size > 0) || attachment.size > MAX_BYTES) return 'The image must be under 10 MB.';
  return '';
}

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_MS) });
  if (!res.ok) throw new Error('image download ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('image too large');
  return { buf, contentType: res.headers.get('content-type') || '' };
}

// Stores the cover and mints its link. cover is { attachment, childName,
// handle, bookTitle, age, language: { code } }. Resolves { coverUrl,
// shareUrl, teamUrl }; shareUrl is '' when sharing is off or Upstash failed.
export async function shareCover(redis, cover, { fetchImage = download, put = putObject } = {}) {
  const { buf, contentType } = await fetchImage(cover.attachment.url);
  const stored = await coverForStorage(buf, contentType || cover.attachment.content_type);
  const id = newGenerationId();
  const key = previewKey({
    childName: cover.childName, age: cover.age, language: cover.language.code,
    bookTitle: cover.bookTitle, themeId: cover.handle, id, ext: stored.ext
  });
  await put(key, stored.body, stored.contentType);
  const coverUrl = publicUrl(key);
  const teamUrl = await mintPreviewLink(redis, {
    generationId: id, themeId: cover.handle, bookTitle: cover.bookTitle,
    childName: cover.childName, age: cover.age, language: cover.language.code, coverUrl
  });
  const shareUrl = teamUrl.replace(new RegExp('[?&]' + TEAM_PARAM + '=1$'), '');
  return { coverUrl, shareUrl, teamUrl };
}
