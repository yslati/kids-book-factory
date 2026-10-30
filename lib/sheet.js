// The requests sheet (SHEET_WEBHOOK_URL): everything the backend sees, one
// tab per kind, so it can be sorted, filtered and counted in Google Sheets.
//   Book previews   each product-page cover (/api/preview), with the preview
//                   page's occasion, extra details and add to cart filled in later
//   Custom stories  each custom story cover (/api/custom-story)
//   Orders          each book in an order          (api/events.js, the pixel)
//   Carts           each add to cart               (api/events.js)
//   Checkouts       each checkout started          (api/events.js)
//   Visits          each new visit and its source  (api/events.js)
//   Daily           each day's totals              (lib/daily-summary.js)
// The sheet's Apps Script (sheet/apps-script.js) writes the rows, adding a tab
// or column for any it hasn't seen yet.
//
// Like #previews, cover rows hold the child's name, age, a link to their
// photo (gone once R2 deletes it) and the prompt, so the sheet must stay
// private to the team.

import {
  COLORS, code, codeBlock, countryName, deviceSummary, envTag, field, finish, postToDiscord, redact, visitorOf
} from './discord.js';
import { OCCASIONS, WORLDS } from './custom-prompt.js';
import { attemptLabel } from './provider-order.js';

export const TABS = {
  previews: 'Book previews',
  custom: 'Custom stories',
  orders: 'Orders',
  carts: 'Carts',
  checkouts: 'Checkouts',
  visits: 'Visits',
  daily: 'Daily'
};

// Apps Script answers in 1-3 s; past this the change is dropped and reported.
const TIMEOUT_MS = 8000;
// A follow-up can beat the preview's own row to the sheet: that row is
// written after the /preview response, while the preview page is loading.
const RETRY_MS = 5000;
// At most one #logs report per tab this often per instance, so a sheet
// outage doesn't post once for every visit.
const REPORT_EVERY_MS = 10 * 60 * 1000;
const lastReport = new Map();

export function sheetConfigured() {
  return Boolean(process.env.SHEET_WEBHOOK_URL && process.env.SHEET_WEBHOOK_SECRET);
}

