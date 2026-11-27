// Reports API problems and storefront errors to Discord's #logs channel
// (DISCORD_WEBHOOK_LOGS, through lib/discord.js) and to the requests sheet's
// Logs tab (lib/sheet.js), which keeps them for sorting and counting.
//
// Reports caused by bots and crawlers go to the bot reports stream instead
// (DISCORD_WEBHOOK_BOT_REPORTS, tab "Bot reports"), and errors in scripts that
// aren't the theme's (Shopify's, apps', extensions') from real visitors to the
// third-party stream (DISCORD_WEBHOOK_THIRD_PARTY, tab "Third party"), so
// #logs holds our own failures and real customers' problems. Who sent a
// request comes from lib/audience.js; a stream without a webhook posts to
// #logs.
//
// withReporting() wraps a route handler. Everything the request logs through
// console is recorded against it (AsyncLocalStorage), and once the response is
// sent the request is reported if it failed (status >= 400) or logged a
// warning or error: one message per request, with its log lines, what it
// asked for and who sent it (IP, country, device). The post runs after the
// response through waitUntil, so a shopper never waits on Discord or the sheet.
//
// Only whitelisted request fields are read - never the child's name, the
// photo key (which carries the name) or tokens - and logged text is redacted
// before it leaves.

import { AsyncLocalStorage } from 'node:async_hooks';
import { format } from 'node:util';
import { waitUntil } from '@vercel/functions';
import {
  COLORS, MAX_DESCRIPTION, clip, code, codeBlock, customerLink, discordConfigured, envTag, field, finish, footer,
  postToDiscord, redact, seconds, shortPaths, visitorFields, visitorOf
} from './discord.js';
import { verifyCustomerToken } from './customer-token.js';
import { bookLink, knownBookTitles } from './store-links.js';
import { TABS, appendRows, logRow, sheetConfigured } from './sheet.js';
import { Audience, agentLabel, resolveAudience } from './audience.js';
import { getRedis } from './redis.js';
import { Step, logStep } from './visitor-log.js';

const CHANNEL = 'logs';
// Where a report goes: its Discord channel (DISCORD_WEBHOOK_<CHANNEL>) and sheet tab.
const STREAMS = {
  logs: { channel: CHANNEL, tab: TABS.logs },
  botReports: { channel: 'bot_reports', tab: TABS.botReports },
  thirdParty: { channel: 'third_party', tab: TABS.thirdParty }
};
// Storefront codes for errors in scripts that aren't the theme's (kb-error-reporter.liquid).
const THIRD_PARTY_CODES = ['third-party-error', 'third-party-rejection', 'third-party-summary'];
const ICONS = { error: '🔴', warn: '🟠', info: 'ℹ️' };

// What most likely caused an error in a script that isn't the theme's, in
// words for whoever reads #third-party or the sheet. Shopify's scripts are
// its analytics, pixels and performance tracking: none of them draws the page.
const SHOPIFY_SCRIPT = /shopifycloud|shop-js|shop_events_listener|\/wpm\/|web-pixels|event-observer|monorail|trekkie|perf-kit/i;
const NETWORK_FAILURE = /failed to fetch|load failed|networkerror|importscripts|network request failed/i;

export function thirdPartyCause({ message = '', stack = '', context = {} } = {}) {
  const text = [message, stack, context.script].filter(Boolean).join('\n');
  const shopify = SHOPIFY_SCRIPT.test(text);
  if (NETWORK_FAILURE.test(text)) {
    return (shopify ? "Shopify's own analytics or pixel script" : 'A script that isn\'t the theme\'s (an app, a pixel or a browser extension)') +
      ' lost a network request in the visitor\'s browser: usually an ad blocker, a weak connection or the page closing mid-request.' +
      ' The page kept working; nothing to fix on our side.';
  }
  return (shopify ? "An error inside Shopify's own scripts, often from an old or unusual browser." : 'An error in a script that isn\'t the theme\'s (an app, a pixel or a browser extension).') +
    ' The theme isn\'t involved; nothing to fix on our side.';
}
const requests = new AsyncLocalStorage();
const MAX_NOTES = 30;
const MAX_NOTE_CHARS = 4000;

// Node prints its own warnings through console.error, once per process. A
// deprecation in a dependency or the Vercel runtime is not a failed request.
const NODE_DEPRECATION = /^\(node:\d+\) \[DEP\d+\] DeprecationWarning:/;

