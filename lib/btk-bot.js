// The Discord app's /btk command (api/discord.js): one slash command whose
// subcommands Discord lists with their parameters as you type "/btk ".
// COMMAND is what scripts/discord-commands.mjs registers; add a subcommand
// there and its handler in COMMANDS.
//
//   /btk customer id:      one visitor's timeline (lib/visitor-log.js), with
//                          buttons for older steps, a gift, an upload reset
//                          and their Clarity recordings
//   /btk order number:     the same, found from an order
//   /btk today             today's funnel so far (UTC)
//   /btk gift id: count:   extra previews for a visitor, today
//   /btk upload-reset id:  a visitor's photo uploads back to full
//   /btk balance           fal, OpenAI and Higgsfield credit now
//
// Gifts and upload resets need Administrator or Manage Server, are added to
// the visitor's timeline and posted to #logs.

import { createPublicKey, verify } from 'node:crypto';
import { COLORS, clip, code, field, finish, plain, postToDiscord } from './discord.js';
import { parseVisitorId } from './visitor-id.js';
import { Step, addStep, readTimeline, visitorOfGeneration, visitorOfOrder } from './visitor-log.js';
import { MAX_GIFT, giftPreviews, giftedPreviews, resetUploads } from './ratelimit.js';
import { dayOf, readDay } from './event-stats.js';
import { falBalance } from './fal-balance.js';
import { openaiBalance } from './openai-feed.js';
import { higgsfieldBalance } from './higgsfield-feed.js';
import { usd } from './spend.js';

const VISITOR_OPTION = { type: 3, name: 'id', description: 'Visitor ID (V-…) or a generation ID from any card', required: true, max_length: 80 };

export const COMMAND = {
  name: 'btk',
  description: 'Book to Kids tools',
  type: 1,
  // Server admins only; others don't see it.
  default_member_permissions: '0',
  contexts: [0],
  options: [
    { type: 1, name: 'customer', description: 'Everything we know about one visitor', options: [VISITOR_OPTION] },
    {
      type: 1,
      name: 'order',
      description: 'The buyer of an order and their whole visit',
      options: [{ type: 3, name: 'number', description: 'Order number, e.g. #btk-1234', required: true, max_length: 40 }]
    },
    { type: 1, name: 'today', description: 'Today\'s visitors, previews, carts and orders so far (UTC)' },
    {
      type: 1,
      name: 'gift',
      description: 'Give a visitor extra previews for the next 24 hours',
      options: [VISITOR_OPTION, { type: 4, name: 'count', description: 'How many previews (1-' + MAX_GIFT + ')', required: true, min_value: 1, max_value: MAX_GIFT }]
    },
    { type: 1, name: 'upload-reset', description: 'Give a visitor all their photo uploads back', options: [VISITOR_OPTION] },
    { type: 1, name: 'balance', description: 'Credit left at fal, OpenAI and Higgsfield' }
  ]
};

// Interaction and response types (Discord API).
export const Interaction = { ping: 1, command: 2, component: 3, modal: 5 };
const Reply = { message: 4, update: 7, modal: 9 };
const EPHEMERAL = 64;

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
  [Step.error]: ['⚠️', 'Error'],
  [Step.gift]: ['🎁', 'Gifted'],
  [Step.reset]: ['🔄', 'Uploads reset']
};

// Steps per card page; 25 lines stay well under the 4096-character description.
const PAGE_STEPS = 25;
const CLARITY_PROJECT = 'xpmgq1z69s';

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

function countOf(steps, kind) {
  return steps.filter((s) => s.kind === kind).length;
}

// Their recordings in Clarity, filtered by the custom user id the storefront
// gives Clarity (snippets/kb-visitor-id.liquid): Shopify's visitor id.
export function clarityUrl(key) {
  if (!/^[A-Za-z0-9._:-]{8,100}$/.test(key || '')) return '';
  return 'https://clarity.microsoft.com/projects/view/' + CLARITY_PROJECT + '/impressions?date=Last%2030%20days&CustomUserId=is%3B' + encodeURIComponent(key);
}

function button(label, customId, style = 2) {
  return { type: 2, style, label, custom_id: customId };
}

