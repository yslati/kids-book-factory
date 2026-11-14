// Says whether the child's face in a photo is usable as a likeness reference,
// before a cover is paid for. A face detector can't tell: BlazeFace scored a
// face behind a hockey cage 0.97. A small vision model answers the yes/no
// question well (gpt-5.4-nano: 10 of 10 right on test photos, including the
// cage and a hand resting on a cheek; gpt-5.4-mini called the hand "covered").
//
// About 1.5 s and 750 tokens (a hundredth of a cent) per photo. Any failure
// returns null and the cover is generated anyway: the check must never block
// a preview by itself.

const API_BASE = 'https://api.openai.com/v1';
export const DEFAULT_CHECK_MODEL = 'gpt-5.4-nano';
const TIMEOUT_MS = 8000;

// Verdicts that stop the preview. too_small is handled by the face crop and
// blurry_or_dark is a judgement call, so those go through.
export const BLOCKING_VERDICTS = ['covered', 'turned_away', 'no_face'];

const INSTRUCTIONS =
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

export function faceCheckConfigured() {
  return Boolean(process.env.OPENAI_KEY);
}

// { verdict, note } for a JPEG of the photo as the generator gets it, or null
// when the check could not run.
export async function checkFace(jpeg, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (!faceCheckConfigured()) return null;
  try {
    const res = await fetchImpl(API_BASE + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.OPENAI_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.FACE_CHECK_MODEL || DEFAULT_CHECK_MODEL,
        reasoning_effort: 'low',
        max_completion_tokens: 600,
        response_format: SCHEMA,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + jpeg.toString('base64'), detail: 'low' } },
            { type: 'text', text: INSTRUCTIONS }
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
    return { verdict: out.verdict, note: String(out.note || '').slice(0, 200) };
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
