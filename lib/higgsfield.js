// Higgsfield cover generation through the Marketing Studio Image endpoints
// (marketing-studio/image, .../flare, .../sunburst), which share one request
// shape: the [cover, child] pair plus the prompt. lib/generate.js picks the
// endpoint and quality.
//
// The API is asynchronous: submit, then poll status_url until a terminal state.
// Failed, NSFW and cancelled requests are not charged. Prompt enhancement stays
// off so Higgsfield never rewrites the name and language rules.
//
// Auth: HIGGSFIELD_KEY = "<key id>:<key secret>" from console.higgsfield.ai.

const API_BASE = 'https://api.higgsfield.ai';
const POLL_MS = 1500;
const DEFAULT_TIMEOUT_MS = 45000;
// The endpoints reject longer prompts.
const MAX_PROMPT_CHARS = 5000;

// Output ratios the endpoint accepts. Its 'auto' means square when prompt
// enhancement is off, so we pick the one nearest the cover's own shape.
const ASPECT_RATIOS = ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'];

export function higgsfieldConfigured() {
  return Boolean(process.env.HIGGSFIELD_KEY);
}

// Nearest supported aspect ratio to a width/height ratio. Unknown → square,
// which is what every book cover in the shop is today.
export function nearestAspectRatio(ratio) {
  if (!(ratio > 0) || !Number.isFinite(ratio)) return '1:1';
  let best = '1:1';
  let bestDistance = Infinity;
  for (const candidate of ASPECT_RATIOS) {
    const [w, h] = candidate.split(':').map(Number);
    // Compare on a log scale so 2:1 and 1:2 are equally far from 1:1.
    const distance = Math.abs(Math.log(ratio / (w / h)));
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function authHeaders() {
  return {
    Authorization: 'Key ' + process.env.HIGGSFIELD_KEY,
    'Content-Type': 'application/json'
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Generate a cover. coverUrl + childUrl must be publicly fetchable by
// Higgsfield. model is the endpoint path, quality one it accepts (low, medium,
// high...); coverAspect is the cover's width / height when known. Returns the
// generated image URL (hosted by Higgsfield for at least 7 days). Throws on
// failure or once timeoutMs passes.
export async function generateWithHiggsfield(coverUrl, childUrl, prompt, { model, quality, coverAspect, timeoutMs } = {}) {
  // Fail fast rather than truncate: the name and language rules sit at the end.
  if (prompt.length > MAX_PROMPT_CHARS) throw new Error('higgsfield-prompt-too-long');

  const deadline = Date.now() + (timeoutMs || DEFAULT_TIMEOUT_MS);
  const headers = authHeaders();

  const submitRes = await fetch(`${API_BASE}/${model}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      prompt: prompt,
      image_urls: [coverUrl, childUrl],
      resolution: '1k',
      aspect_ratio: nearestAspectRatio(coverAspect),
      quality: quality,
      enhance_prompt: false
    }),
    signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now()))
  });
  // 403 here means the Higgsfield balance cannot cover the request.
  if (!submitRes.ok) throw new Error('higgsfield-submit-' + submitRes.status);
  const submitted = await submitRes.json();
  if (!submitted || !submitted.status_url) throw new Error('higgsfield-no-status-url');

  while (Date.now() < deadline) {
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));

    let statusRes;
    try {
      statusRes = await fetch(submitted.status_url, {
        headers,
        signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now()))
      });
    } catch (err) {
      continue; // network blip or slow poll - keep polling until the deadline
    }
    if (!statusRes.ok) {
      if (statusRes.status >= 500) continue;
      throw new Error('higgsfield-status-' + statusRes.status);
    }

    const job = await statusRes.json();
    if (job.status === 'completed') {
      const url = job.images && job.images[0] && job.images[0].url;
      if (!url) throw new Error('higgsfield-empty');
      return url;
    }
    if (job.status === 'failed' || job.status === 'nsfw' || job.status === 'canceled') {
      throw new Error('higgsfield-' + job.status);
    }
  }

  // Out of time. Cancelling only works while the job is still queued (it is
  // then refunded); one that already started may still finish and be charged.
  if (submitted.cancel_url) {
    try {
      await fetch(submitted.cancel_url, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(2000)
      });
    } catch (err) { /* best effort */ }
  }
  throw new Error('higgsfield-timeout');
}