// The card for one visitor's timeline ({ id, info, steps }), newest steps
// from offset; gifts is how many gifted previews are waiting.
export function customerMessage(timeline, { from = '', offset = 0, gifts = 0 } = {}) {
  const { id, info, steps } = timeline;
  const start = Math.max(0, Math.min(offset, Math.max(0, steps.length - 1)));
  const page = steps.slice(start, start + PAGE_STEPS);
  const summary = [
    countOf(steps, Step.page) + ' pages',
    countOf(steps, Step.cover) + ' covers',
    countOf(steps, Step.cart) + ' carts',
    countOf(steps, Step.order) + ' orders'
  ].join(' · ');
  const embed = finish({
    color: countOf(steps, Step.order) ? COLORS.success : COLORS.info,
    title: '👤 Visitor ' + id,
    description: page.map(stepLine).reverse().join('\n') || 'No steps stored.',
    fields: [
      field('Where', info.place || 'unknown'),
      field('Device', info.device || 'unknown'),
      field('IP', code(info.ip || 'unknown', 64)),
      field('First seen', relative(info.first)),
      field('Last seen', relative(info.last)),
      field('Totals', summary),
      gifts > 0 && field('Gifted previews left', String(gifts)),
      from && field('Found from', code(from, 70), false)
    ],
    footer: { text: (steps.length ? 'Steps ' + (start + 1) + '–' + (start + page.length) + ' of ' + steps.length + ' (newest first) · ' : '') + 'kept 90 days' }
  });

  const buttons = [];
  if (start > 0) buttons.push(button('Newer steps', 'btk:page:' + id + ':' + Math.max(0, start - PAGE_STEPS)));
  if (start + PAGE_STEPS < steps.length) buttons.push(button('Older steps', 'btk:page:' + id + ':' + (start + PAGE_STEPS)));
  buttons.push(button('Gift previews', 'btk:gift:' + id, 3));
  buttons.push(button('Reset uploads', 'btk:reset:' + id));
  const clarity = clarityUrl(info.key);
  if (clarity) buttons.push({ type: 2, style: 5, label: 'Clarity recordings', url: clarity });
  return { content: '', embeds: [embed], components: [{ type: 1, components: buttons }] };
}

function textMessage(content) {
  return { content, embeds: [], components: [] };
}

function privateMessage(content) {
  return { content, flags: EPHEMERAL };
}

// Gifts and resets change what a visitor can do: server admins only.
const ADMINISTRATOR = 1n << 3n;
const MANAGE_GUILD = 1n << 5n;

export function isAdmin(interaction) {
  try {
    const perms = BigInt((interaction.member && interaction.member.permissions) || '0');
    return (perms & ADMINISTRATOR) !== 0n || (perms & MANAGE_GUILD) !== 0n;
  } catch (e) {
    return false;
  }
}

function actorOf(interaction) {
  const user = (interaction.member && interaction.member.user) || interaction.user || {};
  return user.global_name || user.username || 'someone';
}

function optionValue(options, name) {
  const option = (options || []).find((o) => o.name === name);
  return option ? option.value : undefined;
}

// A Visitor ID, or the visitor behind a generation ID: { id, from }.
async function findVisitor(redis, input) {
  const text = String(input || '').trim();
  const id = parseVisitorId(text);
  if (id) return { id, from: '' };
  if (!/^[A-Za-z0-9-]{1,64}$/.test(text)) return { id: '', from: '' };
  const found = await visitorOfGeneration(redis, text);
  return { id: found, from: found ? 'generation ' + text : '' };
}

