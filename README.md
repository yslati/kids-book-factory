# kids-book-factory - cover-preview backend

Vercel backend for the kids-book Shopify theme. Puts a child's face on a book's cover (via Higgsfield's image API) so the storefront can show a preview before checkout. This is the **preview slice** only - post-purchase print/PDF/Gelato is out of scope.

## Flow

```
Browser            this backend                      external
POST /api/upload-url  → Turnstile + rate-limit → presign R2 PUT + grant preview pass → { presigned_put_url, photo_key, generation_id, preview_pass }
PUT photo             → Cloudflare R2
POST /api/preview     → redeem preview pass (else Turnstile) + rate-limit → resolve cover+prompt by theme_id (Shopify) → Higgsfield model chain (lib/generate.js) → store cover in R2
                      → { preview_url, generation_id, status: 'ready', remaining }
```

- **Image generation:** an ordered chain of Higgsfield models with fallbacks - see [Image generation](#image-generation) below.
- **Object names:** R2 keys are readable. The photo is `photos/<name>_<age>_<language>_<id>.<ext>` and the cover is `previews/<name>_<age>_<language>_<book>_<id>.<ext>`, e.g. `photos/emma_5_en_k3x9p2m7q1.jpg` and `previews/emma_5_en_the-winning-goal_k3x9p2m7q1.jpg`. `<book>` is the product title before its ": Personalized…" or " – Personalized…" suffix. `<id>` is the `generation_id`: 10 random characters shared by the photo and its cover. It stays random because the bucket is public, and those characters are what keep a photo URL unguessable. Names are slugged to plain ASCII. A missing age or language becomes `na`, and a name with no Latin letters becomes `child`. See `lib/object-names.js`.
- **Anti-tamper:** the browser never sends the prompt or cover; the backend reads them from the product's metafields by `theme_id`. New product → no backend change.
- **One challenge per preview:** Turnstile tokens are single-use, so once `/upload-url` has verified the visitor's token it grants a one-time pass for the `generation_id` it issues (Upstash, 15 min, `lib/preview-pass.js`; not the `photo_key`, which carries the child's name). `/preview` redeems it with `GETDEL` instead of needing a second token mid-generation, so one solve still buys exactly one preview. When no pass can be stored (`UPSTASH_*` unset, a Redis error), `/upload-url` returns `preview_pass: false` and the theme sends a fresh `turnstile_token` with `/preview`, verified as usual.
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
- Covers come back as PNG (~1.7–2 MB). Before they go to R2, `lib/cover-image.js` re-encodes them with sharp as a progressive JPEG (quality 88, 4:4:4 chroma, sRGB, metadata stripped): ~340–450 KB, with no visible difference at 1024px. If that fails, the PNG is stored as-is, so a paid cover is never lost.
- Logs name the attempt behind each cover, e.g. `[generate] cover by higgsfield marketing-studio/image/flare medium`; each failed attempt logs a `[generate] … failed:` warning first.
- **fal is off.** `lib/fal.js` (Nano Banana 2, $0.08 per cover) and the balance check in `lib/fal-balance.js` stay in the code. To use fal again as the last fallback, uncomment its entry at the end of `CHAIN` and set `FAL_KEY`; with `FAL_BILLING_KEY` set too, fal is skipped once its balance is $0.10 or less.
- **Prompt:** `lib/prompt.js`. The default asks for about 75% the real child and 25% the cover's animation style, painted with the cover's own rendering so the face never looks pasted in. The photo gives who the child is; the head angle, gaze and expression come from the cover's original character, so the face fits the pose (a hero cooking looks at the dish, not at the camera) and a smiling hero still smiles when the photo is neutral. Helmets and hats stay on, and only the hero becomes the child: teammates and crowds keep their own faces. Each order appends the book language, the child's name (the whole placeholder name is replaced, with no leftover letters) and the age. A product's `book.cover_preview_prompt` metafield overrides the default; keep it short enough that the full prompt stays under Higgsfield's 5,000-character limit (`test/prompt.test.js` checks the default with the longest name and language).
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
- `POST /api/preview` - resolve book → generate → store → return `preview_url`. Also takes the preview page's `{ action: 'occasion' | 'cart' }` follow-ups for the [requests sheet](#requests-sheet).
- `GET /api/preview-status/<id>` - resilience fallback (sync path returns `ready` directly).
- `POST /api/custom-story` - a cover for a story the catalog doesn't have (see [Custom stories](#custom-stories)), and its add-to-cart follow-up.
- `POST /api/log` - storefront error reports, forwarded to Discord's #logs (see [Discord channels](#discord-channels)).
- `POST /api/events` - storefront analytics from the Shopify custom pixel, for #events.
- `GET /api/cron/daily-summary` - Vercel cron, posts yesterday's totals to #events, plus any days a skipped run missed.
- `GET /api/cron/higgsfield` - Vercel cron, posts the daily Higgsfield account check to #higgsfield.

## Discord channels

The backend posts to Discord channels through their incoming webhooks, one environment variable per channel: `DISCORD_WEBHOOK_<CHANNEL>`. A channel whose variable is unset is off. `lib/discord.js` holds what every channel shares (posting, rate limits, embed pieces, redaction); each channel has a small feed module. Adding a channel takes its variable and a feed that calls `postToDiscord('<channel>', { embeds })`.

| Channel | Variable | Feed | Posts |
| --- | --- | --- | --- |
| #logs | `DISCORD_WEBHOOK_LOGS` | `lib/report.js` | API and storefront warnings and errors |
| #previews | `DISCORD_WEBHOOK_PREVIEWS` | `lib/preview-feed.js` | every preview: the photo, then the cover |
| #visits | `DISCORD_WEBHOOK_VISITS` | `lib/event-feed.js` | each new visit live |
| #events | `DISCORD_WEBHOOK_EVENTS` | `lib/event-feed.js` | add-to-carts, checkouts and orders live, plus a daily summary |
| #higgsfield | `DISCORD_WEBHOOK_HIGGSFIELD` | `lib/higgsfield-feed.js` | Higgsfield alerts live, plus a daily account check |
| #custom-generation | `DISCORD_WEBHOOK_CUSTOM` | `lib/custom-feed.js` | every custom story request: the answers and photo, the cover, the add-to-cart |

### #logs: error reports

- **API:** every route is wrapped in `withReporting` (`lib/report.js`). A request is reported when it answers `>= 400` or logs a `console.warn`/`console.error` (a fallback model, a cover kept on the provider's URL, a rejected Turnstile token, a Redis error...). It becomes one message: status and error code, the request's log lines with timings, and the book, generation id, language, customer (verified id or anonymous), duration, IP, country/region/city, IP time zone, device, user agent, origin and Vercel request id (searchable in the Vercel logs). Errors (red) are `5xx` and `console.error`; warnings (amber) are the rest. An unhandled crash answers `500 internal-error` in JSON. Posts run after the response through `waitUntil`, so they never slow a request.
- **Storefront:** `snippets/kb-error-reporter.liquid` in the theme posts uncaught errors from the theme's own scripts (not apps or extensions) and the failures flows report through `window.KBReport` (a failed preview with its step and HTTP status, a rejected photo, Turnstile errors, a failed add to cart...) to `POST /api/log`, which adds the same visitor details. At most 20 reports per page view (the rest go into one summary) and 120 per IP per hour.
- **Privacy:** reports never include the child's name, photo, photo or cover URLs (their keys carry the name), or tokens: only whitelisted request fields are read, and object keys and `?b=`/`?name=`/`*token=` parameters are redacted from logged text. They do include the visitor's IP and approximate location, and Discord keeps messages until deleted.
- **Limits:** no fixed cap. Posting follows the rate limit Discord reports on every response (5 posts per 1-2 s per webhook when measured in October 2026): when a channel's window is full, a post waits for it to reopen, and a `429` waits out its `retry_after` and retries. Each channel's posts queue in order, so a burst waits its turn instead of colliding. A post is dropped only if its turn doesn't come before the function's deadline (the next post notes how many were; `/api/log` gets 30 s for this), and a webhook that answers 401 or 404 is left alone until the next cold start, as Discord asks. Posts Discord can't take in time (an outage, a burst longer than the function, a deleted webhook) are saved in Upstash (`kbf:discord:outbox:<channel>`, 30 days, at most 10,000) and sent after the channel's next successful post, oldest first, marked "sent late". Storefront pages send 20 reports one by one and count the rest, plus repeats of the same error, into one page summary when the page is hidden; `/api/log` accepts 120 reports per IP per hour; past that it answers `429` and posts one notice per IP per hour (per function instance) instead. Total volume isn't capped. Discord webhooks are free; each storefront report costs one Upstash command.

### #previews: photo and cover

When `/api/preview` starts generating (after Turnstile and the rate limits), it posts the child's photo with the book (linked to its product page), language, occasion (when the parent picked one), customer and country. When it finishes, a follow-up carries the cover (with the time, model and its direct R2 link, or a warning and the provider's temporary link when the copy to R2 failed) or the error. Discord webhooks can't send real replies, so the follow-up's title links back to the photo message and repeats the photo as a thumbnail, which keeps each pair readable when previews overlap. The follow-up goes out after the response, through `waitUntil`.

Each card also shows a **Count** field ("2nd upload from this IP", "3rd preview from this customer") from `lib/visitor-counts.js`: a signed-in customer counts by account, everyone else by IP, so people sharing a network count together. Uploads are counted when `/upload-url` issues the upload link, previews when generation starts (failed ones included). Each count is a Redis `INCR` on `kbf:count:<upload|preview>:<customer:id|ip:address>` that expires 30 days after its last increment; 2 commands per upload, 3 per preview.

This channel shows the child's photo, name and age by design. Images are linked from R2, not uploaded to Discord, so Discord only caches them and they stop showing once the bucket deletes them. Keep the channel private to the people who review covers.

### #events: visitors, funnel and orders

A Shopify **custom pixel** (`pixel/custom-pixel.js`) sends the storefront's events to `POST /api/events`. Install it in Shopify admin → Settings → Customer events → Add custom pixel: paste the file, set Customer privacy → Permission to "Not required" and Data sale to "Data collected does not qualify as data sale" (otherwise Shopify blocks it for every visitor who hasn't consented, which is all of the EEA and UK by default), save and connect. It reports page, product and collection views, searches, cart views, add-to-carts, checkout starts and orders, including the checkout pages the theme's own scripts can't see.

