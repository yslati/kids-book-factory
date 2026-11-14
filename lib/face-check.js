// Looks at the child's photo once, before a cover is paid for, and answers
// two things:
// - whether the face is usable as a likeness reference. A face detector can't
//   tell: BlazeFace scored a face behind a hockey cage 0.97. A small vision
//   model answers this well (gpt-5.4-nano: 10 of 10 right on test photos,
//   including the cage and a hand resting on a cheek).
// - a written description of the face (shape, skin tone, eyes, teeth, hair,
//   marks), which goes into the OpenAI prompt. Spelling the child's features
//   out gave clearly closer covers in side-by-side tests (2026-11-14: braces
//   kept, the right age and face width).
//
// About 2-3 s and ~950 tokens (a few hundredths of a cent) per photo. Any
// failure returns null and the cover is generated anyway: the check must
// never block a preview by itself.

const API_BASE = 'https://api.openai.com/v1';
export const DEFAULT_CHECK_MODEL = 'gpt-5.4-nano';
const TIMEOUT_MS = 10000;
// Longest description kept; the model is asked for 50-80 words.
export const MAX_DESCRIPTION_CHARS = 700;

// Verdicts that stop the preview. too_small is handled by the face crop and
// blurry_or_dark is a judgement call, so those go through.
export const BLOCKING_VERDICTS = ['covered', 'turned_away', 'no_face'];

const INSTRUCTIONS =
  'This photo was uploaded to put a child\'s face on an illustrated book cover.\n' +
  'verdict - judge only whether the main child\'s face is usable as a likeness reference. clear: eyes, ' +
  'nose and mouth all visible and in focus, nothing in front of them. covered: a mask, helmet cage, visor, ' +
  'sunglasses, hand, hair or object hides part of the face. turned_away: profile or looking far away so ' +
  'the face is not readable. too_small: the face is a tiny part of the photo. blurry_or_dark: too blurred ' +
  'or too dark to see features. no_face: no child\'s face. A hat or helmet that leaves the whole face ' +
  'visible is still clear.\n' +
  'note - one short sentence on the verdict.\n';

// What the description covers. A free fix follows a cover the parent said
// didn't look like their child, so it asks for twice the detail.
const DESCRIBE =
  'description - for an illustrator who must paint a recognisable likeness of this child: one compact ' +
  'paragraph, 50-80 words, no names, no clothing, no background, no expression. Cover face shape and ' +
  'width, cheeks and chin, skin tone (precise), eye colour, shape and spacing, eyebrows, nose, lips and ' +
  'teeth (braces, gaps), hair colour, length, texture, parting and style, and any glasses, freckles, ' +
  'moles or dimples. Plain, specific words. Empty when there is no usable face.';
const DESCRIBE_IN_DETAIL =
  'description - a previous painting of this child did not look like them, so the illustrator needs a ' +
  'precise, detailed likeness brief: 130-180 words, no names, no clothing, no background, no expression. ' +
  'Cover face shape, width and length, forehead height, cheekbones, cheek fullness, jawline and chin; skin ' +
  'tone and undertone, precisely; eye colour, size, shape, spacing, eyelids and lashes; eyebrow colour, ' +
  'thickness and shape; nose bridge, tip and nostril width; lip shape and fullness, smile shape, teeth ' +
  '(braces, gaps, missing teeth); ears if visible; hairline, hair colour (with highlights), length, ' +
  'texture, volume, parting, fringe and style; glasses, freckles, moles, dimples and any other mark. ' +
  'Plain, specific words, the most distinctive features first. Empty when there is no usable face.';

// Longest description kept for each.
const MAX_CHARS = { short: MAX_DESCRIPTION_CHARS, detailed: 1500 };

const SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'face_check',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['verdict', 'note', 'description'],
      properties: {
        verdict: { type: 'string', enum: ['clear', 'covered', 'turned_away', 'too_small', 'blurry_or_dark', 'no_face'] },
        note: { type: 'string' },
        description: { type: 'string' }
      }
    }
  }
};

export function faceCheckConfigured() {
  return Boolean(process.env.OPENAI_KEY);
}

// { verdict, note, description } for a JPEG of the photo as the generator
// gets it, or null when the check could not run. detailed asks for the
// longer description a free fix uses.
export async function checkFace(jpeg, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS, detailed = false } = {}) {
  if (!faceCheckConfigured()) return null;
  try {
    const res = await fetchImpl(API_BASE + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.OPENAI_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.FACE_CHECK_MODEL || DEFAULT_CHECK_MODEL,
        reasoning_effort: 'low',
        max_completion_tokens: 1500,
        response_format: SCHEMA,
        messages: [{
          role: 'user',
          content: [
            // 'high' tiles the whole photo: the description needs the detail.
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + jpeg.toString('base64'), detail: 'high' } },
            { type: 'text', text: INSTRUCTIONS + (detailed ? DESCRIBE_IN_DETAIL : DESCRIBE) }
          ]
        }]
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      console.warn('[face-check] refused (HTTP ' + res.status + ')');
      return null;
    }
    const json = await res.json();
    const out = JSON.parse(json.choices[0].message.content);
    if (!SCHEMA.json_schema.schema.properties.verdict.enum.includes(out.verdict)) return null;
    return {
      verdict: out.verdict,
      note: String(out.note || '').slice(0, 200),
      description: String(out.description || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS[detailed ? 'detailed' : 'short'])
    };
  } catch (err) {
    console.warn('[face-check] failed:', (err && err.message) || err);
    return null;
  }
}

// The error to throw for a verdict that stops the preview, or null.
export function faceCheckError(result) {
  if (!result || !BLOCKING_VERDICTS.includes(result.verdict)) return null;
  const err = new Error('face-not-clear');
  err.reason = result.verdict;
  err.note = result.note;
  return err;
}
