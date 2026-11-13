// Spend summaries for the daily provider checks (#higgsfield, #fal). Usage rows
// are { day: 'YYYY-MM-DD', name, quantity, cost } with cost in USD.

import { code, field } from './discord.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function usd(n) {
  return '$' + (Number(n) || 0).toFixed(2);
}

function daysBefore(day, n) {
  return new Date(Date.parse(day + 'T00:00:00Z') - n * DAY_MS).toISOString().slice(0, 10);
}

function total(rows) {
  return rows.reduce((sum, r) => sum + (Number(r.cost) || 0), 0);
}

// day is the last full UTC day; week and month end on it.
export function spendSummary(rows, day) {
  const yesterday = rows.filter((r) => r.day === day);
  const byName = {};
  for (const r of yesterday) {
    const s = (byName[r.name] = byName[r.name] || { quantity: 0, cost: 0 });
    s.quantity += Number(r.quantity) || 0;
    s.cost += Number(r.cost) || 0;
  }
  const since = (n) => rows.filter((r) => r.day > daysBefore(day, n) && r.day <= day);
  return { yesterday: total(yesterday), byName, week: total(since(7)), month: total(since(30)) };
}

// How long a balance lasts at the last 7 days' pace, as text.
export function runwayText(balance, week) {
  if (!(week > 0)) return 'no spend in the last 7 days';
  const days = balance / (week / 7);
  if (days < 1) return 'under a day';
  return '≈ ' + Math.floor(days) + (Math.floor(days) === 1 ? ' day' : ' days');
}

// Fields for a check's embed. usage is { rows } or { error } when the report
// could not be read.
export function spendFields(usage, day) {
  if (!usage.rows) return [field('Spend', '⚠️ usage report unreachable (' + code(usage.error || 'unknown', 80) + ')', false)];
  const s = spendSummary(usage.rows, day);
  const lines = Object.entries(s.byName).sort((a, b) => b[1].cost - a[1].cost)
    .map(([name, v]) => code(name, 80) + ' · ' + +v.quantity.toFixed(2) + ' × · ' + usd(v.cost));
  return [
    field('Spent the day before (UTC)', (lines.length ? lines.join('\n') + '\n**Total ' + usd(s.yesterday) + '**' : 'nothing'), false),
    field('Last 7 days', usd(s.week) + ' (' + usd(s.week / 7) + '/day)'),
    field('Last 30 days', usd(s.month))
  ];
}
