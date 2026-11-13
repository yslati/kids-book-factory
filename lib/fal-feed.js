// The #fal channel (DISCORD_WEBHOOK_FAL): a daily check of the fal account
// (api/cron/fal.js). Posts whether FAL_KEY works, the balance and its change
// since the last check, whether the cover chain uses fal, the previous UTC
// day's spend per endpoint, 7- and 30-day spend, and how long the balance
// lasts at the recent pace.
//
// Upstash: kbf:fal:balance holds the last balance seen.

import { COLORS, code, discordConfigured, envTag, field, finish, footer, postToDiscord } from './discord.js';
import { dayOf } from './event-stats.js';
import { falUsage, readFalBilling } from './fal-balance.js';
import { FAL_LOW_BALANCE_USD } from './provider-order.js';
import { runwayText, spendFields, spendSummary, usd } from './spend.js';

const CHANNEL = 'fal';
const BILLING_URL = 'https://fal.ai/dashboard/billing';
const CHECK_KEY = 'kbf:fal:check:';
const BALANCE_KEY = 'kbf:fal:balance';
const DAY_MS = 24 * 60 * 60 * 1000;
// Under this the check turns amber.
const WARN_BALANCE_USD = 1;

export function falChannelOn() {
  return discordConfigured(CHANNEL);
}

// The check's embed and its problems. Pure, so it can be tested without the
// network. billing is readFalBilling()'s result, usage { rows } or { error },
// previousBalance the last check's balance (null on the first).
export function falCheckMessage({ day, billing, usage, previousBalance, inChain }) {
  const problems = [];
  const warnings = [];
  const balance = billing.balance;

  let keyText = '✅ accepted';
  if (billing.status === 401 || billing.status === 403) {
    keyText = '❌ refused (' + billing.status + ')';
    problems.push('fal refused FAL_KEY for billing (it must be a full-access key)');
  } else if (balance == null) {
    keyText = '⚠️ billing unreachable (' + (billing.error ? code(billing.error, 80) : 'HTTP ' + billing.status) + ')';
    problems.push('the balance could not be read');
  }

  let balanceText = '—';
  if (balance != null) {
    balanceText = '**' + usd(balance) + '**';
    if (previousBalance != null) {
      const change = balance - previousBalance;
      balanceText += '\n' + (Math.abs(change) < 0.005 ? 'unchanged' : (change > 0 ? '+' : '−') + usd(Math.abs(change)) + (change > 0 ? ' (top-up)' : '')) + ' since the last check';
    }
    if (usage.rows) balanceText += '\nLasts ' + runwayText(balance, spendSummary(usage.rows, day).week) + " at the last 7 days' pace";
    if (inChain && balance <= FAL_LOW_BALANCE_USD) problems.push('balance at or under ' + usd(FAL_LOW_BALANCE_USD) + ': covers skip fal');
    else if (balance < WARN_BALANCE_USD) warnings.push('balance under ' + usd(WARN_BALANCE_USD));
  }

  const chainText = inChain
    ? '✅ last fallback · skipped at ' + usd(FAL_LOW_BALANCE_USD) + ' or less'
    : '⏸️ off (commented out of CHAIN in lib/generate.js)';

  const date = new Date(day + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const lines = problems.map((p) => '❌ ' + p).concat(warnings.map((w) => '⚠️ ' + w));
  const embed = finish({
    color: problems.length ? COLORS.error : warnings.length ? COLORS.warn : COLORS.success,
    author: { name: 'fal daily check' + envTag() },
    title: '🩺 ' + date,
    url: BILLING_URL,
    description: lines.length ? lines.join('\n') : '✅ Key and balance fine',
    fields: [
      field('API key', keyText + (billing.username ? '\n' + code(billing.username, 60) : '')),
      field('Balance', balanceText),
      field('Cover chain', chainText),
      ...spendFields(usage, day)
    ],
    footer: footer(),
    timestamp: new Date().toISOString()
  });
  return { embed, problems };
}

// Runs the check and posts it. Resolves to null when today's check already
// ran (unless force), else { problems, posted }.
export async function runFalCheck(redis, { inChain, now = new Date(), force = false } = {}) {
  if (!force && !(await redis.set(CHECK_KEY + dayOf(now), 1, { nx: true, ex: 2 * 24 * 60 * 60 }))) return null;

  const today = new Date(dayOf(now) + 'T00:00:00Z');
  const day = dayOf(new Date(now.getTime() - DAY_MS));
  const [billing, usage, previous] = await Promise.all([
    readFalBilling(),
    falUsage(new Date(today.getTime() - 30 * DAY_MS), today).then((rows) => ({ rows }), (err) => ({ error: String((err && err.message) || err) })),
    redis.get(BALANCE_KEY)
  ]);
  const previousBalance = previous == null || !Number.isFinite(Number(previous)) ? null : Number(previous);

  const { embed, problems } = falCheckMessage({ day, billing, usage, previousBalance, inChain });
  const posted = Boolean(await postToDiscord(CHANNEL, { embeds: [embed] }));
  if (billing.balance != null) await redis.set(BALANCE_KEY, billing.balance);
  return { problems: problems.length, posted };
}
