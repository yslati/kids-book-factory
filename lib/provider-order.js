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

// Runs attempts in order until one returns a URL. Every attempt but the last
// is capped at attemptCapMs so a stalled request still leaves the next one
// time; the last may use whatever is left. No attempt starts with less than
// minAttemptMs left, since it could not finish and might still be billed.
//
// run(attempt, timeoutMs) → Promise<url>. Resolves { url, attempt }; throws
// the last error when every attempt fails or time runs out.
export async function runAttempts(attempts, run, { deadline, attemptCapMs, minAttemptMs, now = Date.now }) {
  let lastError = new Error('no-provider-configured');

  for (let i = 0; i < attempts.length; i++) {
    const remaining = deadline - now();
    if (remaining < minAttemptMs) {
      if (i === 0) lastError = new Error('generation-out-of-time');
      break;
    }
    const isLast = i === attempts.length - 1;
    const timeoutMs = isLast ? remaining : Math.min(attemptCapMs, remaining);

    try {
      const url = await run(attempts[i], timeoutMs);
      return { url, attempt: attempts[i] };
    } catch (err) {
      lastError = err;
      console.warn('[generate] ' + attemptLabel(attempts[i]) + ' failed:', (err && err.message) || err);
    }
  }
  throw lastError;
}
