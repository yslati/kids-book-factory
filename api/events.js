// POST /api/events
// Storefront analytics from the Shopify custom pixel (pixel/custom-pixel.js):
// page, product and collection views, searches, cart and checkout steps, and
// orders, from every visitor: those without analytics consent come without a
// client id and get a cookieless one. Counts them for the daily summary
// (lib/event-stats.js), posts visits to #visits and add-to-carts, checkouts
// and orders to #events (lib/event-feed.js) and adds them to the requests
// sheet (lib/sheet.js).
//
// Also takes the theme's { event: 'chat_opened', ... } (snippets/kb-chat.liquid)
// from the store's own pages, posted to #chat (lib/chat-feed.js).
//
// Body: text/plain JSON, shaped as lib/storefront-events.js describes → 204,
// sent before any counting or posting, which run after the response.
//
// The pixel runs in Shopify's sandbox, so the origin isn't checked: payloads
// are validated, and each IP is capped per instance. Not wrapped in
// withReporting, so junk requests can't flood #logs.

import { waitUntil } from '@vercel/functions';
import { allowedHosts, applyCors, isOriginAllowed } from '../lib/cors.js';
import { getRedis } from '../lib/redis.js';
import { visitorOf } from '../lib/discord.js';
import { normaliseEvent } from '../lib/storefront-events.js';
import { cookielessId, recordEvent, saveJourney } from '../lib/event-stats.js';
import { postLiveEvent } from '../lib/event-feed.js';
import { appendRows, chatRow, storefrontRows, TABS } from '../lib/sheet.js';
import { orderWebhookOn } from '../lib/shopify-order.js';
import { chatOpened, chatRecord, postChatOpened } from '../lib/chat-feed.js';
import { Audience, resolveAudience } from '../lib/audience.js';
import { recordBotVisit } from '../lib/bot-feed.js';
import { visitorId } from '../lib/visitor-id.js';
import { Step, addStep, logStep, visitorOfGeneration } from '../lib/visitor-log.js';
import { isShareSlug } from '../lib/share-link.js';
import { linkKey, parseRow } from '../lib/share-store.js';

// A visit from a shared link: who shared it (the cover's maker), on the visit
// and on both visitors' timelines.
async function noteSharedVisit(redis, recorded, visitor) {
  try {
    await sharedVisit(redis, recorded, visitor);
  } catch (e) {
    console.warn('[events] shared visit not linked:', (e && e.message) || e);
  }
}

async function sharedVisit(redis, recorded, visitor) {
  if (!recorded || !recorded.visit || !recorded.source || recorded.source.label !== 'shared link') return;
  const id = recorded.source.campaign;
  const link = isShareSlug(id) ? parseRow(await redis.get(linkKey(id))) : null;
  const sharer = link && link.generationId ? await visitorOfGeneration(redis, link.generationId) : '';
  recorded.sharedBy = sharer;
  if (!id) return;
  await logStep(redis, visitor, { kind: Step.share, text: 'Came from shared link ' + id + (sharer ? ' by ' + sharer : '') });
  if (sharer && sharer !== visitor.id) {
    await addStep(redis, sharer, { kind: Step.share, text: 'Shared link ' + id + ' opened by ' + (visitor.id || 'a new visitor') });
  }
}

// Cookie consent given mid-visit: the cookieless Visitor ID of that day and
// the lasting one point at each other, so /btk customer finds both.
async function noteConsent(redis, recorded, visitor) {
  if (!recorded || !recorded.continued) return;
  const before = visitorId({ ip: visitor.ip, userAgent: visitor.userAgent });
  if (!before || before === visitor.id) return;
  await Promise.all([
    addStep(redis, before, { kind: Step.account, text: 'Accepted cookies, continues as ' + visitor.id }),
    addStep(redis, visitor.id, { kind: Step.account, text: 'Before accepting cookies: ' + before })
  ]);
}

// Events that are a page view, for the bot streams.
const PAGE_VIEWS = ['page_viewed', 'crawler_seen'];

// A visitor sends a few events per page; this only stops a flood.
const LIMIT_WINDOW_MS = 10 * 60 * 1000;
const LIMIT_EVENTS = 300;
// Chat alerts: a few per visitor, so a loop can't flood #chat.
const LIMIT_CHATS = 5;
const recent = new Map();

const OWN_HOSTS = allowedHosts();

