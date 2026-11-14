// Looks at the child's photo before a cover is paid for, with two small
// vision calls run side by side:
// - a yes/no on whether the face is usable as a likeness reference
//   (gpt-5.4-nano). A face detector can't tell: BlazeFace scored a face
//   behind a hockey cage 0.97. Nano got 10 of 10 test photos right; mini
//   called a hand resting on a cheek "covered".
// - a written description of the face (gpt-5.4-mini), which goes into the
//   OpenAI prompt. Spelling the child's features out gave clearly closer
//   covers (2026-11-14). Mini, told to describe only what it plainly sees,
//   got teeth right on 4 of 4 photos; nano invented braces on a boy with
//   gap teeth, and every cover then showed braces.
//
// About 4-5 s (the description is the slower call) and a tenth of a cent
// per photo. Any failure returns null, or an empty description, and the
// cover is generated anyway: the check must never block a preview by itself.

const API_BASE = 'https://api.openai.com/v1';
export const DEFAULT_CHECK_MODEL = 'gpt-5.4-nano';
export const DEFAULT_DESCRIBE_MODEL = 'gpt-5.4-mini';
const TIMEOUT_MS = 12000;

// Verdicts that stop the preview. too_small is handled by the face crop and
// blurry_or_dark is a judgement call, so those go through.
export const BLOCKING_VERDICTS = ['covered', 'turned_away', 'no_face'];

const VERDICT =
  'This photo was uploaded to put a child\'s face on an illustrated book cover. Judge only whether ' +
  'the main child\'s face is usable as a likeness reference. clear: eyes, nose and mouth all visible ' +
  'and in focus, nothing in front of them. covered: a mask, helmet cage, visor, sunglasses, hand, hair ' +
  'or object hides part of the face. turned_away: profile or looking far away so the face is not ' +
  'readable. too_small: the face is a tiny part of the photo. blurry_or_dark: too blurred or too dark ' +
  'to see features. no_face: no child\'s face. A hat or helmet that leaves the whole face visible is ' +
  'still clear. Note: one short sentence.';

const SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'face_check',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['verdict', 'note'],
      properties: {
        verdict: { type: 'string', enum: ['clear', 'covered', 'turned_away', 'too_small', 'blurry_or_dark', 'no_face'] },
        note: { type: 'string' }
      }
    }
  }
};

// Shared by both lengths: what keeps the description true to the photo.
const ONLY_WHAT_SHOWS =
  'Describe only what you can clearly see in this photo; never guess or assume. Teeth: say exactly what ' +
  'shows - missing or gap teeth, crooked teeth, or braces only when metal brackets are plainly visible on ' +
  'the teeth. Leave out anything you cannot see clearly. Complete sentences, no names, no clothing, no ' +
  'background, no expression. If there is no clear child\'s face, answer with nothing.';

const DESCRIBE =
  'Describe this child\'s face for an illustrator who must paint a recognisable likeness: one compact ' +
  'paragraph, 50-80 words. Cover face shape and width, cheeks and chin, skin tone (precise), eye colour ' +
  'and shape, eyebrows, nose, lips, teeth, hair colour, length, texture and style, and glasses, freckles, ' +
  'moles or dimples. ' + ONLY_WHAT_SHOWS;

// A free fix follows a cover the parent said didn't look like their child,
// so it asks for twice the detail.
const DESCRIBE_IN_DETAIL =
  'A previous painting of this child did not look like them. Write a precise likeness brief for the ' +
  'illustrator: one paragraph, 130-180 words, the most distinctive features first. Cover face shape, ' +
  'width and length, forehead, cheekbones, cheek fullness, jawline and chin; skin tone and undertone, ' +
  'precisely; eye colour, size, shape, spacing and eyelids; eyebrow colour, thickness and shape; nose ' +
  'bridge, tip and width; lip shape and fullness; teeth; ears if visible; hairline, hair colour (with ' +
  'highlights), length, texture, volume, parting, fringe and style; glasses, freckles, moles, dimples ' +
  'and any other mark. ' + ONLY_WHAT_SHOWS;

// Longest description kept, cut back to the last full sentence.
export const MAX_DESCRIPTION_CHARS = { short: 1000, detailed: 2000 };

export function faceCheckConfigured() {
  return Boolean(process.env.OPENAI_KEY);
}

// One chat completion with the photo; resolves the message text.
async function ask(fetchImpl, { model, detail, text, schema, maxTokens, timeoutMs, jpeg }) {
  const res = await fetchImpl(API_BASE + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.OPENAI_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      reasoning_effort: 'low',
      max_completion_tokens: maxTokens,
      ...(schema ? { response_format: schema } : {}),
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + jpeg.toString('base64'), detail } },
          { type: 'text', text }
        ]
      }]
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error('openai-' + res.status);
  const json = await res.json();
  return String(json.choices[0].message.content || '');
}

// text cut to whole sentences within max characters ('' if not even one fits).
export function wholeSentences(text, max) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.lastIndexOf('. ', max - 1);
  return cut > 0 ? clean.slice(0, cut + 1) : '';
}

// { verdict, note, description } for a JPEG of the photo as the generator
// gets it, or null when the verdict could not be had. detailed asks for the
// longer description a free fix uses. description is '' when that call
// failed.
export async function checkFace(jpeg, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS, detailed = false } = {}) {
  if (!faceCheckConfigured()) return null;
  const [verdict, description] = await Promise.all([
    ask(fetchImpl, {
      model: process.env.FACE_CHECK_MODEL || DEFAULT_CHECK_MODEL,
      detail: 'low', text: VERDICT, schema: SCHEMA, maxTokens: 600, timeoutMs, jpeg
    }).then((text) => JSON.parse(text)).catch((err) => {
      console.warn('[face-check] verdict failed:', (err && err.message) || err);
      return null;
    }),
    ask(fetchImpl, {
      model: process.env.FACE_DESCRIBE_MODEL || DEFAULT_DESCRIBE_MODEL,
      detail: 'high', text: detailed ? DESCRIBE_IN_DETAIL : DESCRIBE, maxTokens: 1500, timeoutMs, jpeg
    }).catch((err) => {
      console.warn('[face-check] description failed:', (err && err.message) || err);
      return '';
    })
  ]);
  if (!verdict || !SCHEMA.json_schema.schema.properties.verdict.enum.includes(verdict.verdict)) return null;
  return {
    verdict: verdict.verdict,
    note: String(verdict.note || '').slice(0, 200),
    description: wholeSentences(description, MAX_DESCRIPTION_CHARS[detailed ? 'detailed' : 'short'])
  };
}

// The error to throw for a verdict that stops the preview, or null.
export function faceCheckError(result) {
  if (!result || !BLOCKING_VERDICTS.includes(result.verdict)) return null;
  const err = new Error('face-not-clear');
  err.reason = result.verdict;
  err.note = result.note;
  return err;
}
