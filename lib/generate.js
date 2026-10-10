// Cover generation across providers: fal (lib/fal.js, Nano Banana 2) is
// primary, Higgsfield (lib/higgsfield.js, Marketing Studio Image) is the backup.
//
// Higgsfield goes first when fal's balance is at or below $0.10 (needs
// FAL_BILLING_KEY, see lib/fal-balance.js). Either way, if the first provider
// fails or runs out of time, the other one gets the rest of the time budget.
// With only one provider configured it behaves as before: one attempt, one retry.

import { falConfigured, generateWithFal } from './fal.js';
import { higgsfieldConfigured, generateWithHiggsfield } from './higgsfield.js';
import { falBalance } from './fal-balance.js';
import { providerOrder, generateWithFallback } from './provider-order.js';

// Cap on the first provider when a different one is waiting behind it. Nano
// Banana 2 runs in ~12s (p50) / ~21s (p90) on fal, so 30s only cuts off a stuck
// request, and it leaves the backup about 20s of the preview budget.
const FIRST_ATTEMPT_MS = 30000;

export function generationConfigured() {
  return falConfigured() || higgsfieldConfigured();
}

// Returns { url, provider }. coverAspect is the cover's width / height (or
// null); deadline is the epoch ms by which generation must finish.
export async function generateCover(coverUrl, childUrl, prompt, { coverAspect, deadline }) {
  const falReady = falConfigured();
  const higgsfieldReady = higgsfieldConfigured();
  // The balance only matters when there is somewhere else to send the work.
  const balance = falReady && higgsfieldReady ? await falBalance() : null;
  const order = providerOrder({ falReady, higgsfieldReady, balance });

  const result = await generateWithFallback(order, (provider, timeoutMs) => {
    if (provider === 'fal') {
      return generateWithFal(coverUrl, childUrl, prompt, { timeoutMs });
    }
    return generateWithHiggsfield(coverUrl, childUrl, prompt, { coverAspect, timeoutMs });
  }, { deadline, firstAttemptMs: FIRST_ATTEMPT_MS });

  console.log('[generate] cover by ' + result.provider +
    (typeof balance === 'number' ? ' (fal balance $' + balance.toFixed(2) + ')' : ''));
  return result;
}