function notFound(input) {
  return 'No visitor found for `' + clip(String(input).replace(/`/g, ''), 70) + '`. Paste a Visitor ID (V-…) or a generation ID from a card.';
}

async function showCustomer(deps, id, { from = '', offset = 0 } = {}) {
  const timeline = await readTimeline(deps.redis, id);
  if (!timeline) return textMessage('Nothing stored for `' + id + '` (steps are kept 90 days).');
  const gifts = timeline.info.ip ? await deps.giftedPreviews(timeline.info.ip).catch(() => 0) : 0;
  return customerMessage(timeline, { from, offset, gifts });
}

// Posts an admin action to #logs; never fails the action.
async function audit(text) {
  try {
    await postToDiscord('logs', { embeds: [finish({ color: COLORS.info, author: { name: '/btk' }, description: text, timestamp: new Date().toISOString() })] });
  } catch (e) {
    console.warn('[btk] audit not posted:', (e && e.message) || e);
  }
}

// The visitor's last IP, which gifts and upload limits are keyed by.
async function ipOf(deps, id) {
  const timeline = await readTimeline(deps.redis, id);
  return timeline && timeline.info.ip && timeline.info.ip !== 'unknown' ? timeline.info.ip : '';
}

async function gift(deps, interaction, id, count) {
  if (!isAdmin(interaction)) return 'Only server admins can gift previews.';
  const n = Math.floor(Number(count));
  if (!Number.isFinite(n) || n < 1 || n > MAX_GIFT) return 'Pick a number from 1 to ' + MAX_GIFT + '.';
  const ip = await ipOf(deps, id);
  if (!ip) return 'No IP stored for `' + id + '`, so nothing to gift to.';
  const waiting = await deps.giftPreviews(ip, n);
  const who = actorOf(interaction);
  await Promise.all([
    addStep(deps.redis, id, { kind: Step.gift, text: n + ' previews by ' + who }),
    audit('🎁 ' + who + ' gifted **' + n + '** previews to `' + id + '` (' + waiting + ' waiting, next 24h).')
  ]);
  return '🎁 Gifted ' + n + ' previews to `' + id + '`. ' + waiting + ' are waiting for the next 24 hours, used once their free ones run out.';
}

async function resetUpload(deps, interaction, id) {
  if (!isAdmin(interaction)) return 'Only server admins can reset uploads.';
  const ip = await ipOf(deps, id);
  if (!ip) return 'No IP stored for `' + id + '`, so nothing to reset.';
  await deps.resetUploads(ip);
  const who = actorOf(interaction);
  await Promise.all([
    addStep(deps.redis, id, { kind: Step.reset, text: 'by ' + who }),
    audit('🔄 ' + who + ' reset the photo uploads of `' + id + '`.')
  ]);
  return '🔄 `' + id + '` can upload photos again.';
}

function money(revenue) {
  const parts = Object.entries(revenue || {}).map(([currency, amount]) => (Math.round(amount * 100) / 100) + ' ' + currency);
  return parts.join(' + ') || '0';
}

function top(hash, n = 3) {
  return Object.entries(hash || {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => plain(k) + ' ' + v).join(' · ') || '—';
}

export function todayEmbed(day) {
  const c = day.count;
  const n = (name) => c[name] || 0;
  return finish({
    color: COLORS.info,
    title: '📊 Today so far · ' + day.day + ' (UTC)',
    fields: [
      field('Visitors', String(day.visitors)),
      field('Visits', String(n('visits'))),
      field('Page views', String(n('page_viewed'))),
      field('Product views', String(n('product_viewed'))),
      field('Previews', n('preview_started') + ' started · ' + n('preview_ready') + ' ready · ' + n('preview_failed') + ' failed'),
      field('Add to carts', String(n('product_added_to_cart'))),
      field('Checkouts', String(n('checkout_started'))),
      field('Orders', String(n('checkout_completed'))),
      field('Revenue', money(day.revenue)),
      field('Top sources', top(day.sources), false),
      field('Top countries', top(day.countries), false)
    ]
  });
}

export function balanceEmbed({ fal, openai, higgsfield }) {
  const estimate = (b, link) => {
    if (!b) return 'Not set up. See the ' + link + '.';
    if (b.error) return 'Could not read it (' + clip(b.error, 80) + '). See the ' + link + '.';
    const left = b.left != null ? b.left : b.anchor - b.spent;
    return '**≈ ' + usd(left) + '** (' + usd(b.anchor) + ' on ' + b.at.toISOString().slice(0, 10) + ', ' + usd(b.spent) + ' spent since)';
  };
  return finish({
    color: COLORS.info,
    title: '💰 Credit left',
    fields: [
      field('fal', fal == null ? 'Unknown. See the [billing page](https://fal.ai/dashboard/billing).' : '**' + usd(fal) + '** (exact)', false),
      field('OpenAI', estimate(openai, '[billing page](https://platform.openai.com/settings/organization/billing/overview)'), false),
      field('Higgsfield', estimate(higgsfield, '[console](https://console.higgsfield.ai)'), false)
    ],
    footer: { text: 'OpenAI and Higgsfield are estimates from the last read value; update it after a top-up.' }
  });
}

const settle = (promise) => Promise.resolve(promise).catch((e) => ({ error: String((e && e.message) || e) }));

const COMMANDS = {
  async customer(deps, interaction, options) {
    const input = optionValue(options, 'id');
    const { id, from } = await findVisitor(deps.redis, input);
    return id ? showCustomer(deps, id, { from }) : textMessage(notFound(input));
  },
  async order(deps, interaction, options) {
    const number = String(optionValue(options, 'number') || '').trim();
    const id = await visitorOfOrder(deps.redis, number);
    if (!id) return textMessage('No buyer found for order `' + clip(number.replace(/`/g, ''), 40) + '`. Orders are linked from 2026-11-18, when the pixel saw the buyer.');
    return showCustomer(deps, id, { from: 'order ' + number });
  },
  async today(deps) {
    return { content: '', embeds: [todayEmbed(await readDay(deps.redis, dayOf(deps.now())))], components: [] };
  },
  async gift(deps, interaction, options) {
    const input = optionValue(options, 'id');
    const { id } = await findVisitor(deps.redis, input);
    return textMessage(id ? await gift(deps, interaction, id, optionValue(options, 'count')) : notFound(input));
  },
  async 'upload-reset'(deps, interaction, options) {
    const input = optionValue(options, 'id');
    const { id } = await findVisitor(deps.redis, input);
    return textMessage(id ? await resetUpload(deps, interaction, id) : notFound(input));
  },
  async balance(deps) {
    const [fal, openai, higgsfield] = await Promise.all([
      settle(deps.falBalance()).then((b) => (b && b.error ? null : b)),
      settle(deps.openaiBalance(deps.redis)),
      settle(deps.higgsfieldBalance())
    ]);
    return { content: '', embeds: [balanceEmbed({ fal, openai, higgsfield })], components: [] };
  }
};

const DEFAULT_DEPS = {
  giftPreviews, giftedPreviews, resetUploads, falBalance, openaiBalance, higgsfieldBalance,
  now: () => new Date()
};

function giftModal(id) {
  return {
    custom_id: 'btk:giftform:' + id,
    title: 'Gift previews to ' + id,
    components: [{
      type: 1,
      components: [{ type: 4, custom_id: 'count', label: 'How many previews? (1-' + MAX_GIFT + ')', style: 1, min_length: 1, max_length: 2, value: '2', required: true }]
    }]
  };
}

// The interaction response ({ type, data }) for a command, a button press or
// the gift form. deps.redis is required; the rest default to the real ones.
export async function respond(interaction, deps) {
  const d = { ...DEFAULT_DEPS, ...deps };
  if (!d.redis) return { type: Reply.message, data: textMessage('Redis is not configured, so no timelines are stored.') };
  const data = interaction.data || {};
  try {
    if (interaction.type === Interaction.command) {
      const sub = Array.isArray(data.options) ? data.options[0] : null;
      const run = sub && data.name === COMMAND.name ? COMMANDS[sub.name] : null;
      if (!run) return { type: Reply.message, data: textMessage('Unknown command.') };
      return { type: Reply.message, data: await run(d, interaction, sub.options || []) };
    }

    const [, action, id, extra] = String(data.custom_id || '').split(':');
    if (!parseVisitorId(id || '')) return { type: Reply.message, data: privateMessage('That button is out of date.') };
    if (interaction.type === Interaction.component && action === 'page') {
      return { type: Reply.update, data: await showCustomer(d, id, { offset: Math.max(0, parseInt(extra, 10) || 0) }) };
    }
    if (interaction.type === Interaction.component && action === 'gift') {
      if (!isAdmin(interaction)) return { type: Reply.message, data: privateMessage('Only server admins can gift previews.') };
      return { type: Reply.modal, data: giftModal(id) };
    }
    if (interaction.type === Interaction.component && action === 'reset') {
      return { type: Reply.message, data: privateMessage(await resetUpload(d, interaction, id)) };
    }
    if (interaction.type === Interaction.modal && action === 'giftform') {
      const input = ((data.components || [])[0] || {}).components || [];
      const count = (input.find((c) => c.custom_id === 'count') || {}).value;
      return { type: Reply.message, data: privateMessage(await gift(d, interaction, id, count)) };
    }
    return { type: Reply.message, data: privateMessage('Unknown action.') };
  } catch (e) {
    console.error('[btk] interaction failed:', (e && e.stack) || e);
    return { type: Reply.message, data: privateMessage('Something went wrong. Try again in a moment.') };
  }
}
