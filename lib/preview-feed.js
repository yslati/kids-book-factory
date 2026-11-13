// The #previews channel (DISCORD_WEBHOOK_PREVIEWS): each preview posts the
// child's photo as generation starts, then the cover - or why it failed - as
// a follow-up. Webhooks can't send real Discord replies, so the follow-up's
// title links back to the photo message and repeats the photo as a
// thumbnail, which keeps each pair readable when previews overlap.
//
// Unlike #logs, this channel shows the child's photo, name and age: it is for
// checking covers. Images are linked from R2 rather than uploaded, so Discord
// only caches them, and they disappear once the bucket deletes them.
//
// When the parent adds the book to the cart with extra details about the
// child (preview page), a third card carries them, linked to the photo. So do
// the parent's rating of the cover, and a free fix: its photo card names the
// problem and the rating and links to the first cover's photo.
//
// Each card also shows the visitor's count ("2nd upload from this IP") from
// lib/visitor-counts.js, which does the counting.

import { waitUntil } from '@vercel/functions';
import { attemptLabel } from './provider-order.js';
import { bookLink, bookTitles } from './store-links.js';
import {
  COLORS, code, codeBlock, discordConfigured, envTag, field, finish, footer, messageLink,
  deviceSummary, ordinal, place, plain, postToDiscord, redact, seconds, visitorOf
} from './discord.js';

const CHANNEL = 'previews';
const RATINGS = { 1: '😞 1/5 · Not right', 2: '😕 2/5 · Not quite', 3: '😐 3/5 · It’s okay', 4: '😊 4/5 · Great', 5: '😍 5/5 · Love it' };

// "😕 2/5 · Not quite", as the preview page shows it; '' for anything else.
export function ratingLabel(rating) {
  return RATINGS[rating] || '';
}

// "2nd upload from this IP"; nothing when the count is unknown.
function countField(n, what, by) {
  if (!n) return null;
  return field('Count', ordinal(n) + ' ' + what + ' from this ' + (by === 'customer' ? 'customer' : 'IP'));
}

// "Emma, 5"
function childLabel(p) {
  return [plain(p.childName), p.age].filter(Boolean).join(', ') || 'child';
}

function photoEmbed(p, visitor, counts, titles) {
  return finish({
    color: COLORS.info,
    author: { name: (p.fix ? 'Free fix requested' : 'New preview') + envTag() },
    title: (p.fix ? '🔧 ' : '📸 ') + childLabel(p) + ' · ' + plain(titles.get(p.themeId) || p.themeId),
    fields: [
      p.fix && field('Problem', plain(p.fix.problem), false),
      p.fix && ratingLabel(p.fix.rating) && field('Rating', ratingLabel(p.fix.rating)),
      p.fix && field('Fix of', p.fix.link ? '[first cover](' + p.fix.link + ')' : code(p.fix.of, 64)),
      counts && countField(counts.upload, 'upload', counts.by),
      field('Book', bookLink(p.themeId, titles, { origin: visitor.origin })),
      field('Language', p.language || '—'),
      field('Customer', p.customerId ? 'signed in · ' + p.customerId : 'anonymous'),
      field('Visitor', place(visitor)),
      field('Generation', code(p.generationId, 64))
    ],
    image: { url: p.photoUrl },
    footer: footer(visitor.requestId),
    timestamp: new Date().toISOString()
  });
}

// Where the cover lives (lib/cover-store.js): R2, Upstash until R2 takes it,
// or only the provider's temporary link.
export function storedAt(outcome) {
  const url = /^https?:\/\/\S+$/.test(outcome.coverUrl || '') ? outcome.coverUrl : code(outcome.coverUrl, 300);
  if (outcome.stored === 'pending') return '⚠️ R2 refused it: kept in Upstash and served by the backend until R2 takes it (link stays valid):\n' + url;
  if (outcome.stored === 'provider') return '🚨 Not kept: temporary provider link, gone in about 7 days:\n' + url;
  return url;
}

