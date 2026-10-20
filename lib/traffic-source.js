// Where a visit came from, read from its landing page's query and referrer:
// the campaign's UTM tags, else an ad platform's click id, else the
// referring site, else direct. Labels are the tags and site names themselves
// rather than a list of known sites, so a new source needs no code change.

// Click ids ad platforms append to the links they send. fbclid is added to
// every Facebook and Instagram link, paid or not.
const CLICK_IDS = {
  gclid: 'google ads',
  gbraid: 'google ads',
  wbraid: 'google ads',
  fbclid: 'facebook / instagram',
  ttclid: 'tiktok ads',
  msclkid: 'microsoft ads',
  epik: 'pinterest',
  sccid: 'snapchat ads',
  twclid: 'x ads',
  li_fat_id: 'linkedin ads'
};

// The query parameters worth keeping from a landing page.
export const SOURCE_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', ...Object.keys(CLICK_IDS)];

// "l.instagram.com" → "instagram.com": social sites send visitors through
// link (l., lm.) and mobile (m.) hosts.
function siteOf(host) {
  return String(host || '').toLowerCase().replace(/^(www|m|l|lm|mobile)\./, '');
}

// { params, referrer, ownHosts } → { label, campaign }. ownHosts are the
// storefront's own domains, whose referrals aren't a source.
export function trafficSource({ params = {}, referrer = '', ownHosts = [] } = {}) {
  const tag = (key) => String(params[key] || '').trim().toLowerCase().slice(0, 60);
  if (tag('utm_source')) {
    return {
      label: [tag('utm_source'), tag('utm_medium')].filter(Boolean).join(' / '),
      campaign: [tag('utm_campaign'), tag('utm_content'), tag('utm_term')].filter(Boolean).join(' · ')
    };
  }
  for (const [param, platform] of Object.entries(CLICK_IDS)) {
    if (params[param]) return { label: platform, campaign: '' };
  }
  let host = '';
  try { host = new URL(referrer).hostname; } catch (e) { /* no referrer */ }
  if (host && !ownHosts.map(siteOf).includes(siteOf(host))) return { label: siteOf(host), campaign: '' };
  return { label: 'direct', campaign: '' };
}
