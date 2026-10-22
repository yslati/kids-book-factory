// Short links for shared cover previews: s.booktokids.com/emma-x7k2pq.
//
// The theme's share card builds a self-contained preview URL
// (/pages/create-your-book?b=<book>&s=<base64url JSON>, see kb-my-book.js) and
// api/share.js stores it under a short id. Dependency-free and pure, so the
// part that handles untrusted input is testable on its own.

import { randomInt } from 'node:crypto';
import { slugPart } from './object-names.js';

export const SHARE_TTL_DAYS = 30;
export const SHARE_TTL_SECONDS = SHARE_TTL_DAYS * 24 * 60 * 60;

const SITE_NAME = 'Book to Kids';
const DESCRIPTION = "Look who's the hero of their own book!";
const MAX_URL_LENGTH = 2000;
// Optional market prefix (/fr, /en-gb) before the preview page.
const PAGE_PATH = /^(\/[a-z]{2}(-[a-z]{2})?)?\/pages\/create-your-book\/?$/i;
const PAYLOAD = /^[A-Za-z0-9_-]{1,1800}$/;
// No look-alikes (0/o, 1/l/i), so a link read aloud or retyped still works.
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 40;

function clip(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function decodePayload(text) {
  try {
    const obj = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch (e) {
    return null;
  }
}

// Validates a URL posted for shortening and returns what the link stores, or
// null. Only the storefront's own preview page is accepted, so the service
// can never be used as an open redirect, and only the b= and s= parameters
// survive. The cover becomes the link's preview image only when it lives in
// our own bucket.
export function parseShareTarget(raw, { allowedOrigins = [], coverBase = '' } = {}) {
  const text = String(raw || '');
  if (!text || text.length > MAX_URL_LENGTH) return null;

  let url;
  try { url = new URL(text); } catch (e) { return null; }
  if (allowedOrigins.indexOf(url.origin) === -1) return null;
  if (!PAGE_PATH.test(url.pathname)) return null;

  const s = url.searchParams.get('s') || '';
  if (!PAYLOAD.test(s)) return null;
  const payload = decodePayload(s);
  if (!payload) return null;

  const clean = new URL(url.origin + url.pathname);
  const book = clip(url.searchParams.get('b'), 120);
  if (book) clean.searchParams.set('b', book);
  clean.searchParams.set('s', s);

  const cover = clip(payload.u, 500);
  const base = String(coverBase || '').replace(/\/+$/, '');
  const ownCover = base && /^https:\/\//i.test(base) && cover.indexOf(base + '/previews/') === 0;

  return {
    url: clean.toString(),
    childName: clip(payload.n, 40),
    coverUrl: ownCover ? cover : ''
  };
}

function randomCode(length) {
  let code = '';
  for (let i = 0; i < length; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

// "emma-x7k2pq". A name with no Latin letters gets a longer bare code instead.
export function newShareSlug(childName) {
  const name = slugPart(childName, 16, '');
  return name ? name + '-' + randomCode(6) : randomCode(8);
}

export function isShareSlug(value) {
  return typeof value === 'string' && value.length <= MAX_SLUG_LENGTH && SLUG_PATTERN.test(value);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function shareTitle(childName) {
  return childName ? childName + "'s personalised book" : 'A personalised book';
}

const PAGE_STYLE =
  'body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fff8ef;color:#2b2118;' +
  'font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center}' +
  'main{max-width:28rem;padding:2rem 1rem}h1{font-size:1.5rem;margin:0 0 .5rem}p{margin:0 0 1.5rem}' +
  'a{display:inline-block;padding:.75rem 1.5rem;border-radius:999px;background:#2b2118;color:#fff;text-decoration:none}';

function page({ title, head = '', body, status }) {
  return {
    status,
    html:
      '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<meta name="robots" content="noindex">' +
      '<title>' + escapeHtml(title) + '</title>' + head +
      '<style>' + PAGE_STYLE + '</style></head><body><main>' + body + '</main></body></html>'
  };
}

// What link-preview bots (WhatsApp, Facebook, iMessage...) read: the child's
// cover and name as the card. A person whose browser is mistaken for a bot is
// still sent on by the script, or the button.
export function renderSharePage({ shortUrl, target, childName, coverUrl }) {
  const title = shareTitle(childName);
  const meta = [
    ['og:type', 'website'],
    ['og:site_name', SITE_NAME],
    ['og:title', title],
    ['og:description', DESCRIPTION],
    ['og:url', shortUrl]
  ];
  if (coverUrl) meta.push(['og:image', coverUrl], ['og:image:alt', title]);
  const head =
    meta.map(([property, content]) =>
      '<meta property="' + property + '" content="' + escapeHtml(content) + '">').join('') +
    '<meta name="twitter:card" content="' + (coverUrl ? 'summary_large_image' : 'summary') + '">' +
    '<meta name="description" content="' + escapeHtml(DESCRIPTION) + '">';
  return page({
    status: 200,
    title: title + ' · ' + SITE_NAME,
    head,
    body:
      '<h1>' + escapeHtml(title) + '</h1><p>' + escapeHtml(DESCRIPTION) + '</p>' +
      '<a id="go" href="' + escapeHtml(target) + '">Open the preview</a>' +
      '<script>location.replace(document.getElementById("go").href)</script>'
  });
}

export function renderExpiredPage({ storeUrl, status = 410 }) {
  return page({
    status,
    title: 'This preview has expired · ' + SITE_NAME,
    body:
      '<h1>This preview has expired</h1>' +
      '<p>Book previews are kept for ' + SHARE_TTL_DAYS + ' days. Making a new one takes a minute.</p>' +
      '<a href="' + escapeHtml(storeUrl || '/') + '">Make a new preview</a>'
  });
}