- **Live in #visits:** each new visit (its source, landing page, the browser's visit count, location and device).
- **Live in #events:** each add-to-cart, each checkout start and each order (total, items, discount codes, first or returning customer, and the source of the visitor's first visit).
- **Counted only:** page, product and collection views, cart views and searches, plus previews (counted by `/api/preview`).
- **Daily summary:** a Vercel cron (`api/cron/daily-summary.js`, once a day between 06:00 and 06:59 UTC) posts the previous UTC day: visitors, visits, page views, the funnel from product views through previews, carts and checkouts to orders and revenue, conversion rates, and the top sources, pages and countries. Vercel authenticates it with `CRON_SECRET`; with that header, `?day=YYYY-MM-DD` posts that day again.
- **Missed and repeated runs:** Vercel's cron delivery is best effort: a run can be skipped or delivered twice, and a failed one isn't retried. So each run posts every day since the last one summarised (`kbf:ev:summary:last`), oldest first, up to 30 days back; the first run starts from the earliest day with totals. One run posts at a time (`kbf:ev:summary:lock`), and a run with nothing due posts nothing. A summary Discord can't take right away is saved and sent later like any other post, so it isn't posted twice. About 11 Upstash commands a run (`lib/daily-summary.js`).
- **Visits and sources:** a visit starts after 30 minutes without a page view. Its source is the landing page's UTM tags, else an ad click id (`gclid`, `fbclid`, `ttclid`...), else the referring site, else direct (`lib/traffic-source.js`). The first source a visitor arrives with is kept for 30 days, so later orders are attributed to it.
- **Storage:** per UTC day in Upstash (`kbf:ev:<day>:*`, kept 40 days; unique visitors by Shopify client id), costing about 5 commands per page view and 10 per new visit, and one function invocation per event.
- **Privacy:** only paths (query strings and checkout tokens removed), campaign tags, product titles, prices and quantities are stored or posted: never customer details or line item properties, which carry the child's name. Every visitor is tracked without asking for consent, which EU privacy law (GDPR, ePrivacy) generally requires for analytics.
- **Trust:** the pixel's requests can't be authenticated, so anyone could post fake events. Payloads are validated and each IP is capped at 300 events per 10 minutes per instance; Shopify's orders are the source of truth for revenue.

