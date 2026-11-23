// The Discord app's /btk command (api/discord.js): one slash command whose
// subcommands Discord lists with their parameters as you type "/btk ".
// COMMAND is what scripts/discord-commands.mjs registers; add a subcommand
// there and its handler in COMMANDS.
//
//   /btk customer id:      one visitor's timeline (lib/visitor-log.js), found
//                          by Visitor ID, generation ID or Shopify customer
//                          (admin link or id), with
//                          buttons for older steps, a gift, an upload reset
//                          and their Clarity recordings
//   /btk order number:     the same, found from an order
//   /btk today             today's funnel so far (UTC)
//   /btk gift id: count:   extra previews for a visitor, today
//   /btk upload-reset id:  a visitor's photo uploads back to full
//   /btk block id: [days:] no more covers for a visitor, their IP and their
//                          Shopify customer (lib/blocklist.js)
//   /btk unblock id:       lifts that block
//   /btk share image: name: book: [age:] [language:]
//                          a share link for a cover made outside the store
//                          (lib/btk-share.js); book autocompletes from the store
//   /btk balance           fal's credit, and links to OpenAI's and Higgsfield's
//
// Gifts, upload resets, blocks and share links need Administrator or Manage Server, are added to
// the visitor's timeline and posted to #logs.

import { createPublicKey, verify } from 'node:crypto';
import { COLORS, clip, code, customerLink, field, finish, plain, postToDiscord } from './discord.js';
import { parseVisitorId } from './visitor-id.js';
import { Step, addStep, readTimeline, visitorOfGeneration, visitorOfOrder, visitorsOfCustomer } from './visitor-log.js';
import { MAX_GIFT, giftPreviews, giftedPreviews, resetUploads } from './ratelimit.js';
import { dayOf, readDay } from './event-stats.js';
import { falBalance } from './fal-balance.js';
import { usd } from './spend.js';
import { BOOK_LANGUAGES, resolveBookLanguage } from './book-languages.js';
import { bookTitles } from './store-links.js';
import { attachmentProblem, shareCover } from './btk-share.js';
import { r2Configured } from './r2.js';
import { DEFAULT_BLOCK_DAYS, MAX_BLOCK_DAYS, blockOf, blockVisitor, unblockVisitor } from './blocklist.js';

const VISITOR_OPTION = { type: 3, name: 'id', description: 'Visitor ID (V-…), generation ID, or Shopify customer link or id', required: true, max_length: 200 };

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
    {
      type: 1,
      name: 'block',
      description: 'Stop a visitor (and their IP and account) from making covers',
      options: [VISITOR_OPTION, { type: 4, name: 'days', description: 'For how many days (' + DEFAULT_BLOCK_DAYS + ' if left out)', min_value: 1, max_value: MAX_BLOCK_DAYS }]
    },
    { type: 1, name: 'unblock', description: 'Let a blocked visitor make covers again', options: [VISITOR_OPTION] },
    {
      type: 1,
      name: 'share',
      description: 'A share link for a cover image, opening that book\'s preview page',
      options: [
        { type: 11, name: 'image', description: 'The cover (JPEG, PNG or WebP, under 10 MB)', required: true },
        { type: 3, name: 'name', description: 'The child\'s name, as on the cover', required: true, max_length: 40 },
        { type: 3, name: 'book', description: 'The book (start typing its title)', required: true, autocomplete: true, max_length: 120 },
        { type: 4, name: 'age', description: 'The child\'s age', min_value: 0, max_value: 18 },
        { type: 3, name: 'language', description: 'The book\'s language (English if left out)', choices: Object.entries(BOOK_LANGUAGES).map(([value, name]) => ({ name, value })) }
      ]
    },
    { type: 1, name: 'balance', description: 'fal credit left, with links to OpenAI and Higgsfield billing' }
  ]
};