function record(ctx, level, args) {
  if (ctx.notes.length >= MAX_NOTES) return;
  if (typeof args[0] === 'string' && NODE_DEPRECATION.test(args[0])) level = 'info';
  ctx.notes.push({ level, at: Date.now() - ctx.startedAt, text: format(...args).slice(0, MAX_NOTE_CHARS) });
}

// Console output still goes to the Vercel logs as before; inside a wrapped
// request it is also kept for that request's report.
const PATCHED = Symbol.for('kbf.report.console');
if (!console[PATCHED]) {
  console[PATCHED] = true;
  for (const [method, level] of [['log', 'info'], ['info', 'info'], ['warn', 'warn'], ['error', 'error']]) {
    const print = console[method];
    console[method] = function (...args) {
      print.apply(console, args);
      const ctx = requests.getStore();
      try {
        if (ctx) record(ctx, level, args);
      } catch (e) { /* a report must never break logging */ }
    };
  }
}

// The stream for a report from `who` (lib/audience.js) with a storefront
// code: bots and crawlers to the bot reports, other people's scripts to the
// third-party stream, everything else to #logs.
export function streamFor(who, code) {
  if (who.audience !== Audience.human) return STREAMS.botReports;
  if (THIRD_PARTY_CODES.includes(code)) return STREAMS.thirdParty;
  return STREAMS.logs;
}

// A stream whose webhook isn't set posts to #logs instead, so nothing is lost.
function channelFor(stream) {
  return discordConfigured(stream.channel) ? stream.channel : CHANNEL;
}

// build(who) returns { embed, row } or null. Runs after the response; a bug in
// building a report must never fail the request it describes.
function deliver(visitor, code, build) {
  if (!sheetConfigured() && !Object.values(STREAMS).some((s) => discordConfigured(s.channel))) return;
  waitUntil((async () => {
    try {
      const who = await resolveAudience(visitor);
      const stream = streamFor(who, code);
      const report = build(who);
      if (!report) return;
      // A person's errors join their timeline; their 429s already have their own step.
      const step = stream === STREAMS.logs && who.audience === Audience.human && code !== 'rate-limited'
        ? logStep(getRedis(), visitor, { kind: Step.error, text: [code, report.row.Where].filter(Boolean).join(' · ') })
        : null;
      await Promise.all([
        step,
        postToDiscord(channelFor(stream), { embeds: [report.embed] }),
        // A failed append is reported to #logs by lib/sheet.js, never back here.
        sheetConfigured() && appendRows(stream.tab, [report.row])
      ]);
    } catch (e) {
      console.error('[report] could not build the report:', (e && e.stack) || e);
    }
  })());
}

// The agent behind a bot or crawler report; nothing for a person.
function agentField(who) {
  return Boolean(who && who.audience !== Audience.human) && field('Agent', agentLabel(who));
}

function agentColumn(who) {
  return who && who.audience !== Audience.human ? { Agent: agentLabel(who) } : {};
}

// The request's console lines: offset, level, text.
function timelineText(notes) {
  return notes.map((n) => {
    const text = shortPaths(redact(n.text)).split('\n').slice(0, 10).join('\n');
    return '+' + seconds(n.at).replace(' ', '') + ' ' + n.level.toUpperCase().padEnd(5) + ' ' + clip(text, 900);
  }).join('\n');
}

function timeline(notes) {
  return notes.length ? codeBlock(timelineText(notes), MAX_DESCRIPTION) : '';
}

// A sheet cell holds 50,000 characters; this keeps rows readable.
const MAX_DETAILS = 5000;
const LEVELS = { error: 'Error', warn: 'Warning', info: 'Info' };

export function apiRow(r, who) {
  const req = r.request || {};
  return logRow({
    Source: 'API',
    Level: LEVELS[r.level],
    Where: r.method + ' ' + r.path,
    Status: r.status,
    Code: r.code || '',
    Details: clip(timelineText(r.notes), MAX_DETAILS),
    Seconds: Math.round(r.durationMs / 100) / 10,
    Book: (req.book && knownBookTitles().get(req.book)) || req.book || '',
    Generation: req.generation || '',
    Customer: r.customer || 'anonymous',
    Origin: r.visitor.origin,
    'Request ID': r.visitor.requestId,
    ...agentColumn(who)
  }, r.visitor);
}

