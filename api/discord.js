// POST /api/discord  (also /discord)
// The Discord app's Interactions Endpoint URL: Discord posts each /btk
// command here (lib/btk-bot.js). Every request is checked against the app's
// public key (DISCORD_PUBLIC_KEY); a bad signature gets 401, which is also
// how Discord tests the URL when it is saved.
//
// A command is answered at once when its message is ready within
// INLINE_MS; otherwise Discord shows "thinking…" and the message follows
// through the interaction's webhook, so a slow lookup never misses Discord's
// 3-second limit. DISCORD_GUILD_ID, when set, keeps the commands to our server.

import { waitUntil } from '@vercel/functions';
import { getRedis } from '../lib/redis.js';
import { rawBody } from '../lib/raw-body.js';
import { runCommand, validInteraction } from '../lib/btk-bot.js';

export const config = { api: { bodyParser: false } };

const PING = 1;
const COMMAND = 2;
const PONG = 1;
const MESSAGE = 4;
const DEFERRED_MESSAGE = 5;
const EPHEMERAL = 64;

// Under Discord's 3 seconds, with room for the response to travel.
const INLINE_MS = 2000;
// Discord can take a moment to register the "thinking…" reply; an edit sent
// before that gets 404 Unknown Webhook.
const EDIT_TRIES = 5;
const EDIT_WAIT_MS = 600;

function withoutMentions(message) {
  return { ...message, allowed_mentions: { parse: [] } };
}

async function editAnswer(interaction, message) {
  const url = 'https://discord.com/api/v10/webhooks/' + interaction.application_id + '/' + interaction.token + '/messages/@original';
  for (let i = 1; i <= EDIT_TRIES; i++) {
    try {
      const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(withoutMentions(message))
      });
      if (res.ok) return;
      const text = (await res.text()).slice(0, 300);
      if (res.status !== 404 || i === EDIT_TRIES) {
        console.error('[discord] answer not sent: ' + res.status + ' ' + text);
        return;
      }
    } catch (e) {
      if (i === EDIT_TRIES) {
        console.error('[discord] answer not sent:', (e && e.message) || e);
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, EDIT_WAIT_MS * i));
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed' });
  const raw = await rawBody(req);
  if (!validInteraction(raw, req.headers['x-signature-ed25519'], req.headers['x-signature-timestamp'])) {
    return res.status(401).json({ error: 'bad-signature' });
  }

  let interaction = null;
  try { interaction = JSON.parse(raw.toString('utf8')); } catch (e) { interaction = null; }
  if (!interaction) return res.status(400).json({ error: 'bad-request' });
  if (interaction.type === PING) return res.status(200).json({ type: PONG });
  if (interaction.type !== COMMAND) return res.status(400).json({ error: 'unsupported-interaction' });

  const guild = process.env.DISCORD_GUILD_ID;
  if (guild && interaction.guild_id !== guild) {
    return res.status(200).json({ type: MESSAGE, data: { content: 'Not available here.', flags: EPHEMERAL } });
  }
  const pending = runCommand(interaction.data, { redis: getRedis() });
  const message = await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, INLINE_MS, null))]);
  if (message) return res.status(200).json({ type: MESSAGE, data: withoutMentions(message) });
  res.status(200).json({ type: DEFERRED_MESSAGE });
  waitUntil(pending.then((late) => editAnswer(interaction, late)));
}