// Interaction and response types (Discord API).
export const Interaction = { ping: 1, command: 2, component: 3, autocomplete: 4, modal: 5 };
const Reply = { message: 4, update: 7, choices: 8, modal: 9 };
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
  [Step.reset]: ['🔄', 'Uploads reset'],
  [Step.block]: ['🚫', 'Blocked'],
  [Step.unblock]: ['✅', 'Unblocked'],
  [Step.account]: ['🔑', 'Account']
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
// from offset; gifts is how many gifted previews are waiting, others the
// customer's other Visitor IDs (other devices or days), block their block
// (lib/blocklist.js) or null.
export function customerMessage(timeline, { from = '', offset = 0, gifts = 0, others = [], block = null } = {}) {
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
    color: block ? COLORS.error : countOf(steps, Step.order) ? COLORS.success : COLORS.info,
    title: '👤 Visitor ' + id,
    description: page.map(stepLine).reverse().join('\n') || 'No steps stored.',
    fields: [
      field('Where', info.place || 'unknown'),
      field('Device', info.device || 'unknown'),
      field('IP', code(info.ip || 'unknown', 64)),
      field('First seen', relative(info.first)),
      field('Last seen', relative(info.last)),
      field('Totals', summary),
      info.customer && field('Shopify customer', customerLink(info.customer)),
      others.length > 0 && field('Same customer', others.slice(0, 6).map((o) => code(o, 12)).join(' ') + (others.length > 6 ? ' +' + (others.length - 6) : '')),
      gifts > 0 && field('Gifted previews left', String(gifts)),
      block && field('🚫 Blocked', (block.until ? 'until <t:' + Math.floor(block.until / 1000) + ':d>' : 'yes') + (block.by ? ' · by ' + plain(block.by) : '')),
      from && field('Found from', code(from, 70), false)
    ],
    footer: { text: (steps.length ? 'Steps ' + (start + 1) + '–' + (start + page.length) + ' of ' + steps.length + ' (newest first) · ' : '') + 'kept 90 days' }
  });

  // Discord takes 5 buttons a row: paging and Clarity, then the admin actions.
  const browse = [];
  if (start > 0) browse.push(button('Newer steps', 'btk:page:' + id + ':' + Math.max(0, start - PAGE_STEPS)));
  if (start + PAGE_STEPS < steps.length) browse.push(button('Older steps', 'btk:page:' + id + ':' + (start + PAGE_STEPS)));
  const clarity = clarityUrl(info.key);
  if (clarity) browse.push({ type: 2, style: 5, label: 'Clarity recordings', url: clarity });
  const actions = [
    button('Gift previews', 'btk:gift:' + id, 3),
    button('Reset uploads', 'btk:reset:' + id),
    block ? button('Unblock', 'btk:unblock:' + id, 3) : button('Block', 'btk:block:' + id, 4)
  ];
  const components = [browse, actions].filter((row) => row.length).map((row) => ({ type: 1, components: row }));
  return { content: '', embeds: [embed], components };
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

// Of a customer's visitors, the one seen last.
async function latestOfCustomer(redis, customerId) {
  const ids = await visitorsOfCustomer(redis, customerId);
  const seen = await Promise.all(ids.map((v) => redis.hget('kbf:who:' + v + ':info', 'last')));
  return ids.map((v, i) => [v, Number(seen[i]) || 0]).sort((a, b) => b[1] - a[1]).map(([v]) => v)[0] || '';
}

