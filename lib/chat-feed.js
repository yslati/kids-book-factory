// Posts a visitor opening the storefront's Shopify Inbox chat to #chat
// (snippets/kb-chat.liquid in the theme, through api/events.js), with the
// cover they were looking at when it was opened from the preview page, so
// someone can reply from Shopify Inbox.

import { bookTitles, pageLink } from './store-links.js';
import {
  code, COLORS, deviceSummary, discordConfigured, envTag, field, finish, footer, place, plain, postToDiscord
} from './discord.js';
import { ratingLabel } from './preview-feed.js';
import { readPreviewRecord } from './preview-record.js';
import { getRedis } from './redis.js';

const CHANNEL = 'chat';

// { path, generationId, rating, conversationId } from the storefront's body, or null.
export function chatOpened(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.event !== 'chat_opened') return null;
  const path = String(b.path || '');
  if (!/^\/\S{0,300}$/.test(path)) return null;
  const id = String(b.generation_id || '');
  const conversation = String(b.conversation_id || '');
  return {
    path,
    generationId: /^[A-Za-z0-9-]{1,64}$/.test(id) ? id : '',
    rating: ratingLabel(b.rating) && Number.isInteger(b.rating) ? b.rating : 0,
    conversationId: /^[0-9A-Za-z-]{10,64}$/.test(conversation) ? conversation : ''
  };
}

// Where the reply is written: the visitor's conversation in Shopify Inbox
// (the storefront chat's own conversation id), else the Inbox sales channel.
export function inboxLink(conversationId) {
  const store = (String(process.env.SHOPIFY_SHOP || '').match(/^([\w-]+)\.myshopify\.com$/) || [])[1];
  if (!store) return 'Shopify Inbox';
  if (conversationId) return '[Shopify Inbox](https://inbox.shopify.com/store/' + store + '/conversations/open/' + conversationId + ')';
  return '[Shopify Inbox](https://admin.shopify.com/store/' + store + '/apps/shopify-inbox/shopify_chat)';
}

// The #chat card. record is the cover's preview record, or null.
export function chatEmbed(chat, visitor, record, titles) {
  const who = record ? [plain(record.childName), record.age].filter(Boolean).join(', ') : '';
  return finish({
    color: COLORS.warn,
    author: { name: 'Chat opened' + envTag() },
    title: '💬 ' + (who ? 'Parent of ' + who : 'A visitor') + ' opened the chat',
    description: '↪️ Reply in ' + inboxLink(chat.conversationId) + (record && record.link ? ' · [their preview](' + record.link + ')' : ''),
    fields: [
      field('Page', pageLink(chat.path, titles)),
      record && record.bookTitle && field('Book', plain(record.bookTitle)),
      chat.rating && field('Cover rating', ratingLabel(chat.rating)),
      field('Visitor', place(visitor)),
      field('Device', deviceSummary(visitor.userAgent)),
      chat.generationId && field('Generation', code(chat.generationId, 64))
    ],
    thumbnail: record && record.coverUrl ? { url: record.coverUrl } : undefined,
    footer: footer(visitor.requestId),
    timestamp: new Date().toISOString()
  });
}

// Resolves when posted; null while the channel is off.
export async function postChatOpened(chat, visitor) {
  if (!discordConfigured(CHANNEL)) return null;
  const [titles, record] = await Promise.all([
    bookTitles(),
    chat.generationId ? readPreviewRecord(getRedis(), chat.generationId).catch(() => null) : null
  ]);
  return postToDiscord(CHANNEL, { embeds: [chatEmbed(chat, visitor, record, titles)] });
}
