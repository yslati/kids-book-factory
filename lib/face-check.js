// Looks at the child's photo before a cover is paid for, with two small
// vision calls run side by side:
// - a verdict on whether the face is usable as a likeness reference
//   (gpt-5.4-nano), with a one-sentence tip for the parent in their language.
// - what the photo shows (gpt-5.4-mini): a written description of the face
//   plus the things a cover must keep - glasses, headwear, hair, marks. The
//   description and those traits go into the prompt (lib/prompt.js).
// reviewCover then looks at the finished cover beside the photo and reports
// what does not match, which fills the preview page's fix buttons
// (lib/fix-options.js).
//
// Any failure returns null, or empty traits, and the cover is generated
// anyway: a check must never block a preview by itself.

const API_BASE = 'https://api.openai.com/v1';
export const DEFAULT_CHECK_MODEL = 'gpt-5.4-nano';
export const DEFAULT_DESCRIBE_MODEL = 'gpt-5.4-mini';
const TIMEOUT_MS = 12000;
const REVIEW_TIMEOUT_MS = 7000;

// What the verdict call can answer.
export const Verdict = Object.freeze({
  CLEAR: 'clear',
  COVERED: 'covered',
  TURNED_AWAY: 'turned_away',
  TOO_SMALL: 'too_small',
  BLURRY: 'blurry',
  DARK: 'dark',
  SEVERAL_FACES: 'several_faces',
  NO_FACE: 'no_face'
});

// Verdicts that stop the preview. too_small is decided by the face's size in
// pixels (lib/child-photo.js), not by the model.
export const BLOCKING_VERDICTS = [
  Verdict.COVERED, Verdict.TURNED_AWAY, Verdict.BLURRY, Verdict.DARK, Verdict.SEVERAL_FACES, Verdict.NO_FACE
];

// How a finished cover compares with the photo (reviewCover).
export const Seen = Object.freeze({
  MATCH: 'match',
  MISSING: 'missing',
  DIFFERENT: 'different',
  NONE: 'none',
  UNCLEAR: 'unclear'
});

// The storefront's locales, for the texts written for the parent.
const LANGUAGES = { en: 'English', de: 'German', es: 'Spanish', fr: 'French', it: 'Italian', pt: 'Portuguese' };

// 'pt-PT' → 'Portuguese'; anything unknown → 'English'.
export function languageOf(locale) {
  const code = String(locale || '').toLowerCase().slice(0, 2);
  return LANGUAGES[code] || LANGUAGES.en;
}

const verdictText = (language) =>
  'This photo was uploaded to put a child\'s face on an illustrated book cover. Judge only whether the main ' +
  'child\'s face is usable as a likeness reference. ' +
  'clear: eyes, nose and mouth all visible and in focus, nothing in front of them. ' +
  'covered: a mask, helmet cage, visor, sunglasses, hand, hair, food, pacifier or object hides part of the eyes, ' +
  'nose or mouth. ' +
  'turned_away: profile or looking far away so the face is not readable. ' +
  'too_small: the face is a tiny part of the photo. ' +
  'blurry: so out of focus or motion-blurred that the eyes and mouth have no sharp edges. ' +
  'dark: so dark, backlit or overexposed that the features cannot be made out. ' +
  'several_faces: two or more faces of similar size, so it is unclear which child the book is for. ' +
  'no_face: no real child\'s face. ' +
  'Ordinary clear glasses with the eyes visible, and a hat or helmet that leaves the whole face visible, are ' +
  'still clear. When in doubt between clear and another verdict, answer clear. ' +
  'note: one short sentence in English on what you see. ' +
  'tip: empty for clear; otherwise one short, friendly sentence in ' + language + ' for the parent, saying ' +
  'exactly what is wrong in this photo (name the object or problem) and what kind of photo to send instead.';

const VERDICT_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'face_check',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['verdict', 'note', 'tip'],
      properties: {
        verdict: { type: 'string', enum: Object.values(Verdict) },
        note: { type: 'string' },
        tip: { type: 'string' }
      }
    }
  }
};

// What keeps the description true to the photo.
const ONLY_WHAT_SHOWS =
  'Describe only what you can clearly see in this photo; never guess or assume. Teeth: say exactly what ' +
  'shows - missing or gap teeth, crooked teeth, or braces only when metal brackets are plainly visible on ' +
  'the teeth. Leave out anything you cannot see clearly. Complete sentences, no names, no clothing, no ' +
  'background, no expression. If there is no clear child\'s face, leave every field empty.';

