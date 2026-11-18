// POST /api/discord  (also /discord)
// The Discord app's Interactions Endpoint URL: Discord posts each /btk
// command here (lib/btk-bot.js). Every request is checked against the app's
// public key (DISCORD_PUBLIC_KEY); a bad signature gets 401, which is also
// how Discord tests the URL when it is saved.
//
// A command is answered "thinking…" at once, then the message is filled in
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

async function answer(interaction) {
  const message = await runCommand(interaction.data, { redis: getRedis() });
  const url = 'https://discord.com/api/v10/webhooks/' + interaction.application_id + '/' + interaction.token + '/messages/@original';
  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...message, allowed_mentions: { parse: [] } })
    });
    if (!res.ok) console.error('[discord] answer not sent: ' + res.status + ' ' + (await res.text()).slice(0, 300));
  } catch (e) {
    console.error('[discord] answer not sent:', (e && e.message) || e);
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
  res.status(200).json({ type: DEFERRED_MESSAGE });
  waitUntil(answer(interaction));
}