function oneLine(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// The parent's extra details about the child (preview page and custom story
// page): one line, capped like the storefront field.
export const DETAILS_MAX = 400;

export function cleanDetails(value) {
  return oneLine(value, DETAILS_MAX);
}

function now() {
  return new Date().toISOString();
}

function ageOf(value) {
  const age = parseInt(value, 10);
  return Number.isFinite(age) ? age : '';
}

// Where the visitor is and what they use.
function placeOf(v) {
  return {
    Country: /^[A-Z]{2}$/.test(v.country) ? countryName(v.country) : '',
    City: v.city || '',
    Device: deviceSummary(v.userAgent)
  };
}

// The columns both cover tabs end with. outcome is { coverUrl, bookTitle?,
// attempt?, prompt? } or { error, prompt? }.
function coverEnd(req, request, outcome) {
  const failed = Boolean(outcome.error);
  return {
    'Added to cart': '',
    Photo: request.photoUrl || '',
    Cover: failed ? '' : outcome.coverUrl || '',
    Model: !failed && outcome.attempt ? attemptLabel(outcome.attempt) : '',
    Seconds: request.startedAt ? Math.round((Date.now() - request.startedAt) / 100) / 10 : '',
    Customer: request.customerId ? 'Signed in · ' + request.customerId : 'Guest',
    ...placeOf(visitorOf(req)),
    Error: failed ? redact(String(outcome.error)).slice(0, 300) : '',
    Generation: request.generationId || '',
    Prompt: outcome.prompt || ''
  };
}

// A Book previews row. request: { book, childName, age, language, photoUrl,
// customerId, generationId, startedAt }. Occasion, Extra details and Added to
// cart are filled in by the preview page's follow-ups.
export function previewRow(req, request, outcome) {
  return {
    Date: now(),
    Status: outcome.error ? 'Failed' : 'Ready',
    Book: outcome.bookTitle || request.book || '',
    "Child's name": request.childName || '',
    Age: ageOf(request.age),
    Language: request.language || '',
    Occasion: '',
    'Extra details': '',
    ...coverEnd(req, request, outcome)
  };
}

// A Custom stories row. request is the validated request (lib/custom-story.js)
// plus { photoUrl, customerId, startedAt }.
export function customRow(req, request, outcome) {
  return {
    Date: now(),
    Status: outcome.error ? 'Failed' : 'Ready',
    World: WORLDS[request.world] || request.world || '',
    Hero: request.gender === 'girl' ? 'Girl' : 'Boy',
    "Child's name": request.childName || '',
    Age: ageOf(request.age),
    Occasion: request.occasion || '',
    'Story idea': request.brief || '',
    'Extra details': '',
    'Reference book': request.reference || '',
    ...coverEnd(req, request, outcome)
  };
}

function amount(money) {
  return money ? money.amount : '';
}

function currency(money) {
  return money ? money.currency : '';
}

// The tab and rows a storefront event adds (api/events.js), or null. recorded
// is recordEvent's result (lib/event-stats.js): the visit number and the
// traffic source of the visit, or of the visitor's first visit.
export function storefrontRows(event, recorded, visitor) {
  const place = placeOf(visitor);
  const source = recorded && recorded.source ? recorded.source.label : '';

  if (event.name === 'page_viewed') {
    if (!recorded || !recorded.visit || !recorded.source) return null;
    return {
      tab: TABS.visits,
      rows: [{
        Date: now(),
        Source: recorded.source.label,
        Campaign: recorded.source.campaign || '',
        'Landing page': event.path,
        'Visit number': event.consented === false ? '' : recorded.visit,
        'Cookie consent': event.consented === false ? 'No' : 'Yes',
        ...place
      }]
    };
  }

  if (event.name === 'product_added_to_cart' && event.product) {
    const p = event.product;
    return {
      tab: TABS.carts,
      rows: [{
        Date: now(),
        Book: p.title,
        Variant: p.variant,
        Quantity: p.quantity,
        Price: amount(p.total || p.price),
        Currency: currency(p.total || p.price),
        Source: source,
        ...place
      }]
    };
  }

  if (event.name === 'checkout_started' && event.checkout) {
    const c = event.checkout;
    return {
      tab: TABS.checkouts,
      rows: [{
        Date: now(),
        Total: amount(c.total),
        Currency: currency(c.total),
        Items: c.items.map((i) => i.title + (i.variant ? ' · ' + i.variant : '') + ' ×' + i.quantity).join('; '),
        'Discount codes': c.discounts.join(', '),
        Source: source,
        ...place
      }]
    };
  }

  if (event.name === 'checkout_completed' && event.checkout) {
    const c = event.checkout;
    const order = {
      'Order total': amount(c.total),
      Currency: currency(c.total),
      'Discount codes': c.discounts.join(', '),
      Customer: c.firstOrder === null ? '' : c.firstOrder ? 'First order' : 'Returning',
      Source: source,
      ...place
    };
    const items = c.items.length ? c.items : [{ title: '', variant: '', quantity: '', price: null }];
    return {
      tab: TABS.orders,
      rows: items.map((i) => ({
        Date: now(),
        Order: c.orderId,
        Book: i.title,
        Cover: i.variant,
        Quantity: i.quantity,
        Price: amount(i.price),
        ...order
      }))
    };
  }

  return null;
}

// "key (n), key (n)" for the biggest entries of a { key: count } hash.
function top(hash, label = (key) => key, limit = 10) {
  return Object.entries(hash || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, n]) => label(key) + ' (' + n + ')')
    .join(', ');
}

// A Daily row from readDay (lib/event-stats.js). Day stays text: as a date the
// sheet would show it in its own time zone, a day off for UTC days.
export function dailyRow(stats) {
  const c = (name) => stats.count[name] || 0;
  const revenue = Object.entries(stats.revenue || {});
  return {
    Day: stats.day,
    Visitors: stats.visitors,
    Visits: c('visits'),
    'Visits without cookie consent': c('cookieless_visits'),
    'Page views': c('page_viewed'),
    'Product views': c('product_viewed'),
    'Collection views': c('collection_viewed'),
    Searches: c('search_submitted'),
    'Cart views': c('cart_viewed'),
    'Previews started': c('preview_started'),
    'Previews ready': c('preview_ready'),
    'Previews failed': c('preview_failed'),
    'Added to cart': c('product_added_to_cart'),
    'Checkouts started': c('checkout_started'),
    Orders: c('checkout_completed'),
    Revenue: revenue.length === 1 ? Math.round(revenue[0][1] * 100) / 100 : revenue.map(([cur, n]) => n + ' ' + cur).join(' + '),
    Currency: revenue.map(([cur]) => cur).join(', '),
    'Top sources': top(stats.sources),
    'Orders by source': top(stats.orderSources),
    'Top pages': top(stats.pages),
    'Top countries': top(stats.countries, (cc) => countryName(cc))
  };
}

