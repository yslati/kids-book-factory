# kids-book-factory - cover-preview backend

Vercel backend for the kids-book Shopify theme. Puts a child's face on a book's cover (via Higgsfield's image API) so the storefront can show a preview before checkout. This is the **preview slice** only - post-purchase print/PDF/Gelato is out of scope.

## Flow

```
Browser            this backend                      external
POST /api/upload-url  → Turnstile + rate-limit → presign R2 PUT → { presigned_put_url, photo_key, generation_id }
PUT photo             → Cloudflare R2
POST /api/preview     → resolve cover+prompt by theme_id (Shopify) → Higgsfield model chain (lib/generate.js) → store cover in R2
                      → { preview_url, generation_id, status: 'ready', remaining }
```

- **Image generation:** an ordered chain of Higgsfield models with fallbacks - see [Image generation](#image-generation) below.
- **Object names:** R2 keys are readable. The photo is `photos/<name>_<age>_<language>_<id>.<ext>` and the cover is `previews/<name>_<age>_<language>_<book>_<id>.<ext>`, e.g. `photos/emma_5_en_k3x9p2m7q1.jpg` and `previews/emma_5_en_the-winning-goal_k3x9p2m7q1.jpg`. `<book>` is the product title before its ": Personalized…" or " – Personalized…" suffix. `<id>` is the `generation_id`: 10 random characters shared by the photo and its cover. It stays random because the bucket is public, and those characters are what keep a photo URL unguessable. Names are slugged to plain ASCII. A missing age or language becomes `na`, and a name with no Latin letters becomes `child`. See `lib/object-names.js`.
- **Anti-tamper:** the browser never sends the prompt or cover; the backend reads them from the product's metafields by `theme_id`. New product → no backend change.
- **Book languages:** `en`, `es`, `fr`, `de`, `it`, and `pt`. The preview API rejects other values and asks the image model to translate visible cover text into the selected language.
- **Synchronous**, `maxDuration` 60s; generation must finish within 50s of the request. Generated cover persisted to R2 (provider URLs are temporary).
- Missing env vars degrade to `503 *-not-configured`; Turnstile + rate-limiting no-op until configured.

## Image generation

`lib/generate.js` holds one ordered `CHAIN` of attempts. Each runs only when the one before it failed (an error, a safety block, no credit) or ran out of time:

| # | Provider | Endpoint | Quality | Typical time | Price per cover |
| --- | --- | --- | --- | --- | --- |
| 1 (main) | Higgsfield | `marketing-studio/image/flare` (Marketing Studio 2.5 Flare) | `medium` | 17–25s | ≈ $0.02–0.04 |
| 2 | Higgsfield | `marketing-studio/image/flare` | `low` | 15–24s | ≈ $0.01–0.03 |
| 3 | Higgsfield | `marketing-studio/image` (Marketing Studio 2.0) | `low` | 17–19s | $0.057 |

- All three take the same `[cover, child]` pair at `1k`, at the supported aspect ratio nearest the cover's (`lib/higgsfield.js`). Higgsfield's prompt enhancement stays off, so the name and language rules reach the model unchanged.
- Prices: Flare is billed by tokens and Higgsfield reports no per-request cost, so its figures are estimates from the published rates; they rise a little with prompt length. 2.0's is Higgsfield's exact quote for the default prompt. `POST https://api.higgsfield.ai/estimate/<endpoint>` returns a free quote for any request body.
- Time: generation must finish within 50s of the request. Every attempt but the last is capped at 28s, and none starts with less than 15s left. A job cut off after Higgsfield started it may still be billed.
- Higgsfield is the only provider, so an empty Higgsfield balance (submit returns `403`) means no previews. Keep it topped up.
- Covers come back as PNG (~1.7–2 MB) and are stored as-is.
- Logs name the attempt behind each cover, e.g. `[generate] cover by higgsfield marketing-studio/image/flare medium`; each failed attempt logs a `[generate] … failed:` warning first.
- **fal is off.** `lib/fal.js` (Nano Banana 2, $0.08 per cover) and the balance check in `lib/fal-balance.js` stay in the code. To use fal again as the last fallback, uncomment its entry at the end of `CHAIN` and set `FAL_KEY`; with `FAL_BILLING_KEY` set too, fal is skipped once its balance is $0.10 or less.
- **Prompt:** `lib/prompt.js`. The default asks for about 75% the real child and 25% the cover's animation style, painted with the cover's own rendering so the face never looks pasted in. Each order appends the book language, the child's name (the whole placeholder name is replaced, with no leftover letters) and the age. A product's `book.cover_preview_prompt` metafield overrides the default; keep it short enough that the full prompt stays under Higgsfield's 5,000-character limit (`test/prompt.test.js` checks the default with the longest name and language).
- **Why these models:** a side-by-side study of 20+ models on real covers and child photos (October 2026), with prices, timings and every generated image. It includes children's photos, so it is kept outside this public repo, in `model-study/` next to it on the maintainer's machine (`cover-model-study.html`).

## Preview limits & customer sign-in

Free previews cost real money, so the allowance is tiered. All windows are 24h sliding (Upstash), and everything no-ops when `UPSTASH_*` is unset.

| Tier | Keyed by | `/preview` | `/upload-url` |
| --- | --- | --- | --- |
| Anonymous | IP | 3 | 6 |
| Verified customer | customer id | 3 | 8 |
| Backstop (everyone, incl. logged in) | IP | 8 | — |

**How a customer is verified.** The theme has no way to authenticate to this backend, so it proves identity with a shared secret instead: it signs `"{customer_id}:{YYYY-MM-DD}"` (UTC) with Liquid's `hmac_sha256` filter and posts `{ customer_id, token_date, customer_token }` in the `/upload-url` and `/preview` bodies. `lib/customer-token.js` recomputes the digest and compares it in constant time. Only the digest is ever rendered into the DOM - never the secret. Tokens dated within one day either side of UTC today are accepted. That absorbs both a page rendered before midnight rolled over, and Shopify's `date` filter emitting the *shop's* local date (which for a shop ahead of UTC can read as UTC-tomorrow).

The secret must match in **two** places:
1. Vercel env `PREVIEW_TOKEN_SECRET`
2. Shopify theme → **Settings → Personalisation → Preview token secret**

If `PREVIEW_TOKEN_SECRET` is unset the feature is simply off: every token is treated as invalid and everyone gets the anonymous tier. Nothing crashes.

**Responses.** A `429` carries `login_required: true` for anonymous visitors (the theme shows a sign-in invitation) and `false` for a verified customer who has spent their own allowance. Successful `/preview` responses carry `remaining`, the tighter of the tier and backstop windows; it is `null` when limiting is disabled. The theme does not surface it - there is no preview counter in the UI.

**Marketing tag.** When a *verified* customer gets a `429` on `/preview`, `lib/customer-tag.js` adds the tag `preview-limit-hit` to them via Admin GraphQL `tagsAdd`. This needs the **`write_customers`** scope on the Shopify app (in addition to `read_products`). The call is fire-and-forget inside a `try/catch` - a missing scope or a Shopify outage logs and is otherwise invisible to the shopper.

## Endpoints

- `POST /api/upload-url` - validate + presign an R2 PUT.
- `POST /api/preview` - resolve book → generate → store → return `preview_url`.
- `GET /api/preview-status/<id>` - resilience fallback (sync path returns `ready` directly).

## Tests

```bash
npm test    # node --test
```

## Setup

```bash
cp .env.example .env   # fill values
npm install
npx vercel dev         # local, http://localhost:3000
npx vercel deploy --prod
```

Env (see `.env.example`): `HIGGSFIELD_KEY` (the fal keys are commented out while fal is off), `R2_*` (+ public bucket URL), `SHOPIFY_SHOP` + `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` (scopes `read_products`, `write_customers`), `TURNSTILE_SECRET`, `UPSTASH_*`, `PREVIEW_TOKEN_SECRET`, `ALLOWED_ORIGIN`. The backend obtains and refreshes Shopify's short-lived Admin API token automatically. Add the same values in the Vercel project, then put the deployed URL in the theme section's **Backend URL** setting.

Smoke test:
```bash
curl -i -X POST http://localhost:3000/api/upload-url \
  -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:9292' \
  -d '{"filename":"a.jpg","content_type":"image/jpeg","size":12345,"theme_id":"boy-book-7"}'
```

Shopify-side setup (page handle `create-your-book`, Cover variants, `book.*` metafields) is in the theme's `docs/04-shopify-setup.md`.

## Cost

Vercel/R2/Upstash/Turnstile free tiers + Higgsfield: about $0.02–0.04 per preview when the main model answers, up to ~$0.13 when all three attempts run and are billed. The tiered limits above cap the worst case at 8 previews/day per IP, i.e. ~$0.25 normally and ~$1 at most.