function overLimit(ip, max = LIMIT_EVENTS) {
  const now = Date.now();
  const entry = recent.get(ip);
  if (!entry || now >= entry.resetAt) {
    if (recent.size > 10000) {
      for (const [key, value] of recent) if (now >= value.resetAt) recent.delete(key);
    }
    recent.set(ip, { count: 1, resetAt: now + LIMIT_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > max;
}

// The pixel events a visitor's timeline keeps (lib/visitor-log.js).
function timelineStep(event) {
  const money = (m) => (m ? m.amount + ' ' + m.currency : '');
  switch (event.name) {
    case 'page_viewed': return { kind: Step.page, text: event.path };
    case 'search_submitted': return event.search ? { kind: Step.search, text: '"' + event.search.query + '" · ' + event.search.results + ' results' } : null;
    case 'product_added_to_cart': return event.product ? { kind: Step.cart, text: [event.product.title, event.product.variant].filter(Boolean).join(' · ') } : null;
    case 'checkout_started': return { kind: Step.checkout, text: event.checkout ? money(event.checkout.total) : '' };
    // With the order webhook on, it logs the order with its name (api/shopify-webhook.js).
    case 'checkout_completed': return orderWebhookOn() ? null : { kind: Step.order, text: event.checkout ? money(event.checkout.total) : '' };
    default: return null;
  }
}

async function record(event, visitor) {
  try {
    const redis = getRedis();
    // Bots and crawlers never count as visitors: their page views go to the
    // bot streams (lib/bot-feed.js), their other events are only duplicates.
    const who = await resolveAudience(visitor);
    if (who.audience !== Audience.human) {
      if (PAGE_VIEWS.includes(event.name)) await recordBotVisit(redis, who, visitor, { page: event.path, referrer: event.referrer });
      return;
    }
    // A person's browser that merely looks automated to the beacon.
    if (event.name === 'crawler_seen') return;
    visitor.key = event.consented ? event.clientId : '';
    visitor.id = visitorId({ key: visitor.key, ip: visitor.ip, userAgent: visitor.userAgent });
    const step = timelineStep(event);
    if (step) await logStep(redis, visitor, step);
    if (!event.consented) event.clientId = await cookielessId(redis, visitor);
    // Shopify's order webhook (api/shopify-webhook.js) reports every order,
    // signed; the pixel's can be missed or faked, so it only tells the
    // webhook's card how the buyer got here.
    if (event.name === 'checkout_completed' && orderWebhookOn()) {
      await saveJourney(redis, event.checkout && event.checkout.orderId, event.clientId, visitor.id);
      return;
    }
    // A first page view after consent may continue a cookieless visit.
    const anonId = event.consented && event.name === 'page_viewed' ? await cookielessId(redis, visitor) : '';
    const recorded = event.clientId ? await recordEvent(redis, event, { country: visitor.country, ownHosts: OWN_HOSTS, anonId }) : null;
    await Promise.all([noteSharedVisit(redis, recorded, visitor), noteConsent(redis, recorded, visitor)]);
    const sheet = storefrontRows(event, recorded, visitor);
    await Promise.all([
      postLiveEvent(event, recorded, visitor),
      sheet && appendRows(sheet.tab, sheet.rows)
    ]);
  } catch (e) {
    console.error('[events] ' + event.name + ' failed:', (e && e.stack) || e);
  }
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  const chat = chatOpened(body);
  if (chat) {
    if (!isOriginAllowed(req)) return res.status(403).json({ error: 'forbidden-origin' });
    const visitor = visitorOf(req);
    if (overLimit('chat:' + visitor.ip, LIMIT_CHATS)) return res.status(429).json({ error: 'rate-limited' });
    res.status(204).end();
    waitUntil(chatRecord(chat).then((record) => Promise.all([
      logStep(getRedis(), visitor, { kind: Step.chat, text: chat.path, generation: '' }),
      postChatOpened(chat, visitor, record).catch((e) => console.error('[events] chat alert failed:', (e && e.stack) || e)),
      appendRows(TABS.chats, [chatRow(chat, visitor, record)])
    ])));
    return;
  }

  const event = normaliseEvent(body);
  if (!event) return res.status(400).json({ error: 'bad-event' });

  const visitor = visitorOf(req);
  if (overLimit(visitor.ip)) return res.status(429).json({ error: 'rate-limited' });

  res.status(204).end();
  waitUntil(record(event, visitor));
}
