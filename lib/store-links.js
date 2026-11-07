// Storefront links for Discord posts: a page's path as [Book title](url), with
// titles read from Shopify by product handle.

import { allowedOrigins } from './cors.js';
import { clip, code, plain } from './discord.js';
import { adminGraphQL, shopifyConfigured } from './shopify.js';

const TITLES_TTL_MS = 60 * 60 * 1000;
const TITLES_RETRY_MS = 5 * 60 * 1000;

let titles = new Map();
let titlesAt = 0;
let titlesRequest = null;

// The storefront's public origin, for posts whose request has no usable Origin.
export function storeOrigin() {
  return process.env.STORE_URL || allowedOrigins().find((o) => o.indexOf('https://') === 0) || '';
}

// Product titles by handle, read once an hour per instance. Never throws: a
// failed read keeps the last titles and retries after a few minutes.
export function bookTitles() {
  if (Date.now() - titlesAt < TITLES_TTL_MS || !shopifyConfigured()) return Promise.resolve(titles);
  if (!titlesRequest) {
    titlesRequest = adminGraphQL('{ products(first: 250) { nodes { handle title } } }')
      .then((data) => {
        // "The Dragon Rider: Personalized Dragon Book for Boys" → "The Dragon Rider"
        titles = new Map(data.products.nodes.map((p) => [p.handle, p.title.split(': ')[0]]));
        titlesAt = Date.now();
      })
      .catch((e) => {
        console.error('[store-links] book titles failed:', (e && e.message) || e);
        titlesAt = Date.now() - TITLES_TTL_MS + TITLES_RETRY_MS;
      })
      .then(() => {
        titlesRequest = null;
        return titles;
      });
  }
  return titlesRequest;
}

// The titles read so far, without waiting on Shopify; for posts that must not.
export function knownBookTitles() {
  return titles;
}

// For tests: the titles bookTitles() returns until the hour is up.
export function setBookTitles(map) {
  titles = map;
  titlesAt = Date.now();
}

// "/fr/products/the-dragon-rider" as [The Dragon Rider · fr](origin + path)
// and "/" as [Home]; other pages, and books without a known title, show
// `label` or the path.
// Plain code when the origin or path could break the link, or the path hides
// a token as ":id".
export function pageLink(path, bookTitlesByHandle, { origin = storeOrigin(), label = '', max = 80 } = {}) {
  const p = String(path || '');
  if (!/^https?:\/\/[^\s/()[\]<>]+$/.test(origin) || !/^\/[^\s()[\]<>:]*$/.test(p)) return code(label || p, max);
  const product = p.match(/^(?:\/([a-z]{2}(?:-[a-z]{2})?))?\/products\/([^/]+)\/?$/i);
  const home = p.match(/^(?:\/([a-z]{2}(?:-[a-z]{2})?))?\/?$/i);
  const title = home ? 'Home' : product && bookTitlesByHandle.get(product[2]);
  const locale = home ? home[1] : product && product[1];
  const text = title ? plain(title) + (locale ? ' · ' + locale : '') : plain(label || p);
  return '[' + clip(text || p, max) + '](' + origin + p + ')';
}

// A book's product page as a link, from its handle.
export function bookLink(handle, bookTitlesByHandle, options = {}) {
  if (!/^[\w-]+$/.test(String(handle || ''))) return code(handle, 80);
  return pageLink('/products/' + handle, bookTitlesByHandle, { label: handle, ...options });
}

// An order in Shopify admin: its page by id, or a search for its name ("#btk-1009").
export function orderLink(orderId) {
  const shop = process.env.SHOPIFY_SHOP || '';
  const id = String(orderId || '');
  if (!/^[\w-]+\.myshopify\.com$/.test(shop) || !/^#?[\w-]+$/.test(id)) return code(id, 40);
  const path = /^\d+$/.test(id) ? '/admin/orders/' + id : '/admin/orders?query=' + encodeURIComponent(id);
  return '[' + id + '](https://' + shop + path + ')';
}
