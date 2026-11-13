// The #openai channel (DISCORD_WEBHOOK_OPENAI): the OpenAI account behind the
// covers made through lib/openai.js.
//
// Live, from real cover jobs (lib/generate.js): an alert when OpenAI refuses
// a job for a reason that won't fix itself: key rejected (401), organisation
// not verified or not allowed (403), credit used up (429 insufficient_quota).
// Each goes out at most once an hour per problem.
//
// Daily (api/cron/openai.js): whether the key works and each chain model is
// still offered to it (GET /v1/models), the previous UTC day's jobs per model
// with their exact spend, 7- and 30-day spend, and an estimated balance.
//
// OpenAI has no API for a prepaid credit balance (the usage and costs
// endpoints need an admin key and lag by hours). Each response carries its
// token usage, so spend is exact and comes from the jobs counted here; the
// balance is the amount last read on the billing page (OPENAI_BALANCE_USD,
// read at OPENAI_BALANCE_AT) minus what was spent since.
//
// Upstash: kbf:oa:jobs:<day> counts each attempt's outcome, time and cost
// (40 days).

import { COLORS, code, discordConfigured, envTag, field, finish, footer, postToDiscord, seconds } from './discord.js';
import { dayOf } from './event-stats.js';
import { listOpenAIModels } from './openai.js';
import { runwayText, spendFields, spendSummary, usd } from './spend.js';

const CHANNEL = 'openai';
const BILLING_URL = 'https://platform.openai.com/settings/organization/billing/overview';
const JOBS_KEY = 'kbf:oa:jobs:';
const JOBS_SECONDS = 40 * 24 * 60 * 60;
const ALERT_KEY = 'kbf:oa:alert:';
const ALERT_SECONDS = 60 * 60;
const CHECK_KEY = 'kbf:oa:check:';
const DAY_MS = 24 * 60 * 60 * 1000;
const SPEND_DAYS = 30;
// Estimated balances under this many days of spend are flagged.
const LOW_RUNWAY_DAYS = 7;
// Costs are summed in Redis as whole micro-dollars (HINCRBY takes integers).
const USD_SCALE = 1e6;

// Refusals that fail every job until someone acts. Keyed by the outcome
// jobOutcome() gives them.
const ALERTS = {
  '401': { title: '🔑 API key rejected', text: 'OpenAI refused OPENAI_KEY. Every OpenAI cover fails until a working key is set in Vercel.' },
  '403': { title: '🚫 Request forbidden', text: 'OpenAI answered 403: the organisation is not verified for GPT Image models, or the key\'s project may not use this model. Check the organisation settings on platform.openai.com.' },
  'insufficient-quota': { title: '💸 Out of credit', text: 'OpenAI refused a cover because the prepaid credit is used up. Every OpenAI cover fails until the balance is topped up.' }
};

// Alerts sent by an instance without Redis, and job keys it has set to expire.
const alertedAt = new Map();
const expiring = new Set();

export function openaiChannelOn() {
  return discordConfigured(CHANNEL);
}

function label(attempt) {
  return [attempt.model, attempt.quality].filter(Boolean).join(' ');
}

// What became of a job: 'completed', or the error lib/openai.js threw without
// its prefix ('400', '429', 'empty', 'prompt-too-long'...). A 429 for used-up
// credit is told apart from a rate limit by OpenAI's error code.
export function jobOutcome(err) {
  if (!err) return 'completed';
  const match = /^openai-([a-z0-9-]+)$/.exec(String(err.message || ''));
  if (match) {
    if (match[1] === '429' && err.code === 'insufficient_quota') return 'insufficient-quota';
    return match[1];
  }
  return err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : 'error';
}

function outcomeText(outcome) {
  if (/^\d{3}$/.test(outcome)) return 'refused ' + outcome;
  return outcome.replace(/-/g, ' ');
}

