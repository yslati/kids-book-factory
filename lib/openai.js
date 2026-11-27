// OpenAI cover generation through the Images API (POST /v1/images/edits).
// The GPT Image models take the same [cover, child] pair plus the prompt as
// Higgsfield's Marketing Studio endpoints; lib/generate.js picks the model
// and quality. Higgsfield's Sunburst and Flare are these same models resold
// (gpt-image-2.5-sunburst, gpt-image-2.5-flare), so calling OpenAI directly
// gives the same covers without Higgsfield's two-jobs-at-a-time limit.
//
// The call is synchronous: one request, the image comes back base64 in the
// response. There is no job to cancel, so a request cut off by its timeout
// may still be billed. Every response carries its token usage, from which
// costOf() gives the exact price of the cover.
//
// Auth: OPENAI_KEY, a project API key from platform.openai.com. The
// organisation may need OpenAI's one-time verification before GPT Image
// models answer (a 403 until then).

const API_BASE = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 55000;
// The edits endpoint's own limit; lib/generate.js applies Higgsfield's much
// shorter one while that provider is in the chain.
export const MAX_PROMPT_CHARS = 32000;

// Sunburst 2.6: closer likeness than 2.5 (Higgsfield's resold model) in the
// 2026-11-14 comparison, at about twice the price and 35-38s a cover.
export const DEFAULT_OPENAI_MODEL = 'gpt-image-2.6-sunburst';

// USD per million tokens, the same for every GPT Image 2.x model (OpenAI's
// pricing page, November 2026).
export const OPENAI_PRICES_PER_M = { textInput: 5, imageInput: 8, imageOutput: 30 };

// Output sizes every GPT Image model accepts; the cover's own shape picks one.
const SIZES = ['1024x1024', '1536x1024', '1024x1536'];

export function openaiConfigured() {
  return Boolean(process.env.OPENAI_KEY);
}

function authHeaders() {
  return {
    Authorization: 'Bearer ' + process.env.OPENAI_KEY,
    'Content-Type': 'application/json'
  };
}

// The fixed size nearest a width/height ratio. Unknown → square, which is
// what every book cover in the shop is today.
export function nearestSize(ratio) {
  if (!(ratio > 0) || !Number.isFinite(ratio)) return SIZES[0];
  let best = SIZES[0];
  let bestDistance = Infinity;
  for (const size of SIZES) {
    const [w, h] = size.split('x').map(Number);
    const distance = Math.abs(Math.log(ratio / (w / h)));
    if (distance < bestDistance) {
      best = size;
      bestDistance = distance;
    }
  }
  return best;
}

// The cost in USD of a response's `usage`, or null when it has none.
export function costOf(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const details = usage.input_tokens_details || {};
  const text = Number(details.text_tokens) || 0;
  const imageIn = Number(details.image_tokens) || 0;
  const out = Number(usage.output_tokens) || 0;
  if (!(text + imageIn + out)) return null;
  const p = OPENAI_PRICES_PER_M;
  return (text * p.textInput + imageIn * p.imageInput + out * p.imageOutput) / 1e6;
}

// Image types the edits endpoint accepts, and the most fetched for one image.
const EMBED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_EMBED_BYTES = 20 * 1024 * 1024;
const MAX_EMBED_MS = 10000;

// The image at url as a base64 data URL, so OpenAI doesn't download it: a host
// that rate-limits OpenAI's downloader fails the whole cover ("Error while
// downloading file. Upstream status code: 429"). Falls back to the URL when
// the image can't be fetched here. `label` names it in the logs; the URL is
// never logged, as it holds the photo's object key.
export async function embedImage(url, label, timeoutMs = MAX_EMBED_MS) {
  if (!/^https?:\/\//i.test(String(url))) return url;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!EMBED_TYPES.includes(type)) throw new Error('unsupported type ' + (type || 'none'));
    if (Number(res.headers.get('content-length')) > MAX_EMBED_BYTES) throw new Error('too large');
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_EMBED_BYTES) throw new Error('too large');
    return 'data:' + type + ';base64,' + bytes.toString('base64');
  } catch (err) {
    console.warn('[openai] sending the ' + label + ' as a link, embedding failed: ' + ((err && err.message) || err));
    return url;
  }
}

