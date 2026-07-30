# kids-book-factory - cover-preview backend

Vercel backend for the kids-book Shopify theme. Puts a child's face on a book's cover (via fal.ai) so the storefront can show a preview before checkout. This is the **preview slice** only - post-purchase print/PDF/Gelato is out of scope.

## Flow

```
Browser            this backend                      external
POST /api/upload-url  → Turnstile + rate-limit → presign R2 PUT → { presigned_put_url, photo_key, generation_id }
PUT photo             → Cloudflare R2
POST /api/preview     → resolve cover+prompt by theme_id (Shopify) → fal Kontext multi → store cover in R2
                      → { preview_url, generation_id, status: 'ready' }
```

- **fal model:** `fal-ai/flux-pro/kontext/max/multi` - multi-image (`[cover, child]`) so it can place the face on the existing cover.
- **Anti-tamper:** the browser never sends the prompt or cover; the backend reads them from the product's metafields by `theme_id`. New product → no backend change.
- **Book languages:** `en`, `es`, `fr`, `de`, `it`, and `pt`. The preview API rejects other values and asks the image model to translate visible cover text into the selected language.
- **Synchronous**, one retry, `maxDuration` 60s. Generated cover persisted to R2 (fal URLs are temporary).
- Missing env vars degrade to `503 *-not-configured`; Turnstile + rate-limiting no-op until configured.

## Endpoints

- `POST /api/upload-url` - validate + presign an R2 PUT.
- `POST /api/preview` - resolve book → generate → store → return `preview_url`.
- `GET /api/preview-status/<id>` - resilience fallback (sync path returns `ready` directly).

## Setup

```bash
cp .env.example .env   # fill values
npm install
npx vercel dev         # local, http://localhost:3000
npx vercel deploy --prod
```

Env (see `.env.example`): `FAL_KEY`, `R2_*` (+ public bucket URL), `SHOPIFY_SHOP` + `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` (scope `read_products`), `TURNSTILE_SECRET`, `UPSTASH_*`, `ALLOWED_ORIGIN`. The backend obtains and refreshes Shopify's short-lived Admin API token automatically. Add the same values in the Vercel project, then put the deployed URL in the theme section's **Backend URL** setting.

Smoke test:
```bash
curl -i -X POST http://localhost:3000/api/upload-url \
  -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:9292' \
  -d '{"filename":"a.jpg","content_type":"image/jpeg","size":12345,"theme_id":"boy-book-7"}'
```

Shopify-side setup (page handle `create-your-book`, Cover variants, `book.*` metafields) is in the theme's `docs/04-shopify-setup.md`.

## Cost

Vercel/R2/Upstash/Turnstile free tiers + ~$0.04 per preview to fal.ai.
