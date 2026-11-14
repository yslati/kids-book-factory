// Cover generation: an ordered chain of model attempts. Each one runs only if
// the one before it failed, within the request's budget.

import { falConfigured, generateWithFal } from './fal.js';
import { cancelHiggsfieldJob, generateWithHiggsfield, higgsfieldConfigured, readHiggsfieldJob } from './higgsfield.js';
import { DEFAULT_OPENAI_MODEL, MAX_PROMPT_CHARS as OPENAI_PROMPT_CHARS, generateWithOpenAI, openaiConfigured } from './openai.js';
import { MAX_PROMPT_CHARS as HIGGSFIELD_PROMPT_CHARS } from './prompt.js';
import { falBalance } from './fal-balance.js';
import { FAL_LOW_BALANCE_USD, attemptLabel, raiseQuality, runAttempts, usableAttempts } from './provider-order.js';
import { trackHiggsfieldJob } from './higgsfield-feed.js';
import { trackOpenAIJob } from './openai-feed.js';
import { getRedis } from './redis.js';
import { waitUntil } from '@vercel/functions';

// 1. OpenAI directly (lib/openai.js): gpt-image-2.5-sunburst, the model that
//    won every cover comparison. No two-jobs-at-a-time queue, a 32k prompt
//    limit, and the exact cost in each response.
// 2. The same Sunburst through Higgsfield, for when OpenAI is down or its
//    balance is empty. Flare and Higgsfield 2.0 are left out: they share
//    Higgsfield's account and queue, and Flare's covers were weaker.
// 3. fal's Nano Banana 2, a different model from a different company, for
//    when both are down or both refuse a photo. Skipped once fal's balance is
//    FAL_LOW_BALANCE_USD or less.
// OpenAI's medium covers take 20-25s. A request still running at 35s is
// cut off (it may still be billed) so Higgsfield gets its turn within the
// 60s budget; a Higgsfield job still running at the deadline is queued and
// finished by /preview-status, so the parent still gets a cover.
const CHAIN = [
  { provider: 'openai', model: DEFAULT_OPENAI_MODEL, quality: 'medium', maxMs: 35000 },
  { provider: 'higgsfield', model: 'marketing-studio/image/sunburst', quality: 'medium' },
  { provider: 'fal' },
];

// The longest prompt each provider takes. Every attempt gets the prompt
// sized for its own provider, so a fix line OpenAI can read in full is only
// trimmed when Higgsfield or fal steps in.
const PROMPT_CHARS = { openai: OPENAI_PROMPT_CHARS, higgsfield: HIGGSFIELD_PROMPT_CHARS, fal: HIGGSFIELD_PROMPT_CHARS };

// Sunburst medium takes 22-35s once Higgsfield starts it. The account runs two
// jobs at once and a started job can't be cancelled, so a slow Sunburst gets
// the whole budget rather than a second job that would queue behind it.
// Higgsfield covers take at least ~15s, so a shorter attempt could only be cut off.
const MIN_ATTEMPT_MS = 15000;

function configuredProviders() {
  return { higgsfield: higgsfieldConfigured(), fal: falConfigured(), openai: openaiConfigured() };
}

export function falInChain() {
  return CHAIN.some((attempt) => attempt.provider === 'fal');
}

// The chain's Higgsfield models, which the daily #higgsfield check watches.
export function higgsfieldChain() {
  return CHAIN.filter((attempt) => attempt.provider === 'higgsfield');
}

// The chain's OpenAI models, which the daily #openai check watches. The
// default model is watched even while OpenAI is out of the chain, so the
// check still says whether the key and model work.
export function openaiChain() {
  const attempts = CHAIN.filter((attempt) => attempt.provider === 'openai');
  return attempts.length ? attempts : [{ provider: 'openai', model: DEFAULT_OPENAI_MODEL, quality: 'medium' }];
}

export function openaiInChain() {
  return CHAIN.some((attempt) => attempt.provider === 'openai');
}

export function generationConfigured() {
  return usableAttempts(CHAIN, { configured: configuredProviders() }).length > 0;
}

// Returns { url, attempt, prompt, cost? } (cost in USD where the provider
// reports it; url may be a data: URL; prompt the text that attempt was sent).
// prompt is a string, or a function of the provider's character limit that
// returns one. coverAspect is the cover's width / height (or null); deadline
// is the epoch ms by which generation must finish. With keepPending, a
// Higgsfield job still queued or running at the deadline is left to finish:
// the error thrown carries err.pending = { attempt, statusUrl, cancelUrl,
// queued, startedAt, prompt } for checkPendingCover. quality, when given,
// replaces the chain's 'medium' (see raiseQuality).
export async function generateCover(coverUrl, childUrl, prompt, { coverAspect, deadline, keepPending = false, quality }) {
  const promptFor = (attempt) => (typeof prompt === 'function' ? prompt(PROMPT_CHARS[attempt.provider]) : prompt);
  const attempts = raiseQuality(usableAttempts(CHAIN, { configured: configuredProviders() }), quality);

  const result = await runAttempts(attempts, async (attempt, timeoutMs) => {
    const text = promptFor(attempt);
    const out = await runAttempt(attempt, text, timeoutMs);
    return typeof out === 'string' ? { url: out, prompt: text } : { ...out, prompt: text };
  }, { deadline, minAttemptMs: MIN_ATTEMPT_MS });

  console.log('[generate] cover by ' + attemptLabel(result.attempt));
  return result;

  async function runAttempt(attempt, text, timeoutMs) {
    if (attempt.provider === 'fal') {
      // Checked only when fal is reached (cached a minute), so covers made
      // by the first two providers don't wait for fal's billing API.
      const balance = await falBalance();
      if (typeof balance === 'number' && balance <= FAL_LOW_BALANCE_USD) throw new Error('fal-low-balance');
      return generateWithFal(coverUrl, childUrl, text, { timeoutMs });
    }
    if (attempt.provider === 'openai') {
      const started = Date.now();
      try {
        const out = await generateWithOpenAI(coverUrl, childUrl, text, { model: attempt.model, quality: attempt.quality, coverAspect, timeoutMs });
        waitUntil(trackOpenAIJob(getRedis(), attempt, null, Date.now() - started, out.cost));
        return out;
      } catch (err) {
        waitUntil(trackOpenAIJob(getRedis(), attempt, err, Date.now() - started));
        throw err;
      }
    }
    const started = Date.now();
    try {
      const url = await generateWithHiggsfield(coverUrl, childUrl, text, {
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
      if (err && err.job) err.pending = { attempt, ...err.job, startedAt: started, prompt: text };
      else trackJob(attempt, err, started);
      throw err;
    }
  }
}

// Each attempt is counted, and refusals alerted, in #higgsfield after the response.
function trackJob(attempt, err, started) {
  waitUntil(trackHiggsfieldJob(getRedis(), attempt, err, Date.now() - started));
}

// One look at a job generateCover left running (err.pending). Resolves
// { url } once it has completed, or { queued } while it waits for a slot
// (true) or runs (false); throws when it failed.
export async function checkPendingCover(pending) {
  try {
    const job = await readHiggsfieldJob(pending.statusUrl, { model: pending.attempt.model });
    if (job.url) trackJob(pending.attempt, null, pending.startedAt);
    return job;
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
