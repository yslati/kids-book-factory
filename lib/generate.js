// Cover generation: an ordered chain of model attempts. Each one runs only if
// the one before it failed, within the request's budget.

import { falConfigured, generateWithFal } from './fal.js';
import { cancelHiggsfieldJob, generateWithHiggsfield, higgsfieldConfigured, readHiggsfieldJob } from './higgsfield.js';
import { falBalance } from './fal-balance.js';
import { attemptLabel, runAttempts, usableAttempts } from './provider-order.js';
import { trackHiggsfieldJob } from './higgsfield-feed.js';
import { getRedis } from './redis.js';
import { waitUntil } from '@vercel/functions';

// Higgsfield Marketing Studio Image endpoints. Sunburst replaced the name
// everywhere on the cover in side-by-side tests, where Flare left the old one
// on caps and jerseys; Flare takes over only when Sunburst fails. 2.0 is a
// different model, so it can still answer when both are down or flag a photo.
const CHAIN = [
  { provider: 'higgsfield', model: 'marketing-studio/image/sunburst', quality: 'medium' },
  { provider: 'higgsfield', model: 'marketing-studio/image/flare', quality: 'medium' },
  { provider: 'higgsfield', model: 'marketing-studio/image', quality: 'low' },
  // fal (Nano Banana 2) is off while that account has no credit. To use it as
  // the last fallback, uncomment this entry and set FAL_KEY (full access); it
  // is skipped once the balance is $0.10 or less.
  // { provider: 'fal' },
];

// Sunburst medium takes 22-35s once Higgsfield starts it. The account runs two
// jobs at once and a started job can't be cancelled, so a slow Sunburst gets
// the whole budget rather than a second job that would queue behind it.
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
// null); deadline is the epoch ms by which generation must finish. With
// keepPending, a Higgsfield job still queued or running at the deadline is
// left to finish: the error thrown carries err.pending = { attempt,
// statusUrl, cancelUrl, startedAt } for checkPendingCover.
export async function generateCover(coverUrl, childUrl, prompt, { coverAspect, deadline, keepPending = false }) {
  const configured = configuredProviders();
  const usesFal = configured.fal && CHAIN.some((attempt) => attempt.provider === 'fal');
  const attempts = usableAttempts(CHAIN, {
    configured,
    falBalance: usesFal ? await falBalance() : null
  });

  const result = await runAttempts(attempts, async (attempt, timeoutMs) => {
    if (attempt.provider === 'fal') {
      return generateWithFal(coverUrl, childUrl, prompt, { timeoutMs });
    }
    const started = Date.now();
    try {
      const url = await generateWithHiggsfield(coverUrl, childUrl, prompt, {
        model: attempt.model,
        quality: attempt.quality,
        coverAspect,
        timeoutMs,
        keepPending
      });
      trackJob(attempt, null, started);
      return url;
    } catch (err) {
      // A job left running is counted once checkPendingCover sees it end.
      if (err && err.job) err.pending = { attempt, ...err.job, startedAt: started };
      else trackJob(attempt, err, started);
      throw err;
    }
  }, { deadline, minAttemptMs: MIN_ATTEMPT_MS });

  console.log('[generate] cover by ' + attemptLabel(result.attempt));
  return result;
}

// Each attempt is counted, and refusals alerted, in #higgsfield after the response.
function trackJob(attempt, err, started) {
  waitUntil(trackHiggsfieldJob(getRedis(), attempt, err, Date.now() - started));
}

// One look at a job generateCover left running (err.pending). Resolves the
// cover's URL once it has completed, or null while it hasn't; throws when it
// failed.
export async function checkPendingCover(pending) {
  try {
    const url = await readHiggsfieldJob(pending.statusUrl, { model: pending.attempt.model });
    if (url) trackJob(pending.attempt, null, pending.startedAt);
    return url;
  } catch (err) {
    trackJob(pending.attempt, err, pending.startedAt);
    throw err;
  }
}

// Gives up on a job generateCover left running: cancelled if still queued,
// and counted as timed out.
export async function abandonPendingCover(pending) {
  await cancelHiggsfieldJob(pending.cancelUrl);
  trackJob(pending.attempt, new Error('higgsfield-timeout'), pending.startedAt);
}
