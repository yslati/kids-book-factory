// The #openai channel: job outcomes, counted jobs and the daily check's message.

import test from 'node:test';
import assert from 'node:assert/strict';
import { balanceAnchor, jobOutcome, openaiCheckMessage, spendRows, trackOpenAIJob } from '../lib/openai-feed.js';

const SUNBURST = { provider: 'openai', model: 'gpt-image-2.5-sunburst', quality: 'medium' };
const DAY = '2026-11-12';
const fieldValue = (embed, name) => embed.fields.find((f) => f.name === name).value;

function input(overrides = {}) {
  return {
    day: DAY,
    attempts: [SUNBURST],
    catalog: { status: 200, models: ['gpt-image-2.5-sunburst', 'gpt-image-2.6-flare'] },
    jobsByDay: {
      [DAY]: { 'gpt-image-2.5-sunburst medium': { completed: 4, ms: 120000, usd6: 280000, timeout: 1 } },
      '2026-11-08': { 'gpt-image-2.5-sunburst medium': { completed: 10, ms: 300000, usd6: 700000 } }
    },
    anchor: { anchor: 5, at: new Date('2026-11-01T10:00:00Z') },
    inChain: false,
    ...overrides
  };
}

test('job outcomes name the error lib/openai.js threw, telling quota from rate limits', () => {
  assert.equal(jobOutcome(null), 'completed');
  assert.equal(jobOutcome(new Error('openai-401')), '401');
  assert.equal(jobOutcome(Object.assign(new Error('openai-429'), { code: 'rate_limit_exceeded' })), '429');
  assert.equal(jobOutcome(Object.assign(new Error('openai-429'), { code: 'insufficient_quota' })), 'insufficient-quota');
  assert.equal(jobOutcome(Object.assign(new Error('aborted'), { name: 'TimeoutError' })), 'timeout');
  assert.equal(jobOutcome(new Error('fetch failed')), 'error');
});

test('counts outcome, time and cost in micro-dollars in the day hash', async () => {
  const calls = [];
  const pipe = {
    hincrby: (...a) => { calls.push(['hincrby', ...a]); return pipe; },
    expire: (...a) => { calls.push(['expire', ...a]); return pipe; },
    exec: async () => []
  };
  const redis = { pipeline: () => pipe, set: async () => null };
  process.env.DISCORD_WEBHOOK_OPENAI = '';
  await trackOpenAIJob(redis, SUNBURST, null, 24500, 0.0712);
  const key = 'kbf:oa:jobs:' + new Date().toISOString().slice(0, 10);
  assert.deepEqual(calls.slice(0, 3), [
    ['hincrby', key, 'gpt-image-2.5-sunburst medium|completed', 1],
    ['hincrby', key, 'gpt-image-2.5-sunburst medium|ms', 24500],
    ['hincrby', key, 'gpt-image-2.5-sunburst medium|usd6', 71200]
  ]);
});

test('spend rows turn the counted jobs into dollars per model and day', () => {
  const rows = spendRows(input().jobsByDay);
  assert.deepEqual(rows.find((r) => r.day === DAY), { day: DAY, name: 'gpt-image-2.5-sunburst medium', quantity: 4, cost: 0.28 });
});

test('a healthy check shows the key, models, jobs with cost each, spend and the estimated balance', () => {
  const { embed, problems } = openaiCheckMessage(input());
  assert.equal(problems.length, 0);
  assert.equal(fieldValue(embed, 'API key'), '✅ accepted');
  assert.match(fieldValue(embed, 'Cover models'), /✅ `gpt-image-2.5-sunburst medium`/);
  assert.match(fieldValue(embed, 'Jobs the day before (UTC)'), /4 done \(avg 30\.0 s, \$0\.07 each\) · 1 timeout/);
  assert.match(fieldValue(embed, 'Spent the day before (UTC)'), /Total \$0\.28/);
  assert.match(fieldValue(embed, 'Last 7 days'), /\$0\.98/);
  // $5 read on 1 November, $0.98 spent since.
  assert.match(fieldValue(embed, 'Balance'), /≈ \$4\.02 left/);
  assert.match(fieldValue(embed, 'Cover chain'), /off/);
});

test('a rejected key, a missing model and refusals the day before are called out', () => {
  const rejected = openaiCheckMessage(input({ catalog: { status: 401, models: null } }));
  assert.match(rejected.embed.description, /rejected OPENAI_KEY/);
  const missing = openaiCheckMessage(input({ catalog: { status: 200, models: ['gpt-image-2.6-flare'] } }));
  assert.match(missing.embed.description, /not offered to this key/);
  const quota = openaiCheckMessage(input({ jobsByDay: { [DAY]: { 'gpt-image-2.5-sunburst medium': { 'insufficient-quota': 3 } } } }));
  assert.match(quota.embed.description, /⚠️ .*3 × insufficient quota/);
  assert.equal(quota.problems.length, 0);
});

test('the balance anchor needs both values', () => {
  assert.equal(balanceAnchor({}), null);
  assert.equal(balanceAnchor({ OPENAI_BALANCE_USD: '5' }), null);
  assert.deepEqual(balanceAnchor({ OPENAI_BALANCE_USD: '5', OPENAI_BALANCE_AT: '2026-11-13T17:00:00Z' }), { anchor: 5, at: new Date('2026-11-13T17:00:00Z') });
  assert.match(openaiCheckMessage(input({ anchor: null })).embed.fields.find((f) => f.name === 'Balance').value, /See the \[billing page\]/);
});
