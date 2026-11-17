// The bot streams of the #bots channel: crawler visits (DISCORD_WEBHOOK_CRAWLERS,
// sheet tab "Crawler visits") and bot visits (DISCORD_WEBHOOK_BOTS, tab "Bot
// visits"). Page views come from the pixel and the theme's crawler beacon
// (api/events.js); link previews of shared links from api/share.js. Who is a
// crawler and who is a bot comes from lib/audience.js.
//
// A stream without a webhook posts to #visits, so nothing is lost before the
// variable exists. The same agent's view of the same page posts once per 10
// minutes, since the pixel and the beacon can both report one render.

import { COLORS, code, discordConfigured, envTag, field, finish, footer, postToDiscord, visitorFields } from './discord.js';
import { Audience, agentLabel } from './audience.js';
import { countEvent } from './event-stats.js';
import { TABS, appendRows, placeOf } from './sheet.js';
import { bookTitles, pageLink, storeOrigin } from './store-links.js';

const FALLBACK_CHANNEL = 'visits';
const SEEN_KEY = 'kbf:ev:bot-seen:';
const SEEN_SECONDS = 10 * 60;

const STREAMS = {
  [Audience.crawler]: { channel: 'crawlers', tab: TABS.crawlerVisits, counter: 'crawler_visits' },
  [Audience.bot]: { channel: 'bots', tab: TABS.botVisits, counter: 'bot_visits' }
};

// { channel, tab, counter } for a crawler or a bot; null for a person.
export function botStreamFor(who) {
  return STREAMS[who.audience] || null;
}

// A store path as a link, or a full URL (a share link) as is.
function pageText(page, titles) {
  return page.startsWith('/') ? pageLink(page, titles) : page;
}

// view is { page, referrer? }: a store path or a full URL, and the referrer's origin.
export function botVisitEmbed(who, visitor, { page = '/', referrer = '' } = {}, titles = new Map()) {
  const crawler = who.audience === Audience.crawler;
  const [where, ip, device, , userAgent] = visitorFields(visitor);
  return {
    color: COLORS.info,
    author: { name: (crawler ? 'Crawler visit' : 'Bot visit') + envTag() },
    title: (crawler ? '🕷️ ' : '🤖 ') + agentLabel(who),
    fields: [
      field('Page', pageText(page, titles)),
      Boolean(referrer) && field('Referrer', code(referrer, 120)),
      where, ip, device, userAgent
    ]
  };
}

export function botVisitRow(who, visitor, { page = '/', referrer = '' } = {}) {
  return {
    Date: new Date().toISOString(),
    Agent: agentLabel(who),
    Page: page.startsWith('/') ? storeOrigin() + page : page,
    Referrer: referrer,
    IP: visitor.ip,
    ...placeOf(visitor)
  };
}

// Posts one view to its stream. Resolves when posted; null when there's nowhere to post.
export async function postBotVisit(who, visitor, view) {
  const stream = botStreamFor(who);
  if (!stream) return null;
  const channel = discordConfigured(stream.channel) ? stream.channel : FALLBACK_CHANNEL;
  if (!discordConfigured(channel)) return null;
  const embed = botVisitEmbed(who, visitor, view, await bookTitles());
  return postToDiscord(channel, { embeds: [finish({ ...embed, footer: footer(visitor.requestId), timestamp: new Date().toISOString() })] });
}

// Whether this is the agent's first view of the page in 10 minutes. Without
// Redis, or on a Redis error, every view counts.
async function firstView(redis, ip, page) {
  if (!redis) return true;
  try {
    return Boolean(await redis.set(SEEN_KEY + ip + ':' + page, 1, { nx: true, ex: SEEN_SECONDS }));
  } catch (e) {
    console.warn('[bot-feed] view not checked:', (e && e.message) || e);
    return true;
  }
}

// Counts, posts and adds to the sheet one page view by a bot or crawler.
// Resolves to true when recorded, false for a repeat or a person.
export async function recordBotVisit(redis, who, visitor, view) {
  const stream = botStreamFor(who);
  if (!stream) return false;
  if (!(await firstView(redis, visitor.ip, view.page))) return false;
  await Promise.all([
    countEvent(redis, stream.counter),
    postBotVisit(who, visitor, view),
    appendRows(stream.tab, [botVisitRow(who, visitor, view)])
  ]);
  return true;
}
