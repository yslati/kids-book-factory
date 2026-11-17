# Bot, crawler and third-party streams

Date: 2026-11-17. Status: approved in conversation, implemented without commit.

## Intent

Keep #logs and #visits for real people. Everything a bot causes still gets
posted, nowhere is anything dropped, but it goes to the #bots channel through
three webhooks (bot report, Bot, crawler) and to its own sheet tabs. Third-party
errors raised in real visitors' browsers (Shopify telemetry, extensions, in-app
webviews) get their own stream too, so #logs holds only failures of our own code
and real customer problems.

## Goals

- Every report, failed request and pixel visit from a bot leaves #logs and #visits.
- Recognised crawlers (search engines, AI crawlers, link previews, SEO tools) are
  named, and a crawler's claim is verified against the IP ranges its operator
  publishes where one exists.
- Bot and crawler page views no longer count as visitors or visits in the daily
  and weekly summaries; they get their own counts.
- Render passes by Googlebot, Bingbot and similar are seen even if Shopify skips
  the pixel for them, through a tiny theme beacon.

## Non-goals

- Seeing plain HTML crawls. They hit Shopify, never this backend. The Search
  Console URL Inspection API is the follow-up for that.
- Changing what humans see in #logs beyond moving third-party errors out.

## Constraints

- Webhook URLs are secrets: environment variables only, never in the repo.
- Posting and sheet writes stay after the response (waitUntil).
- Classification must not fetch anything for human user agents, so existing
  request paths and tests are untouched.
- A failed or missing IP list must never misroute: unknown means unverifiable,
  not spoofed.

## Approaches considered

1. Route server-side by user agent, in each feed (chosen). The backend already
   classifies with isbot; one shared module names crawlers and verifies IPs.
2. Filter in the browser. Impossible for bots (a page cannot trust its own
   user agent) and only partly possible for third-party errors. Rejected.
3. Drop bot traffic. Simplest, but the owner wants to see it. Rejected.

## Design

### lib/audience.js (new)

- `Audience` enum: `human`, `crawler`, `bot`.
- `CrawlerKind` enum: `search`, `ai`, `preview`, `seo`.
- `Verification` enum: `verified`, `unverifiable`, `failed`.
- A table of known crawlers: name, user-agent pattern, kind, published IP list
  URLs (Google, Bing, OpenAI, Perplexity publish the same `{ prefixes: [...] }`
  JSON shape).
- `classifyAgent(userAgent)`: sync. Human when isbot says no; crawler with its
  table entry when a pattern matches; otherwise bot.
- `resolveAudience(visitor)`: async. For a crawler with published lists, checks
  the IP (IPv4 and IPv6 CIDR). Inside: `verified`. Outside: the claim failed and
  the visitor becomes a `bot` labelled "claims <name>". Lists are cached in
  memory for a day; a fetch failure means `unverifiable` and a retry later.
- `agentLabel(result)`: "Bingbot · search crawler · verified", for embeds and
  sheet rows.

### Routing

| Stream | Env var | Sheet tab | Source |
|---|---|---|---|
| bot report | `DISCORD_WEBHOOK_BOT_REPORTS` | Bot reports | lib/report.js: every report or failed request whose sender is a bot or crawler |
| crawler | `DISCORD_WEBHOOK_CRAWLERS` | Crawler visits | api/events.js page views and theme beacon hits from recognised crawlers; api/share.js link previews |
| Bot | `DISCORD_WEBHOOK_BOTS` | Bot visits | the same, from anonymous automation and failed crawler claims |
| third party | `DISCORD_WEBHOOK_THIRD_PARTY` | Third party | lib/report.js: `third-party-error` and `third-party-rejection` from humans |

- Bot and crawler page views are deduplicated per IP and path for 10 minutes
  (Redis SET NX), so the pixel and the beacon never post the same render twice.
- Bot and crawler events never reach `recordEvent`; they count as
  `crawler_visits` or `bot_visits` in the day's counters instead. The daily
  summary and the Daily and Weekly tabs show both.
- Other pixel events from bots (product views, searches) are ignored: they
  duplicate the page view.

### Theme beacon

`snippets/kb-crawler-beacon.liquid`, rendered after the error reporter. When
`navigator.webdriver` is set or the user agent looks automated, it posts
`{ event: 'crawler_seen', path, referrer }` to `/events`. The server trusts only
its own classification: a human agent's beacon is ignored.

## Left to the builder

Embed layout details, exact crawler table contents, test fixtures.