function requestBody(coverImage, childImage, prompt, { model, quality, coverAspect }) {
  return {
    model: model || DEFAULT_OPENAI_MODEL,
    prompt: prompt,
    images: [{ image_url: coverImage }, { image_url: childImage }],
    n: 1,
    quality: quality || 'medium',
    size: nearestSize(coverAspect),
    // JPEG at this quality is a third of the PNG and looks the same at 1024px.
    output_format: 'jpeg',
    output_compression: 92
  };
}

// The error OpenAI reports ({ error: { code, message, type } }), as text for
// the logs. Only these fields are read, so no prompt is echoed.
async function errorDetail(res) {
  let json = null;
  try { json = await res.json(); } catch (e) { /* not JSON */ }
  const e = (json && json.error) || {};
  return { code: String(e.code || e.type || ''), text: [e.code, e.message].filter(Boolean).join(': ').slice(0, 300) };
}

// The model ids this key can use, as strings, or null when the call failed
// ({ status, models }); status 0 when OpenAI could not be reached.
export async function listOpenAIModels({ timeoutMs = 10000 } = {}) {
  try {
    const res = await fetch(API_BASE + '/models', { headers: authHeaders(), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { status: res.status, models: null };
    const json = await res.json();
    return { status: res.status, models: Array.isArray(json && json.data) ? json.data.map((m) => String(m.id)) : [] };
  } catch (err) {
    return { status: 0, models: null, error: String((err && err.message) || err) };
  }
}

// Generate a cover. coverUrl + childUrl are fetched here and sent embedded
// (embedImage); one that can't be is sent as its link, which OpenAI fetches.
// model is a GPT Image model id, quality one it accepts (low, medium, high);
// coverAspect is the cover's width / height when known. Resolves { url, usage,
// cost }, where url is a data: URL holding the JPEG (OpenAI returns no hosted
// URL) and cost its exact price in USD. Throws 'openai-<status>' when OpenAI
// refuses (err.code carries its error code), 'openai-empty' on a response
// without an image, or the fetch's own TimeoutError once timeoutMs passes.
export async function generateWithOpenAI(coverUrl, childUrl, prompt, { model, quality, coverAspect, timeoutMs } = {}) {
  if (prompt.length > MAX_PROMPT_CHARS) throw new Error('openai-prompt-too-long');

  const deadline = Date.now() + (timeoutMs || DEFAULT_TIMEOUT_MS);
  const embedMs = Math.min(MAX_EMBED_MS, Math.floor((timeoutMs || DEFAULT_TIMEOUT_MS) / 4));
  const [coverImage, childImage] = await Promise.all([
    embedImage(coverUrl, 'cover', embedMs),
    embedImage(childUrl, 'photo', embedMs)
  ]);

  const res = await fetch(API_BASE + '/images/edits', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(requestBody(coverImage, childImage, prompt, { model, quality, coverAspect })),
    signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now()))
  });
  if (!res.ok) {
    const detail = await errorDetail(res);
    console.warn('[openai] ' + (model || DEFAULT_OPENAI_MODEL) + ' refused (HTTP ' + res.status + '): ' + (detail.text || 'no reason given'));
    const err = new Error('openai-' + res.status);
    err.code = detail.code;
    throw err;
  }

  const json = await res.json();
  const image = json && json.data && json.data[0];
  if (!image || !image.b64_json) throw new Error('openai-empty');
  const format = json.output_format === 'png' ? 'png' : json.output_format === 'webp' ? 'webp' : 'jpeg';
  return {
    url: 'data:image/' + format + ';base64,' + image.b64_json,
    usage: json.usage || null,
    cost: costOf(json.usage)
  };
}
