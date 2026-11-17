// Who a visitor is, from the user agent and IP: a person, a recognised
// crawler (search engine, AI crawler, link preview or SEO tool) or anonymous
// automation. Decides which Discord stream and sheet tab a report or visit
// goes to (lib/report.js, api/events.js, api/share.js).
//
// A crawler whose operator publishes its IP ranges (Google, Bing, OpenAI,
// Perplexity) is checked against them: a claim from outside is a bot. Lists
// are fetched once a day per instance; one that can't be fetched leaves the
// claim unverifiable, never failed.

import { isbot, isbotMatch } from 'isbot';

export const Audience = Object.freeze({ human: 'human', crawler: 'crawler', bot: 'bot' });
export const CrawlerKind = Object.freeze({ search: 'search', ai: 'ai', preview: 'preview', seo: 'seo' });
export const Verification = Object.freeze({ verified: 'verified', unverifiable: 'unverifiable', failed: 'failed' });

const GOOGLE_LISTS = [
  'https://developers.google.com/static/search/apis/ipranges/googlebot.json',
  'https://developers.google.com/static/search/apis/ipranges/special-crawlers.json',
  'https://developers.google.com/static/search/apis/ipranges/user-triggered-fetchers.json',
  'https://developers.google.com/static/search/apis/ipranges/user-triggered-fetchers-google.json'
];
const BING_LISTS = ['https://www.bing.com/toolbox/bingbot.json'];
const OPENAI_LISTS = ['https://openai.com/gptbot.json', 'https://openai.com/chatgpt-user.json', 'https://openai.com/searchbot.json'];
const PERPLEXITY_LISTS = ['https://www.perplexity.com/perplexitybot.json', 'https://www.perplexity.com/perplexity-user.json'];