function resultEmbed(p, outcome, link, ms, visitor, counts) {
  const failed = Boolean(outcome.error);
  const back = link ? '↪️ Reply to [the photo](' + link + ')' : '';
  return finish({
    color: failed ? COLORS.error : COLORS.success,
    author: { name: (failed ? 'Preview failed' : 'Cover ready') + envTag() },
    // The book title comes from Shopify; the handle fallback came from the request.
    title: (failed ? '❌ ' : '🎨 ') + childLabel(p) + ' · ' + (outcome.bookTitle || plain(p.themeId)),
    url: link || undefined,
    description: failed ? [back, codeBlock(redact(outcome.error), 600)].filter(Boolean).join('\n') : back,
    fields: [
      counts && countField(counts.preview, 'preview', counts.by),
      field('Time', seconds(ms)),
      !failed && outcome.attempt && field('Model', code(attemptLabel(outcome.attempt), 80) +
        (typeof outcome.cost === 'number' ? '\n$' + outcome.cost.toFixed(4) : '')),
      field('Generation', code(p.generationId, 64)),
      !failed && field('Stored', storedAt(outcome), false)
    ],
    image: failed ? undefined : { url: outcome.coverUrl },
    thumbnail: { url: p.photoUrl },
    footer: footer(visitor.requestId),
    timestamp: new Date().toISOString()
  });
}

// Posts the photo now. preview: { photoUrl, themeId, generationId, childName,
// age, language, customerId, startedAt, counts, fix? }, where fix is
// { of, problem } for a free fix and counts is
// countPreview's result or its promise (lib/visitor-counts.js). Returns
// done(outcome), which posts the follow-up once - outcome is { coverUrl,
// bookTitle, attempt, temporary } or { error } - and resolves when it has
// gone. Also returns link, a promise of the photo message's link ('' when it
// couldn't post), or null while the channel is off. Never throws; a no-op
// while the channel is off.
export function announcePreview(req, preview) {
  const off = { link: null, done: () => Promise.resolve(null) };
  if (!discordConfigured(CHANNEL)) return off;

  let visitor;
  let counts;
  let photo;
  try {
    visitor = visitorOf(req);
    counts = Promise.resolve(preview.counts).catch(() => null);
    // A paid generation must never fail over its Discord post.
    photo = Promise.all([counts, bookTitles()])
      .then(([n, titles]) => postToDiscord(CHANNEL, { embeds: [photoEmbed(preview, visitor, n, titles)] }, { wait: true }))
      .catch((e) => {
        console.error('[preview-feed] photo post failed:', (e && e.stack) || e);
        return null;
      });
  } catch (e) {
    console.error('[preview-feed] photo post failed:', (e && e.stack) || e);
    return off;
  }
  waitUntil(photo);
  const link = photo.then((m) => messageLink(CHANNEL, m)).catch(() => '');

  return { link, done: followUp(preview, visitor, link, counts) };
}

// The feed of a preview whose photo announcePreview posted in an earlier
// request: preview as given to it, with counts resolved, and link what its
// link resolved to. Returns { link, done } like announcePreview.
export function resumePreviewFeed(req, preview, link) {
  if (!discordConfigured(CHANNEL)) return { link: null, done: () => Promise.resolve(null) };
  return { link: Promise.resolve(link), done: followUp(preview, visitorOf(req), Promise.resolve(link), Promise.resolve(preview.counts)) };
}

// done(outcome): posts the cover or the error once, linked to the photo.
function followUp(preview, visitor, link, counts) {
  let posted = null;
  return (outcome) => {
    if (posted) return posted;
    const ms = Date.now() - (preview.startedAt || Date.now());
    posted = Promise.all([link, counts])
      .then(([photoLink, n]) => postToDiscord(CHANNEL, {
        embeds: [resultEmbed(preview, outcome, photoLink, ms, visitor, n)]
      }))
      .catch((e) => {
        console.error('[preview-feed] follow-up failed:', (e && e.stack) || e);
        return null;
      });
    waitUntil(posted);
    return posted;
  };
}

