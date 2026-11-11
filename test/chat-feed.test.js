// The #chat alert for a visitor opening the storefront chat.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chatEmbed, chatOpened, inboxLink } from '../lib/chat-feed.js';

const visitor = { country: 'GB', region: '', city: 'London', timezone: 'Europe/London', userAgent: '', requestId: 'r1' };

test('a chat opening is read from the storefront body', () => {
  assert.deepEqual(chatOpened({ event: 'chat_opened', path: '/pages/create-your-book', generation_id: 'm8mtjy6rzr', rating: 2 }),
    { path: '/pages/create-your-book', generationId: 'm8mtjy6rzr', rating: 2 });
  assert.deepEqual(chatOpened({ event: 'chat_opened', path: '/', generation_id: '../x', rating: 9 }),
    { path: '/', generationId: '', rating: 0 });
  assert.equal(chatOpened({ event: 'chat_opened', path: 'https://evil.example/' }), null);
  assert.equal(chatOpened({ event: 'page_viewed', path: '/' }), null);
  assert.equal(chatOpened(null), null);
});

test('the Inbox link opens the store\'s Inbox sales channel', (t) => {
  const saved = process.env.SHOPIFY_SHOP;
  t.after(() => { if (saved === undefined) delete process.env.SHOPIFY_SHOP; else process.env.SHOPIFY_SHOP = saved; });
  process.env.SHOPIFY_SHOP = 'eytisc-0a.myshopify.com';
  assert.equal(inboxLink(), '[Shopify Inbox](https://admin.shopify.com/store/eytisc-0a/apps/shopify-inbox/shopify_chat)');
  process.env.SHOPIFY_SHOP = 'evil.example.com';
  assert.equal(inboxLink(), 'Shopify Inbox');
});

test('the chat card names the child, the cover rating and where to reply', () => {
  const record = { childName: 'Jack', age: '3', bookTitle: 'The Volcano Discovery', coverUrl: 'https://cdn.example/c.jpg', link: 'https://discord.com/channels/1/2/3' };
  const embed = chatEmbed({ path: '/pages/create-your-book', generationId: 'm8mtjy6rzr', rating: 2 }, visitor, record, new Map());
  assert.equal(embed.title, '💬 Parent of Jack, 3 opened the chat');
  assert.match(embed.description, /Shopify Inbox/);
  assert.match(embed.description, /\[their preview\]\(https:\/\/discord\.com/);
  assert.deepEqual(embed.thumbnail, { url: record.coverUrl });
  assert.ok(embed.fields.some((f) => f.name === 'Cover rating' && f.value === '😕 2/5 · Not quite'));

  const plainVisit = chatEmbed({ path: '/', generationId: '', rating: 0 }, visitor, null, new Map());
  assert.equal(plainVisit.title, '💬 A visitor opened the chat');
  assert.equal(plainVisit.fields.some((f) => f.name === 'Cover rating'), false);
});
