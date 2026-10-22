// The #higgsfield channel: job outcomes, live alerts and the daily check's
// messages, with Discord stubbed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { checkMessages, jobOutcome, trackHiggsfieldJob } from '../lib/higgsfield-feed.js';
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
