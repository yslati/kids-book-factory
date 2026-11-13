// The #fal daily check's message.

import test from 'node:test';
import assert from 'node:assert/strict';
import { falCheckMessage } from '../lib/fal-feed.js';

const DAY = '2026-11-12';
const ROWS = [
  { day: DAY, name: 'fal-ai/nano-banana-2/edit', quantity: 2, cost: 0.16 },
  { day: '2026-11-08', name: 'fal-ai/nano-banana-2/edit', quantity: 5, cost: 0.4 }
];
const fieldValue = (embed, name) => embed.fields.find((f) => f.name === name).value;

function message(overrides = {}) {
  return falCheckMessage({ day: DAY, billing: { status: 200, balance: 5.65, username: 'shop' }, usage: { rows: ROWS }, previousBalance: 5.81, inChain: false, ...overrides });
}

test('a healthy account shows balance, change, runway and spend', () => {
  const { embed, problems } = message();
  assert.equal(problems.length, 0);
  assert.match(fieldValue(embed, 'Balance'), /\$5\.65[\s\S]*−\$0\.16 since the last check[\s\S]*≈ 70 days/);
  assert.match(fieldValue(embed, 'Spent the day before (UTC)'), /nano-banana-2\/edit.*2 ×.*\$0\.16/);
  assert.match(fieldValue(embed, 'Cover chain'), /off/);
});

test('a top-up, a low balance and a refused key are called out', () => {
  assert.match(fieldValue(message({ previousBalance: 1 }).embed, 'Balance'), /\+\$4\.65 \(top-up\)/);
  assert.match(message({ billing: { status: 200, balance: 0.5 } }).embed.description, /⚠️ balance under \$1\.00/);
  assert.equal(message({ billing: { status: 200, balance: 0.05 }, inChain: true }).problems.length, 1);
  const refused = message({ billing: { status: 403, balance: null } });
  assert.match(refused.embed.description, /full-access/);
});
