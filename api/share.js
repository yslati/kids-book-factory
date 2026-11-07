// Short links for shared cover previews, served on SHARE_BASE_URL
// (s.booktokids.com, routed here by vercel.json).
//
// POST /            Body: { url } → { id, short_url }
//   url is the preview page URL the theme's share card builds (kb-my-book.js).
//   The same URL always gets the same link back while it lives.
// GET  /<id>        → 302 to the stored preview page, tagged utm_source=share
//   so the visit counts as one from a share. Link-preview bots get a small
//   page with the child's cover and name as OG tags instead, which the
//   storefront itself cannot render per preview. Each open is counted, added
//   to the sheet's Shares tab and, for a link's first few, posted to #previews.
// GET  /            → 302 to the store.
//
// Links live 30 days in Upstash, like the covers they point at:
//   kbf:share:<id>              → { url, childName, coverUrl }
//   kbf:share-url:<sha256(url)> → <id>

import { createHash } from 'node:crypto';
import { isbot } from 'isbot';
import { waitUntil } from '@vercel/functions';
import { allowedOrigins, applyCors, isOriginAllowed } from '../lib/cors.js';
import { visitorOf } from '../lib/discord.js';
import { countEvent } from '../lib/event-stats.js';
import { postShareOpen } from '../lib/preview-feed.js';
import { checkRateLimit } from '../lib/ratelimit.js';
import { getRedis } from '../lib/redis.js';
import { withReporting } from '../lib/report.js';
import {
  SHARE_TTL_SECONDS, isShareSlug, newShareSlug, parseShareTarget, renderExpiredPage, renderSharePage
} from '../lib/share-link.js';
import { appendRows, shareRow, TABS } from '../lib/sheet.js';
import { storeOrigin } from '../lib/store-links.js';

const SHARE_BASE = (process.env.SHARE_BASE_URL || '').replace(/\/+$/, '');
const COVER_BASE = process.env.R2_PUBLIC_BASE_URL || '';
// #previews cards per link; later opens are only counted.
const OPEN_POSTS = 5;

const reportedCreate = withReporting(create);

// Opening a link is not wrapped in withReporting: every click on an expired
// link would otherwise post a 410 to #logs.
export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method === 'POST') return reportedCreate(req, res);
  if (req.method === 'GET' || req.method === 'HEAD') return open(req, res);
  return res.status(405).json({ error: 'method-not-allowed' });
}

function storeUrl() {
  return storeOrigin() || '/';
}

function linkKey(id) {
  return 'kbf:share:' + id;
}

function opensKey(id) {
  return 'kbf:share-opens:' + id;
}

// The preview page with the tags that mark its visit as one from a share.
function sharedVisitUrl(url) {
  const u = new URL(url);
  u.searchParams.set('utm_source', 'share');
  u.searchParams.set('utm_medium', 'link');
  return u.toString();
}

// A person opening a shared link: counted, a Shares row and, for the link's
// first few opens, a #previews card. Never throws.
async function recordOpen(req, id, target) {
  try {
    const redis = getRedis();
    const opens = Number(await redis.incr(opensKey(id))) || 1;
    if (opens === 1) await redis.expire(opensKey(id), SHARE_TTL_SECONDS);
    const visitor = visitorOf(req);
    const book = new URL(target.url).searchParams.get('b') || '';
    await Promise.all([
      countEvent(redis, 'share_opened'),
      appendRows(TABS.shares, [shareRow({ Event: 'Link opened', Opens: opens, Child: target.childName, Book: book, Link: SHARE_BASE + '/' + id }, visitor)]),
      opens <= OPEN_POSTS && postShareOpen(visitor, { id, childName: target.childName, coverUrl: target.coverUrl, book }, opens)
    ]);
  } catch (e) {
    console.warn('[share] open not recorded:', (e && e.message) || e);
  }
}

function urlKey(url) {
  return 'kbf:share-url:' + createHash('sha256').update(url).digest('hex').slice(0, 32);
}

async function create(req, res) {
  if (!isOriginAllowed(req)) return res.status(403).json({ error: 'forbidden-origin' });
  const redis = getRedis();
  if (!SHARE_BASE || !redis) return res.status(503).json({ error: 'share-not-configured' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  const target = parseShareTarget(body && body.url, { allowedOrigins: allowedOrigins(), coverBase: COVER_BASE });
  if (!target) return res.status(400).json({ error: 'bad-url' });

  const rl = await checkRateLimit(req, 'share');
  if (!rl.success) return res.status(429).json({ error: 'rate-limited' });

  try {
    const byUrl = urlKey(target.url);
    let id = await redis.get(byUrl);
    if (!isShareSlug(id)) {
      id = null;
      // A clash is a one-in-a-billion event for the same name; retry rather than overwrite.
      for (let attempt = 0; attempt < 3 && !id; attempt++) {
        const candidate = newShareSlug(target.childName);
        const stored = await redis.set(linkKey(candidate), JSON.stringify(target), { nx: true, ex: SHARE_TTL_SECONDS });
        if (stored) id = candidate;
      }
      if (!id) throw new Error('no free share id after 3 attempts');
      await redis.set(byUrl, id, { ex: SHARE_TTL_SECONDS });
    }
    return res.status(200).json({ id, short_url: SHARE_BASE + '/' + id });
  } catch (e) {
    // The theme falls back to the full URL on any non-2xx.
    console.error('[share] store failed:', (e && e.message) || e);
    return res.status(503).json({ error: 'share-unavailable' });
  }
}

function sendHtml(res, { status, html }) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(status).send(html);
}

async function open(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');

  const id = String((req.query && req.query.id) || '').toLowerCase();
  if (!id) return res.redirect(302, storeUrl());
  if (!isShareSlug(id)) return sendHtml(res, renderExpiredPage({ storeUrl: storeUrl() }));

  const redis = getRedis();
  let entry = null;
  try {
    const row = redis ? await redis.get(linkKey(id)) : null;
    // Upstash may hand back an already-parsed object or a JSON string.
    entry = typeof row === 'string' ? JSON.parse(row) : row;
  } catch (e) {
    console.error('[share] lookup failed:', (e && e.message) || e);
    return sendHtml(res, renderExpiredPage({ storeUrl: storeUrl(), status: 503 }));
  }

  // Re-validated on the way out too, so a bad row can never become a redirect elsewhere.
  const target = entry && parseShareTarget(entry.url, { allowedOrigins: allowedOrigins(), coverBase: COVER_BASE });
  if (!target) return sendHtml(res, renderExpiredPage({ storeUrl: storeUrl() }));

  if (!isbot(req.headers['user-agent'] || '')) {
    waitUntil(recordOpen(req, id, target));
    return res.redirect(302, sharedVisitUrl(target.url));
  }
  // A chat app fetching the link to show its preview: the link was just sent.
  waitUntil(countEvent(redis, 'share_unfurled'));
  return sendHtml(res, renderSharePage({
    shortUrl: SHARE_BASE + '/' + id,
    target: target.url,
    childName: target.childName,
    coverUrl: target.coverUrl
  }));
}
