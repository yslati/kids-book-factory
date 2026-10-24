// The #custom-generation channel (DISCORD_WEBHOOK_CUSTOM): every custom story
// request, to learn what shoppers want that the catalog doesn't have yet.
// Each request posts everything the parent sent - their story idea, world,
// occasion, the child's name, age and photo - as generation starts, then the
// cover or why it failed as a follow-up linked to it, and a third card if
// they add the book to the cart.
//
// Like #previews, this channel shows the child's photo, name and age by
// design. Images are linked from R2, not uploaded, so they disappear once the
// bucket deletes them.

import { waitUntil } from '@vercel/functions';
import { attemptLabel } from './provider-order.js';
import { WORLDS } from './custom-prompt.js';
import {
  COLORS, code, codeBlock, discordConfigured, envTag, field, finish, footer, messageLink,
  plain, postToDiscord, redact, seconds, visitorFields, visitorOf
} from './discord.js';

const CHANNEL = 'custom';

// "Lina, 5"
function childLabel(r) {
  return [plain(r.childName), r.age].filter(Boolean).join(', ') || 'child';
}

// The reference book's page on the storefront the shopper used, when the
// request's Origin (checked against ALLOWED_ORIGIN) makes a safe link.
function referenceLink(handle, visitor) {
  const origin = /^https?:\/\/[^\s/()[\]<>]+$/.test(visitor.origin) ? visitor.origin : '';
  if (!origin) return code(handle, 80);
  return '[' + plain(handle) + '](' + origin + '/products/' + encodeURIComponent(handle) + ')';
}

function requestEmbed(r, visitor) {
  return finish({
    color: COLORS.info,
    author: { name: 'New custom story' + envTag() },
    title: '✨ ' + childLabel(r) + ' · ' + r.gender + ' · ' + WORLDS[r.world],
    description: 'Their story idea:\n' + codeBlock(r.brief, 1200),
    fields: [
      field('World', WORLDS[r.world]),
      field('Hero', r.gender),
      field('Name', code(r.childName, 40)),
      field('Age', r.age || '—'),
      field('Occasion', r.occasion || '—'),
      field('Reference cover', referenceLink(r.reference, visitor)),
      field('Customer', r.customerId ? 'signed in · ' + r.customerId : 'anonymous'),
      field('Generation', code(r.generationId, 64)),
      ...visitorFields(visitor)
    ],
    image: { url: r.photoUrl },
    footer: footer(visitor.requestId),
    timestamp: new Date().toISOString()
  });
}

function storedAt(outcome) {
  const url = /^https?:\/\/\S+$/.test(outcome.coverUrl || '') ? outcome.coverUrl : code(outcome.coverUrl, 300);
  return outcome.temporary ? '⚠️ Not in R2, temporary provider link:\n' + url : url;
}

function resultEmbed(r, outcome, link, ms, visitor) {
  const failed = Boolean(outcome.error);
  const back = link ? '↪️ Reply to [the request](' + link + ')' : '';
  return finish({
    color: failed ? COLORS.error : COLORS.success,
    author: { name: (failed ? 'Custom cover failed' : 'Cover ready') + envTag() },
    title: (failed ? '❌ ' : '🎨 ') + childLabel(r) + ' · ' + WORLDS[r.world],
    url: link || undefined,
    description: failed ? [back, codeBlock(redact(outcome.error), 600)].filter(Boolean).join('\n') : back,
    fields: [
      field('Time', seconds(ms)),
      !failed && outcome.attempt && field('Model', code(attemptLabel(outcome.attempt), 80)),
      field('Generation', code(r.generationId, 64)),
      !failed && field('Stored', storedAt(outcome), false)
    ],
    image: failed ? undefined : { url: outcome.coverUrl },
    thumbnail: { url: r.photoUrl },
    footer: footer(visitor.requestId),
    timestamp: new Date().toISOString()
  });
}

// Posts the request now. request: { generationId, childName, age, gender,
// world, occasion, brief, reference, photoUrl, customerId, startedAt }.
// Returns { link, done(outcome) }: link resolves to the request message's URL
// ('' when unknown); done posts the follow-up once - outcome is { coverUrl,
// attempt, temporary } or { error } - and resolves when it has gone. Never
// throws; a no-op while the channel is off.
export function announceCustomStory(req, request) {
  const off = { link: Promise.resolve(''), done: () => Promise.resolve(null) };
  if (!discordConfigured(CHANNEL)) return off;

  let visitor;
  let message;
  try {
    visitor = visitorOf(req);
    // A paid generation must never fail over its Discord post.
    message = postToDiscord(CHANNEL, { embeds: [requestEmbed(request, visitor)] }, { wait: true })
      .catch((e) => {
        console.error('[custom-feed] request post failed:', (e && e.stack) || e);
        return null;
      });
  } catch (e) {
    console.error('[custom-feed] request post failed:', (e && e.stack) || e);
    return off;
  }
  waitUntil(message);
  const link = message.then((m) => messageLink(CHANNEL, m)).catch(() => '');

  let followUp = null;
  return {
    link,
    done(outcome) {
      if (followUp) return followUp;
      const ms = Date.now() - (request.startedAt || Date.now());
      followUp = link
        .then((url) => postToDiscord(CHANNEL, { embeds: [resultEmbed(request, outcome, url, ms, visitor)] }))
        .catch((e) => {
          console.error('[custom-feed] follow-up failed:', (e && e.stack) || e);
          return null;
        });
      waitUntil(followUp);
      return followUp;
    }
  };
}

// Posts the add-to-cart card. record is the generation's saved record
// (lib/custom-story.js), cart is { generationId, variant, price }. Resolves
// when posted; null while the channel is off.
export function postCustomCart(req, record, cart) {
  if (!discordConfigured(CHANNEL)) return Promise.resolve(null);
  const visitor = visitorOf(req);
  return postToDiscord(CHANNEL, {
    embeds: [finish({
      color: COLORS.warn,
      author: { name: 'Added to cart' + envTag() },
      title: '🛒 ' + childLabel(record) + ' · custom storybook',
      url: record.link || undefined,
      description: record.link ? '↪️ Reply to [the request](' + record.link + ')' : '',
      fields: [
        field('Cover', plain(cart.variant) || '—'),
        field('Price', plain(cart.price) || '—'),
        field('Generation', code(cart.generationId, 64))
      ],
      thumbnail: record.coverUrl ? { url: record.coverUrl } : undefined,
      footer: footer(visitor.requestId),
      timestamp: new Date().toISOString()
    })]
  });
}
