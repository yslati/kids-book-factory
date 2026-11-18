// The Discord app's /btk command (api/discord.js): one slash command whose
// subcommands Discord lists with their parameters as you type "/btk ".
// COMMAND is what scripts/discord-commands.mjs registers; add a subcommand
// there and its handler in HANDLERS.
//
//   /btk customer id:<Visitor ID or generation ID>
//     everything stored about one visitor (lib/visitor-log.js)

import { createPublicKey, verify } from 'node:crypto';
import { COLORS, clip, code, field, finish, plain } from './discord.js';
import { parseVisitorId } from './visitor-id.js';
import { Step, readTimeline, visitorOfGeneration } from './visitor-log.js';

export const COMMAND = {
  name: 'btk',
  description: 'Book to Kids tools',
  type: 1,
  // Server admins only; others don't see it.
  default_member_permissions: '0',
  contexts: [0],
  options: [
    {
      type: 1,
      name: 'customer',
      description: 'Everything we know about one visitor',
      options: [{
        type: 3,
        name: 'id',
        description: 'Visitor ID (V-…) or a generation ID from any card',
        required: true,
        max_length: 80
      }]
    }
  ]
};

// Discord signs every interaction with the app's Ed25519 key.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function validInteraction(raw, signature, timestamp, publicKey = process.env.DISCORD_PUBLIC_KEY) {
  if (!/^[0-9a-f]{64}$/i.test(publicKey || '') || !/^[0-9a-f]{128}$/i.test(signature || '') || !/^\d{1,20}$/.test(timestamp || '')) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKey, 'hex')]), format: 'der', type: 'spki' });
    return verify(null, Buffer.concat([Buffer.from(timestamp), raw]), key, Buffer.from(signature, 'hex'));
  } catch (e) {
    return false;
  }
}

const LABELS = {
  [Step.page]: ['📄', 'Page'],
  [Step.search]: ['🔎', 'Search'],
  [Step.preview]: ['🎨', 'Preview started'],
  [Step.cover]: ['🖼️', 'Cover ready'],
  [Step.failed]: ['❌', 'Preview failed'],
  [Step.limit]: ['⛔', 'Limit reached'],
  [Step.rating]: ['⭐', 'Rated'],
  [Step.fix]: ['🛠️', 'Fix asked'],
  [Step.share]: ['📤', 'Shared'],
  [Step.cart]: ['🛒', 'Added to cart'],
  [Step.checkout]: ['💳', 'Checkout started'],
  [Step.order]: ['✅', 'Ordered'],
  [Step.chat]: ['💬', 'Opened chat'],
  [Step.custom]: ['✨', 'Custom story'],
  [Step.error]: ['⚠️', 'Error']
};

const MAX_DESCRIPTION = 4000;

function stamp(ms) {
  const s = Math.floor(Number(ms) / 1000);
  return Number.isFinite(s) && s > 0 ? '<t:' + s + ':d> <t:' + s + ':t>' : '';
}

function relative(ms) {
  const s = Math.floor(Number(ms) / 1000);
  return Number.isFinite(s) && s > 0 ? '<t:' + s + ':R>' : 'unknown';
}

function stepLine(step) {
  const [icon, label] = LABELS[step.kind] || ['•', step.kind];
  const text = step.text ? ': ' + clip(plain(step.text), 110) : '';
  const link = step.url ? ' [cover](' + step.url + ')' : '';
  return stamp(step.at) + ' ' + icon + ' ' + label + text + link;
}

// Oldest first, as many of the newest steps as fit.
function timelineText(steps) {
  const lines = [];
  let size = 0;
  for (const step of steps) {
    const line = stepLine(step);
    if (size + line.length + 1 > MAX_DESCRIPTION - 40) break;
    lines.push(line);
    size += line.length + 1;
  }
  const hidden = steps.length - lines.length;
  return (hidden ? '… ' + hidden + ' earlier steps\n' : '') + lines.reverse().join('\n');
}

function countOf(steps, kind) {
  return steps.filter((s) => s.kind === kind).length;
}

// The card for one visitor's timeline ({ id, info, steps }).
export function customerEmbed(timeline, { from = '' } = {}) {
  const { id, info, steps } = timeline;
  const summary = [
    countOf(steps, Step.page) + ' pages',
    countOf(steps, Step.cover) + ' covers',
    countOf(steps, Step.cart) + ' carts',
    countOf(steps, Step.order) + ' orders'
  ].join(' · ');
  return finish({
    color: countOf(steps, Step.order) ? COLORS.success : COLORS.info,
    title: '👤 Visitor ' + id,
    description: timelineText(steps) || 'No steps stored.',
    fields: [
      field('Where', info.place || 'unknown'),
      field('Device', info.device || 'unknown'),
      field('IP', code(info.ip || 'unknown', 64)),
      field('First seen', relative(info.first)),
      field('Last seen', relative(info.last)),
      field('Totals', summary),
      from && field('Found from', code(from, 70), false)
    ],
    footer: { text: steps.length + ' steps stored · kept 90 days' }
  });
}

function textMessage(content) {
  return { content, embeds: [] };
}

async function customer(options, { redis }) {
  const input = String((options.find((o) => o.name === 'id') || {}).value || '').trim();
  if (!redis) return textMessage('Redis is not configured, so no timelines are stored.');
  let id = parseVisitorId(input);
  let from = '';
  if (!id && /^[A-Za-z0-9-]{1,64}$/.test(input)) {
    id = await visitorOfGeneration(redis, input);
    from = id ? 'generation ' + input : '';
  }
  if (!id) return textMessage('No visitor found for `' + clip(input.replace(/`/g, ''), 70) + '`. Paste a Visitor ID (V-…) or a generation ID from a card.');
  const timeline = await readTimeline(redis, id);
  if (!timeline) return textMessage('Nothing stored for `' + id + '` (steps are kept 90 days).');
  return { content: '', embeds: [customerEmbed(timeline, { from })] };
}

const HANDLERS = { customer };

// The message answering one /btk interaction's data.
export async function runCommand(data, deps) {
  const sub = data && Array.isArray(data.options) ? data.options[0] : null;
  const handler = sub && data.name === COMMAND.name ? HANDLERS[sub.name] : null;
  if (!handler) return textMessage('Unknown command.');
  try {
    return await handler(sub.options || [], deps);
  } catch (e) {
    console.error('[btk] ' + sub.name + ' failed:', (e && e.stack) || e);
    return textMessage('Something went wrong reading that. Try again in a moment.');
  }
}
