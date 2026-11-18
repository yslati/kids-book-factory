// Registers the /btk command (lib/btk-bot.js COMMAND) in our Discord server.
// Run again after adding or changing a subcommand:
//
//   DISCORD_APP_ID=… DISCORD_GUILD_ID=… DISCORD_BOT_TOKEN=… node scripts/discord-commands.mjs
//
// A server ("guild") command shows up at once, unlike a global one.

import { COMMAND } from '../lib/btk-bot.js';

const { DISCORD_APP_ID: app, DISCORD_GUILD_ID: guild, DISCORD_BOT_TOKEN: token } = process.env;
if (!app || !guild || !token) {
  console.error('Set DISCORD_APP_ID, DISCORD_GUILD_ID and DISCORD_BOT_TOKEN.');
  process.exit(1);
}

const res = await fetch('https://discord.com/api/v10/applications/' + app + '/guilds/' + guild + '/commands', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bot ' + token },
  body: JSON.stringify([COMMAND])
});
const body = await res.text();
if (!res.ok) {
  console.error('Discord answered ' + res.status + ': ' + body.slice(0, 500));
  process.exit(1);
}
console.log('Registered: ' + JSON.parse(body).map((c) => '/' + c.name + ' ' + c.options.map((o) => o.name).join(', ')).join('; '));