const DESCRIBE =
  'description: this child\'s face for an illustrator who must paint a recognisable likeness, one compact ' +
  'paragraph, 50-80 words. Cover face shape and width, cheeks and chin, skin tone (precise), eye colour ' +
  'and shape, eyebrows, nose, lips, teeth, hair colour, length, texture and style, and glasses, freckles, ' +
  'moles or dimples.';

// A free fix follows a cover the parent said didn't look like their child,
// so it asks for twice the detail.
const DESCRIBE_IN_DETAIL =
  'description: a previous painting of this child did not look like them. Write a precise likeness brief for ' +
  'the illustrator: one paragraph, 130-180 words, the most distinctive features first. Cover face shape, ' +
  'width and length, forehead, cheekbones, cheek fullness, jawline and chin; skin tone and undertone, ' +
  'precisely; eye colour, size, shape, spacing and eyelids; eyebrow colour, thickness and shape; nose ' +
  'bridge, tip and width; lip shape and fullness; teeth; ears if visible; hairline, hair colour (with ' +
  'highlights), length, texture, volume, parting, fringe and style; glasses, freckles, moles, dimples ' +
  'and any other mark.';

const traitsText = (language) =>
  'glasses: the glasses the child wears, as frame colour and shape (for example "black rectangular glasses"), ' +
  'or empty when they wear none; sunglasses do not count. ' +
  'headwear: what the child wears on their head (hat, cap, hood, headscarf, crown, bow, headband), as colour ' +
  'and kind (for example "tall black chef hat"), or empty. ' +
  'headwear_label: that headwear in one to three words in ' + language + ', lower case, or empty. ' +
  'hair: the hair that is visible - colour, length, texture and style - or empty when none shows. ' +
  'hair_hidden: true when headwear hides most of the hair. ' +
  'skin: the skin tone in a few precise words. ' +
  'marks: other things that make this child recognisable and must not be lost, each a few words (freckles ' +
  'across the nose, gap between the front teeth, dimples, a mole, braces, a hearing aid, earrings); at most ' +
  'four, an empty list when there are none. ' +
  'outfit: only when the child wears a themed outfit - a sports kit, a uniform, a chef\'s apron or jacket, a ' +
  'costume - its kind, main colours and any number or print (for example "yellow basketball jersey with ' +
  'black trim, number 10", "white chef jacket with red buttons"); empty for everyday clothes.';

const TRAITS_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'child_traits',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['description', 'glasses', 'headwear', 'headwear_label', 'hair', 'hair_hidden', 'skin', 'marks', 'outfit'],
      properties: {
        description: { type: 'string' },
        glasses: { type: 'string' },
        headwear: { type: 'string' },
        headwear_label: { type: 'string' },
        hair: { type: 'string' },
        hair_hidden: { type: 'boolean' },
        skin: { type: 'string' },
        marks: { type: 'array', items: { type: 'string' } },
        outfit: { type: 'string' }
      }
    }
  }
};

// Longest description kept, cut back to the last full sentence.
export const MAX_DESCRIPTION_CHARS = { short: 1000, detailed: 2000 };
const MAX_TRAIT_CHARS = 120;
const MAX_LABEL_CHARS = 30;
const MAX_MARKS = 4;
const MAX_TIP_CHARS = 240;

export function faceCheckConfigured() {
  return Boolean(process.env.OPENAI_KEY);
}

const jpegUrl = (jpeg) => 'data:image/jpeg;base64,' + jpeg.toString('base64');

// One chat completion over images; resolves the message text. images are
// [{ url, detail }].
async function ask(fetchImpl, { model, images, text, schema, maxTokens, timeoutMs }) {
  const res = await fetchImpl(API_BASE + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.OPENAI_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      reasoning_effort: 'low',
      max_completion_tokens: maxTokens,
      response_format: schema,
      messages: [{
        role: 'user',
        content: [
          ...images.map((image) => ({ type: 'image_url', image_url: image })),
          { type: 'text', text }
        ]
      }]
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error('openai-' + res.status);
  const json = await res.json();
  return JSON.parse(String(json.choices[0].message.content || ''));
}

// text cut to whole sentences within max characters ('' if not even one fits).
export function wholeSentences(text, max) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.lastIndexOf('. ', max - 1);
  return cut > 0 ? clean.slice(0, cut + 1) : '';
}

