// Discord toolkit shared by the channel feeds (lib/report.js posts to #logs,
// lib/preview-feed.js to #previews): posting to a channel's incoming webhook,
// and the pieces their embeds are built from.
//
// Each channel has its own webhook in DISCORD_WEBHOOK_<CHANNEL>, e.g.
// DISCORD_WEBHOOK_LOGS. A channel whose variable is unset is off, so a new
// channel needs only its variable and a feed that posts to it.
//
// Anything a visitor can influence is shown in code spans or blocks, so it
// can't render as a link or formatting, and mentions are always disabled.
// redact() strips object keys and URL parameters that can carry a child's
// name.
//
// postToDiscord() never throws. It follows Discord's rate limit as each
// response reports it (X-RateLimit-* headers, retry_after on a 429) instead of
// a fixed number, as Discord asks. Each channel's posts go out one at a time,
// in order, so a burst queues for the webhook's window instead of colliding.
//
// Nothing is lost when Discord can't take a post in time (an outage, a burst
// longer than the function, a deleted webhook): it is saved in Upstash and
// sent after the channel's next successful post, oldest first, with its
// original timestamp. Only a post Discord rejects outright (an invalid embed)
// is discarded, with a warning.

import UAParser from 'ua-parser-js';
import { isbot, isbotMatch } from 'isbot';
import { getDeadline } from '@vercel/functions';

const TIMEOUT_MS = 2500;
// Never retry a 429 faster than this, whatever Discord's retry_after says.
const MIN_RETRY_MS = 250;
// How long a post may wait for room when no Vercel deadline is known (local runs).
const FALLBACK_WAIT_MS = 5000;
// Saved posts: one Redis list per channel, kept 30 days after the last
// addition (like the photos) and capped so Redis can't fill up.
const OUTBOX_KEY = 'kbf:discord:outbox:';
const OUTBOX_DAYS = 30;
const OUTBOX_MAX = 10000;
// Saved posts sent after each successful one, so a backlog shrinks steadily
// without holding up new posts for long.
const OUTBOX_BATCH = 25;

// Discord's embed limits. Descriptions stay well under their 4096 so the
// fields still fit in the 6000-character total.
const MAX_TITLE = 256;
const MAX_AUTHOR = 256;
export const MAX_DESCRIPTION = 3500;
const MAX_FIELDS = 25;
const MAX_FIELD_VALUE = 1024;
const MAX_FOOTER = 2048;
const MAX_TOTAL = 6000;

export const COLORS = { error: 0xed4245, warn: 0xf0b232, info: 0x5865f2, success: 0x57f287 };

// Per channel: the queue of posts, Discord's window for its webhook from the
// last response ({ remaining, resetAt }), posts dropped since the last one
// went out, and webhooks Discord no longer accepts (it asks clients to stop
// using those).
const queues = new Map();
const windows = new Map();
const dropped = new Map();
const rejected = new Set();
const guilds = new Map();
// Channels whose saved posts this instance has looked for, and those it knows
// have some.
const outboxChecked = new Set();
const outboxPending = new Set();
let outboxClient;

function webhookUrl(channel) {
  return process.env['DISCORD_WEBHOOK_' + channel.toUpperCase()] || '';
}

