// The #visits channel (DISCORD_WEBHOOK_VISITS): each new visit as it starts.
// The #searches channel (DISCORD_WEBHOOK_SEARCHES): each storefront search.
// The #events channel (DISCORD_WEBHOOK_EVENTS): add-to-carts, checkouts and
// orders as they happen (api/events.js), and each morning a summary of the
// day before (lib/cron/daily-summary.js). Page, product and collection views
// and cart views are only counted, for the summary, since posting each one
// would bury everything else.

import {
  COLORS, MAX_FIELD_VALUE, code, countryLabel, deviceSummary, discordConfigured, envTag, field, finish, footer, ordinal,
  place, plain, postToDiscord, visitorFields
} from './discord.js';
import { bookLink, bookTitles, orderLink, pageLink, searchLink } from './store-links.js';

const CHANNEL = 'events';
const VISITS_CHANNEL = 'visits';
const SEARCHES_CHANNEL = 'searches';

function moneyText(m) {
  if (!m) return '—';
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: m.currency }).format(m.amount);
  } catch (e) {
    return m.amount + ' ' + m.currency;
  }
}

function sourceField(source) {
  if (!source) return null;
  return field('Source', code(source.label, 80) + (source.campaign ? '\n' + code(source.campaign, 120) : ''));
}

// "3rd visit · 2 days after their first · first came from chatgpt.com"
export function journeyText(journey, now = Date.now()) {
  if (!journey) return '';
  const days = journey.firstAt ? Math.floor((now - journey.firstAt) / 86400000) : null;
  return [
    journey.visits ? ordinal(journey.visits) + ' visit' : '',
    days === null ? '' : days === 0 ? 'same day as their first' : days + (days === 1 ? ' day' : ' days') + ' after their first',
    journey.firstSource ? 'first came from ' + plain(journey.firstSource) : ''
  ].filter(Boolean).join(' · ');
}

function itemsText(items) {
  return items.map((i) => plain(i.title) + (i.variant ? ' · ' + plain(i.variant) : '') + ' ×' + i.quantity).join('\n') || '—';
}

// Where the visitor is and what they use; the pixel's request has no useful origin.
function whoFields(visitor) {
  return [field('Visitor', place(visitor)), field('Device', deviceSummary(visitor.userAgent))];
}

// A visitor without cookie consent has a cookieless id that changes daily, so
// no visit count, and their IP isn't shown.
function visitEmbed(event, recorded, visitor, titles) {
  const [where, ip, device, , userAgent] = visitorFields(visitor);
  const consented = event.consented !== false;
  return {
    color: COLORS.info,
    author: { name: 'Visit' + envTag() },
    title: '🆕 ' + plain(recorded.source.label),
    fields: [
      field('Count', consented ? ordinal(recorded.visit) + ' visit from this browser' : 'No cookie consent, counted without cookies'),
      field('Landing page', pageLink(event.path, titles)),
      recorded.source.campaign && field('Campaign', code(recorded.source.campaign, 120)),
      where, consented && ip, device, userAgent
    ]
  };
}

// "Boys collection" or "Search page, from [The Dragon Rider](url)".
function searchPlace(event, titles) {
  const s = event.search;
  if (s.collection) return pageLink(event.path, titles, { label: s.collection + ' collection' });
  const from = s.from && !/\/search\/?$/.test(s.from) ? ', from ' + pageLink(s.from, titles) : '';
  return 'Search page' + from;
}

// A search with no results stands out: it is something people want that the
// store doesn't show them.
function searchEmbed(event, recorded, visitor, titles) {
  const s = event.search;
  const none = s.results === 0;
  return {
    color: none ? COLORS.warn : COLORS.info,
    author: { name: 'Search' + envTag() },
    title: '🔍 ' + plain(s.query),
    fields: [
      field('Results', none ? '⚠️ none' : String(s.results)),
      field('Where', searchPlace(event, titles)),
      field('Search', searchLink(s.query, s.collection ? event.path : '/search')),
      sourceField(recorded && recorded.source),
      ...whoFields(visitor)
    ]
  };
}

function cartEmbed(event, recorded, visitor) {
  const p = event.product || {};
  const price = p.total || p.price;
  return {
    color: COLORS.info,
    author: { name: 'Added to cart' + envTag() },
    title: '🛒 ' + (plain(p.title) || 'A product') + (price ? ' · ' + moneyText(price) : ''),
    fields: [
      p.variant && field('Variant', plain(p.variant) || '—'),
      field('Quantity', String(p.quantity || 1)),
      sourceField(recorded && recorded.source),
      ...whoFields(visitor)
    ]
  };
}