// One line of at most max characters, with nothing that could close a quote.
function phrase(text, max) {
  return String(text || '').replace(/["\s]+/g, ' ').trim().replace(/[.\s]+$/, '').slice(0, max);
}

export const NO_TRAITS = Object.freeze({
  description: '', glasses: '', headwear: '', headwearLabel: '', hair: '', hairHidden: false, skin: '', marks: [],
  outfit: ''
});

// The model's answer as traits, every text cleaned and capped.
export function readTraits(raw, { detailed = false } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const headwear = phrase(r.headwear, MAX_TRAIT_CHARS);
  return {
    description: wholeSentences(r.description, MAX_DESCRIPTION_CHARS[detailed ? 'detailed' : 'short']),
    glasses: phrase(r.glasses, MAX_TRAIT_CHARS),
    headwear,
    headwearLabel: headwear ? phrase(r.headwear_label, MAX_LABEL_CHARS) : '',
    hair: phrase(r.hair, MAX_TRAIT_CHARS),
    hairHidden: Boolean(headwear) && r.hair_hidden === true,
    skin: phrase(r.skin, MAX_TRAIT_CHARS),
    marks: (Array.isArray(r.marks) ? r.marks : []).map((m) => phrase(m, MAX_TRAIT_CHARS)).filter(Boolean).slice(0, MAX_MARKS),
    outfit: phrase(r.outfit, MAX_TRAIT_CHARS)
  };
}

// { verdict, note, tip, traits } for a JPEG of the photo as the generator
// gets it, or null when the verdict could not be had. traits (readTraits)
// carries the description; it is NO_TRAITS when that call failed. detailed
// asks for the longer description a free fix uses; locale is the page's
// language, for the tip and the headwear label.
export async function checkFace(jpeg, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS, detailed = false, locale = 'en' } = {}) {
  if (!faceCheckConfigured()) return null;
  const language = languageOf(locale);
  const [verdict, traits] = await Promise.all([
    ask(fetchImpl, {
      model: process.env.FACE_CHECK_MODEL || DEFAULT_CHECK_MODEL,
      images: [{ url: jpegUrl(jpeg), detail: 'low' }],
      text: verdictText(language), schema: VERDICT_SCHEMA, maxTokens: 700, timeoutMs
    }).catch((err) => {
      console.warn('[face-check] verdict failed:', (err && err.message) || err);
      return null;
    }),
    ask(fetchImpl, {
      model: process.env.FACE_DESCRIBE_MODEL || DEFAULT_DESCRIBE_MODEL,
      images: [{ url: jpegUrl(jpeg), detail: 'high' }],
      text: 'Read this photo of a child for an illustrator. ' + (detailed ? DESCRIBE_IN_DETAIL : DESCRIBE) + ' ' +
        traitsText(language) + ' ' + ONLY_WHAT_SHOWS,
      schema: TRAITS_SCHEMA, maxTokens: 2000, timeoutMs
    }).then((raw) => readTraits(raw, { detailed })).catch((err) => {
      console.warn('[face-check] description failed:', (err && err.message) || err);
      return NO_TRAITS;
    })
  ]);
  if (!verdict || !Object.values(Verdict).includes(verdict.verdict)) return null;
  return {
    verdict: verdict.verdict,
    note: String(verdict.note || '').slice(0, 200),
    tip: verdict.verdict === Verdict.CLEAR ? '' : String(verdict.tip || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TIP_CHARS),
    traits
  };
}

// The error to throw for a photo that stops the preview, or null. tooSmall
// is lib/child-photo.js's own finding, which no verdict is needed for.
export function faceCheckError(result, { tooSmall = false } = {}) {
  const blocked = result && BLOCKING_VERDICTS.includes(result.verdict);
  if (!blocked && !tooSmall) return null;
  const err = new Error('face-not-clear');
  err.reason = blocked ? result.verdict : Verdict.TOO_SMALL;
  err.note = blocked ? result.note : 'face too small in the photo';
  err.tip = blocked ? result.tip : '';
  return err;
}

const reviewText = (language, traits) =>
  'Image 1 is a photo of a real child. Image 2 is an illustrated book cover whose main character was painted ' +
  'to be this child. Compare the main character with the child and report only what you can clearly see. ' +
  'glasses: match when both wear glasses of the same kind, missing when the child wears glasses and the ' +
  'character does not, different when the character wears glasses the child does not or of another kind, ' +
  'none when neither wears any. ' +
  'headwear: match when the character wears the headwear the child wears in the photo' +
  (traits.headwear ? ' (' + traits.headwear + ')' : '') + ', missing when the child wears headwear and the ' +
  'character is bare-headed, different when the character wears other headwear, none when the child wears none. ' +
  'hair: match, different (another colour, length or texture) or unclear when the hair is hidden. ' +
  'skin: match, or different when the character\'s skin is clearly lighter or darker; unclear otherwise. ' +
  'head_too_big: true only when the character\'s head is clearly oversized for its body, wider than its ' +
  'shoulders or far bigger than the other characters\' heads. ' +
  'pasted: true only when the head looks like a photograph placed on a painted body instead of being painted ' +
  'in the cover\'s style. ' +
  'title_name: the first name written in the cover\'s title, exactly as spelled. ' +
  'notes: up to two other clear differences a parent would mind (for example missing freckles, wrong eye ' +
  'colour, missing gap teeth), each with label: two to four words in ' + language + ' naming the problem, and ' +
  'fix: one English sentence telling the illustrator what to correct. An empty list when there are none. ' +
  'Never comment on likeness in general.';

const seen = (...values) => ({ type: 'string', enum: values });

const REVIEW_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'cover_review',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['glasses', 'headwear', 'hair', 'skin', 'head_too_big', 'pasted', 'title_name', 'notes'],
      properties: {
        glasses: seen(Seen.MATCH, Seen.MISSING, Seen.DIFFERENT, Seen.NONE),
        headwear: seen(Seen.MATCH, Seen.MISSING, Seen.DIFFERENT, Seen.NONE),
        hair: seen(Seen.MATCH, Seen.DIFFERENT, Seen.UNCLEAR),
        skin: seen(Seen.MATCH, Seen.DIFFERENT, Seen.UNCLEAR),
        head_too_big: { type: 'boolean' },
        pasted: { type: 'boolean' },
        title_name: { type: 'string' },
        notes: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['label', 'fix'],
            properties: { label: { type: 'string' }, fix: { type: 'string' } }
          }
        }
      }
    }
  }
};