// Known crawlers, first match wins. `name` is what posts and rows show.
const CRAWLERS = [
  { name: 'Google-InspectionTool', pattern: /Google-InspectionTool/i, kind: CrawlerKind.search, lists: GOOGLE_LISTS },
  { name: 'Googlebot', pattern: /Googlebot|Google-PageRenderer|Storebot-Google|GoogleOther|AdsBot-Google|Mediapartners-Google|APIs-Google|FeedFetcher-Google|Google-Site-Verification|Google-Read-Aloud/i, kind: CrawlerKind.search, lists: GOOGLE_LISTS },
  { name: 'Google-Extended', pattern: /Google-Extended/i, kind: CrawlerKind.ai, lists: GOOGLE_LISTS },
  { name: 'Bingbot', pattern: /bingbot|BingPreview|adidxbot|MicrosoftPreview/i, kind: CrawlerKind.search, lists: BING_LISTS },
  { name: 'DuckDuckBot', pattern: /DuckDuckBot|DuckDuckGo-Favicons-Bot/i, kind: CrawlerKind.search, lists: [] },
  { name: 'DuckAssistBot', pattern: /DuckAssistBot/i, kind: CrawlerKind.ai, lists: [] },
  { name: 'Applebot-Extended', pattern: /Applebot-Extended/i, kind: CrawlerKind.ai, lists: [] },
  { name: 'Applebot', pattern: /Applebot/i, kind: CrawlerKind.search, lists: [] },
  { name: 'YandexBot', pattern: /Yandex/i, kind: CrawlerKind.search, lists: [] },
  { name: 'Baiduspider', pattern: /Baiduspider/i, kind: CrawlerKind.search, lists: [] },
  { name: 'Yahoo Slurp', pattern: /Yahoo! Slurp/i, kind: CrawlerKind.search, lists: [] },
  { name: 'SeznamBot', pattern: /SeznamBot/i, kind: CrawlerKind.search, lists: [] },
  { name: 'PetalBot', pattern: /PetalBot/i, kind: CrawlerKind.search, lists: [] },
  { name: 'Qwantbot', pattern: /Qwantify|Qwantbot/i, kind: CrawlerKind.search, lists: [] },
  { name: 'GPTBot', pattern: /GPTBot/i, kind: CrawlerKind.ai, lists: OPENAI_LISTS },
  { name: 'ChatGPT-User', pattern: /ChatGPT-User/i, kind: CrawlerKind.ai, lists: OPENAI_LISTS },
  { name: 'OAI-SearchBot', pattern: /OAI-SearchBot/i, kind: CrawlerKind.ai, lists: OPENAI_LISTS },
  { name: 'ClaudeBot', pattern: /ClaudeBot|Claude-Web|anthropic-ai/i, kind: CrawlerKind.ai, lists: [] },
  { name: 'Claude-User', pattern: /Claude-User|Claude-SearchBot/i, kind: CrawlerKind.ai, lists: [] },
  { name: 'PerplexityBot', pattern: /PerplexityBot/i, kind: CrawlerKind.ai, lists: PERPLEXITY_LISTS },
  { name: 'Perplexity-User', pattern: /Perplexity-User/i, kind: CrawlerKind.ai, lists: PERPLEXITY_LISTS },
  { name: 'Meta-ExternalAgent', pattern: /meta-externalagent|meta-externalfetcher|FacebookBot/i, kind: CrawlerKind.ai, lists: [] },
  { name: 'Amazonbot', pattern: /Amazonbot/i, kind: CrawlerKind.ai, lists: [] },
  { name: 'Bytespider', pattern: /Bytespider|TikTokSpider/i, kind: CrawlerKind.ai, lists: [] },
  { name: 'CCBot', pattern: /CCBot/i, kind: CrawlerKind.ai, lists: [] },
  { name: 'MistralAI-User', pattern: /MistralAI-User/i, kind: CrawlerKind.ai, lists: [] },
  { name: 'cohere-ai', pattern: /cohere-ai|cohere-training-data-crawler/i, kind: CrawlerKind.ai, lists: [] },
  { name: 'Diffbot', pattern: /Diffbot/i, kind: CrawlerKind.ai, lists: [] },
  { name: 'Facebook', pattern: /facebookexternalhit|Facebot|facebookcatalog/i, kind: CrawlerKind.preview, lists: [] },
  { name: 'WhatsApp', pattern: /WhatsApp/i, kind: CrawlerKind.preview, lists: [] },
  { name: 'Instagram', pattern: /Instagram.*(Bot|externalhit)/i, kind: CrawlerKind.preview, lists: [] },
  { name: 'Twitter', pattern: /Twitterbot/i, kind: CrawlerKind.preview, lists: [] },
  { name: 'LinkedIn', pattern: /LinkedInBot/i, kind: CrawlerKind.preview, lists: [] },
  { name: 'Slack', pattern: /Slackbot|Slack-ImgProxy/i, kind: CrawlerKind.preview, lists: [] },
  { name: 'Discord', pattern: /Discordbot/i, kind: CrawlerKind.preview, lists: [] },
  { name: 'Telegram', pattern: /TelegramBot/i, kind: CrawlerKind.preview, lists: [] },
  { name: 'Pinterest', pattern: /Pinterest(bot)?\//i, kind: CrawlerKind.preview, lists: [] },
  { name: 'Snapchat', pattern: /Snapchat/i, kind: CrawlerKind.preview, lists: [] },
  { name: 'Skype', pattern: /SkypeUriPreview/i, kind: CrawlerKind.preview, lists: [] },
  { name: 'Viber', pattern: /Viber/i, kind: CrawlerKind.preview, lists: [] },
  { name: 'iMessage', pattern: /iMessageLinkPreview/i, kind: CrawlerKind.preview, lists: [] },
  { name: 'Embedly', pattern: /Embedly/i, kind: CrawlerKind.preview, lists: [] },
  { name: 'AhrefsBot', pattern: /AhrefsBot|AhrefsSiteAudit/i, kind: CrawlerKind.seo, lists: [] },
  { name: 'SemrushBot', pattern: /SemrushBot|SiteAuditBot/i, kind: CrawlerKind.seo, lists: [] },
  { name: 'MJ12bot', pattern: /MJ12bot/i, kind: CrawlerKind.seo, lists: [] },
  { name: 'DotBot', pattern: /DotBot/i, kind: CrawlerKind.seo, lists: [] },
  { name: 'DataForSeoBot', pattern: /DataForSeoBot/i, kind: CrawlerKind.seo, lists: [] },
  { name: 'Screaming Frog', pattern: /Screaming Frog/i, kind: CrawlerKind.seo, lists: [] },
  { name: 'Lighthouse', pattern: /Chrome-Lighthouse|PageSpeed/i, kind: CrawlerKind.seo, lists: [] }
];

const KIND_LABELS = {
  [CrawlerKind.search]: 'search engine',
  [CrawlerKind.ai]: 'AI crawler',
  [CrawlerKind.preview]: 'link preview',
  [CrawlerKind.seo]: 'SEO tool'
};

const LIST_TTL_MS = 24 * 60 * 60 * 1000;
const LIST_RETRY_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;

// Per list URL: { ranges, until } once read, or { ranges: null, until } after a failed read.
const lists = new Map();
let rangeSource = null;

function crawlerOf(userAgent) {
  return CRAWLERS.find((c) => c.pattern.test(userAgent)) || null;
}

// { audience, name, kind } from the user agent alone.
export function classifyAgent(userAgent) {
  const ua = String(userAgent || '');
  if (!ua) return { audience: Audience.bot, name: 'no user agent', kind: null };
  const crawler = crawlerOf(ua);
  if (crawler) return { audience: Audience.crawler, name: crawler.name, kind: crawler.kind };
  if (isbot(ua)) return { audience: Audience.bot, name: isbotMatch(ua) || 'bot', kind: null };
  return { audience: Audience.human, name: '', kind: null };
}

function parseIp(ip) {
  const s = String(ip || '').trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    const parts = s.split('.').map(Number);
    if (parts.some((n) => n > 255)) return null;
    // IPv4 as an IPv4-mapped IPv6 address, so one comparison covers both.
    return { bits: 128, value: (0xffffn << 32n) | BigInt(parts.reduce((n, p) => n * 256 + p, 0)), v4: true };
  }
  if (!/^[0-9a-f:.]+$/i.test(s) || !s.includes(':')) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const expand = (part) => (part ? part.split(':') : []);
  let head = expand(halves[0]);
  let tail = halves.length === 2 ? expand(halves[1]) : [];
  const last = (tail.length ? tail : head)[(tail.length ? tail : head).length - 1];
  if (last && last.includes('.')) {
    const v4 = parseIp(last);
    if (!v4) return null;
    const low = Number(v4.value & 0xffffffffn);
    const words = [(low >>> 16).toString(16), (low & 0xffff).toString(16)];
    if (tail.length) tail = tail.slice(0, -1).concat(words);
    else head = head.slice(0, -1).concat(words);
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const words = head.concat(new Array(missing).fill('0'), tail);
  if (words.some((w) => !/^[0-9a-f]{1,4}$/i.test(w))) return null;
  return { bits: 128, value: words.reduce((n, w) => (n << 16n) | BigInt(parseInt(w, 16)), 0n), v4: false };
}

// Whether the IP falls inside any of the CIDR ranges (IPv4 or IPv6).
export function ipInRanges(ip, ranges) {
  const addr = parseIp(ip);
  if (!addr) return false;
  return (ranges || []).some((cidr) => {
    const [base, lenText] = String(cidr).split('/');
    const net = parseIp(base);
    if (!net || net.v4 !== addr.v4) return false;
    const len = Number(lenText) + (net.v4 ? 96 : 0);
    if (!Number.isFinite(len) || len < 0 || len > 128) return false;
    const mask = len === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - len)) - 1n);
    return (net.value & mask) === (addr.value & mask);
  });
}

