// The #previews channel (DISCORD_WEBHOOK_PREVIEWS): each preview posts the
// child's photo as generation starts, then the cover - or why it failed - as
// a follow-up. Webhooks can't send real Discord replies, so the follow-up's
// title links back to the photo message and repeats the photo as a
// thumbnail, which keeps each pair readable when previews overlap.
//
// Unlike #logs, this channel shows the child's photo, name and age: it is for
// checking covers. Images are linked from R2 rather than uploaded, so Discord
// only caches them, and they disappear once the bucket deletes them.

import { waitUntil } from '@vercel/functions';
import { attemptLabel } from './provider-order.js';
import {
  COLORS, code, codeBlock, discordConfigured, envTag, field, finish, footer, messageLink,
  place, plain, postToDiscord, redact, seconds, visitorOf
} from './discord.js';

const CHANNEL = 'previews';

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

function photoEmbed(p, visitor) {
  return finish({
    color: COLORS.info,
    author: { name: 'New preview' + envTag() },
    title: '📸 ' + childLabel(p) + ' · ' + plain(p.themeId),
    fields: [
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

function resultEmbed(p, outcome, link, ms, visitor) {
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
// age, language, customerId, startedAt }. Returns done(outcome), which posts
// the follow-up once - outcome is { coverUrl, bookTitle, attempt, temporary }
// or { error } - and resolves when it has gone. Never throws; a no-op while
// the channel is off.
export function announcePreview(req, preview) {
  const off = { done: () => Promise.resolve(null) };
  if (!discordConfigured(CHANNEL)) return off;

  let visitor;
  let photo;
  try {
    visitor = visitorOf(req);
    photo = postToDiscord(CHANNEL, { embeds: [photoEmbed(preview, visitor)] }, { wait: true });
  } catch (e) {
    // A paid generation must never fail over its Discord post.
    console.error('[preview-feed] photo post failed:', (e && e.stack) || e);
    return off;
  }
  waitUntil(photo);

  let followUp = null;
  return {
    done(outcome) {
      if (followUp) return followUp;
      const ms = Date.now() - (preview.startedAt || Date.now());
      followUp = photo
        .then(async (message) => postToDiscord(CHANNEL, {
          embeds: [resultEmbed(preview, outcome, await messageLink(CHANNEL, message), ms, visitor)]
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