const MAX_NOTES = 2;
const MAX_NOTE_FIX_CHARS = 200;

// The model's answer as a review, every text cleaned and capped.
export function readReview(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const one = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
  return {
    glasses: one(r.glasses, [Seen.MATCH, Seen.MISSING, Seen.DIFFERENT, Seen.NONE], Seen.NONE),
    headwear: one(r.headwear, [Seen.MATCH, Seen.MISSING, Seen.DIFFERENT, Seen.NONE], Seen.NONE),
    hair: one(r.hair, [Seen.MATCH, Seen.DIFFERENT, Seen.UNCLEAR], Seen.UNCLEAR),
    skin: one(r.skin, [Seen.MATCH, Seen.DIFFERENT, Seen.UNCLEAR], Seen.UNCLEAR),
    headTooBig: r.head_too_big === true,
    pasted: r.pasted === true,
    titleName: phrase(r.title_name, 60),
    notes: (Array.isArray(r.notes) ? r.notes : [])
      .map((n) => ({ label: phrase(n && n.label, MAX_LABEL_CHARS + 10), fix: phrase(n && n.fix, MAX_NOTE_FIX_CHARS) }))
      .filter((n) => n.label && n.fix)
      .slice(0, MAX_NOTES)
  };
}

// How the finished cover compares with the photo (readReview), or null when
// it could not be checked. photo is the JPEG the generator got; coverUrl an
// https or data: URL of the cover; traits what checkFace read from the photo.
export async function reviewCover(photo, coverUrl, { fetchImpl = fetch, timeoutMs = REVIEW_TIMEOUT_MS, traits = NO_TRAITS, locale = 'en' } = {}) {
  if (!faceCheckConfigured() || !photo || !coverUrl) return null;
  try {
    return readReview(await ask(fetchImpl, {
      model: process.env.COVER_REVIEW_MODEL || DEFAULT_DESCRIBE_MODEL,
      images: [{ url: jpegUrl(photo), detail: 'low' }, { url: coverUrl, detail: 'high' }],
      text: reviewText(languageOf(locale), traits), schema: REVIEW_SCHEMA, maxTokens: 1200, timeoutMs
    }));
  } catch (err) {
    console.warn('[face-check] cover review failed:', (err && err.message) || err);
    return null;
  }
}
