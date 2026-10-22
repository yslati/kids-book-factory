// The #higgsfield channel (DISCORD_WEBHOOK_HIGGSFIELD): the Higgsfield
// account behind the covers.
//
// Live, from real cover jobs (lib/generate.js): an alert when Higgsfield
// refuses a job for a reason that won't fix itself: out of credits (403), key
// rejected (401), model not found, blocked or disabled (404, 423, 503). Each
// goes out at most once an hour per problem.
//
// Daily (api/cron/higgsfield.js): whether the key works, whether each model in
// the cover chain is still offered and accepted, price changes in
// Higgsfield's free /estimate quote, models added to or removed from the
// account's catalog, and the previous UTC day's jobs per model.
//
// Higgsfield has no API for the account balance, so running out shows up as
// the live 403 alert, not as a low-balance warning.
//
// Upstash: kbf:hf:jobs:<day> counts each attempt's outcome (40 days);
// kbf:hf:catalog and kbf:hf:prices hold what the last check saw.

import { COLORS, clip, code, discordConfigured, envTag, field, finish, footer, plain, postToDiscord, seconds } from './discord.js';
import { dayOf } from './event-stats.js';
import { estimateHiggsfieldCover, listHiggsfieldModels } from './higgsfield.js';

const CHANNEL = 'higgsfield';
const CONSOLE_URL = 'https://console.higgsfield.ai';
const JOBS_KEY = 'kbf:hf:jobs:';
const JOBS_SECONDS = 40 * 24 * 60 * 60;
const ALERT_KEY = 'kbf:hf:alert:';
const ALERT_SECONDS = 60 * 60;
const CATALOG_KEY = 'kbf:hf:catalog';
const PRICES_KEY = 'kbf:hf:prices';
const CHECK_KEY = 'kbf:hf:check:';
const DAY_MS = 24 * 60 * 60 * 1000;
// Room left in a 4096-character description for the "…and N more" line.
const LIST_CHARS = 3300;

// Submit statuses that fail every job until someone acts. Account-wide ones
// alert once for all models.
const ALERTS = {
  401: { title: '🔑 API key rejected', account: true, text: 'Higgsfield refused HIGGSFIELD_KEY. Every cover fails until a working key is set in Vercel.' },
  403: { title: '💸 Out of credits', account: true, text: 'Higgsfield refused a cover for lack of credits. Every cover fails until the API balance is topped up.' },
  404: { title: '🚫 Model not found', text: 'Higgsfield no longer offers this model to the account. Covers fall through to the next model in the chain.' },
  423: { title: '⏸️ Model temporarily blocked', text: 'Higgsfield has blocked this model for now. Covers fall through to the next model in the chain.' },
  503: { title: '🛑 Model disabled', text: 'Higgsfield reports this model disabled or not ready. Covers fall through to the next model in the chain.' }
};

const STATUS_TEXT = { 0: 'unreachable', 401: 'key rejected', 403: 'refused (403)', 404: 'not found', 423: 'blocked', 503: 'disabled' };

// Alerts sent by an instance without Redis, and job keys it has set to expire.
const alertedAt = new Map();
const expiring = new Set();

export function higgsfieldChannelOn() {
  return discordConfigured(CHANNEL);
}

function label(attempt) {
  return [attempt.model, attempt.quality].filter(Boolean).join(' ');
}

// What became of a job: 'completed', or the error lib/higgsfield.js threw
// without its prefix ('failed', 'nsfw', 'timeout', 'submit-403'...).
export function jobOutcome(err) {
  if (!err) return 'completed';
  const match = /^higgsfield-([a-z0-9-]+)$/.exec(String(err.message || ''));
  if (match) return match[1];
  return err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : 'error';
}

function outcomeText(outcome) {
  const refused = /^submit-(\d+)$/.exec(outcome);
  return refused ? 'refused ' + refused[1] : outcome;
}

// Counts a finished attempt and alerts when Higgsfield refused it for good.
// err is null for a completed job. Never throws.
export async function trackHiggsfieldJob(redis, attempt, err, ms) {
  const outcome = jobOutcome(err);
  if (redis) {
    const key = JOBS_KEY + dayOf();
    try {
      const pipe = redis.pipeline().hincrby(key, label(attempt) + '|' + outcome, 1);
      if (outcome === 'completed') pipe.hincrby(key, label(attempt) + '|ms', Math.round(ms));
      if (!expiring.has(key)) {
        pipe.expire(key, JOBS_SECONDS);
        expiring.add(key);
      }
      await pipe.exec();
    } catch (e) {
      console.warn('[higgsfield-feed] job not counted:', (e && e.message) || e);
    }
  }
  const refused = /^submit-(\d+)$/.exec(outcome);
  if (refused && ALERTS[refused[1]]) await sendAlert(redis, Number(refused[1]), attempt);
}