// The preview page's follow-up (api/preview.js): { action: 'occasion',
// generation_id, occasion } when the parent picks or clears an occasion,
// { action: 'details', generation_id, details } when they leave the extra
// details field, and { action: 'cart', generation_id, occasion?, details?,
// variant } when they add the book to the cart. A cart message only sets what
// it has, so a shared link opened elsewhere can't clear the parent's answers.
// Returns { value: { generationId, fields } } or { error } for a 400.
export function previewFollowUp(body) {
  const b = body && typeof body === 'object' ? body : {};
  const generationId = oneLine(b.generation_id, 64);
  const occasion = oneLine(b.occasion, 40);
  const details = cleanDetails(b.details);
  if (!['occasion', 'details', 'cart'].includes(b.action)) return { error: 'bad-action' };
  if (!/^[A-Za-z0-9-]{1,64}$/.test(generationId)) return { error: 'bad-generation-id' };
  if (occasion && !OCCASIONS.includes(occasion)) return { error: 'bad-occasion' };

  const fields = {};
  if (b.action === 'occasion' || occasion) fields.Occasion = occasion;
  if (b.action === 'details' || details) fields['Extra details'] = details;
  if (b.action === 'cart') fields['Added to cart'] = oneLine(b.variant, 40) || 'Yes';
  return { value: { generationId, details, variant: fields['Added to cart'] || '', fields } };
}

// Posts to the sheet's script. Resolves to { ok, error, status }; never throws.
async function callSheet(payload) {
  try {
    const res = await fetch(process.env.SHEET_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: process.env.SHEET_WEBHOOK_SECRET, ...payload }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const json = await res.json().catch(() => null);
    if (res.ok && json && json.ok === true) return { ok: true };
    return { ok: false, status: res.status, error: (json && json.error) || '' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function reason(result) {
  return result.status ? 'sheet answered ' + result.status + (result.error ? ' ' + result.error : '') : result.error;
}

// #logs never shows the child's name or photo; the generation id finds the
// request in #previews or #custom-generation. Needed because these changes
// run after the response, where withReporting no longer looks.
async function reportLost(title, why, tab, generationId) {
  console.warn('[sheet] ' + title + ' (' + tab + '):', why);
  const last = lastReport.get(tab) || 0;
  if (Date.now() - last < REPORT_EVERY_MS) return;
  lastReport.set(tab, Date.now());
  await postToDiscord('logs', {
    embeds: [finish({
      color: COLORS.warn,
      author: { name: 'Requests sheet' + envTag() },
      title: '⚠️ ' + title,
      description: codeBlock(redact(why), 600),
      fields: [field('Tab', tab), generationId && field('Generation', code(generationId, 64))],
      timestamp: now()
    })]
  }).catch(() => null);
}

// Appends rows to a tab. Resolves true once the sheet has them, false
// otherwise; never throws and does nothing while the sheet is off, so a sheet
// problem can't fail a paid generation or an event.
export async function appendRows(tab, rows) {
  if (!sheetConfigured() || !rows.length) return false;
  const result = await callSheet({ tab, rows });
  if (result.ok) return true;
  await reportLost('Rows not added to the requests sheet', reason(result), tab, rows[0].Generation);
  return false;
}

// Sets fields on a tab's row for this generation, trying once more if the
// row isn't there yet. A row that never turns up (a preview from before the
// sheet existed) is left alone without a report. Same guarantees as appendRows.
export async function updateRow(tab, generationId, fields) {
  if (!sheetConfigured()) return false;
  const payload = { tab, update: { generation: generationId, set: fields } };
  let result = await callSheet(payload);
  if (!result.ok && result.error === 'not-found') {
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    result = await callSheet(payload);
  }
  if (result.ok) return true;
  if (result.error === 'not-found') {
    console.info('[sheet] no row for generation', generationId, 'in', tab);
    return false;
  }
  await reportLost('Row not updated in the requests sheet', reason(result), tab, generationId);
  return false;
}
