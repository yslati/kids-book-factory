// Fallback-chain logic for cover generation. Pure (no SDK imports) so the
// tests run without @fal-ai/client installed, like lib/preview-entry.js.
//
// An attempt is { provider, model?, quality? }; lib/generate.js defines the chain.

// fal is skipped at or below this balance (USD): one fal cover costs $0.08.
export const FAL_LOW_BALANCE_USD = 0.1;

export function attemptLabel(attempt) {
  return [attempt.provider, attempt.model, attempt.quality].filter(Boolean).join(' ');
}

// The attempts that can run: their provider has credentials, and fal is
// dropped when its balance is known to be too low to pay for a cover.
export function usableAttempts(chain, { configured, falBalance = null, threshold = FAL_LOW_BALANCE_USD }) {
  return chain.filter((attempt) => {
    if (!configured[attempt.provider]) return false;
    const falTooLow = attempt.provider === 'fal' &&
      typeof falBalance === 'number' && falBalance <= threshold;
    return !falTooLow;
  });
}

// Runs attempts in order until one returns a URL. Each attempt may use all
// the time left, and the next one starts only when it fails: a started
// Higgsfield job can't be cancelled, so cutting a slow one off only leaves it
// running beside its replacement. No attempt starts with less than
// minAttemptMs left, since it could not finish and might still be billed.
//
// run(attempt, timeoutMs) → Promise<url | { url, cost? }>, cost being the
// cover's price in USD when the provider reports one. Resolves { url, attempt,
// cost? }; throws the last error when every attempt fails or time runs out,
// or at once an error with err.pending (a job still running at the deadline).
export async function runAttempts(attempts, run, { deadline, minAttemptMs, now = Date.now }) {
  let lastError = new Error('no-provider-configured');

  for (let i = 0; i < attempts.length; i++) {
    const remaining = deadline - now();
    if (remaining < minAttemptMs) {
      if (i === 0) lastError = new Error('generation-out-of-time');
      break;
    }

    try {
      const out = await run(attempts[i], remaining);
      const result = typeof out === 'string' ? { url: out } : { url: out.url };
      if (out && typeof out.cost === 'number') result.cost = out.cost;
      return { ...result, attempt: attempts[i] };
    } catch (err) {
      // A job left running for later ends the chain: nothing else could finish in time.
      if (err && err.pending) throw err;
      lastError = err;
      console.warn('[generate] ' + attemptLabel(attempts[i]) + ' failed:', (err && err.message) || err);
    }
  }
  throw lastError;
}