export function discordConfigured(channel) {
  return Boolean(webhookUrl(channel));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Records the window Discord reported for the channel's webhook.
function learnWindow(channel, res) {
  const header = (name) => {
    const value = res.headers.get(name);
    return value === null ? NaN : Number(value);
  };
  const remaining = header('x-ratelimit-remaining');
  const resetAfter = header('x-ratelimit-reset-after');
  if (Number.isFinite(remaining) && Number.isFinite(resetAfter)) {
    windows.set(channel, { remaining, resetAt: Date.now() + resetAfter * 1000 });
  }
}

// Waits until the channel's window has room. false when it reopens only after
// `giveUpAt`.
async function waitForRoom(channel, giveUpAt) {
  const w = windows.get(channel);
  if (!w || w.remaining > 0 || Date.now() >= w.resetAt) return true;
  if (w.resetAt > giveUpAt) return false;
  await sleep(w.resetAt - Date.now());
  return true;
}

export function clip(text, max) {
  const s = String(text);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// A backtick would close the span early; U+02CB looks the same.
function noTicks(text) {
  return String(text).replace(/`/g, 'ˋ');
}

export function code(text, max = 200) {
  const s = noTicks(String(text == null ? '' : text).replace(/\s+/g, ' ').trim());
  return s ? '`' + clip(s, max) + '`' : '—';
}

export function codeBlock(text, max) {
  return '```\n' + clip(noTicks(text), max - 8) + '\n```';
}

// Visitor text for a title, where code spans don't render: markdown and
// mention characters removed. Parentheses stay; without brackets they can't
// make a link.
export function plain(text) {
  return String(text == null ? '' : text).replace(/[*_~`|>#@<[\]\\]/g, '').replace(/\s+/g, ' ').trim();
}

// Photo and cover keys carry the child's name and age (lib/object-names.js),
// and some URL parameters carry a name or a token.
const REDACTIONS = [
  [/\b(photos|previews)\/[^\s"'`<>()[\]?#]+/g, '$1/…'],
  [/([?&](?:[a-z_]*token|name|b)=)[^&\s#"'`]*/gi, '$1…']
];

export function redact(text) {
  return REDACTIONS.reduce((s, [pattern, to]) => s.replace(pattern, to), String(text == null ? '' : text));
}

// Stack frames as lib/higgsfield.js:124:9 or assets/kb-start-personalising.js:940:27.
export function shortPaths(text) {
  return String(text)
    .split('file://' + process.cwd() + '/').join('')
    .split(process.cwd() + '/').join('')
    .replace(/https?:\/\/[^\s/]+\/cdn\/shop\/t\/\d+\//g, '')
    .replace(/\?v=\d+/g, '');
}

function header(req, name) {
  const value = req.headers && req.headers[name];
  return String((Array.isArray(value) ? value[0] : value) || '');
}

// Who sent a request. Vercel sets these headers and overwrites any the client
// sends.
export function visitorOf(req) {
  let city = header(req, 'x-vercel-ip-city');
  try { city = decodeURIComponent(city); } catch (e) { /* keep it as sent */ }
  return {
    // The rate limiter's key too (lib/ratelimit.js clientIp); not imported, to
    // keep Upstash out of functions that don't use it.
    ip: header(req, 'x-forwarded-for').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown',
    country: header(req, 'x-vercel-ip-country'),
    region: header(req, 'x-vercel-ip-country-region'),
    city,
    timezone: header(req, 'x-vercel-ip-timezone'),
    language: header(req, 'accept-language').split(',')[0].trim(),
    userAgent: header(req, 'user-agent'),
    origin: header(req, 'origin'),
    requestId: header(req, 'x-vercel-id')
  };
}

function flag(country) {
  return String.fromCodePoint(...[...country].map((c) => 0x1f1a5 + c.charCodeAt(0)));
}

let regionNames = null;
export function countryName(country) {
  try {
    regionNames = regionNames || new Intl.DisplayNames(['en'], { type: 'region' });
    return regionNames.of(country) || country;
  } catch (e) {
    return country;
  }
}

// "🇫🇷 France", or the code as given when it isn't one.
export function countryLabel(country) {
  return /^[A-Z]{2}$/.test(country) ? flag(country) + ' ' + countryName(country) : code(country, 10);
}

// "🇫🇷 France · IDF · Paris" with the IP's time zone below it.
export function place(v) {
  if (!/^[A-Z]{2}$/.test(v.country)) return 'unknown';
  const parts = [countryLabel(v.country)];
  if (/^[A-Z0-9]{1,3}$/.test(v.region)) parts.push(v.region);
  if (v.city) parts.push(/^[\p{L}\p{M}\p{N} .'’-]{1,60}$/u.test(v.city) ? v.city : code(v.city, 60));
  const zone = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(v.timezone) ? '\n' + v.timezone : '';
  return parts.join(' · ') + zone;
}

// Device label from maintained detection data: isbot for crawlers and
// scripts, ua-parser-js (v1, MIT; v2 is AGPL) for browsers, in-app browsers
// and phone models. Desktop browsers report frozen OS versions (Mac OS 10.15,
// Windows NT 10.0) and Chrome reports "Android 10; K" for every phone, so OS
// versions are shown only where they are real. The raw user agent is shown
// beside it.
export function deviceSummary(userAgent) {
  const ua = String(userAgent || '');
  if (!ua) return 'unknown';
  if (isbot(ua)) return '🤖 ' + (isbotMatch(ua) || 'bot');

  const { browser, os, device } = new UAParser(ua).getResult();
  const frozen = device.model === 'K';
  const mobile = device.type === 'mobile' || device.type === 'tablet';
  return [
    mobile && !frozen && device.model,
    [os.name, (os.name === 'iOS' || os.name === 'Android') && !frozen && os.version].filter(Boolean).join(' '),
    [browser.name, browser.major].filter(Boolean).join(' ')
  ].filter(Boolean).join(' · ') || 'unknown';
}

export function field(name, value, inline = true) {
  return { name, value: clip(value, MAX_FIELD_VALUE), inline };
}

// [visitor, ip, device, origin, userAgent]; origin and userAgent are false
// when the request had none.
export function visitorFields(v) {
  return [
    field('Visitor', place(v)),
    field('IP', code(v.ip, 64)),
    field('Device', deviceSummary(v.userAgent) + (v.language ? '\n' + code(v.language, 35) : '')),
    Boolean(v.origin) && field('Origin', code(v.origin, 120)),
    Boolean(v.userAgent) && field('User agent', code(v.userAgent, 300), false)
  ];
}

export function footer(requestId) {
  const commit = (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7);
  return { text: [process.env.VERCEL_ENV, process.env.VERCEL_REGION, commit, requestId].filter(Boolean).join(' · ') };
}

// Marks posts from preview and development deployments.
export function envTag() {
  const env = process.env.VERCEL_ENV;
  return env && env !== 'production' ? ' (' + env + ')' : '';
}

export function seconds(ms) {
  return (ms / 1000).toFixed(1) + ' s';
}

const ORDINAL_SUFFIX = { one: 'st', two: 'nd', few: 'rd', other: 'th' };
const ordinalRules = new Intl.PluralRules('en', { type: 'ordinal' });

// 1st, 2nd, 3rd, 11th, 22nd
export function ordinal(n) {
  return n + ORDINAL_SUFFIX[ordinalRules.select(n)];
}

// Enforces Discord's limits, trimming the description last.
export function finish(embed) {
  const out = { ...embed, fields: (embed.fields || []).filter(Boolean).slice(0, MAX_FIELDS) };
  if (out.title) out.title = clip(out.title, MAX_TITLE);
  if (out.author) out.author = { name: clip(out.author.name, MAX_AUTHOR) };
  if (out.footer && out.footer.text) out.footer = { text: clip(out.footer.text, MAX_FOOTER) };
  else delete out.footer;
  if (!out.description) delete out.description;

  const size = (e) => [e.title || '', e.description || '', e.author ? e.author.name : '', e.footer ? e.footer.text : '']
    .concat(e.fields.map((f) => f.name + f.value))
    .reduce((n, s) => n + s.length, 0);
  const over = size(out) - MAX_TOTAL;
  if (over > 0 && out.description) {
    // Descriptions that can grow are code blocks: re-wrap a shorter excerpt.
    const room = out.description.length - over - 1;
    if (room > 16) out.description = codeBlock(out.description.slice(4, -4), room);
    else delete out.description;
  }
  while (size(out) > MAX_TOTAL && out.fields.length) out.fields.pop();
  return out;
}

// Posts { embeds } to a channel, after the channel's earlier posts. With
// `wait`, resolves to the created message (a follow-up links to it by id);
// otherwise to true. Resolves to null when the channel is off or the post
// couldn't go out now (then it is saved and sent later).
export function postToDiscord(channel, message, { wait = false } = {}) {
  const url = webhookUrl(channel);
  if (!url) return Promise.resolve(null);

  // Read now, inside the request: the time left to wait and still send.
  const deadline = getDeadline();
  const giveUpAt = (deadline ? deadline.getTime() : Date.now() + FALLBACK_WAIT_MS) - TIMEOUT_MS;

  const send = () => sendInTurn(channel, url, message, wait, giveUpAt);
  const result = (queues.get(channel) || Promise.resolve()).then(send, send);
  queues.set(channel, result);
  return result;
}

// Sends one message once the channel's window has room. { ok, value } on
// success; otherwise { ok: false, retry }, where retry says whether it can
// go out later or Discord rejected the message itself.
async function deliver(channel, url, message, wait, giveUpAt) {
  while (Date.now() < giveUpAt && (await waitForRoom(channel, giveUpAt))) {
    let res;
    try {
      const target = new URL(url);
      if (wait) target.searchParams.set('wait', 'true');
      res = await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...message, allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch (err) {
      console.warn('[discord] ' + channel + ' post failed:', (err && err.message) || err);
      return { ok: false, retry: true };
    }
    learnWindow(channel, res);

    if (res.status === 429) {
      const json = await res.json().catch(() => ({}));
      const pause = Number(json.retry_after) || Number(res.headers.get('retry-after')) || 1;
      windows.set(channel, { remaining: 0, resetAt: Date.now() + Math.max(pause * 1000, MIN_RETRY_MS) });
      continue;
    }
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      rejected.add(channel);
      console.warn('[discord] ' + channel + ' webhook rejected (HTTP ' + res.status + '): posts are saved until a deploy with a working webhook');
      return { ok: false, retry: true };
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.warn('[discord] ' + channel + ' post failed: HTTP ' + res.status, detail.slice(0, 300));
      return { ok: false, retry: res.status >= 500 };
    }
    return { ok: true, value: wait ? await res.json() : true };
  }
  return { ok: false, retry: true };
}

function withFooterNote(message, note) {
  if (!message.embeds || !message.embeds.length) return message;
  const [first, ...rest] = message.embeds;
  return { ...message, embeds: [{ ...first, footer: { text: clip(first.footer ? first.footer.text + ' · ' + note : note, MAX_FOOTER) } }, ...rest] };
}

async function sendInTurn(channel, url, message, wait, giveUpAt) {
  const lost = dropped.get(channel) || 0;
  const outcome = rejected.has(channel)
    ? { ok: false, retry: true }
    : await deliver(channel, url, lost ? withFooterNote(message, lost + ' earlier lost') : message, wait, giveUpAt);

  if (outcome.ok) {
    if (lost) dropped.set(channel, 0);
    await sendSaved(channel, url, giveUpAt);
    return outcome.value;
  }
  if (outcome.retry) await saveForLater(channel, message);
  return null;
}

async function outboxRedis() {
  if (outboxClient !== undefined) return outboxClient;
  const { getRedis } = await import('./redis.js');
  return getRedis();
}

function markLost(channel, why) {
  dropped.set(channel, (dropped.get(channel) || 0) + 1);
  console.warn('[discord] ' + channel + ' post lost: ' + why);
}

async function saveForLater(channel, message) {
  const redis = await outboxRedis();
  if (!redis) return markLost(channel, 'Discord could not take it and Upstash is not configured to save it');
  const key = OUTBOX_KEY + channel;
  try {
    await redis.pipeline().rpush(key, message).ltrim(key, -OUTBOX_MAX, -1).expire(key, OUTBOX_DAYS * 86400).exec();
    outboxPending.add(channel);
    console.warn('[discord] ' + channel + ' post saved: it goes out after the next successful post');
  } catch (err) {
    markLost(channel, 'saving it failed: ' + ((err && err.message) || err));
  }
}

// Sends saved posts, oldest first, while Discord takes them and time allows.
// One instance at a time per channel, so none goes out twice.
async function sendSaved(channel, url, giveUpAt) {
  if (outboxChecked.has(channel) && !outboxPending.has(channel)) return;
  outboxChecked.add(channel);
  const redis = await outboxRedis();
  if (!redis) return;
  const key = OUTBOX_KEY + channel;
  const lock = key + ':lock';
  try {
    if (!(await redis.lrange(key, 0, 0)).length) {
      outboxPending.delete(channel);
      return;
    }
    outboxPending.add(channel);
    if (!(await redis.set(lock, 1, { nx: true, px: Math.max(1000, giveUpAt - Date.now() + TIMEOUT_MS) }))) return;
    try {
      for (let i = 0; i < OUTBOX_BATCH; i++) {
        const [saved] = await redis.lrange(key, 0, 0);
        if (!saved) {
          outboxPending.delete(channel);
          return;
        }
        const outcome = await deliver(channel, url, withFooterNote(saved, 'sent late'), false, giveUpAt);
        if (!outcome.ok && outcome.retry) return;
        await redis.lpop(key);
        if (!outcome.ok) console.warn('[discord] ' + channel + ' saved post discarded: Discord rejected it');
      }
    } finally {
      await redis.del(lock);
    }
  } catch (err) {
    console.warn('[discord] ' + channel + ' saved posts not sent:', (err && err.message) || err);
  }
}

// A link to a message the channel's webhook posted. Messages don't carry
// their server's id, so it comes from the webhook's own record, read once per
// instance. '' when unknown.
export async function messageLink(channel, message) {
  if (!message || !message.id || !message.channel_id) return '';
  let guild = message.guild_id || guilds.get(channel);
  if (!guild) {
    try {
      const res = await fetch(webhookUrl(channel), { signal: AbortSignal.timeout(TIMEOUT_MS) });
      guild = res.ok ? String((await res.json()).guild_id || '') : '';
    } catch (e) {
      guild = '';
    }
    if (guild) guilds.set(channel, guild);
  }
  return guild ? 'https://discord.com/channels/' + guild + '/' + message.channel_id + '/' + message.id : '';
}

// For tests: forget queues, rate limits, rejected webhooks, saved-post state
// and cached server ids.
export function resetDiscordThrottle() {
  queues.clear();
  windows.clear();
  dropped.clear();
  rejected.clear();
  guilds.clear();
  outboxChecked.clear();
  outboxPending.clear();
}

// For tests: the Redis client that holds saved posts (null for none).
export function setDiscordOutbox(client) {
  outboxClient = client;
}