// The visitor behind a Visitor ID, a generation ID, or a Shopify customer
// (admin link, "customer 123" or the bare id): { id, from }.
async function findVisitor(redis, input) {
  const text = String(input || '').trim();
  const id = parseVisitorId(text);
  if (id) return { id, from: '' };
  const named = text.match(/\/customers\/(\d{1,20})(?:[/?#]|$)/) || text.match(/^customer[:\s#]*(\d{1,20})$/i);
  if (!named && /^[A-Za-z0-9-]{1,64}$/.test(text)) {
    const found = await visitorOfGeneration(redis, text);
    if (found) return { id: found, from: 'generation ' + text };
  }
  const customer = named ? named[1] : (/^\d{6,20}$/.test(text) ? text : '');
  const found = customer ? await latestOfCustomer(redis, customer) : '';
  return { id: found, from: found ? 'customer ' + customer : '' };
}

function notFound(input) {
  return 'No visitor found for `' + clip(String(input).replace(/`/g, ''), 70) + '`. Paste a Visitor ID (V-…), a generation ID from a card, or a Shopify customer link (customers seen signed in or ordering from 2026-11-18).';
}

async function showCustomer(deps, id, { from = '', offset = 0 } = {}) {
  const timeline = await readTimeline(deps.redis, id);
  if (!timeline) return textMessage('Nothing stored for `' + id + '` (steps are kept 90 days).');
  const [gifts, others, block] = await Promise.all([
    timeline.info.ip ? deps.giftedPreviews(timeline.info.ip).catch(() => 0) : 0,
    timeline.info.customer ? visitorsOfCustomer(deps.redis, timeline.info.customer).catch(() => []) : [],
    blockOf(deps.redis, id).catch(() => null)
  ]);
  return customerMessage(timeline, { from, offset, gifts, others: others.filter((o) => o !== id), block });
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

async function block(deps, interaction, id, days = DEFAULT_BLOCK_DAYS) {
  if (!isAdmin(interaction)) return 'Only server admins can block visitors.';
  const n = Math.floor(Number(days));
  if (!Number.isFinite(n) || n < 1 || n > MAX_BLOCK_DAYS) return 'Pick a number of days from 1 to ' + MAX_BLOCK_DAYS + '.';
  const timeline = await readTimeline(deps.redis, id);
  const info = (timeline && timeline.info) || {};
  const who = actorOf(interaction);
  const record = await blockVisitor(deps.redis, { id, ip: info.ip, customer: info.customer }, { by: who, days: n, now: deps.now().getTime() });
  const covers = ['`' + id + '`', record.ip && 'IP ' + code(record.ip, 64), record.customer && 'customer ' + record.customer].filter(Boolean).join(', ');
  await Promise.all([
    addStep(deps.redis, id, { kind: Step.block, text: n + ' days by ' + who }),
    audit('🚫 ' + who + ' blocked ' + covers + ' from making covers for ' + n + ' days.')
  ]);
  return '🚫 Blocked ' + covers + ' for ' + n + ' days. They are told their previews are used up. Others on the same IP are blocked too; undo with /btk unblock.';
}

async function unblock(deps, interaction, id) {
  if (!isAdmin(interaction)) return 'Only server admins can unblock visitors.';
  if (!(await unblockVisitor(deps.redis, id))) return '`' + id + '` is not blocked.';
  const who = actorOf(interaction);
  await Promise.all([
    addStep(deps.redis, id, { kind: Step.unblock, text: 'by ' + who }),
    audit('✅ ' + who + ' unblocked `' + id + '`.')
  ]);
  return '✅ `' + id + '` can make covers again.';
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

// fal's credit from its API; OpenAI and Higgsfield have no balance API, so
// their billing pages are linked.
export function balanceEmbed({ fal }) {
  return finish({
    color: COLORS.info,
    title: '💰 Credit left',
    fields: [
      field('fal', fal == null ? 'Could not read it. See the [billing page](https://fal.ai/dashboard/billing).' : '**' + usd(fal) + '**', false),
      field('OpenAI', 'No balance API: see the [billing page](https://platform.openai.com/settings/organization/billing/overview).', false),
      field('Higgsfield', 'No balance API: see the [console](https://console.higgsfield.ai).', false)
    ]
  });
}

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
  async block(deps, interaction, options) {
    const input = optionValue(options, 'id');
    const { id } = await findVisitor(deps.redis, input);
    return textMessage(id ? await block(deps, interaction, id, optionValue(options, 'days') ?? DEFAULT_BLOCK_DAYS) : notFound(input));
  },
  async unblock(deps, interaction, options) {
    const input = optionValue(options, 'id');
    const { id } = await findVisitor(deps.redis, input);
    return textMessage(id ? await unblock(deps, interaction, id) : notFound(input));
  },
  async share(deps, interaction, options) {
    if (!isAdmin(interaction)) return textMessage('Only server admins can make share links.');
    if (!deps.r2Configured()) return textMessage('R2 storage is not configured, so covers can\'t be stored.');
    const attachments = ((interaction.data || {}).resolved || {}).attachments || {};
    const attachment = attachments[optionValue(options, 'image')];
    const problem = attachmentProblem(attachment);
    if (problem) return textMessage(problem);
    const childName = String(optionValue(options, 'name') || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!childName) return textMessage('Give the child\'s name.');
    const handle = String(optionValue(options, 'book') || '').trim();
    const titles = await deps.bookTitles();
    if (!titles.has(handle)) return textMessage('Pick the book from the list as you type its title.');
    const age = optionValue(options, 'age');
    const language = resolveBookLanguage(optionValue(options, 'language') || 'en');
    const made = await deps.shareCover(deps.redis, {
      attachment, childName, handle, bookTitle: titles.get(handle), age: age == null ? '' : String(age), language
    });
    if (!made.shareUrl) return textMessage('The cover is stored (' + made.coverUrl + ') but the link could not be made. Try again in a moment.');
    await audit('🔗 ' + actorOf(interaction) + ' made a share link for **' + plain(childName) + '** · ' + plain(titles.get(handle)) + ': ' + made.shareUrl);
    return {
      content: '',
      embeds: [finish({
        color: COLORS.success,
        title: '🔗 Share link for ' + childName,
        description: '```\n' + made.shareUrl + '\n```',
        fields: [
          field('Book', plain(titles.get(handle))),
          field('Language', language.name),
          age != null && field('Age', String(age)),
          field('Your test link', '[open without counting](' + made.teamUrl + ')', false)
        ],
        image: { url: made.coverUrl },
        footer: { text: 'Kept 30 days, like the covers' }
      })],
      components: []
    };
  },
  async balance(deps) {
    const fal = await Promise.resolve(deps.falBalance()).catch(() => null);
    return { content: '', embeds: [balanceEmbed({ fal })], components: [] };
  }
};

// Up to 25 books whose title or handle holds what was typed into the focused option.
async function bookChoices(deps, data) {
  const sub = (data.options || [])[0] || {};
  const focused = (sub.options || []).find((o) => o.focused) || {};
  const typed = String(focused.value || '').toLowerCase().trim();
  const titles = await deps.bookTitles();
  return [...titles.entries()]
    .filter(([handle, title]) => !typed || title.toLowerCase().includes(typed) || handle.includes(typed))
    .sort((a, b) => a[1].localeCompare(b[1]))
    .slice(0, 25)
    .map(([handle, title]) => ({ name: clip(title, 100), value: handle }));
}

const DEFAULT_DEPS = {
  giftPreviews, giftedPreviews, resetUploads, falBalance, bookTitles, shareCover, r2Configured,
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
    if (interaction.type === Interaction.autocomplete) return { type: Reply.choices, data: { choices: await bookChoices(d, data) } };
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
    if (interaction.type === Interaction.component && action === 'block') {
      return { type: Reply.message, data: privateMessage(await block(d, interaction, id)) };
    }
    if (interaction.type === Interaction.component && action === 'unblock') {
      return { type: Reply.message, data: privateMessage(await unblock(d, interaction, id)) };
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
