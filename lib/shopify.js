// Reads a book product's cover image + AI prompt from Shopify, server-side, by
// product handle (== theme_id). This is the anti-tamper boundary: the browser
// never supplies the prompt or cover - we resolve them here from the product's
// own metafields, so a new product "just works" with zero backend changes.
//
// Metafields expected (namespace `book`, see theme docs/04-shopify-setup.md):
//   book.cover_preview_prompt  (multi-line text)
//   book.cover_template_url    (file reference)  -- optional; falls back to featured image
//   book.art_style_lock        (multi-line text) -- optional; appended to the prompt

import { DEFAULT_PREVIEW_PROMPT } from './prompt.js';

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';

let cachedAccessToken = '';
let accessTokenExpiresAt = 0;
let accessTokenRequest = null;

// Image models bill by input size, so we shrink the cover via Shopify's CDN.
// We set WIDTH ONLY: a single dimension always scales preserving aspect ratio
// (never crops). Setting both width+height risks a center-crop of portrait covers,
// since Shopify's crop default is `center`. Only Shopify-hosted URLs support this;
// any other URL passes through unchanged.
function capCoverWidth(url, maxWidth) {
  try {
    const u = new URL(url);
    if (u.hostname.indexOf('shopify') === -1) return url;
    u.searchParams.set('width', String(maxWidth));
    return u.toString();
  } catch (e) {
    return url;
  }
}

function shopDomain() {
  return process.env.SHOPIFY_SHOP;
}

export function shopifyConfigured() {
  const hasClientCredentials = Boolean(
    process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET
  );
  return Boolean(
    process.env.SHOPIFY_SHOP &&
      (hasClientCredentials || process.env.SHOPIFY_ADMIN_TOKEN)
  );
}

async function requestAccessToken() {
  const res = await fetch(
    `https://${shopDomain()}/admin/oauth/access_token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.SHOPIFY_CLIENT_ID,
        client_secret: process.env.SHOPIFY_CLIENT_SECRET
      })
    }
  );
  if (!res.ok) throw new Error('shopify-auth-' + res.status);

  const json = await res.json();
  if (!json.access_token) throw new Error('shopify-auth-token-missing');

  cachedAccessToken = json.access_token;
  // Refresh one minute early so it cannot expire during an API request.
  accessTokenExpiresAt = Date.now() + (Number(json.expires_in || 86400) - 60) * 1000;
  return cachedAccessToken;
}

async function adminAccessToken() {
  if (process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET) {
    if (cachedAccessToken && Date.now() < accessTokenExpiresAt) {
      return cachedAccessToken;
    }
    if (!accessTokenRequest) {
      accessTokenRequest = requestAccessToken().finally(() => {
        accessTokenRequest = null;
      });
    }
    return accessTokenRequest;
  }

  // Backwards compatibility for existing admin-created custom apps.
  return process.env.SHOPIFY_ADMIN_TOKEN;
}

// Exported so sibling modules (lib/customer-tag.js) reuse this cached-token
// auth instead of re-implementing the client-credentials dance.
export async function adminGraphQL(query, variables) {
  const accessToken = await adminAccessToken();
  const res = await fetch(
    `https://${shopDomain()}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken
      },
      body: JSON.stringify({ query, variables })
    }
  );
  if (!res.ok) throw new Error('shopify-admin-' + res.status);
  const json = await res.json();
  if (json.errors) throw new Error('shopify-graphql-error');
  return json.data;
}

// Resolve { title, coverUrl, coverAspect, prompt } for a product handle. Throws if the book has no
// preview prompt configured (we refuse to guess a prompt client-side).
export async function resolveBook(themeId) {
  const query = `
    query BookByHandle($handle: String!) {
      productByHandle(handle: $handle) {
        id
        title
        featuredImage { url width height }
        promptMf: metafield(namespace: "book", key: "cover_preview_prompt") { value }
        coverMf: metafield(namespace: "book", key: "cover_template_url") { value reference { ... on MediaImage { image { url width height } } } }
        styleMf: metafield(namespace: "book", key: "art_style_lock") { value }
      }
    }`;

  const data = await adminGraphQL(query, { handle: themeId });
  const p = data && data.productByHandle;
  if (!p) throw new Error('product-not-found');

  let coverUrl = '';
  let coverImage = null; // Shopify image, when we have one, for its dimensions
  if (p.coverMf && p.coverMf.reference && p.coverMf.reference.image) {
    coverImage = p.coverMf.reference.image;
    coverUrl = coverImage.url;
  } else if (p.coverMf && p.coverMf.value && /^https?:\/\//.test(p.coverMf.value)) {
    coverUrl = p.coverMf.value;
  } else if (p.featuredImage && p.featuredImage.url) {
    coverImage = p.featuredImage;
    coverUrl = coverImage.url;
  }
  if (!coverUrl) throw new Error('cover-missing');
  coverUrl = capCoverWidth(coverUrl, 1024);

  // Width / height, for providers that need an explicit output aspect ratio.
  // null for a raw URL metafield, whose size we don't know.
  const coverAspect = coverImage && coverImage.width > 0 && coverImage.height > 0
    ? coverImage.width / coverImage.height
    : null;

  // Per-book metafield overrides; otherwise use the sensible default so a
  // product with no prompt still generates.
  let prompt = (p.promptMf && p.promptMf.value ? p.promptMf.value : '').trim();
  if (!prompt) prompt = DEFAULT_PREVIEW_PROMPT;

  const style = (p.styleMf && p.styleMf.value ? p.styleMf.value : '').trim();
  if (style) prompt += '\n\nArt style: ' + style;

  return { title: p.title, coverUrl, coverAspect, prompt };
}
