// Cover generation: an ordered chain of model attempts. Each one runs only if
// the one before it failed or ran out of time, within the request's budget.

import { falConfigured, generateWithFal } from './fal.js';
import { higgsfieldConfigured, generateWithHiggsfield } from './higgsfield.js';
import { falBalance } from './fal-balance.js';
import { attemptLabel, runAttempts, usableAttempts } from './provider-order.js';

// Higgsfield Marketing Studio Image endpoints. 2.5 Flare gave the best likeness
// in side-by-side tests; 2.0 is a different model, so it can still answer when
// Flare is down or flags a photo.
const CHAIN = [
  { provider: 'higgsfield', model: 'marketing-studio/image/flare', quality: 'medium' },
  { provider: 'higgsfield', model: 'marketing-studio/image/flare', quality: 'low' },
  { provider: 'higgsfield', model: 'marketing-studio/image', quality: 'low' },
  // fal (Nano Banana 2) is off while that account has no credit. To use it as
  // the last fallback, uncomment this entry and set FAL_KEY; with
  // FAL_BILLING_KEY set too, it is skipped once the balance is $0.10 or less.
  // { provider: 'fal' },
];

// Flare medium usually finishes in 17-25s. Capping each attempt but the last
// leaves the next one time when a request stalls in the provider's queue.
const ATTEMPT_CAP_MS = 28000;
// Higgsfield covers take at least ~15s, so a shorter attempt could only be cut off.
const MIN_ATTEMPT_MS = 15000;

function configuredProviders() {
  return { higgsfield: higgsfieldConfigured(), fal: falConfigured() };
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

  const result = await runAttempts(attempts, (attempt, timeoutMs) => {
    if (attempt.provider === 'fal') {
      return generateWithFal(coverUrl, childUrl, prompt, { timeoutMs });
    }
    return generateWithHiggsfield(coverUrl, childUrl, prompt, {
      model: attempt.model,
      quality: attempt.quality,
      coverAspect,
      timeoutMs
    });
  }, { deadline, attemptCapMs: ATTEMPT_CAP_MS, minAttemptMs: MIN_ATTEMPT_MS });

  console.log('[generate] cover by ' + attemptLabel(result.attempt));
  return result;
}
