// Who a visitor is: a person, a recognised crawler (named, and verified
// against its operator's published IP ranges) or anonymous automation.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Audience, CrawlerKind, Verification, agentLabel, classifyAgent, ipInRanges, resetRanges, resolveAudience, setRangeSource
} from '../lib/audience.js';

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  googlebot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/120.0.0.0 Safari/537.36',
  inspection: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Google-InspectionTool/1.0;)',
  bingbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36',
  gptbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot',
  claudebot: 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
  whatsapp: 'WhatsApp/2.23.20.0 A',
  ahrefs: 'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
  headless: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36',
  curl: 'curl/8.7.1',
  reflection: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Reflectionbot/1.0;'
};

test('classifyAgent: a browser is a person, a known crawler is named by kind, the rest is a bot', () => {
  assert.deepEqual(classifyAgent(UA.iphone), { audience: Audience.human, name: '', kind: null });
  assert.deepEqual(classifyAgent(UA.googlebot), { audience: Audience.crawler, name: 'Googlebot', kind: CrawlerKind.search });
  assert.deepEqual(classifyAgent(UA.inspection), { audience: Audience.crawler, name: 'Google-InspectionTool', kind: CrawlerKind.search });
  assert.deepEqual(classifyAgent(UA.bingbot), { audience: Audience.crawler, name: 'Bingbot', kind: CrawlerKind.search });
  assert.deepEqual(classifyAgent(UA.gptbot), { audience: Audience.crawler, name: 'GPTBot', kind: CrawlerKind.ai });
  assert.deepEqual(classifyAgent(UA.claudebot), { audience: Audience.crawler, name: 'ClaudeBot', kind: CrawlerKind.ai });
  assert.deepEqual(classifyAgent(UA.whatsapp), { audience: Audience.crawler, name: 'WhatsApp', kind: CrawlerKind.preview });
  assert.deepEqual(classifyAgent(UA.ahrefs), { audience: Audience.crawler, name: 'AhrefsBot', kind: CrawlerKind.seo });
  assert.deepEqual(classifyAgent(UA.headless), { audience: Audience.bot, name: 'Headless', kind: null });
  assert.deepEqual(classifyAgent(UA.curl), { audience: Audience.bot, name: 'curl/8.7.1', kind: null });
  assert.deepEqual(classifyAgent(UA.reflection), { audience: Audience.bot, name: 'Reflectionbot/1.0;', kind: null });
  assert.deepEqual(classifyAgent(''), { audience: Audience.bot, name: 'no user agent', kind: null });
});

test('ipInRanges: IPv4 and IPv6 prefixes', () => {
  const ranges = ['66.249.64.0/19', '2001:4860:4801::/48'];
  assert.equal(ipInRanges('66.249.66.1', ranges), true);
  assert.equal(ipInRanges('66.249.96.1', ranges), false);
  assert.equal(ipInRanges('2001:4860:4801:10::1', ranges), true);
  assert.equal(ipInRanges('2001:4860:4802::1', ranges), false);
  assert.equal(ipInRanges('not-an-ip', ranges), false);
  assert.equal(ipInRanges('66.249.66.1', []), false);
});

// A range source answering like Google's JSON for every list it is asked for.
function rangeSource(t, prefixes, { fail = false } = {}) {
  const asked = [];
  resetRanges();
  setRangeSource(async (url) => {
    asked.push(url);
    if (fail) throw new Error('offline');
    return { prefixes };
  });
  t.after(() => { setRangeSource(null); resetRanges(); });
  return asked;
}

const visitor = (userAgent, ip = '66.249.66.1') => ({ userAgent, ip });

test('resolveAudience: a crawler inside its published ranges is verified', async (t) => {
  const asked = rangeSource(t, [{ ipv4Prefix: '66.249.64.0/19' }, { ipv6Prefix: '2001:4860:4801::/48' }]);
  const who = await resolveAudience(visitor(UA.googlebot));
  assert.deepEqual(who, { audience: Audience.crawler, name: 'Googlebot', kind: CrawlerKind.search, verification: Verification.verified });
  assert.ok(asked.length > 0, 'the lists were fetched');
  const again = await resolveAudience(visitor(UA.googlebot, '2001:4860:4801:10::1'));
  assert.equal(again.verification, Verification.verified);
  assert.equal(asked.length, new Set(asked).size, 'each list is fetched once and cached');
});

test('resolveAudience: a crawler claim from outside the ranges is a bot', async (t) => {
  rangeSource(t, [{ ipv4Prefix: '66.249.64.0/19' }]);
  const who = await resolveAudience(visitor(UA.googlebot, '203.0.113.7'));
  assert.deepEqual(who, { audience: Audience.bot, name: 'claims Googlebot', kind: null, verification: Verification.failed });
});

test('resolveAudience: unreachable lists or an operator without lists mean unverifiable, never failed', async (t) => {
  const asked = rangeSource(t, [], { fail: true });
  const google = await resolveAudience(visitor(UA.googlebot, '203.0.113.7'));
  assert.deepEqual(google, { audience: Audience.crawler, name: 'Googlebot', kind: CrawlerKind.search, verification: Verification.unverifiable });
  const before = asked.length;
  const claude = await resolveAudience(visitor(UA.claudebot, '203.0.113.7'));
  assert.deepEqual(claude, { audience: Audience.crawler, name: 'ClaudeBot', kind: CrawlerKind.ai, verification: Verification.unverifiable });
  assert.equal(asked.length, before, 'no lists to fetch for ClaudeBot');
});

test('resolveAudience: people and anonymous bots never fetch anything', async (t) => {
  const asked = rangeSource(t, []);
  assert.deepEqual(await resolveAudience(visitor(UA.iphone)), { audience: Audience.human, name: '', kind: null, verification: Verification.unverifiable });
  assert.deepEqual(await resolveAudience(visitor(UA.headless)), { audience: Audience.bot, name: 'Headless', kind: null, verification: Verification.unverifiable });
  assert.equal(asked.length, 0);
});

test('agentLabel: name, kind and verification in words', () => {
  assert.equal(agentLabel({ audience: Audience.crawler, name: 'Bingbot', kind: CrawlerKind.search, verification: Verification.verified }), 'Bingbot · search engine · verified');
  assert.equal(agentLabel({ audience: Audience.crawler, name: 'GPTBot', kind: CrawlerKind.ai, verification: Verification.unverifiable }), 'GPTBot · AI crawler');
  assert.equal(agentLabel({ audience: Audience.crawler, name: 'WhatsApp', kind: CrawlerKind.preview, verification: Verification.unverifiable }), 'WhatsApp · link preview');
  assert.equal(agentLabel({ audience: Audience.crawler, name: 'AhrefsBot', kind: CrawlerKind.seo, verification: Verification.unverifiable }), 'AhrefsBot · SEO tool');
  assert.equal(agentLabel({ audience: Audience.bot, name: 'claims Googlebot', kind: null, verification: Verification.failed }), 'claims Googlebot · IP outside the published ranges');
  assert.equal(agentLabel({ audience: Audience.bot, name: 'Headless', kind: null, verification: Verification.unverifiable }), 'Headless · bot');
  assert.equal(agentLabel({ audience: Audience.human, name: '', kind: null, verification: Verification.unverifiable }), 'person');
});
