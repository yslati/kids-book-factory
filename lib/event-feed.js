// The #visits channel (DISCORD_WEBHOOK_VISITS): each new visit as it starts.
// The #events channel (DISCORD_WEBHOOK_EVENTS): add-to-carts, checkouts and
// orders as they happen (api/events.js), and each morning a summary of the
// day before (api/cron/daily-summary.js). Page, product and collection views,
// cart views and searches are only counted, for the summary, since posting
// each one would bury everything else.

import {
  COLORS, code, countryLabel, deviceSummary, discordConfigured, envTag, field, finish, footer, ordinal,
  place, plain, postToDiscord, visitorFields
} from './discord.js';

const CHANNEL = 'events';
const VISITS_CHANNEL = 'visits';

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

function itemsText(items) {
  return items.map((i) => plain(i.title) + (i.variant ? ' · ' + plain(i.variant) : '') + ' ×' + i.quantity).join('\n') || '—';
}

// Where the visitor is and what they use; the pixel's request has no useful origin.
function whoFields(visitor) {
  return [field('Visitor', place(visitor)), field('Device', deviceSummary(visitor.userAgent))];
}

// A visitor without cookie consent has a cookieless id that changes daily, so
// no visit count, and their IP isn't shown.
function visitEmbed(event, recorded, visitor) {
  const [where, ip, device, , userAgent] = visitorFields(visitor);
  const consented = event.consented !== false;
  return {
    color: COLORS.info,
    author: { name: 'Visit' + envTag() },
    title: '🆕 ' + plain(recorded.source.label),
    fields: [
      field('Count', consented ? ordinal(recorded.visit) + ' visit from this browser' : 'No cookie consent, counted without cookies'),
      field('Landing page', code(event.path, 120)),
      recorded.source.campaign && field('Campaign', code(recorded.source.campaign, 120)),
      where, consented && ip, device, userAgent
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
      done && c.orderId && field('Order', code(c.orderId, 40)),
      done && c.firstOrder !== null && field('Customer', c.firstOrder ? 'first order' : 'returning customer'),
      field('Items', itemsText(c.items), false),
      c.discounts.length > 0 && field('Discount codes', c.discounts.map((d) => code(d, 40)).join(' ')),
      sourceField(recorded && recorded.source),
      ...whoFields(visitor)
    ]
  };
}

// Posts a visit (to #visits), add-to-cart, checkout or order as it happens. recorded is
// recordEvent's result (lib/event-stats.js); a page view posts only when it
// started a visit. Resolves when posted; null when there's nothing to post.
export function postLiveEvent(event, recorded, visitor) {
  let channel = CHANNEL;
  let embed = null;
  if (event.name === 'page_viewed' && recorded && recorded.visit) {
    channel = VISITS_CHANNEL;
    embed = visitEmbed(event, recorded, visitor);
  } else if (event.name === 'product_added_to_cart') embed = cartEmbed(event, recorded, visitor);
  else if (event.name === 'checkout_started' || event.name === 'checkout_completed') embed = checkoutEmbed(event, recorded, visitor);
  if (!embed || !discordConfigured(channel)) return Promise.resolve(null);
  return postToDiscord(channel, {
    embeds: [finish({ ...embed, footer: footer(visitor.requestId), timestamp: new Date().toISOString() })]
  });
}

const number = (n) => (n || 0).toLocaleString('en');
const share = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 + '%' : '—');

// The biggest entries of a { key: count } hash, one per line.
function top(hash, label, limit = 6) {
  return Object.entries(hash)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, n]) => label(key) + ' · ' + number(n))
    .join('\n') || '—';
}

// A day's totals from readDay (lib/event-stats.js).
export function summaryEmbed(stats) {
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
      field('Top sources', top(stats.sources, (s) => code(s, 60)), false),
      Object.keys(stats.orderSources).length > 0 && field('Orders by source', top(stats.orderSources, (s) => code(s, 60)), false),
      field('Top pages', top(stats.pages, (p) => code(p, 80)), false),
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
export function postSummary(stats) {
  if (!discordConfigured(CHANNEL)) return Promise.resolve(null);
  return postToDiscord(CHANNEL, { embeds: [summaryEmbed(stats)] });
}