function checkoutEmbed(event, recorded, visitor) {
  const c = event.checkout || { items: [], discounts: [] };
  const done = event.name === 'checkout_completed';
  const units = c.items.reduce((n, i) => n + i.quantity, 0);
  return {
    color: done ? COLORS.success : COLORS.info,
    author: { name: (done ? 'Order' : 'Checkout started') + envTag() },
    title: (done ? '💰 Order · ' : '💳 Checkout · ') + moneyText(c.total) + ' · ' + units + (units === 1 ? ' item' : ' items'),
    fields: [
      done && c.orderId && field('Order', orderLink(c.orderId)),
      done && c.firstOrder !== null && field('Customer', c.firstOrder ? 'first order' : 'returning customer'),
      done && recorded && recorded.journey && field('Journey', journeyText(recorded.journey), false),
      field('Items', itemsText(c.items), false),
      c.discounts.length > 0 && field('Discount codes', c.discounts.map((d) => code(d, 40)).join(' ')),
      sourceField(recorded && recorded.source),
      ...whoFields(visitor)
    ]
  };
}

// Posts a visit (to #visits), search (to #searches), add-to-cart, checkout or
// order as it happens. recorded is recordEvent's result (lib/event-stats.js);
// a page view posts only when it started a visit. Resolves when posted; null when there's nothing to post.
export async function postLiveEvent(event, recorded, visitor) {
  let channel = CHANNEL;
  let embed = null;
  if (event.name === 'page_viewed' && recorded && recorded.visit) {
    channel = VISITS_CHANNEL;
    if (!discordConfigured(channel)) return null;
    embed = visitEmbed(event, recorded, visitor, await bookTitles());
  } else if (event.name === 'search_submitted' && event.search) {
    channel = SEARCHES_CHANNEL;
    if (!discordConfigured(channel)) return null;
    embed = searchEmbed(event, recorded, visitor, await bookTitles());
  } else if (event.name === 'product_added_to_cart') embed = cartEmbed(event, recorded, visitor);
  else if (event.name === 'checkout_started' || event.name === 'checkout_completed') embed = checkoutEmbed(event, recorded, visitor);
  if (!embed || !discordConfigured(channel)) return null;
  return postToDiscord(channel, {
    embeds: [finish({ ...embed, footer: footer(visitor.requestId), timestamp: new Date().toISOString() })]
  });
}

const number = (n) => (n || 0).toLocaleString('en');
const share = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 + '%' : '—');

const counted = (n, one, many = one + 's') => number(n) + ' ' + (n === 1 ? one : many);

// Lines for a field, as many as fit whole (a clipped link would break).
function fit(lines) {
  while (lines.join('\n').length > MAX_FIELD_VALUE) lines.pop();
  return lines.join('\n') || '—';
}

// The biggest entries of a { key: count } hash, one per line.
function top(hash, label, limit = 6) {
  return fit(Object.entries(hash || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, n]) => label(key) + ' · ' + number(n)));
}

// Each book's funnel from a books hash (lib/event-stats.js), where views and
// previews are counted by handle and carts and orders by title. Most viewed
// first.
export function bookFunnels(books, titles = new Map()) {
  const handleOf = new Map([...titles].map(([handle, title]) => [title, handle]));
  const rows = new Map();
  for (const [key, n] of Object.entries(books || {})) {
    const at = key.indexOf(':');
    const metric = key.slice(0, at);
    const name = key.slice(at + 1);
    if (!['views', 'previews', 'carts', 'orders'].includes(metric) || !name) continue;
    const handle = metric === 'views' || metric === 'previews' ? name : handleOf.get(name) || '';
    const id = handle || name;
    const row = rows.get(id) || { handle, title: titles.get(handle) || name, views: 0, previews: 0, carts: 0, orders: 0 };
    row[metric] += n;
    rows.set(id, row);
  }
  return [...rows.values()].sort((a, b) => b.views - a.views || b.previews - a.previews || b.carts - a.carts);
}

// "[The Dragon Rider](…) · 120 views → 8 previews → 2 carts → 1 order"
function booksField(books, titles, limit = 6) {
  return fit(bookFunnels(books, titles).slice(0, limit).map((r) =>
    (r.handle ? bookLink(r.handle, titles, { max: 40 }) : plain(r.title)) + ' · '
    + [counted(r.views, 'view'), counted(r.previews, 'preview'), counted(r.carts, 'cart'), counted(r.orders, 'order')].join(' → ')));
}

function sharingText(c, sources) {
  return counted(c('share_clicked'), 'share click') + ' · ' + counted(c('share_opened'), 'link open') + '\n'
    + counted(c('share_unfurled'), 'chat preview') + ' · ' + counted((sources || {})['share / link'] || 0, 'visit') + ' from shares';
}