// true the first time a problem is seen within the hour.
async function firstAlert(redis, key) {
  if (redis) {
    try {
      return Boolean(await redis.set(key, 1, { nx: true, ex: ALERT_SECONDS }));
    } catch (e) { /* fall back to this instance's memory */ }
  }
  if (Date.now() - (alertedAt.get(key) || 0) < ALERT_SECONDS * 1000) return false;
  alertedAt.set(key, Date.now());
  return true;
}

async function sendAlert(redis, status, attempt) {
  if (!higgsfieldChannelOn()) return;
  const alert = ALERTS[status];
  if (!(await firstAlert(redis, ALERT_KEY + status + (alert.account ? '' : ':' + attempt.model)))) return;
  await postToDiscord(CHANNEL, {
    embeds: [finish({
      color: COLORS.error,
      author: { name: 'Higgsfield alert' + envTag() },
      title: alert.title,
      url: CONSOLE_URL,
      description: alert.text,
      fields: [
        field('Model', code(label(attempt), 120)),
        field('HTTP status', String(status)),
        field('Repeats', 'muted for an hour')
      ],
      footer: footer(),
      timestamp: new Date().toISOString()
    })]
  });
}

// A day's jobs as { label: { completed, failed, ..., ms } }.
async function readJobs(redis, day) {
  const jobs = {};
  for (const [key, value] of Object.entries((await redis.hgetall(JOBS_KEY + day)) || {})) {
    const cut = key.lastIndexOf('|');
    const name = key.slice(0, cut);
    jobs[name] = jobs[name] || {};
    jobs[name][key.slice(cut + 1)] = Number(value) || 0;
  }
  return jobs;
}

function quoteText(quote) {
  if (!quote) return 'no quote';
  if (quote.type === 'estimate') return quote.credits + ' credits ($' + quote.usd + ')';
  if (quote.type === 'description') return 'token-priced';
  return code(JSON.stringify(quote), 200);
}