export function webRow(e, v, who) {
  const context = Object.entries(e.context).map(([key, value]) => label(key) + ': ' + redact(value));
  const detail = e.stack && e.stack.indexOf(e.message) !== -1 ? e.stack : [e.message, e.stack].filter(Boolean).join('\n');
  return logRow({
    Source: 'Storefront',
    Level: LEVELS[e.level],
    Where: e.page || '/',
    Status: '',
    Code: e.code,
    ...(e.cause ? { Cause: e.cause } : {}),
    Details: clip(shortPaths(redact([detail].concat(context).filter(Boolean).join('\n'))), MAX_DETAILS),
    Origin: v.origin,
    'Request ID': v.requestId,
    ...agentColumn(who)
  }, v);
}

// One API request: { level, method, path, status, code, notes, durationMs,
// request: { book, generation, language, photo }, customer, visitor }; who is
// the sender (lib/audience.js), named when it isn't a person.
export function apiEmbed(r, who) {
  const req = r.request || {};
  const [visitor, ip, device, origin, userAgent] = visitorFields(r.visitor);
  return finish({
    color: COLORS[r.level],
    author: { name: 'API' + envTag() + ' · ' + r.method + ' ' + r.path },
    title: ICONS[r.level] + ' ' + r.status + (r.code ? ' ' + r.code : ''),
    description: timeline(r.notes),
    fields: [
      visitor, ip, device, agentField(who),
      field('Customer', r.customerId ? 'signed in · ' + customerLink(r.customerId) : r.customer || 'anonymous'),
      req.book && field('Book', bookLink(req.book, knownBookTitles())),
      req.generation && field('Generation', code(req.generation, 64)),
      req.language && field('Language', code(req.language, 12)),
      req.photo && field('Photo', code(req.photo, 60)),
      field('Duration', seconds(r.durationMs)),
      origin, userAgent
    ],
    footer: footer(r.visitor.requestId),
    timestamp: new Date().toISOString()
  });
}

function label(key) {
  const words = key.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// One storefront report (normaliseClientEvent) from a visitor.
export function webEmbed(e, v, who) {
  // Browsers start the stack with the message; don't print it twice.
  const detail = e.stack && e.stack.indexOf(e.message) !== -1 ? e.stack : [e.message, e.stack].filter(Boolean).join('\n');
  const [visitor, ip, device, origin, userAgent] = visitorFields(v);
  return finish({
    color: COLORS[e.level],
    author: { name: 'Storefront' + envTag() + ' · ' + (e.page || '/') },
    title: ICONS[e.level] + ' ' + e.code,
    description: detail ? codeBlock(shortPaths(redact(detail)), MAX_DESCRIPTION) : '',
    fields: [e.cause && field('Cause', e.cause, false)]
      .concat(Object.entries(e.context).map(([key, value]) => field(label(key), code(redact(value), 160))))
      .concat([visitor, ip, device, agentField(who), origin, userAgent]),
    footer: footer(v.requestId),
    timestamp: new Date().toISOString()
  });
}

// The parsed body, or the query for a GET. The platform's body getter throws
// on invalid JSON, which the handler has answered by now.
function requestInput(req) {
  try {
    let input = req.method === 'GET' ? req.query : req.body;
    if (typeof input === 'string') input = JSON.parse(input);
    return input && typeof input === 'object' ? input : {};
  } catch (e) {
    return {};
  }
}

function verifiedCustomerId(input) {
  if (!input.customer_token) return '';
  const customer = verifyCustomerToken(input);
  return customer.valid ? customer.customerId : '';
}

function customerLabel(input) {
  if (!input.customer_token) return 'anonymous';
  const customer = verifyCustomerToken(input);
  return customer.valid ? 'signed in · ' + customer.customerId : 'anonymous · token rejected';
}

function requestReport(req, status, ctx) {
  const failed = status >= 400;
  if (!failed && !ctx.notes.some((n) => n.level !== 'info')) return null;

  const input = requestInput(req);
  const str = (value) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '');
  const size = Number(input.size);
  return {
    level: status >= 500 || ctx.notes.some((n) => n.level === 'error') ? 'error' : 'warn',
    method: req.method,
    path: String(req.url || '').split('?')[0],
    status,
    code: ctx.body && typeof ctx.body.error === 'string' ? ctx.body.error : '',
    notes: ctx.notes,
    durationMs: Date.now() - ctx.startedAt,
    request: {
      book: str(input.theme_id),
      generation: str(input.generation_id),
      language: str(input.language),
      photo: input.content_type ? str(input.content_type) + (size > 0 ? ' · ' + (size / 1048576).toFixed(1) + ' MB' : '') : ''
    },
    customer: customerLabel(input),
    customerId: verifiedCustomerId(input),
    visitor: visitorOf(req)
  };
}

