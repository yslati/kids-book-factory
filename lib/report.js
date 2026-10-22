// Reports API problems and storefront errors to Discord's #logs channel
// (DISCORD_WEBHOOK_LOGS, through lib/discord.js).
//
// withReporting() wraps a route handler. Everything the request logs through
// console is recorded against it (AsyncLocalStorage), and once the response is
// sent the request is reported if it failed (status >= 400) or logged a
// warning or error: one message per request, with its log lines, what it
// asked for and who sent it (IP, country, device). The post runs after the
// response through waitUntil, so a shopper never waits on Discord.
//
// Only whitelisted request fields are read - never the child's name, the
// photo key (which carries the name) or tokens - and logged text is redacted
// before it leaves.

import { AsyncLocalStorage } from 'node:async_hooks';
import { format } from 'node:util';
import { waitUntil } from '@vercel/functions';
import {
  COLORS, MAX_DESCRIPTION, clip, code, codeBlock, discordConfigured, envTag, field, finish, footer,
  postToDiscord, redact, seconds, shortPaths, visitorFields, visitorOf
} from './discord.js';
import { verifyCustomerToken } from './customer-token.js';

const CHANNEL = 'logs';
const ICONS = { error: '🔴', warn: '🟠' };
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

// A bug in building a report must never fail the request it describes.
function deliver(build) {
  if (!discordConfigured(CHANNEL)) return;
  try {
    const embed = build();
    if (embed) waitUntil(postToDiscord(CHANNEL, { embeds: [embed] }));
  } catch (e) {
    console.error('[report] could not build the report:', (e && e.stack) || e);
  }
}

// The request's console lines as a log excerpt: offset, level, text.
function timeline(notes) {
  if (!notes.length) return '';
  const lines = notes.map((n) => {
    const text = shortPaths(redact(n.text)).split('\n').slice(0, 10).join('\n');
    return '+' + seconds(n.at).replace(' ', '') + ' ' + n.level.toUpperCase().padEnd(5) + ' ' + clip(text, 900);
  });
  return codeBlock(lines.join('\n'), MAX_DESCRIPTION);
}

// One API request: { level, method, path, status, code, notes, durationMs,
// request: { book, generation, language, photo }, customer, visitor }.
export function apiEmbed(r) {
  const req = r.request || {};
  const [visitor, ip, device, origin, userAgent] = visitorFields(r.visitor);
  return finish({
    color: COLORS[r.level],
    author: { name: 'API' + envTag() + ' · ' + r.method + ' ' + r.path },
    title: ICONS[r.level] + ' ' + r.status + (r.code ? ' ' + r.code : ''),
    description: timeline(r.notes),
    fields: [
      visitor, ip, device,
      field('Customer', r.customer || 'anonymous'),
      req.book && field('Book', code(req.book, 80)),
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
export function webEmbed(e, v) {
  // Browsers start the stack with the message; don't print it twice.
  const detail = e.stack && e.stack.indexOf(e.message) !== -1 ? e.stack : [e.message, e.stack].filter(Boolean).join('\n');
  return finish({
    color: COLORS[e.level],
    author: { name: 'Storefront' + envTag() + ' · ' + (e.page || '/') },
    title: ICONS[e.level] + ' ' + e.code,
    description: detail ? codeBlock(shortPaths(redact(detail)), MAX_DESCRIPTION) : '',
    fields: Object.entries(e.context)
      .map(([key, value]) => field(label(key), code(redact(value), 160)))
      .concat(visitorFields(v)),
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

    deliver(() => {
      const report = requestReport(req, res.statusCode, ctx);
      return report && apiEmbed(report);
    });
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
  return {
    level: raw.level === 'warn' ? 'warn' : 'error',
    code,
    message: String(raw.message || '').slice(0, 500),
    stack: String(raw.stack || '').slice(0, 2000),
    page: /^\/\S*$/.test(page) ? page : '',
    context
  };
}

export function reportClientEvent(req, event) {
  console.warn('[web] ' + event.level + ' ' + event.code + (event.message ? ': ' + event.message : ''));
  deliver(() => webEmbed(event, visitorOf(req)));
}

// When each IP past the storefront report limit may get another notice. Per
// instance, so a visitor spread over several instances gets one from each.
const noticed = new Map();
const NOTICE_EVERY_MS = 60 * 60 * 1000;

// Once a visitor passes the hourly limit (api/log.js answers 429), posts one
// notice per IP per hour instead of one per rejected report.
export function reportClientLimit(req) {
  deliver(() => {
    const v = visitorOf(req);
    const now = Date.now();
    if (noticed.get(v.ip) > now) return null;
    for (const [ip, until] of noticed) if (until <= now) noticed.delete(ip);
    noticed.set(v.ip, now + NOTICE_EVERY_MS);
    return finish({
      color: COLORS.warn,
      author: { name: 'Storefront' + envTag() },
      title: ICONS.warn + ' Storefront reports muted for this visitor',
      description: 'This visitor sent more than the hourly limit of storefront reports. Further reports from this IP are not posted this hour.',
      fields: visitorFields(v),
      footer: footer(v.requestId),
      timestamp: new Date().toISOString()
    });
  });
}
