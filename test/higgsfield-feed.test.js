// The #higgsfield channel: job outcomes, live alerts and the daily check's
// messages, with Discord stubbed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { balanceAnchor, checkMessages, jobOutcome, trackHiggsfieldJob } from '../lib/higgsfield-feed.js';
import { resetDiscordThrottle, setDiscordOutbox } from '../lib/discord.js';

const FLARE = { provider: 'higgsfield', model: 'marketing-studio/image/flare', quality: 'medium' };
const ALPHA = { provider: 'higgsfield', model: 'marketing-studio/image', quality: 'low' };
const TOKENS = { type: 'description', pricing_description: 'Per 1M tokens: image output $30.' };
const FIXED = { type: 'estimate', credits: '0.674', usd: '0.043', discount: null };
const MODELS = [
  { slug: 'marketing-studio/image/flare', title: 'Marketing Studio Image', output_type: 'image', description: 'Flare' },
  { slug: 'marketing-studio/image', title: 'Marketing Studio Image', output_type: 'image', description: '2.0' },
  { slug: 'kling-video/v3.0/pro/text-to-video', title: 'Kling 3.0', output_type: 'video', description: 'Video' }
];

function input(overrides = {}) {
  return {
    day: '2026-10-21',
    attempts: [FLARE, ALPHA],
    catalog: { status: 200, models: MODELS },
    quotes: [{ status: 200, quote: TOKENS }, { status: 200, quote: FIXED }],
    previousCatalog: Object.fromEntries(MODELS.map((m) => [m.slug, m.title])),
    previousPrices: { 'marketing-studio/image/flare medium': JSON.stringify(TOKENS), 'marketing-studio/image low': FIXED },
    jobs: {},
    ...overrides
  };
}

const fieldValue = (embed, name) => embed.fields.find((f) => f.name === name).value;

test('job outcomes name the error lib/higgsfield.js threw', () => {
  assert.equal(jobOutcome(null), 'completed');
  assert.equal(jobOutcome(new Error('higgsfield-submit-403')), 'submit-403');
  assert.equal(jobOutcome(new Error('higgsfield-nsfw')), 'nsfw');
  assert.equal(jobOutcome(Object.assign(new Error('aborted'), { name: 'TimeoutError' })), 'timeout');
  assert.equal(jobOutcome(new Error('fetch failed')), 'error');
});

test('a quiet day is one green status message', () => {
  const { embeds, problems } = checkMessages(input());
  assert.equal(problems.length, 0);
  assert.equal(embeds.length, 1);
  assert.match(fieldValue(embeds[0], 'Cover models'), /✅ `marketing-studio\/image\/flare medium` · token-priced/);
  assert.match(fieldValue(embeds[0], 'Cover models'), /0\.674 credits \(\$0\.043\)/);
  assert.match(fieldValue(embeds[0], 'Catalog'), /3 models · 2 image · 1 video\n0 new · 0 removed/);
});

test('new and removed models get their own messages', () => {
  const previousCatalog = { 'marketing-studio/image/flare': 'x', 'marketing-studio/image': 'x', 'old/model': 'Old Model' };
  const { embeds } = checkMessages(input({ previousCatalog }));
  assert.equal(embeds.length, 3);
  assert.match(embeds[1].title, /1 new model$/);
  assert.match(embeds[1].description, /\*\*Kling 3\.0\*\* · video · \[`kling-video\/v3\.0\/pro\/text-to-video`\]\(https:\/\/console\.higgsfield\.ai\/models\/kling-video%2Fv3\.0%2Fpro%2Ftext-to-video\/playground\)/);
  assert.match(embeds[2].title, /1 model removed/);
  assert.match(embeds[2].description, /Old Model/);
});

test('the first check sets a baseline without listing every model', () => {
  const { embeds } = checkMessages(input({ previousCatalog: null, previousPrices: null }));
  assert.equal(embeds.length, 1);
  assert.match(fieldValue(embeds[0], 'Catalog'), /First check/);
});

test('a changed quote is posted with before and after', () => {
  const previousPrices = { 'marketing-studio/image low': { ...FIXED, credits: '0.5', usd: '0.031' } };
  const { embeds } = checkMessages(input({ previousPrices }));
  assert.equal(embeds.length, 2);
  assert.match(embeds[1].fields[0].value, /Before:\*\* 0\.5 credits \(\$0\.031\)\n\*\*After:\*\* 0\.674 credits/);
});

test('a refused model, a missing one and a bad key are problems', () => {
  const catalog = { status: 200, models: MODELS.filter((m) => m.slug !== 'marketing-studio/image') };
  const { embeds, problems } = checkMessages(input({ catalog, quotes: [{ status: 503, quote: null }, { status: 200, quote: FIXED }] }));
  assert.deepEqual(problems, ['marketing-studio/image/flare medium: disabled', 'marketing-studio/image low: missing from the catalog']);
  assert.equal(embeds[0].color, 0xed4245);

  const rejected = checkMessages(input({ catalog: { status: 401, models: null } }));
  assert.match(rejected.problems[0], /rejected HIGGSFIELD_KEY/);
});

