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

// Runs attempts in order until one returns a URL. The next attempt starts
// when the one before it fails, or once it has run hedgeMs without an answer;
// a slow attempt keeps running, so whichever finishes first wins and the
// others are told to stop through their AbortSignal. Every attempt may run
// until the deadline. None starts with less than minAttemptMs left, since it
// could not finish and might still be billed.
//
// run(attempt, timeoutMs, signal) → Promise<url>. Resolves { url, attempt };
// throws the last error when every attempt fails or time runs out.
export function runAttempts(attempts, run, { deadline, hedgeMs, minAttemptMs, now = Date.now }) {
  if (!attempts.length) return Promise.reject(new Error('no-provider-configured'));
  if (deadline - now() < minAttemptMs) return Promise.reject(new Error('generation-out-of-time'));

  return new Promise((resolve, reject) => {
    const controllers = [];
    let next = 0;
    let running = 0;
    let settled = false;
    let lastError = null;
    let hedge = null;

    function settle(finish) {
      settled = true;
      clearTimeout(hedge);
      for (const controller of controllers) controller.abort();
      finish();
    }

    // Starts the next attempt; false when none is left or there is no time.
    function startNext() {
      clearTimeout(hedge);
      const remaining = deadline - now();
      if (settled || next >= attempts.length || remaining < minAttemptMs) return false;
      const attempt = attempts[next++];
      const controller = new AbortController();
      controllers.push(controller);
      running++;
      Promise.resolve()
        .then(() => run(attempt, remaining, controller.signal))
        .then((url) => {
          if (!settled) settle(() => resolve({ url, attempt }));
        }, (err) => {
          running--;
          if (settled) return;
          lastError = err;
          console.warn('[generate] ' + attemptLabel(attempt) + ' failed:', (err && err.message) || err);
          if (!startNext() && running === 0) settle(() => reject(lastError));
        });
      if (next < attempts.length) hedge = setTimeout(startNext, hedgeMs);
      return true;
    }

    startNext();
  });
}