async function fetchList(url) {
  if (rangeSource) return rangeSource(url);
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// The CIDR ranges of one published list, or null when it can't be read now.
async function rangesOf(url) {
  const cached = lists.get(url);
  if (cached && Date.now() < cached.until) return cached.ranges;
  try {
    const json = await fetchList(url);
    const ranges = (json && Array.isArray(json.prefixes) ? json.prefixes : [])
      .map((p) => p && (p.ipv4Prefix || p.ipv6Prefix))
      .filter(Boolean);
    lists.set(url, { ranges, until: Date.now() + LIST_TTL_MS });
    return ranges;
  } catch (e) {
    console.warn('[audience] IP list not read: ' + url + ': ' + ((e && e.message) || e));
    lists.set(url, { ranges: null, until: Date.now() + LIST_RETRY_MS });
    return null;
  }
}

// Verification of a crawler's claim from its lists and the visitor's IP.
async function verify(crawler, ip) {
  if (!crawler.lists.length) return Verification.unverifiable;
  const all = await Promise.all(crawler.lists.map(rangesOf));
  if (all.some((r) => r === null)) return Verification.unverifiable;
  return all.some((ranges) => ipInRanges(ip, ranges)) ? Verification.verified : Verification.failed;
}

// { audience, name, kind, verification } for a visitor (lib/discord.js
// visitorOf). Fetches nothing for people and anonymous bots.
export async function resolveAudience(visitor) {
  const who = classifyAgent(visitor && visitor.userAgent);
  if (who.audience !== Audience.crawler) return { ...who, verification: Verification.unverifiable };
  const crawler = crawlerOf(String(visitor.userAgent));
  const verification = await verify(crawler, visitor.ip);
  if (verification === Verification.failed) {
    return { audience: Audience.bot, name: 'claims ' + crawler.name, kind: null, verification };
  }
  return { ...who, verification };
}

// "Bingbot · search engine · verified", for embeds and sheet rows.
export function agentLabel(who) {
  if (who.audience === Audience.human) return 'person';
  if (who.audience === Audience.crawler) {
    return [who.name, KIND_LABELS[who.kind], who.verification === Verification.verified && 'verified'].filter(Boolean).join(' · ');
  }
  return who.name + (who.verification === Verification.failed ? ' · IP outside the published ranges' : ' · bot');
}

// For tests: answer list fetches with (url) => Promise<json>; null restores fetch.
export function setRangeSource(fn) {
  rangeSource = fn;
}

// For tests: forget cached lists.
export function resetRanges() {
  lists.clear();
}