// Counts a finished attempt (with its cost in USD when known) and alerts when
// OpenAI refused it for good. err is null for a completed job. Never throws.
export async function trackOpenAIJob(redis, attempt, err, ms, cost = null) {
  const outcome = jobOutcome(err);
  if (redis) {
    const key = JOBS_KEY + dayOf();
    try {
      const pipe = redis.pipeline().hincrby(key, label(attempt) + '|' + outcome, 1);
      if (outcome === 'completed') pipe.hincrby(key, label(attempt) + '|ms', Math.round(ms));
      if (typeof cost === 'number') pipe.hincrby(key, label(attempt) + '|usd6', Math.round(cost * USD_SCALE));
      if (!expiring.has(key)) {
        pipe.expire(key, JOBS_SECONDS);
        expiring.add(key);
      }
      await pipe.exec();
    } catch (e) {
      console.warn('[openai-feed] job not counted:', (e && e.message) || e);
    }
  }
  if (ALERTS[outcome]) await sendAlert(redis, outcome, attempt);
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

async function sendAlert(redis, outcome, attempt) {
  if (!openaiChannelOn()) return;
  const alert = ALERTS[outcome];
  if (!(await firstAlert(redis, ALERT_KEY + outcome))) return;
  await postToDiscord(CHANNEL, {
    embeds: [finish({
      color: COLORS.error,
      author: { name: 'OpenAI alert' + envTag() },
      title: alert.title,
      url: BILLING_URL,
      description: alert.text,
      fields: [
        field('Model', code(label(attempt), 120)),
        field('Outcome', outcomeText(outcome)),
        field('Repeats', 'muted for an hour')
      ],
      footer: footer(),
      timestamp: new Date().toISOString()
    })]
  });
}

// A day's jobs as { label: { completed, ms, usd6, <outcome>... } }.
function parseJobs(hash) {
  const jobs = {};
  for (const [key, value] of Object.entries(hash || {})) {
    const cut = key.lastIndexOf('|');
    const name = key.slice(0, cut);
    jobs[name] = jobs[name] || {};
    jobs[name][key.slice(cut + 1)] = Number(value) || 0;
  }
  return jobs;
}

// The last `days` UTC days ending on `day`, newest last.
function daysEnding(day, days) {
  const end = Date.parse(day + 'T00:00:00Z');
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(new Date(end - i * DAY_MS).toISOString().slice(0, 10));
  return out;
}

// Spend rows for lib/spend.js from the counted jobs: { day, name, quantity,
// cost } per model and day.
export function spendRows(jobsByDay) {
  const rows = [];
  for (const [day, jobs] of Object.entries(jobsByDay)) {
    for (const [name, j] of Object.entries(jobs)) {
      rows.push({ day, name, quantity: j.completed || 0, cost: (j.usd6 || 0) / USD_SCALE });
    }
  }
  return rows;
}

// OPENAI_BALANCE_USD and OPENAI_BALANCE_AT, or null when unset or invalid.
export function balanceAnchor(env = process.env) {
  const anchor = Number(env.OPENAI_BALANCE_USD);
  const at = new Date(env.OPENAI_BALANCE_AT || '');
  if (!env.OPENAI_BALANCE_USD || !Number.isFinite(anchor) || Number.isNaN(at.getTime())) return null;
  return { anchor, at };
}

function balanceText(anchor, rows, day) {
  const link = '[billing page](' + BILLING_URL + ')';
  if (!anchor) return 'See the ' + link + '.';
  const since = dayOf(anchor.at);
  const spent = rows.filter((r) => r.day >= since).reduce((sum, r) => sum + r.cost, 0);
  const left = anchor.anchor - spent;
  const read = usd(anchor.anchor) + ' on the ' + link + ' on ' + anchor.at.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  let text = '**≈ ' + usd(left) + ' left** (' + read + ', ' + usd(spent) + ' spent since)';
  const week = spendSummary(rows, day).week;
  const low = week > 0 && left / (week / 7) < LOW_RUNWAY_DAYS;
  text += '\n' + (low ? '⚠️ ' : '') + 'Lasts ' + runwayText(Math.max(left, 0), week) + ' at the last 7 days\' pace';
  return text + '\nAn estimate from the covers counted here: top-ups are not seen, so update both values after one.';
}

// The check's embed and its problems. Pure, so it can be tested without the
// network. catalog is listOpenAIModels()'s result; jobsByDay maps each of the
// last 30 UTC days to its parsed jobs; anchor is balanceAnchor()'s result.
export function openaiCheckMessage({ day, attempts, catalog, jobsByDay, anchor = null, inChain }) {
  const problems = [];
  const warnings = [];
  const models = catalog.models;

  let keyText = '✅ accepted';
  if (catalog.status === 401) {
    keyText = '❌ rejected';
    problems.push('OpenAI rejected OPENAI_KEY');
  } else if (!models) {
    keyText = '⚠️ model list unreachable (' + (catalog.error ? code(catalog.error, 80) : 'HTTP ' + catalog.status) + ')';
    problems.push('the model list could not be read');
  }

  const modelLines = attempts.map((attempt) => {
    const listed = models ? models.includes(attempt.model) : null;
    if (listed === false) problems.push(label(attempt) + ': not offered to this key');
    return (listed === false ? '❌' : '✅') + ' ' + code(label(attempt), 80) + (listed === false ? ' · not offered to this key' : '');
  });

  const rows = spendRows(jobsByDay);
  const jobs = jobsByDay[day] || {};
  const jobLines = Object.entries(jobs).sort().map(([name, j]) => {
    const done = j.completed || 0;
    const parts = [done + ' done' + (done ? ' (avg ' + seconds((j.ms || 0) / done) + ', ' + usd((j.usd6 || 0) / USD_SCALE / done) + ' each)' : '')];
    for (const [outcome, n] of Object.entries(j)) {
      if (!['completed', 'ms', 'usd6'].includes(outcome)) parts.push(n + ' ' + outcomeText(outcome));
    }
    return code(name, 80) + ' · ' + parts.join(' · ');
  });
  for (const [name, j] of Object.entries(jobs)) {
    for (const outcome of Object.keys(ALERTS)) if (j[outcome]) warnings.push(name + ': ' + j[outcome] + ' × ' + outcomeText(outcome) + ' the day before');
  }

  const chainText = inChain
    ? '✅ in the cover chain (lib/generate.js)'
    : '⏸️ off (commented out of CHAIN in lib/generate.js); only tests use it';

  const date = new Date(day + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const lines = problems.map((p) => '❌ ' + p).concat(warnings.map((w) => '⚠️ ' + w));
  const embed = finish({
    color: problems.length ? COLORS.error : warnings.length ? COLORS.warn : COLORS.success,
    author: { name: 'OpenAI daily check' + envTag() },
    title: '🩺 ' + date,
    url: BILLING_URL,
    description: lines.length ? lines.join('\n') : '✅ Key and cover models fine',
    fields: [
      field('API key', keyText),
      field('Cover chain', chainText),
      field('Cover models', modelLines.join('\n') || '—', false),
      field('Jobs the day before (UTC)', jobLines.join('\n') || 'none', false),
      ...spendFields({ rows }, day),
      field('Balance', balanceText(anchor, rows, day), false)
    ],
    footer: footer(),
    timestamp: new Date().toISOString()
  });
  return { embed, problems };
}

// Runs the check and posts it. Resolves to null when today's check already
// ran (unless force), else { problems, posted }.
export async function runOpenAICheck(redis, attempts, { inChain, now = new Date(), force = false } = {}) {
  if (!force && !(await redis.set(CHECK_KEY + dayOf(now), 1, { nx: true, ex: 2 * 24 * 60 * 60 }))) return null;

  const day = dayOf(new Date(now.getTime() - DAY_MS));
  const days = daysEnding(day, SPEND_DAYS);
  const [catalog, hashes] = await Promise.all([
    listOpenAIModels(),
    Promise.all(days.map((d) => redis.hgetall(JOBS_KEY + d)))
  ]);
  const jobsByDay = Object.fromEntries(days.map((d, i) => [d, parseJobs(hashes[i])]));

  const { embed, problems } = openaiCheckMessage({ day, attempts, catalog, jobsByDay, anchor: balanceAnchor(), inChain });
  const posted = Boolean(await postToDiscord(CHANNEL, { embeds: [embed] }));
  return { problems: problems.length, posted };
}