export function withReporting(handler) {
  return async function reportedHandler(req, res) {
    const ctx = { startedAt: Date.now(), notes: [], body: undefined };
    const json = res.json;
    if (typeof json === 'function') {
      res.json = function (body) {
        ctx.body = body;
        return json.call(this, body);
      };
    }

    try {
      await requests.run(ctx, () => handler(req, res));
    } catch (err) {
      // A crash, or the platform's 400 for an invalid JSON body. Answering here
      // keeps the CORS headers, so the storefront can read the error.
      const status = err && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
      requests.run(ctx, () => (status === 500 ? console.error : console.warn)('[api] unhandled:', err));
      if (!res.headersSent) res.status(status).json({ error: status === 500 ? 'internal-error' : 'bad-request' });
    }

    try {
      const report = requestReport(req, res.statusCode, ctx);
      if (report) deliver(report.visitor, report.code, (who) => ({ embed: apiEmbed(report, who), row: apiRow(report, who) }));
    } catch (e) {
      console.error('[report] could not build the report:', (e && e.stack) || e);
    }
  };
}

const MAX_CONTEXT = 16;

// Validates a storefront report (api/log.js). Returns null when unusable.
export function normaliseClientEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const code = String(raw.code || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/.test(code)) return null;

  const context = {};
  if (raw.context && typeof raw.context === 'object' && !Array.isArray(raw.context)) {
    for (const [key, value] of Object.entries(raw.context)) {
      if (Object.keys(context).length >= MAX_CONTEXT) break;
      if (!/^[a-z][a-z0-9_]{0,23}$/.test(key)) continue;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        const text = String(value).trim().slice(0, 160);
        if (text) context[key] = text;
      }
    }
  }

  const page = String(raw.page || '').split(/[?#]/)[0].slice(0, 200);
  const event = {
    level: raw.level === 'warn' ? 'warn' : 'error',
    code,
    message: String(raw.message || '').slice(0, 500),
    stack: String(raw.stack || '').slice(0, 2000),
    page: /^\/\S*$/.test(page) ? page : '',
    context
  };
  // Other people's scripts are information, whatever level the page sent.
  if (THIRD_PARTY_CODES.includes(code)) {
    event.level = 'info';
    event.cause = thirdPartyCause(event);
  }
  return event;
}

export function reportClientEvent(req, event) {
  (event.level === 'info' ? console.log : console.warn)('[web] ' + event.level + ' ' + event.code + (event.message ? ': ' + event.message : ''));
  const v = visitorOf(req);
  deliver(v, event.code, (who) => ({ embed: webEmbed(event, v, who), row: webRow(event, v, who) }));
}

// When each IP past the storefront report limit may get another notice. Per
// instance, so a visitor spread over several instances gets one from each.
const noticed = new Map();
const NOTICE_EVERY_MS = 60 * 60 * 1000;

// Once a visitor passes the hourly limit (api/log.js answers 429), posts one
// notice per IP per hour instead of one per rejected report.
export function reportClientLimit(req) {
  const v = visitorOf(req);
  const now = Date.now();
  if (noticed.get(v.ip) > now) return;
  for (const [ip, until] of noticed) if (until <= now) noticed.delete(ip);
  noticed.set(v.ip, now + NOTICE_EVERY_MS);
  deliver(v, 'reports-muted', (who) => {
    const [visitor, ip, device, origin, userAgent] = visitorFields(v);
    const row = logRow({
      Source: 'Storefront',
      Level: 'Warning',
      Where: '',
      Status: 429,
      Code: 'reports-muted',
      Details: 'More than the hourly limit of storefront reports; the rest from this IP are not posted this hour.',
      Origin: v.origin,
      'Request ID': v.requestId,
      ...agentColumn(who)
    }, v);
    const embed = finish({
      color: COLORS.warn,
      author: { name: 'Storefront' + envTag() },
      title: ICONS.warn + ' Storefront reports muted for this visitor',
      description: 'This visitor sent more than the hourly limit of storefront reports. Further reports from this IP are not posted this hour.',
      fields: [visitor, ip, device, agentField(who), origin, userAgent],
      footer: footer(v.requestId),
      timestamp: new Date().toISOString()
    });
    return { embed, row };
  });
}
