# kids-book-factory - cover-preview backend

Vercel backend for the kids-book Shopify theme. Puts a child's face on a book's cover (via fal.ai) so the storefront can show a preview before checkout. This is the **preview slice** only - post-purchase print/PDF/Gelato is out of scope.

## Flow

```
Browser            this backend                      external
POST /api/upload-url  → Turnstile + rate-limit → presign R2 PUT → { presigned_put_url, photo_key, generation_id }
PUT photo             → Cloudflare R2
POST /api/preview     → resolve cover+prompt by theme_id (Shopify) → fal Nano Banana 2 edit (or Higgsfield) → store cover in R2
                      → { preview_url, generation_id, status: 'ready', remaining }
```

- **fal model:** `fal-ai/nano-banana-2/edit` (Google Gemini 3.1 Flash Image) - multi-image (`[cover, child]`) so it can redraw the existing cover's character as the child. Flat $0.08/image at the `1K` resolution we request.
- **Higgsfield fallback:** `marketing-studio/image` (Marketing Studio Image 2.0, `quality: low`) on the Higgsfield API, same `[cover, child]` input. Billed by tokens: ~$0.061/image at `1k` with the default ~3,700-character prompt (check longer per-book prompts with Higgsfield's free `POST /estimate/marketing-studio/image`). Prompts are capped at 5,000 characters. Higgsfield has no Nano Banana, so the fallback cover can look a little different. `lib/generate.js` routes:
  - fal balance **at or below $0.10** → Higgsfield first, fal as its backup. Needs `FAL_BILLING_KEY`; the balance is re-read at most once a minute.
  - otherwise fal first; if it fails, or is still running after 30s, Higgsfield gets the rest of the time budget.
  - only one provider configured → one attempt + one retry on it, as before.
  - Logs say which provider made each cover: `[generate] cover by fal (fal balance $12.34)`.
- **Anti-tamper:** the browser never sends the prompt or cover; the backend reads them from the product's metafields by `theme_id`. New product → no backend change.
- **Book languages:** `en`, `es`, `fr`, `de`, `it`, and `pt`. The preview API rejects other values and asks the image model to translate visible cover text into the selected language.
- **Synchronous**, `maxDuration` 60s; generation must finish within 50s of the request. Generated cover persisted to R2 (provider URLs are temporary).
- Missing env vars degrade to `503 *-not-configured`; Turnstile + rate-limiting no-op until configured.

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

Env (see `.env.example`): `FAL_KEY` (+ optional `FAL_BILLING_KEY`, `HIGGSFIELD_KEY` for the fallback), `R2_*` (+ public bucket URL), `SHOPIFY_SHOP` + `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` (scopes `read_products`, `write_customers`), `TURNSTILE_SECRET`, `UPSTASH_*`, `PREVIEW_TOKEN_SECRET`, `ALLOWED_ORIGIN`. The backend obtains and refreshes Shopify's short-lived Admin API token automatically. Add the same values in the Vercel project, then put the deployed URL in the theme section's **Backend URL** setting.

Smoke test:
```bash
curl -i -X POST http://localhost:3000/api/upload-url \
  -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:9292' \
  -d '{"filename":"a.jpg","content_type":"image/jpeg","size":12345,"theme_id":"boy-book-7"}'
```

Shopify-side setup (page handle `create-your-book`, Cover variants, `book.*` metafields) is in the theme's `docs/04-shopify-setup.md`.

## Cost

Vercel/R2/Upstash/Turnstile free tiers + $0.08 per preview to fal.ai (Nano Banana 2, `1K`), or ~$0.06 when Higgsfield makes it. The tiered limits above cap the worst case at 8 previews/day per IP, i.e. ~$0.64. A fal attempt that times out can still be billed even when Higgsfield then makes the cover.
