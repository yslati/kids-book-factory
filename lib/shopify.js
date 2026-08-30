// Reads a book product's cover image + AI prompt from Shopify, server-side, by
// product handle (== theme_id). This is the anti-tamper boundary: the browser
// never supplies the prompt or cover - we resolve them here from the product's
// own metafields, so a new product "just works" with zero backend changes.
//
// Metafields expected (namespace `book`, see theme docs/04-shopify-setup.md):
//   book.cover_preview_prompt  (multi-line text)
//   book.cover_template_url    (file reference)  -- optional; falls back to featured image
//   book.art_style_lock        (multi-line text) -- optional; appended to the prompt

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';

let cachedAccessToken = '';
let accessTokenExpiresAt = 0;
let accessTokenRequest = null;

// Used when a product has no `book.cover_preview_prompt` metafield of its own.
// Fill that metafield per book to override this. (Image 1 = cover, image 2 = child photo.)
const DEFAULT_PREVIEW_PROMPT =
  "You are editing the first image, a children's book cover. The second image is a " +
  "photo of a real child.\n\n" +
  "MAIN TASK - change the character: redraw the cover's main character so it becomes " +
  "this child. Give the character the child's face, skin tone, AND hair. Copy the " +
  "child's hair exactly - the same length, shape, style, color, and texture as in " +
  "the photo - fully replacing the original character's hairstyle (for example, if " +
  "the original has long hair but the child has short hair, the result must have " +
  "short hair). The character must clearly look like THIS child and no longer look " +
  "like the original - do not keep the original character's face OR hair. Match the " +
  "child's gender too: draw a boy if the photo is a boy, a girl if it is a girl.\n\n" +
  "Draw the new character in the cover's illustration art style - painted/illustrated " +
  "rendering, not a pasted photo - but the child's identity must clearly survive the " +
  "stylisation: anyone who knows this child should recognise them instantly. " +
  "Preserve the child's true facial geometry from the photo: face shape, eye shape " +
  "and colour, eyebrow shape, nose shape, mouth and smile, cheek structure, skin " +
  "tone, and any distinctive features (freckles, dimples, glasses, birthmarks). " +
  "Stylise ONLY the rendering technique (linework, brushstrokes, shading, colour " +
  "palette) - never the facial proportions. Aim for roughly 70% faithful to the " +
  "child's real face and 30% adapted to the art style. Do not make the face more " +
  "generic, younger, cuter, or more \"cartoon\" than the real child's face.\n\n" +
  "Keep everything else the same: the cover's art style, colors, background, scene, " +
  "composition, layout, and the character's pose. Keep the title and any other text " +
  "in the same lettering and position, unless a name change is requested below.";

// fal bills per megapixel of input + output, so we shrink the cover via Shopify's
// CDN. We set WIDTH ONLY: a single dimension always scales preserving aspect ratio
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

async function adminGraphQL(query, variables) {
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

// Resolve { coverUrl, prompt } for a product handle. Throws if the book has no
// preview prompt configured (we refuse to guess a prompt client-side).
export async function resolveBook(themeId) {
  const query = `
    query BookByHandle($handle: String!) {
      productByHandle(handle: $handle) {
        id
        title
        featuredImage { url }
        promptMf: metafield(namespace: "book", key: "cover_preview_prompt") { value }
        coverMf: metafield(namespace: "book", key: "cover_template_url") { value reference { ... on MediaImage { image { url } } } }
        styleMf: metafield(namespace: "book", key: "art_style_lock") { value }
      }
    }`;

  const data = await adminGraphQL(query, { handle: themeId });
  const p = data && data.productByHandle;
  if (!p) throw new Error('product-not-found');

  let coverUrl = '';
  if (p.coverMf && p.coverMf.reference && p.coverMf.reference.image) {
    coverUrl = p.coverMf.reference.image.url;
  } else if (p.coverMf && p.coverMf.value && /^https?:\/\//.test(p.coverMf.value)) {
    coverUrl = p.coverMf.value;
  } else if (p.featuredImage && p.featuredImage.url) {
    coverUrl = p.featuredImage.url;
  }
  if (!coverUrl) throw new Error('cover-missing');
  coverUrl = capCoverWidth(coverUrl, 1024);

  // Per-book metafield overrides; otherwise use the sensible default so a
  // product with no prompt still generates.
  let prompt = (p.promptMf && p.promptMf.value ? p.promptMf.value : '').trim();
  if (!prompt) prompt = DEFAULT_PREVIEW_PROMPT;

  const style = (p.styleMf && p.styleMf.value ? p.styleMf.value : '').trim();
  if (style) prompt += '\n\nArt style: ' + style;

  return { title: p.title, coverUrl, prompt };
}