// A day's totals from readDay (lib/event-stats.js); titles are book titles by
// handle, for the top books and pages.
export function summaryEmbed(stats, titles = new Map()) {
  const c = (name) => stats.count[name] || 0;
  const revenue = Object.entries(stats.revenue).map(([currency, amount]) => moneyText({ amount, currency })).join(' + ');
  const date = new Date(stats.day + 'T00:00:00Z').toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
  });
  return finish({
    color: COLORS.info,
    author: { name: 'Daily summary' + envTag() },
    title: '📊 ' + date + ' (UTC)',
    description: '**' + number(stats.visitors) + '** visitors · **' + number(c('visits')) + '** visits'
      + (c('cookieless_visits') ? ' (' + number(c('cookieless_visits')) + ' without cookie consent)' : '')
      + ' · **' + number(c('page_viewed')) + '** page views',
    fields: [
      field('Product views', number(c('product_viewed'))),
      field('Previews', number(c('preview_started')) + ' started\n' + number(c('preview_ready')) + ' ready · ' + number(c('preview_failed')) + ' failed'),
      field('Added to cart', number(c('product_added_to_cart'))),
      field('Checkouts', number(c('checkout_started'))),
      field('Orders', number(c('checkout_completed')) + (revenue ? '\n' + revenue : '')),
      field('Conversion', share(c('checkout_completed'), c('visits')) + ' of visits ordered\n' + share(c('product_added_to_cart'), c('preview_ready')) + ' of previews reached the cart'),
      field('Browsing', number(c('collection_viewed')) + ' collection views · ' + number(c('search_submitted')) + ' searches · ' + number(c('cart_viewed')) + ' cart views', false),
      field('Sharing', sharingText(c, stats.sources), false),
      field('Top books', booksField(stats.books, titles), false),
      field('Top searches', top(stats.searches, (s) => code(s, 40), 8), false),
      field('Top sources', top(stats.sources, (s) => code(s, 60)), false),
      Object.keys(stats.orderSources).length > 0 && field('Orders by source', top(stats.orderSources, (s) => code(s, 60)), false),
      field('Top pages', top(stats.pages, (p) => pageLink(p, titles, { max: 50 })), false),
      field('Top countries', top(stats.countries, countryLabel), false)
    ],
    footer: footer(),
    timestamp: new Date().toISOString()
  });
}

// Whether #events has a webhook, so a summary has somewhere to go.
export function eventsChannelOn() {
  return discordConfigured(CHANNEL);
}

// Posts a day's summary. Resolves to true once posted, else null.
export async function postSummary(stats) {
  if (!discordConfigured(CHANNEL)) return null;
  return postToDiscord(CHANNEL, { embeds: [summaryEmbed(stats, await bookTitles())] });
}

// "+12%", "−5%", "new" or "—" for a week against the one before.
function change(now, before) {
  if (!before) return now ? 'new' : '—';
  const pct = Math.round(((now - before) / before) * 100);
  return (pct > 0 ? '+' : pct < 0 ? '−' : '±') + Math.abs(pct) + '%';
}

function compared(now, before, format = number) {
  return '**' + format(now) + '** · ' + change(now, before) + '\nlast week ' + format(before);
}

// A week's totals against the week before, both from sumDays
// (lib/event-stats.js).
export function weeklyEmbed(week, prior, titles = new Map()) {
  const c = (stats) => (name) => stats.count[name] || 0;
  const [now, before] = [c(week), c(prior)];
  const date = (day) => new Date(day + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const currencies = [...new Set([...Object.keys(week.revenue), ...Object.keys(prior.revenue)])];
  return finish({
    color: COLORS.info,
    author: { name: 'Weekly summary' + envTag() },
    title: '📈 ' + date(week.from) + ' – ' + date(week.to) + ' ' + week.to.slice(0, 4) + ' (UTC)',
    fields: [
      field('Visitors', compared(week.visitors, prior.visitors)),
      field('Visits', compared(now('visits'), before('visits'))),
      field('Product views', compared(now('product_viewed'), before('product_viewed'))),
      field('Previews ready', compared(now('preview_ready'), before('preview_ready'))),
      field('Added to cart', compared(now('product_added_to_cart'), before('product_added_to_cart'))),
      field('Orders', compared(now('checkout_completed'), before('checkout_completed'))),
      ...currencies.map((currency) => field('Revenue ' + currency, compared(week.revenue[currency] || 0, prior.revenue[currency] || 0, (amount) => moneyText({ amount, currency })))),
      field('Shared links opened', compared(now('share_opened'), before('share_opened'))),
      field('Conversion', share(now('checkout_completed'), now('visits')) + ' of visits ordered\nlast week ' + share(before('checkout_completed'), before('visits'))),
      field('Top books', booksField(week.books, titles), false),
      field('Top searches', top(week.searches, (s) => code(s, 40), 8), false),
      field('Top sources', top(week.sources, (s) => code(s, 60)), false)
    ],
    footer: footer(),
    timestamp: new Date().toISOString()
  });
}

// Posts a week's summary. Resolves to true once posted, else null.
export async function postWeeklySummary(week, prior) {
  if (!discordConfigured(CHANNEL)) return null;
  return postToDiscord(CHANNEL, { embeds: [weeklyEmbed(week, prior, await bookTitles())] });
}
