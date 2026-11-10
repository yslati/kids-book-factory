// Cover generation: an ordered chain of model attempts. The next one starts
// when the one before it fails or is slow to answer, and the first cover back
// wins, within the request's budget (lib/provider-order.js).

import { falConfigured, generateWithFal } from './fal.js';
import { higgsfieldConfigured, generateWithHiggsfield } from './higgsfield.js';
import { falBalance } from './fal-balance.js';
import { attemptLabel, runAttempts, usableAttempts } from './provider-order.js';
import { trackHiggsfieldJob } from './higgsfield-feed.js';
import { getRedis } from './redis.js';
import { waitUntil } from '@vercel/functions';

// Higgsfield Marketing Studio Image endpoints. Sunburst replaced the name
// everywhere on the cover in side-by-side tests, where Flare left the old one
// on caps and jerseys; Flare is faster, so it runs alongside a slow Sunburst. 2.0 is a different model, so it can still answer when both are down
// or flag a photo.
const CHAIN = [
  { provider: 'higgsfield', model: 'marketing-studio/image/sunburst', quality: 'medium' },
  { provider: 'higgsfield', model: 'marketing-studio/image/flare', quality: 'medium' },
  { provider: 'higgsfield', model: 'marketing-studio/image', quality: 'low' },
  // fal (Nano Banana 2) is off while that account has no credit. To use it as
  // the last fallback, uncomment this entry and set FAL_KEY (full access); it
  // is skipped once the balance is $0.10 or less.
  // { provider: 'fal' },
];

// Sunburst medium usually finishes in 22-27s but about one in four takes
// 28-40s, almost all of it generating rather than queued; Flare medium takes
// 17-25s. Past this, Flare starts too and Sunburst keeps going, so a slow
// Sunburst cover is still used when it beats Flare.
const HEDGE_MS = 28000;
// Higgsfield covers take at least ~15s, so a shorter attempt could only be cut off.
const MIN_ATTEMPT_MS = 15000;

function configuredProviders() {
  return { higgsfield: higgsfieldConfigured(), fal: falConfigured() };
}

// The chain's Higgsfield models, which the daily #higgsfield check watches.
export function higgsfieldChain() {
  return CHAIN.filter((attempt) => attempt.provider === 'higgsfield');
}

export function generationConfigured() {
  return usableAttempts(CHAIN, { configured: configuredProviders() }).length > 0;
}

// Returns { url, attempt }. coverAspect is the cover's width / height (or
// null); deadline is the epoch ms by which generation must finish.
export async function generateCover(coverUrl, childUrl, prompt, { coverAspect, deadline }) {
  const configured = configuredProviders();
  const usesFal = configured.fal && CHAIN.some((attempt) => attempt.provider === 'fal');
  const attempts = usableAttempts(CHAIN, {
    configured,
    falBalance: usesFal ? await falBalance() : null
  });

  const result = await runAttempts(attempts, async (attempt, timeoutMs, signal) => {
    if (attempt.provider === 'fal') {
      // fal can't be stopped early; a losing fal attempt runs to its end.
      return generateWithFal(coverUrl, childUrl, prompt, { timeoutMs });
    }
    const started = Date.now();
    // Each attempt is counted, and refusals alerted, in #higgsfield after the response.
    const track = (err) => waitUntil(trackHiggsfieldJob(getRedis(), attempt, err, Date.now() - started));
    try {
      const url = await generateWithHiggsfield(coverUrl, childUrl, prompt, {
        model: attempt.model,
        quality: attempt.quality,
        coverAspect,
        timeoutMs,
        signal
      });
      track(null);
      return url;
    } catch (err) {
      track(err);
      throw err;
    }
  }, { deadline, hedgeMs: HEDGE_MS, minAttemptMs: MIN_ATTEMPT_MS });

  console.log('[generate] cover by ' + attemptLabel(result.attempt));
  return result;
}
