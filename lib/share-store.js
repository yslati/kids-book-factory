// Short share links in Upstash, kept 30 days like the covers they point at:
//   kbf:share:<id>                → { url, childName, coverUrl }
//   kbf:share-url:<sha256(url)>   → <id>
//   kbf:share-gen:<generation>    → { id, cover }: the link minted with the cover
//   kbf:share-bound:<generation>  set once a preview page has taken that link
//
// Each product-page cover gets its link as soon as it is ready, so #previews
// and the requests sheet can show it. Until the preview page asks for a link
// (api/share.js), it opens a page URL built here; the page's first request
// swaps in its own URL, so the parent shares the same link the feed shows.
// The feed's copy carries ?team=1, so the team opening it isn't counted.

import { createHash } from 'node:crypto';
import { isShareSlug, newShareSlug, parseShareTarget, previewPageUrl, SHARE_TTL_SECONDS } from './share-link.js';
import { storeOrigin } from './store-links.js';

// Marks a link opened by the team: api/share.js redirects it uncounted.
export const TEAM_PARAM = 'team';

export function shareBase() {
  return (process.env.SHARE_BASE_URL || '').replace(/\/+$/, '');
}

export function linkKey(id) {
  return 'kbf:share:' + id;
}

export function urlKey(url) {
  return 'kbf:share-url:' + createHash('sha256').update(url).digest('hex').slice(0, 32);
}

function genKey(generationId) {
  return 'kbf:share-gen:' + generationId;
}

function boundKey(generationId) {
  return 'kbf:share-bound:' + generationId;
}

function linkRow(target) {
  return JSON.stringify({ url: target.url, childName: target.childName, coverUrl: target.coverUrl, generationId: target.generationId || '' });
}

// Upstash may hand back an already-parsed object or a JSON string.
export function parseRow(row) {
  return typeof row === 'string' ? JSON.parse(row) : row;
}

// Stores target under a fresh slug and resolves it. Throws when Upstash fails.
export async function storeNewLink(redis, target) {
  // A clash is a one-in-a-billion event for the same name; retry rather than overwrite.
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = newShareSlug(target.childName);
    if (await redis.set(linkKey(candidate), linkRow(target), { nx: true, ex: SHARE_TTL_SECONDS })) return candidate;
  }
  throw new Error('no free share id after 3 attempts');
}

// Mints the share link of a cover that is ready. cover is { generationId,
// themeId, bookTitle, childName, age, language, coverUrl, photoKey }.
// Resolves the team's copy of the short URL, or '' while sharing is off or
// Upstash fails: a paid cover never fails over its link.
export async function mintPreviewLink(redis, cover) {
  const base = shareBase();
  const origin = storeOrigin();
  if (!base || !origin || !redis) return '';
  try {
    const target = parseShareTarget(previewPageUrl(origin, cover), {
      allowedOrigins: [origin],
      coverBase: process.env.R2_PUBLIC_BASE_URL || ''
    });
    if (!target) return '';
    const id = await storeNewLink(redis, target);
    await redis.set(genKey(cover.generationId), JSON.stringify({ id, cover: cover.coverUrl }), { ex: SHARE_TTL_SECONDS });
    return base + '/' + id + '?' + TEAM_PARAM + '=1';
  } catch (e) {
    console.warn('[share] link not minted:', (e && e.message) || e);
    return '';
  }
}

// The minted link of the cover a preview page asks a link for, now opening
// the page's own URL. Only the first request for a cover takes it, and only
// with that cover's URL, so a shared link's recipient can't repoint it.
// Resolves the id, or null when there is none to take.
export async function claimPreviewLink(redis, target) {
  if (!target.generationId) return null;
  const minted = parseRow(await redis.get(genKey(target.generationId)));
  if (!minted || !isShareSlug(minted.id) || !minted.cover || minted.cover !== target.previewUrl) return null;
  if (!(await redis.set(boundKey(target.generationId), 1, { nx: true, ex: SHARE_TTL_SECONDS }))) return null;
  await redis.set(linkKey(minted.id), linkRow(target), { ex: SHARE_TTL_SECONDS });
  return minted.id;
}