### #custom-generation: custom story requests

The storefront's "Dream up their story" page (theme `sections/kb-custom-story.liquid`) asks for a story world, boy or girl, the child's name, optional age, photo, a free-text story idea and an optional occasion. `/api/custom-story` posts all of it with the photo as generation starts, then the cover or the error as a follow-up linked to it, and a third card if the parent adds the custom book to the cart. Like #previews, it shows the child's photo, name and age by design; keep it private.

## Custom stories

`POST /api/custom-story` paints a cover for a story the catalog doesn't have. The photo goes up through `/upload-url` as usual, and its one-time pass covers this call.

- **Reference cover:** the theme sends one of our product handles (picked per world and boy/girl in the section's settings), and the backend reads that product's cover from Shopify, so the model keeps the series' look and layout while the scene, title and tagline come from the parent's idea (`lib/custom-prompt.js`). The child's pose and expression come from that moment of the story, not from the photo, and only the hero has the child's face. The parent's text is quoted as a description, never as instructions; covers stay child-safe, and named characters become original ones.
- **Limits:** 3 custom covers per IP (or per signed-in customer) per 24h, plus the per-IP backstop shared with `/preview` (8 a day across both). Same model chain and cost as a preview.
- **Storage:** the cover is `previews/<name>_<age>_en_custom-<world>_<id>.jpg` in R2, and `kbf:custom:<id>` in Upstash keeps the name, world and cover for 30 days so the add-to-cart card (`{ action: 'cart' }`) can only be posted for a real cover, once.

### #higgsfield: the generation account

- **Live alerts:** each Higgsfield attempt in the cover chain (`lib/generate.js`) is tracked after the response. When Higgsfield refuses one for a reason that won't fix itself, the channel gets an alert: out of credits (`403`) or key rejected (`401`) for the whole account, model not found (`404`), blocked (`423`) or disabled (`503`) per model. Each problem alerts at most once an hour (`kbf:hf:alert:*`), so an empty balance doesn't post once per preview.
- **Daily check:** a Vercel cron (`api/cron/higgsfield.js`, once a day between 07:00 and 07:59 UTC) posts whether the key works, whether each chain model is still in the account's catalog (`GET /models`) and accepted by Higgsfield's free `POST /estimate/<model>` quote, its price, and the previous UTC day's jobs per model (completed with average time and, for fixed-price models, the spend; failed, NSFW, timed out or refused). Separate messages list models added to or removed from the catalog and any change in a chain model's quote since the last check (`kbf:hf:catalog`, `kbf:hf:prices`). A repeated run the same day posts nothing (`kbf:hf:check:<day>`); with `CRON_SECRET`, `?force=1` runs it again.
- **Balance:** Higgsfield has no API for the account balance (October 2026: none in the docs, the OpenAPI file or the official SDK; the higgsfield.ai website's credits are a separate wallet). Running out therefore shows as the live out-of-credits alert, and the daily check links to the console.
- **Cost:** about 3 Upstash commands per attempt; the daily check makes 4 Higgsfield calls, none billed, about 6 Upstash commands and one function invocation.

## Requests sheet

Everything the backend sees also goes to a Google Sheet, one tab per kind, so it can be filtered, counted and downloaded (File → Download → Microsoft Excel). `lib/sheet.js` posts after the response through `waitUntil`; a sheet that is down or slow (8 s) only costs that change, and lost changes are reported to #logs (at most once per tab per 10 minutes per instance, with the generation id for cover rows; Discord's channels still have everything).

| Tab | One row per | From | Columns |
| --- | --- | --- | --- |
| Book previews | product-page cover | `/api/preview` | Date, Status, Book, Child's name, Age, Language, Occasion, Added to cart, Photo, Cover, Model, Seconds, Customer, Country, City, Device, Error, Generation, Prompt |
| Custom stories | custom story cover | `/api/custom-story` | Date, Status, World, Hero, Child's name, Age, Occasion, Story idea, Reference book, Added to cart, Photo, Cover, Model, Seconds, Customer, Country, City, Device, Error, Generation, Prompt |
| Orders | book in an order | the pixel's `checkout_completed` (`/api/events`) | Date, Order, Book, Cover, Quantity, Price, Order total, Currency, Discount codes, Customer (first order or returning), Source, Country, City, Device |
| Carts | add to cart | the pixel | Date, Book, Variant, Quantity, Price, Currency, Source, Country, City, Device |
| Checkouts | checkout started | the pixel | Date, Total, Currency, Items, Discount codes, Source, Country, City, Device |
| Visits | new visit | the pixel's first page view of a visit | Date, Source, Campaign, Landing page, Visit number, Country, City, Device |
| Daily | UTC day | the daily summary cron (`lib/daily-summary.js`) | Day, Visitors, Visits, Page views, Product views, Collection views, Searches, Cart views, Previews started/ready/failed, Added to cart, Checkouts started, Orders, Revenue, Currency, Top sources, Orders by source, Top pages, Top countries |

- **Tabs and columns:** a tab or field the backend starts sending gets added by the script by itself (columns at the end). Source is the visit's traffic source (`lib/traffic-source.js`), or for carts, checkouts and orders the visitor's first one. Orders come from the pixel, which can't be authenticated: Shopify's orders stay the source of truth for revenue. Search terms aren't recorded: the pixel doesn't send them.
- **Filled in later:** product-page books ask for the occasion on the preview page, after the cover, so the parent sees their cover with no extra questions first. The page posts `{ action: 'occasion', generation_id, occasion }` to `/api/preview` when the parent picks or clears one (the last choice after 1.5 s), and `{ action: 'cart', generation_id, occasion, variant }` when they add the book to the cart; the custom story's own cart follow-up sets Added to cart on its row too. They answer `204` and change only the newest row with that Generation id in that tab, so they can't add rows; a cart message without an occasion leaves the parent's answer alone, so a shared link opened elsewhere can't clear it. When the row isn't there yet (it is written while the preview page loads), the change is tried once more after 5 s; a preview from before the sheet existed has no row and is skipped. 30 follow-ups per IP per hour (`preview-follow-up`).
- **Safety:** the script only touches its own spreadsheet (`@OnlyCurrentDoc`), refuses any post without the shared secret, accepts at most 50 rows per post, and writes text that starts with `=`, `+`, `-` or `@` (or looks like a number or a date) as plain text, so a name or story idea can't become a formula.
- **Privacy:** like #previews, cover rows hold the child's name, age, photo link (the photo itself stays in R2 and its link stops working when the bucket deletes it after 30 days) and the prompt, which includes the name. Rows are kept until deleted. Keep the sheet shared only with the team, and list Google as a processor in the privacy policy.
- **Cost:** free. Apps Script and Google Sheets have no charge at this volume; a spreadsheet holds 10 million cells (at 500 visits a day, the Visits tab fills about 1.6 million a year). One outbound request per cover, follow-up, visit, cart, checkout, order and day; Vercel bills the wait as duration, not active CPU.

Setup, once:

1. Create a Google Sheet (for example "Book to Kids requests").
2. Extensions → Apps Script. Replace the editor's contents with `sheet/apps-script.js` and save.
3. Pick `setup` in the toolbar's function list and click Run, then allow the permissions it asks for (Google warns that the app isn't verified: it is your own script, so Advanced → Go to … → Allow). It creates the shared secret in the script's properties, lays out the tabs (removing the empty sheet the spreadsheet started with) and shows `SHEET_WEBHOOK_SECRET=…` in the execution log; running it again shows the same secret and changes nothing else.
4. Deploy → New deployment → type **Web app**, Execute as **Me**, Who has access **Anyone** → Deploy. Copy the web app URL (`https://script.google.com/macros/s/.../exec`).
5. Set `SHEET_WEBHOOK_URL` (that URL) and `SHEET_WEBHOOK_SECRET` (the logged value) in Vercel (production, sensitive), then redeploy. Rows start with the next request.

After editing the script, Deploy → Manage deployments → edit → Version: New version keeps the same URL.

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

Env (see `.env.example`): `HIGGSFIELD_KEY` (the fal keys are commented out while fal is off), `R2_*` (+ public bucket URL), `SHOPIFY_SHOP` + `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` (scopes `read_products`, `write_customers`), `TURNSTILE_SECRET`, `UPSTASH_*`, `PREVIEW_TOKEN_SECRET`, `ALLOWED_ORIGIN`, `DISCORD_WEBHOOK_*`, optionally `SHEET_WEBHOOK_URL` + `SHEET_WEBHOOK_SECRET` for the [requests sheet](#requests-sheet), and optionally `SHARE_BASE_URL` + `STORE_URL` for short share links (`api/share.js`, served on `s.booktokids.com`). The backend obtains and refreshes Shopify's short-lived Admin API token automatically. Add the same values in the Vercel project, then put the deployed URL in the theme section's **Backend URL** setting.

Smoke test:
```bash
curl -i -X POST http://localhost:3000/api/upload-url \
  -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:9292' \
  -d '{"filename":"a.jpg","content_type":"image/jpeg","size":12345,"theme_id":"boy-book-7"}'
```

Shopify-side setup (page handle `create-your-book`, Cover variants, `book.*` metafields) is in the theme's `docs/04-shopify-setup.md`.

## Cost

Vercel/R2/Upstash/Turnstile free tiers + Higgsfield: about $0.02–0.04 per preview when the main model answers, up to ~$0.13 when all three attempts run and are billed. The tiered limits above cap the worst case at 8 previews/day per IP, i.e. ~$0.25 normally and ~$1 at most.