// Upstash returns stored JSON parsed, so compare in one serialised form.
function asJson(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function quoteDetail(json) {
  let quote;
  try { quote = JSON.parse(json); } catch (e) { return code(json, 300); }
  return quoteText(quote) + (quote && quote.pricing_description ? '\n' + clip(plain(quote.pricing_description), 400) : '');
}

function playground(slug) {
  return CONSOLE_URL + '/models/' + encodeURIComponent(slug) + '/playground';
}

// Lines joined until the description would be too long, then a count of the rest.
function listText(lines) {
  let text = '';
  for (let i = 0; i < lines.length; i++) {
    if (text.length + lines[i].length > LIST_CHARS) return text + '…and ' + (lines.length - i) + ' more';
    text += lines[i] + '\n';
  }
  return text.trim();
}

function plural(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

// The check's messages: the daily status first, then any new models, removed
// models and price changes. Pure, so it can be tested without the network.
// catalog is listHiggsfieldModels()'s result, quotes estimateHiggsfieldCover()'s
// per attempt (or { status: 0, error } when unreachable); previousCatalog
// ({ slug: title }) and previousPrices ({ label: quote JSON }) are what the
// last check saw, null on the first.
export function checkMessages({ day, attempts, catalog, quotes, previousCatalog, previousPrices, jobs }) {
  const problems = [];
  const time = { footer: footer(), timestamp: new Date().toISOString() };
  const models = catalog.models;

  let keyText = '✅ accepted';
  if (catalog.status === 401) {
    keyText = '❌ rejected';
    problems.push('Higgsfield rejected HIGGSFIELD_KEY');
  } else if (!models) {
    keyText = '⚠️ catalog unreachable (' + (catalog.error ? code(catalog.error, 80) : 'HTTP ' + catalog.status) + ')';
    problems.push('the model catalog could not be read');
  }

  const modelLines = attempts.map((attempt, i) => {
    const q = quotes[i];
    const listed = models ? models.some((m) => m.slug === attempt.model) : null;
    let state = '✅';
    let why = '';
    if (q.status !== 200) {
      state = '❌';
      why = q.error ? 'unreachable' : STATUS_TEXT[q.status] || 'HTTP ' + q.status;
    } else if (listed === false) {
      state = '❌';
      why = 'missing from the catalog';
    }
    if (why) problems.push(label(attempt) + ': ' + why);
    return state + ' ' + code(label(attempt), 80) + ' · ' + (why || quoteText(q.quote));
  });

  const priceChanges = [];
  attempts.forEach((attempt, i) => {
    const q = quotes[i];
    const before = previousPrices && previousPrices[label(attempt)];
    if (q.status !== 200 || before == null) return;
    const now = JSON.stringify(q.quote);
    if (asJson(before) !== now) priceChanges.push(field(label(attempt), '**Before:** ' + quoteDetail(asJson(before)) + '\n**After:** ' + quoteDetail(now), false));
  });

  let added = [];
  let removed = [];
  let catalogText = '—';
  if (models) {
    const count = (type) => models.filter((m) => m.output_type === type).length;
    catalogText = plural(models.length, 'model') + ' · ' + count('image') + ' image · ' + count('video') + ' video';
    if (previousCatalog) {
      added = models.filter((m) => !(m.slug in previousCatalog));
      const now = new Set(models.map((m) => m.slug));
      removed = Object.keys(previousCatalog).filter((slug) => !now.has(slug));
      catalogText += '\n' + added.length + ' new · ' + removed.length + ' removed since the last check';
    } else {
      catalogText += '\nFirst check: new models are posted from the next one on';
    }
  }

  const prices = Object.fromEntries(attempts.map((a, i) => [label(a), quotes[i].quote]));
  const jobLines = Object.entries(jobs).sort().map(([name, j]) => {
    const done = j.completed || 0;
    const quote = prices[name];
    const parts = [done + ' done' + (done ? ' (avg ' + seconds((j.ms || 0) / done) + ')' : '')];
    if (done && quote && quote.type === 'estimate') parts[0] += ' ≈ $' + (done * Number(quote.usd)).toFixed(2);
    for (const [outcome, n] of Object.entries(j)) {
      if (outcome !== 'completed' && outcome !== 'ms') parts.push(n + ' ' + outcomeText(outcome));
    }
    return code(name, 80) + ' · ' + parts.join(' · ');
  });

  const date = new Date(day + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const embeds = [finish({
    color: problems.length ? COLORS.error : COLORS.success,
    author: { name: 'Higgsfield daily check' + envTag() },
    title: '🩺 ' + date,
    url: CONSOLE_URL,
    description: problems.length ? problems.map((p) => '❌ ' + p).join('\n') : '✅ Key, cover models and catalog all fine',
    fields: [
      field('API key', keyText),
      field('Catalog', catalogText),
      field('Cover models', modelLines.join('\n') || '—', false),
      field('Jobs the day before (UTC)', jobLines.join('\n') || 'none', false),
      field('Balance', "Higgsfield's API can't report it: see the [console](" + CONSOLE_URL + '). Running out posts an alert here at once.', false)
    ],
    ...time
  })];

  if (added.length) {
    embeds.push(finish({
      color: COLORS.info,
      author: { name: 'Higgsfield catalog' + envTag() },
      title: '🆕 ' + plural(added.length, 'new model'),
      description: listText(added.map((m) => '**' + plain(m.title) + '** · ' + plain(m.output_type) + ' · [' + code(m.slug, 100) + '](' + playground(m.slug) + ')' +
        (m.description ? '\n' + clip(plain(m.description), 160) : ''))),
      ...time
    }));
  }
  if (removed.length) {
    embeds.push(finish({
      color: COLORS.warn,
      author: { name: 'Higgsfield catalog' + envTag() },
      title: '👋 ' + plural(removed.length, 'model') + ' removed',
      description: listText(removed.map((slug) => '**' + plain(previousCatalog[slug]) + '** · ' + code(slug, 100))),
      ...time
    }));
  }
  if (priceChanges.length) {
    embeds.push(finish({
      color: COLORS.warn,
      author: { name: 'Higgsfield prices' + envTag() },
      title: '💲 ' + (priceChanges.length === 1 ? 'A cover model' : priceChanges.length + ' cover models') + ' changed price',
      fields: priceChanges,
      ...time
    }));
  }
  return { embeds, problems };
}

function unreachable(promise) {
  return promise.catch((err) => ({ status: 0, models: null, quote: null, error: String((err && err.message) || err) }));
}

// Runs the daily check and posts it. attempts are the chain's Higgsfield
// entries; repeated ones are checked once. Resolves to null when today's
// check already ran (unless force), else { problems, posted }.
export async function runHiggsfieldCheck(redis, chainAttempts, { now = new Date(), force = false } = {}) {
  if (!force && !(await redis.set(CHECK_KEY + dayOf(now), 1, { nx: true, ex: 2 * 24 * 60 * 60 }))) return null;

  const attempts = [...new Map(chainAttempts.map((a) => [label(a), a])).values()];
  const day = dayOf(new Date(now.getTime() - DAY_MS));
  const [catalog, quotes, previousCatalog, previousPrices, jobs] = await Promise.all([
    unreachable(listHiggsfieldModels()),
    Promise.all(attempts.map((a) => unreachable(estimateHiggsfieldCover(a.model, a.quality)))),
    redis.get(CATALOG_KEY),
    redis.hgetall(PRICES_KEY),
    readJobs(redis, day)
  ]);

  const { embeds, problems } = checkMessages({ day, attempts, catalog, quotes, previousCatalog, previousPrices, jobs });
  let posted = true;
  for (const embed of embeds) posted = Boolean(await postToDiscord(CHANNEL, { embeds: [embed] })) && posted;

  // What this check saw becomes the next one's baseline; a failed read keeps the old one.
  if (catalog.models) await redis.set(CATALOG_KEY, Object.fromEntries(catalog.models.map((m) => [m.slug, m.title || m.slug])));
  const seen = Object.fromEntries(attempts.flatMap((a, i) => (quotes[i].status === 200 ? [[label(a), JSON.stringify(quotes[i].quote)]] : [])));
  if (Object.keys(seen).length) await redis.hset(PRICES_KEY, seen);

  return { problems: problems.length, posted };
}