test("the day's jobs show counts, average time and fixed-price spend", () => {
  const jobs = {
    'marketing-studio/image low': { completed: 2, ms: 30000, nsfw: 1 },
    'marketing-studio/image/flare medium': { completed: 1, ms: 20000, 'submit-403': 3 }
  };
  const value = fieldValue(checkMessages(input({ jobs })).embeds[0], 'Jobs the day before (UTC)');
  assert.match(value, /`marketing-studio\/image low` · 2 done \(avg 15\.0 s\) ≈ \$0\.09 · 1 nsfw/);
  assert.match(value, /`marketing-studio\/image\/flare medium` · 1 done \(avg 20\.0 s\) · 3 refused 403/);
});

test('an out-of-credits refusal alerts once an hour for the whole account', async (t) => {
  const saved = process.env.DISCORD_WEBHOOK_HIGGSFIELD;
  process.env.DISCORD_WEBHOOK_HIGGSFIELD = 'https://discord.com/api/webhooks/4/higgsfield-token';
  resetDiscordThrottle();
  setDiscordOutbox(null);
  const original = globalThis.fetch;
  const titles = [];
  globalThis.fetch = async (url, init = {}) => {
    titles.push(JSON.parse(init.body).embeds[0].title);
    return new Response(null, { status: 204 });
  };
  t.after(() => {
    globalThis.fetch = original;
    process.env.DISCORD_WEBHOOK_HIGGSFIELD = saved;
    setDiscordOutbox(undefined);
  });

  const refused = new Error('higgsfield-submit-403');
  await trackHiggsfieldJob(null, FLARE, refused, 300);
  await trackHiggsfieldJob(null, ALPHA, refused, 300);
  await trackHiggsfieldJob(null, FLARE, new Error('higgsfield-failed'), 300);
  assert.deepEqual(titles, ['💸 Out of credits']);
});

test('the daily check shows spend and an estimated balance', () => {
  const usage = { rows: [
    { day: '2026-10-21', name: 'marketing-studio/image/sunburst', quantity: 3, cost: 0.21 },
    { day: '2026-10-21', name: 'marketing-studio/image/flare', quantity: 1, cost: 0.07 },
    { day: '2026-10-18', name: 'marketing-studio/image/sunburst', quantity: 10, cost: 0.70 },
    { day: '2026-09-30', name: 'marketing-studio/image/sunburst', quantity: 10, cost: 5 }
  ] };
  const balance = { anchor: 10, at: new Date('2026-10-15T09:30:00Z'), spent: 0.98 };
  const embed = checkMessages(input({ usage, balance })).embeds[0];
  assert.match(fieldValue(embed, 'Spent the day before (UTC)'), /sunburst.*\$0\.21[\s\S]*Total \$0\.28/);
  assert.equal(fieldValue(embed, 'Last 7 days').startsWith('$0.98'), true);
  assert.equal(fieldValue(embed, 'Last 30 days'), '$5.98');
  assert.match(fieldValue(embed, 'Balance'), /≈ \$9\.02 left[\s\S]*≈ 64 days/);
});

test('the balance asks for the console amount when none is set, and flags a short runway', () => {
  const unset = checkMessages(input()).embeds[0];
  assert.match(fieldValue(unset, 'Balance'), /HIGGSFIELD_BALANCE_USD/);
  const usage = { rows: [{ day: '2026-10-21', name: 'm', quantity: 7, cost: 7 }] };
  const low = checkMessages(input({ usage, balance: { anchor: 5, at: new Date('2026-10-01T00:00:00Z'), spent: 1 } })).embeds[0];
  assert.match(fieldValue(low, 'Balance'), /⚠️ Lasts ≈ 4 days/);
  const broken = checkMessages(input({ usage: { error: 'higgsfield-usage-500' } })).embeds[0];
  assert.match(fieldValue(broken, 'Spend'), /unreachable/);
});

test('balance anchors need both a number and a time', () => {
  assert.deepEqual(balanceAnchor({ HIGGSFIELD_BALANCE_USD: '12.5', HIGGSFIELD_BALANCE_AT: '2026-11-13T10:00:00Z' }), { anchor: 12.5, at: new Date('2026-11-13T10:00:00Z') });
  assert.equal(balanceAnchor({ HIGGSFIELD_BALANCE_USD: '12.5' }), null);
  assert.equal(balanceAnchor({ HIGGSFIELD_BALANCE_USD: 'x', HIGGSFIELD_BALANCE_AT: '2026-11-13' }), null);
});
