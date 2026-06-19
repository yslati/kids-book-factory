// Reads a book product's cover image + AI prompt from Shopify, server-side, by
// product handle (== theme_id). This is the anti-tamper boundary: the browser
// never supplies the prompt or cover — we resolve them here from the product's
// own metafields, so a new product "just works" with zero backend changes.
//
// Metafields expected (namespace `book`, see theme docs/04-shopify-setup.md):
//   book.cover_preview_prompt  (multi-line text)
//   book.cover_template_url    (file reference)  -- optional; falls back to featured image
//   book.art_style_lock        (multi-line text) -- optional; appended to the prompt

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';

// Used when a product has no `book.cover_preview_prompt` metafield of its own.
// Fill that metafield per book to override this. (Image 1 = cover, image 2 = child photo.)
const DEFAULT_PREVIEW_PROMPT =
  "You are given two images. The first is a children's book cover with a main " +
  "character. The second is a photo of a real child. Replace the cover's main " +
  "character with this child, redrawing them fully in the cover's illustration " +
  "style (not pasting the photo).\n\n" +
  "First, study the child's photo and capture their full likeness: face shape and " +
  "features, hair style and color, skin tone, and apparent age and gender. " +
  "Render the child entirely in the same art style, line work, shading, and color " +
  "palette as the cover so they look hand-drawn as part of the original artwork.\n\n" +
  "Keep the cover's art style, background, scene, composition, layout, lighting, " +
  "and mood. You MAY adapt the character's pose, hairstyle, clothing, and " +
  "accessories so they suit this child naturally — for example, change the outfit " +
  "or hair to fit the child's apparent gender and age when the original character " +
  "differs. The goal is a believable, flattering picture of THIS child as the hero " +
  "of the cover, not a forced copy of the original character. Use your best " +
  "judgement to produce the most natural result.\n\n" +
  "Keep the title and any other text in the same lettering, color, and position, " +
  "unless a name change is requested below.";

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
  return Boolean(process.env.SHOPIFY_SHOP && process.env.SHOPIFY_ADMIN_TOKEN);
}

async function adminGraphQL(query, variables) {
  const res = await fetch(
    `https://${shopDomain()}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN
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
