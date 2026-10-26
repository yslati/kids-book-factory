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
// child (preview page), a third card carries them, linked to the photo.
//
// Each card also shows the visitor's count ("2nd upload from this IP") from
// lib/visitor-counts.js, which does the counting.

import { waitUntil } from '@vercel/functions';
import { attemptLabel } from './provider-order.js';
import {
  COLORS, code, codeBlock, discordConfigured, envTag, field, finish, footer, messageLink,
  ordinal, place, plain, postToDiscord, redact, seconds, visitorOf
} from './discord.js';

const CHANNEL = 'previews';
// "2nd upload from this IP"; nothing when the count is unknown.
function countField(n, what, by) {
  if (!n) return null;
  return field('Count', ordinal(n) + ' ' + what + ' from this ' + (by === 'customer' ? 'customer' : 'IP'));
}

// "Emma, 5"
function childLabel(p) {
  return [plain(p.childName), p.age].filter(Boolean).join(', ') || 'child';
}

// The book's page on the storefront the shopper used: the request's Origin,
// which /api/preview has checked against ALLOWED_ORIGIN. Shown as plain code
// when either part could break the link.
function bookLink(p, visitor) {
  const origin = /^https?:\/\/[^\s/()[\]<>]+$/.test(visitor.origin) ? visitor.origin : '';
  if (!origin || !/^[^\s()[\]<>]+$/.test(p.themeId)) return code(p.themeId, 80);
  return '[' + plain(p.themeId) + '](' + origin + '/products/' + encodeURIComponent(p.themeId) + ')';
}

function photoEmbed(p, visitor, counts) {
  return finish({
    color: COLORS.info,
    author: { name: 'New preview' + envTag() },
    title: '📸 ' + childLabel(p) + ' · ' + plain(p.themeId),
    fields: [
      counts && countField(counts.upload, 'upload', counts.by),
      field('Book', bookLink(p, visitor)),
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

// Where the cover lives: its permanent R2 link, or the provider's temporary
// one when copying it to R2 failed.
function storedAt(outcome) {
  const url = /^https?:\/\/\S+$/.test(outcome.coverUrl || '') ? outcome.coverUrl : code(outcome.coverUrl, 300);
  return outcome.temporary ? '⚠️ Not in R2, temporary provider link:\n' + url : url;
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
      !failed && outcome.attempt && field('Model', code(attemptLabel(outcome.attempt), 80)),
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
// age, language, customerId, startedAt, counts }, where counts is
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
    photo = counts
      .then((n) => postToDiscord(CHANNEL, { embeds: [photoEmbed(preview, visitor, n)] }, { wait: true }))
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

  let followUp = null;
  return {
    link,
    done(outcome) {
      if (followUp) return followUp;
      const ms = Date.now() - (preview.startedAt || Date.now());
      followUp = Promise.all([photo, counts])
        .then(async ([message, n]) => postToDiscord(CHANNEL, {
          embeds: [resultEmbed(preview, outcome, await messageLink(CHANNEL, message), ms, visitor, n)]
        }))
        .catch((e) => {
          console.error('[preview-feed] follow-up failed:', (e && e.stack) || e);
          return null;
        });
      waitUntil(followUp);
      return followUp;
    }
  };
}

// Posts the parent's extra details when they add the book to the cart. record
// is the generation's saved record (lib/preview-record.js), cart is
// { generationId, variant, details }. Resolves when posted; null while the
// channel is off.
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
        field('Extra details', plain(cart.details), false),
        field('Generation', code(cart.generationId, 64))
      ],
      thumbnail: record.coverUrl ? { url: record.coverUrl } : undefined,
      footer: footer(visitor.requestId),
      timestamp: new Date().toISOString()
    })]
  });
}
