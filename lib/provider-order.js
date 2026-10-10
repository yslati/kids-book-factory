// Routing between the cover-generation providers. Pure logic with no SDK
// imports, so the tests run without @fal-ai/client installed (the same split
// as lib/preview-entry.js and lib/user-previews.js). lib/generate.js wires in
// the real providers.

// At or below this fal balance (USD), Higgsfield goes first. One fal cover
// costs $0.08, so this is roughly the last cover fal can still pay for.
export const FAL_LOW_BALANCE_USD = 0.1;

// Not worth starting an attempt with less time than this left.
const MIN_ATTEMPT_MS = 5000;

// Providers to try, in order. fal is primary. Higgsfield goes first when fal's
// balance is known and at or below the threshold, and each provider is the
// other's backup. An unknown balance (null) keeps fal first.
export function providerOrder({ falReady, higgsfieldReady, balance, threshold = FAL_LOW_BALANCE_USD }) {
  const falLow = typeof balance === 'number' && balance <= threshold;
  const order = falLow ? ['higgsfield', 'fal'] : ['fal', 'higgsfield'];
  return order.filter((provider) => (provider === 'fal' ? falReady : higgsfieldReady));
}

// Run providers in order until one returns a URL. With a single provider it
// gets one retry, as before the fallback existed. When the next attempt is a
// different provider, this attempt is capped at firstAttemptMs so a hung
// request still leaves the backup time to run; otherwise an attempt may use
// everything left before the deadline.
//
// run(provider, timeoutMs) → Promise<url>. Resolves { url, provider }; throws
// the last error when every attempt fails or time runs out.
export async function generateWithFallback(order, run, { deadline, firstAttemptMs, now = Date.now }) {
  const attempts = order.length === 1 ? [order[0], order[0]] : order;
  let lastError = new Error('no-provider-configured');

  for (let i = 0; i < attempts.length; i++) {
    const remaining = deadline - now();
    if (remaining < MIN_ATTEMPT_MS) {
      if (i === 0) lastError = new Error('generation-out-of-time');
      break;
    }
    const nextIsOtherProvider = i + 1 < attempts.length && attempts[i + 1] !== attempts[i];
    const timeoutMs = nextIsOtherProvider ? Math.min(firstAttemptMs, remaining) : remaining;

    try {
      const url = await run(attempts[i], timeoutMs);
      return { url, provider: attempts[i] };
    } catch (err) {
      lastError = err;
      console.warn('[generate] ' + attempts[i] + ' failed:', (err && err.message) || err);
    }
  }
  throw lastError;
}