// Posts the parent's occasion and extra details when they add the book to the
// cart. record is the generation's saved record (lib/preview-record.js), cart
// is { generationId, variant, occasion, details }. Resolves when posted; null
// while the channel is off.
export function postPreviewDetails(req, record, cart) {
  if (!discordConfigured(CHANNEL)) return Promise.resolve(null);
  const visitor = visitorOf(req);
  return postToDiscord(CHANNEL, {
    embeds: [finish({
      color: COLORS.warn,
      author: { name: 'Added to cart' + envTag() },
      title: '🛒 ' + childLabel(record) + ' · ' + (plain(record.bookTitle) || 'book'),
      url: record.link || undefined,
      description: record.link ? '↪️ Reply to [the photo](' + record.link + ')' : '',
      fields: [
        field('Cover', plain(cart.variant) || '—'),
        field('Occasion', plain(cart.occasion) || '—'),
        field('Extra details', plain(cart.details) || '—', false),
        field('Generation', code(cart.generationId, 64))
      ],
      thumbnail: record.coverUrl ? { url: record.coverUrl } : undefined,
      footer: footer(visitor.requestId),
      timestamp: new Date().toISOString()
    })]
  });
}

// Posts the parent's rating of a cover from the preview page. record is the
// generation's saved record, rated is { generationId, rating }. Resolves when
// posted; null while the channel is off.
export function postPreviewRating(req, record, rated) {
  if (!discordConfigured(CHANNEL)) return Promise.resolve(null);
  const visitor = visitorOf(req);
  const color = rated.rating >= 4 ? COLORS.success : rated.rating === 3 ? COLORS.warn : COLORS.error;
  return postToDiscord(CHANNEL, {
    embeds: [finish({
      color,
      author: { name: 'Cover rated' + envTag() },
      title: ratingLabel(rated.rating).split(' ')[0] + ' ' + childLabel(record) + ' · ' + (plain(record.bookTitle) || 'book'),
      url: record.link || undefined,
      description: record.link ? '↪️ Reply to [the photo](' + record.link + ')' : '',
      fields: [
        field('Rating', ratingLabel(rated.rating)),
        record.fixOf && field('Fix of', code(record.fixOf, 64)),
        field('Generation', code(rated.generationId, 64))
      ],
      thumbnail: record.coverUrl ? { url: record.coverUrl } : undefined,
      footer: footer(visitor.requestId),
      timestamp: new Date().toISOString()
    })]
  });
}

const SHARE_LABELS = { native: 'the share sheet', whatsapp: 'WhatsApp', facebook: 'Facebook', copy: 'a copied link' };

// Posts a parent pressing a share button on their preview, once per button
// per generation. record is the generation's saved record. Resolves when
// posted; null while the channel is off.
export function postShareClick(req, record, share) {
  if (!discordConfigured(CHANNEL)) return Promise.resolve(null);
  const visitor = visitorOf(req);
  return postToDiscord(CHANNEL, {
    embeds: [finish({
      color: COLORS.success,
      author: { name: 'Preview shared' + envTag() },
      title: '🔗 ' + childLabel(record) + ' · ' + (plain(record.bookTitle) || 'book') + ' · via ' + SHARE_LABELS[share.via],
      url: record.link || undefined,
      description: record.link ? '↪️ Reply to [the photo](' + record.link + ')' : '',
      fields: [
        field('Visitor', place(visitor)),
        field('Generation', code(share.generationId, 64))
      ],
      thumbnail: record.coverUrl ? { url: record.coverUrl } : undefined,
      footer: footer(visitor.requestId),
      timestamp: new Date().toISOString()
    })]
  });
}

// Posts someone opening a shared preview link (api/share.js). link is
// { id, childName, coverUrl, book }, opens how often this link has been
// opened. Resolves when posted; null while the channel is off.
export async function postShareOpen(visitor, link, opens) {
  if (!discordConfigured(CHANNEL)) return null;
  const titles = await bookTitles();
  return postToDiscord(CHANNEL, {
    embeds: [finish({
      color: COLORS.success,
      author: { name: 'Shared preview opened' + envTag() },
      title: '👀 ' + (plain(link.childName) || 'A child') + ' · ' + (plain(titles.get(link.book) || link.book) || 'book'),
      fields: [
        field('Opens', ordinal(opens) + ' open of this link'),
        link.book && field('Book', bookLink(link.book, titles)),
        field('Link', code(link.id, 60)),
        field('Visitor', place(visitor)),
        field('Device', deviceSummary(visitor.userAgent))
      ],
      thumbnail: link.coverUrl ? { url: link.coverUrl } : undefined,
      footer: footer(visitor.requestId),
      timestamp: new Date().toISOString()
    })]
  });
}
