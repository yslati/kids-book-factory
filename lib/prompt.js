// Cover-preview prompt. Image 1 is the book cover, image 2 the child's photo.

// How much of the hero is the real child and how much the cover's style, in percent.
export const STYLE_MIX = Object.freeze({ child: 70, style: 30 });
// The mix a "doesn't look like my child" fix asks for.
export const LIKENESS_FIX_MIX = Object.freeze({ child: 80, style: 20 });
// The mix a "looks like a pasted photo" fix asks for.
export const PASTED_FIX_MIX = Object.freeze({ child: 60, style: 40 });

// Used when a product has no `book.cover_preview_prompt` metafield of its own.
export const DEFAULT_PREVIEW_PROMPT =
  "You are editing the first image, a children's book cover. The second image is a " +
  "photo of a real child.\n\n" +
  "MAIN TASK - make THIS child the hero of the cover, painted as a character in the " +
  "cover's own art style, in the original hero's exact pose, head angle, gaze, " +
  "expression and outfit. Only the hero changes. Keep the child's exact skin tone " +
  "and face shape; lighter or darker skin or a more generic face is a failed cover. " +
  "The result must look like one finished illustration in which the child was " +
  "always the hero. No part of the child may look like a photo pasted onto the " +
  "artwork.\n\n" +
  "LIKENESS - the child's parents must instantly recognise their child. Keep what " +
  "makes this child unique: face shape and width, jawline and chin, cheek fullness, " +
  "eye shape, eye spacing and eye colour, eyebrow shape, nose shape, lip shape, " +
  "teeth, ears, skin tone, and every distinctive mark (freckles, dimples, moles, " +
  "birthmarks, glasses, gap teeth, braces). These stay the same from any angle and " +
  "with any expression.\n\n" +
  "EXPRESSION COMES FROM THE COVER, NEVER FROM THE PHOTO - the photo only tells you " +
  "WHO the child is. Give the child the hero's exact expression, whatever the photo " +
  "shows: a big smile or laugh where the hero smiles, even if the photo is neutral, " +
  "serious, sleepy, surprised or open-mouthed, and a determined, focused or tender " +
  "look where the hero has one. Paint it with the child's own mouth, cheeks, eyes " +
  "and eyebrows. Turn and tilt the head like the hero's head, with the eyes looking " +
  "the same way (down at a dish, up at a ribbon, across at a ball, or at the " +
  "viewer).\n\n" +
  "HAIR AND HEADWEAR - copy the child's real hair: the same length, shape, style, " +
  "parting, colour and texture, replacing the hero's hairstyle. If the hero wears a " +
  "helmet, hat, crown or hood, the child wears that same one, on their head in the " +
  "same place, and their hair shows only where it peeks out. Match the child's " +
  "gender: a boy if the photo is a boy, a girl if it is a girl.\n\n" +
  "STYLE - about " + STYLE_MIX.child + "% the real child and " + STYLE_MIX.style + "% the cover's animation style. Paint the " +
  "child with the cover's own rendering - the same technique, skin shading, level of " +
  "detail, lighting, rim light, colour grading and finish as the rest of the cover - " +
  "so they belong in the scene. The cover's style may only soften and stylise the " +
  "child's features slightly (for example a little larger, more expressive eyes or " +
  "smoother skin, if that is how the cover draws people, never a lighter or darker " +
  "skin).\n\n" +
  "EVERYONE ELSE STAYS - every other person on the cover (teammates, friends, the " +
  "crowd, adults) keeps their own original face, hair, skin tone, age, size, outfit " +
  "and number exactly as in the first image. Never give anyone else the child's " +
  "face, hair or age, and never fill the scene with copies of the child.\n\n" +
  "NEVER:\n" +
  "- paste or blend in a photographic face, or keep photo skin texture, photo " +
  "lighting or any of the photo's background\n" +
  "- turn the child into a generic or prettier character who no longer looks like " +
  "them\n" +
  "- make the child look younger or older than in the photo\n" +
  "- keep the photo's expression, head angle or eye direction: a blank or " +
  "open-mouthed face where the hero smiles is wrong\n" +
  "- take off the hero's helmet, hat or hood to show the hair\n" +
  "- blend the child with the hero's original face - that face must be entirely " +
  "gone\n\n" +
  "Keep everything else the same: the cover's art style, colours, background, scene, " +
  "composition, layout, and the hero's pose, outfit, headwear and props. Keep the " +
  "title and any other text in the same lettering and position, unless a name change " +
  "is requested below.";

// Higgsfield rejects longer prompts.
export const MAX_PROMPT_CHARS = 5000;

// Longest hero-pose line used, so the longest order plus a fix line still fits
// MAX_PROMPT_CHARS (see test/prompt.test.js). The longest line written is 156.
export const MAX_HERO_POSE_CHARS = 160;

// Puts the book's own hero-pose line (book.hero_pose) first. Generic pose rules
// lose to a strongly angled photo; naming this cover's head angle and gaze wins.
export function withHeroPose(prompt, pose) {
  const line = String(pose || '').replace(/\s+/g, ' ').trim().slice(0, MAX_HERO_POSE_CHARS);
  if (!line) return prompt;
  return 'THE HERO\'S HEAD ON THIS COVER - ' + line + ' Give the child exactly this head ' +
    'angle and gaze, whatever angle the photo shows.\n\n' + prompt;
}

// Head size and skin rules for prompts without a section of their own (custom stories).
export const HEAD_AND_SKIN =
  'HEAD SIZE AND SKIN - The photo may be framed close to the face, so the head can fill it; that says ' +
  'nothing about size. Give the child the natural proportions of a child of their age in the cover\'s style: the ' +
  'head, hair included, is narrower than the shoulders and never larger than the heads of other ' +
  'characters at the same distance; when unsure, paint it slightly smaller, never larger. It sits naturally ' +
  'on the neck and fits any helmet, hat or hood. Every bit of visible skin - neck, arms, hands, legs and ' +
  'knees - takes the child\'s own skin tone from the photo, exactly like the face, so face and body read ' +
  'as one child.';

// Put first in every cover prompt, whatever the book's own prompt says, since
// rules at the top win over the photo's close framing.
export const HEAD_SIZE_RULE =
  'HEAD SIZE (hard rule) - The child\'s head, hair and headwear included, fits inside the original ' +
  'hero\'s head outline, narrower than the shoulders; when unsure, smaller. The photo never sets its size.';

// The cover prompt sent to OpenAI, which has room for 32k characters.
export const OPENAI_PREVIEW_PROMPT = [
  'ROLE - You are an expert children\'s book illustrator and a specialist in preserving a real child\'s ' +
  'identity. You personalise an existing illustrated book cover with the real photograph of a customer\'s ' +
  'child. The result must look like the original, professionally designed cover, with its main character ' +
  'now accurately representing this child.',

  'INPUT IMAGES - Image 1 is the original book cover, the master design: illustration style, the hero\'s ' +
  'body and pose, head angle, gaze and expression, clothing and accessories, background, lighting, ' +
  'composition, camera angle, typography and colours. Image 2 is the photograph of the child: the identity ' +
  'reference only. It says WHO the child is, never how they stand, turn, look or smile.',

  'PRIMARY OBJECTIVE - Repaint the main character\'s head as the child in the photograph, drawn as a ' +
  'character of this cover\'s world: about ' + STYLE_MIX.child + '% the real child and ' + STYLE_MIX.style +
  '% the cover\'s own illustration style. The ' + STYLE_MIX.child + '% is identity: the shapes, proportions ' +
  'and colours that make this child who they are. The ' + STYLE_MIX.style + '% is rendering: the way this ' +
  'cover draws skin, eyes, hair, light and shading. The parents must recognise their child at once, and the ' +
  'head must look painted by the same artist as the rest of the cover.',

  'HEAD POSE AND EXPRESSION COME FROM THE COVER - The photo is usually taken straight on; that angle is ' +
  'wrong for the cover. Give the child the original hero\'s exact head turn, tilt and chin height, with the ' +
  'eyes looking exactly where the hero looks (at the reader, up at an object, across at a ball), and the ' +
  'hero\'s exact expression: a big smile or laugh where the hero smiles, even when the photo is neutral or ' +
  'serious, a focused or tender look where the hero has one. The head leans and turns with the body as the ' +
  'hero\'s does. Paint that pose and expression with the child\'s own features.',

  'LIKENESS - FACIAL IDENTITY (critical) - Preserve the child\'s face shape and proportions; skin tone and ' +
  'undertone; eye shape, size, spacing and colour; eyebrow shape, thickness and position; nose shape, ' +
  'bridge, width and nostrils; mouth shape, lip fullness and teeth (gaps, missing teeth, braces); cheek ' +
  'structure and fullness; chin and jawline; forehead; hairline; hair colour, texture, curl pattern, length ' +
  'and style; glasses, freckles, moles, dimples and any other distinctive mark; the child\'s real age; the ' +
  'relative position of every feature. Never replace them with generic cartoon features, and never change ' +
  'the child\'s ethnicity or complexion.',

  'ILLUSTRATION STYLE (' + STYLE_MIX.child + '/' + STYLE_MIX.style + ') - Render the child\'s face and hair ' +
  'the way this cover renders its people: the same skin shading and smoothness, the same way of drawing ' +
  'eyes, lashes, eyebrows, lips and teeth, the same hair rendering, rim light, colour grading and finish. ' +
  'That stylisation is wanted: clean simplified skin with no pores or photo grain, eyes a little larger and ' +
  'brighter when the cover draws eyes that way, soft rounded shapes. What it must not touch is the child\'s ' +
  'own geometry and colours: face shape, the shape, size and spacing of each feature, skin tone, eye colour ' +
  'and hair colour. Two ways to fail: a head that looks like a photograph placed on a painted body ' +
  '(photographic skin texture, photo lighting, a cut-out edge), and a generic, prettier or doll-like face ' +
  'that could be any child.',

  'HEAD SIZE, NECK AND BODY - The photo may be framed close to the face, so the head can fill it; that ' +
  'says nothing about size. The hero\'s body, shoulders, hands and outfit stay exactly as on the cover, and the ' +
  'new head, hair and headwear included, fits inside the outline of the original hero\'s head: the same ' +
  'height from chin to crown and the same width, never larger. Check it against the hero\'s shoulders and ' +
  'torso and against the other characters\' heads; if it looks big for the body, make it smaller. A younger ' +
  'child keeps their young face on the hero\'s head size, not a bigger head. A natural neck, consistent ' +
  'perspective and lighting. Every bit of visible skin - face, ears, neck, arms, hands, legs and knees - is ' +
  'the child\'s own skin tone, so face and body read as one child. Never an oversized or floating head, a ' +
  'disconnected neck, mismatched skin or an unnatural head angle.',

  'HAIR AND HEADWEAR - Use the child\'s real hair, replacing the hero\'s hairstyle, wherever the cover ' +
  'shows hair. If the hero wears a helmet, hat, crown or hood, keep it exactly where it is, fitting the ' +
  'child\'s head, with any chin strap fastened; show only the hair that would naturally peek out, never ' +
  'hair through or floating above it. Glasses the child wears in the photo always stay on. Match the ' +
  'child\'s gender: a boy if the photo is a boy, a girl if it is a girl.',

  'EVERYONE ELSE STAYS - Personalise only the main character. Teammates, friends, siblings, the crowd and ' +
  'adults keep their own faces, hair, skin, age, size, outfits and number exactly as on the cover; never ' +
  'give anyone else the child\'s face.',

  'THE COVER IS LOCKED - Do not change the background, environment, other characters, the hero\'s body ' +
  'pose, clothing, objects, decorations, lighting, colour palette, camera angle, composition or text, ' +
  'except the name and language changes requested below and the glasses or headwear the photo rules ask ' +
  'for. The result must be one cohesive, professional illustration: the same cover with a personalised ' +
  'hero, no extra text or watermark.',

  'FINAL CHECK - Before finishing, check that the parents would recognise their child at once (eyes, nose, ' +
  'mouth, teeth, cheeks, face shape, skin tone, hair, glasses); that the head is painted in the cover\'s ' +
  'style, not photographic; that it has the hero\'s turn, tilt, gaze and expression and fits inside the ' +
  'hero\'s head outline, narrower than the shoulders; that skin matches from face to hands; and that ' +
  'nothing else on the cover changed. If ' +
  'the likeness is weak, correct the shapes and proportions of the features rather than making the face ' +
  'more photographic.'
].join('\n\n');

// The prompt with the written description of the child's face before its LIKENESS section, or at the end.
export function withFaceDescription(prompt, description) {
  const text = String(description || '').replace(/\s+/g, ' ').trim();
  if (!text) return prompt;
  const block = 'THIS CHILD, AS THE PHOTO SHOWS THEM (identity only) - ' + text + ' These features say who ' +
    'the child is; they never change the hero\'s head turn, tilt, gaze, expression or pose.';
  const at = prompt.indexOf('LIKENESS - ');
  if (at < 0) return prompt + '\n\n' + block;
  return prompt.slice(0, at) + block + '\n\n' + prompt.slice(at);
}

// Where the hero comes from: an existing cover's hero, or a newly painted scene.
export const Scene = Object.freeze({ COVER: 'cover', NEW: 'new' });

// The prompt with the rules for what this photo shows (lib/face-check.js traits) put first.
export function withPhotoTraits(prompt, traits, { scene = Scene.COVER } = {}) {
  const t = traits || {};
  const lines = [];
  if (t.glasses) {
    lines.push('Glasses: the child wears ' + t.glasses + '. The hero wears the same glasses - same frame shape ' +
      'and colour, drawn in the cover\'s style, eyes visible behind the lenses. A cover without them is wrong.');
  }
  if (t.headwear) {
    lines.push('Headwear in the photo: ' + t.headwear + '. ' + (scene === Scene.COVER
      ? 'If the hero on the cover is bare-headed, the hero wears it too, drawn in the cover\'s style at a ' +
        'natural size and kept clear of the title; if the hero already has a helmet, hat, crown or hood, keep ' +
        'the hero\'s and leave the photo\'s out.'
      : 'The hero wears it too, drawn in the cover\'s style, unless the story gives them other headwear.'));
  }
  if (t.hair) {
    lines.push(t.hairHidden
      ? 'Hair: most of it is hidden in the photo; what shows is ' + t.hair + '. Wherever hair is visible, paint ' +
        'only hair that agrees with that - never another colour, and no long or full style the photo does not show.'
      : 'Hair: ' + t.hair + '. Keep exactly this colour, length, texture and style.');
  }
  if (t.skin) lines.push('Skin: ' + t.skin + '. Never lighter or darker.');
  if (t.marks && t.marks.length) lines.push('Also keep: ' + t.marks.join('; ') + '.');
  if (t.outfit) {
    lines.push('Outfit in the photo: ' + t.outfit + '. If the hero wears the same kind of outfit, it takes ' +
      'these colours and details (a number, a print), keeping its cut and any lettering from the cover; ' +
      'everyone else keeps theirs. Otherwise ignore this.');
  }
  if (!lines.length) return prompt;
  return 'FROM THE PHOTO, NEVER DROPPED - what this child really looks like. These rules win over the ' +
    'original hero\'s look:\n- ' + lines.join('\n- ') + '\n\n' + prompt;
}

// The head-size rule, the book's prompt, then this order's language, name and age.
// language is a lib/book-languages.js entry; childName and age may be empty.
export function buildPreviewPrompt(basePrompt, { language, childName, age }) {
  let prompt = HEAD_SIZE_RULE + '\n\n' + basePrompt;
  prompt += '\n\nBook language: ' + language.name + ' (' + language.code + '). ' +
    'Translate all visible cover text into this language while preserving the ' +
    'existing typography, layout, colours, and the child\'s name.';
  if (childName) {
    prompt += '\n\nPersonalise the cover: the child\'s first name is "' + childName +
      '". The hero\'s old name can appear more than once: in the title and also on ' +
      'the hero\'s cap, jersey or clothing, signs, banners, scoreboards and labels. ' +
      'Replace every one of them with "' + childName + '", each in its own font, size, ' +
      'colour, and position. No letter of the old name may remain anywhere; re-centre ' +
      'the new name in the space the old one used. Only the hero\'s name ' +
      'changes: other words on clothes, signs and banners, numbers and other names ' +
      'stay as they are. Change no other words beyond the translation.';
  }
  if (age) {
    prompt += '\n\nThe child is ' + age + ' years old. Paint a face of that age from the ' +
      'photo\'s features, not a generic child\'s.';
  }
  return prompt;
}

// The theme's note box allows this much.
export const MAX_FIX_NOTE_CHARS = 200;

// What a parent can ask to have fixed under a cover (theme: kb-my-book).
export const FixReason = Object.freeze({
  LIKENESS: 'likeness',
  STYLE: 'style',
  HEAD: 'head',
  HAIR: 'hair',
  SKIN: 'skin',
  HAIR_SKIN: 'hair_skin',
  GLASSES: 'glasses',
  HEADWEAR_ADD: 'headwear_add',
  HEADWEAR_REMOVE: 'headwear_remove',
  NAME: 'name',
  OTHER: 'other'
});

const hairLine = (t) => 'Hair: it was wrong. ' + (t.hair ? 'The child\'s hair is ' + t.hair + '. ' : '') +
  'Copy the photo\'s exact hair colour, length, texture and style.';
const skinLine = (t) => 'Skin: the tone was wrong. ' + (t.skin ? 'The child\'s skin is ' + t.skin + '. ' : '') +
  'Copy the photo\'s exact skin tone on the face and on every bit of visible skin.';

// label is what the requests sheet shows; line({ name, traits }) the correction asked of the model.
// touchUp reasons are corrected on the finished cover; the others need the cover painted again.
export const FIX_REASONS = {
  [FixReason.LIKENESS]: {
    label: 'Doesn\'t look like my child',
    touchUp: false,
    line: () => 'Likeness: it did not look like this child. Match the photo closely in face shape, cheeks and ' +
      'chin, eye shape and spacing, nose, mouth and smile, skin tone, hairline and hair texture, and age. Use ' +
      'about ' + LIKENESS_FIX_MIX.child + '% of the real child and ' + LIKENESS_FIX_MIX.style + '% of the ' +
      'cover\'s style, overriding the ratio below, and do not beautify or replace any feature. Pose, ' +
      'expression, outfit, background and text still come from the cover.'
  },
  [FixReason.STYLE]: {
    label: 'Looks like a pasted photo',
    touchUp: false,
    line: () => 'Style: the head looked like a pasted photograph. Repaint the whole head in the ' +
      'cover\'s own illustration style, with the same shading, eye rendering and finish as the other ' +
      'characters, keeping the child\'s features. Use about ' + PASTED_FIX_MIX.child + '% of the real child ' +
      'and ' + PASTED_FIX_MIX.style + '% of the cover\'s style, overriding the ratio below.'
  },
  [FixReason.HEAD]: {
    label: 'Head is too big',
    touchUp: false,
    line: () => 'Head size: the head was too big for the body. Paint it clearly smaller: no larger than the ' +
      'original hero\'s head, narrower than the shoulders and in proportion with the torso and hands. Set it ' +
      'on the neck at the hero\'s exact angle and gaze, ignoring the photo\'s angle.'
  },
  [FixReason.HAIR]: { label: 'Hair is wrong', touchUp: true, line: ({ traits }) => hairLine(traits) },
  [FixReason.SKIN]: { label: 'Skin tone is wrong', touchUp: true, line: ({ traits }) => skinLine(traits) },
  [FixReason.HAIR_SKIN]: {
    label: 'Hair or skin colour is wrong',
    touchUp: true,
    line: ({ traits }) => hairLine(traits) + ' ' + skinLine(traits)
  },
  [FixReason.GLASSES]: {
    label: 'Glasses are missing or wrong',
    touchUp: true,
    line: ({ traits }) => (traits.glasses
      ? 'Glasses: the hero must wear the child\'s ' + traits.glasses + ', with the same frame shape and colour ' +
        'and the eyes visible behind the lenses.'
      : 'Glasses: make them match the photo exactly. The hero wears the child\'s own glasses if the child ' +
        'wears any, and none if the child wears none.')
  },
  [FixReason.HEADWEAR_ADD]: {
    label: 'Headwear from the photo is missing',
    touchUp: true,
    line: ({ traits }) => 'Headwear: the hero must wear the child\'s ' + (traits.headwear || 'headwear from the photo') +
      ', drawn in the cover\'s style at a natural size.'
  },
  [FixReason.HEADWEAR_REMOVE]: {
    label: 'Remove the headwear',
    touchUp: true,
    line: ({ traits }) => 'Headwear: take the ' + (traits.headwear || 'headwear') + ' off the hero. Paint the hero ' +
      'bare-headed, with hair that agrees with what the photo shows' + (traits.hair ? ' (' + traits.hair + ')' : '') + '.'
  },
  [FixReason.NAME]: {
    label: 'Name is wrong',
    touchUp: true,
    line: ({ name }) => 'Name: write "' + name + '" exactly, letter for letter, with no apostrophe or extra ' +
      'letters, everywhere the hero\'s name appears.'
  },
  [FixReason.OTHER]: {
    label: 'Something else',
    touchUp: false,
    line: () => 'Look again at the photo and fix what does not match it.'
  }
};

// The known reasons among those asked for, without repeats, in the order given.
export function knownReasons(reasons) {
  const list = Array.isArray(reasons) ? reasons : [reasons];
  return [...new Set(list.map(String))].filter((r) => Object.prototype.hasOwnProperty.call(FIX_REASONS, r));
}

// true when every correction asked for can be made on the finished cover.
// fix is { reasons, note, extra }, extra being the cover review's own notes ({ label, fix }).
export function isTouchUp(fix) {
  const reasons = knownReasons(fix.reasons);
  if (!reasons.length && !(fix.extra || []).length) return false;
  return reasons.every((r) => FIX_REASONS[r].touchUp);
}

// The parent's own words, safe to quote.
function quoted(note, max) {
  return String(note || '').replace(/["\s]+/g, ' ').trim().slice(0, Math.max(0, max));
}

function firstSentence(text) {
  const end = text.indexOf('. ');
  return end < 0 ? text : text.slice(0, end + 1);
}

// The corrections as a list, shortened to fit room characters: whole lines,
// then first sentences only, then fewer lines, then the first one cut short.
function corrections(fix, ctx, room) {
  const context = { name: (ctx && ctx.name) || 'the child', traits: (ctx && ctx.traits) || {} };
  let lines = knownReasons(fix.reasons).map((r) => FIX_REASONS[r].line(context))
    .concat((fix.extra || []).map((e) => String(e.fix || '').trim()).filter(Boolean).map((t) => (/[.!?]$/.test(t) ? t : t + '.')));
  const size = (list) => list.reduce((n, line) => n + line.length + 3, 0);
  if (size(lines) > room) lines = lines.map(firstSentence);
  while (lines.length > 1 && size(lines) > room) lines.pop();
  if (size(lines) > room) lines = [lines[0].slice(0, Math.max(0, room - 3))];
  const words = quoted(fix.note, Math.min(MAX_FIX_NOTE_CHARS, room - size(lines) - 24));
  if (words) lines.push('The parent adds: "' + words + '".');
  return lines.map((line) => '- ' + line).join('\n');
}

const FIX_HEADER = 'FIX - the parent reported these problems with the last cover; correct each one:\n';

// The prompt with the parent's reported problems put first. ctx is { name, traits };
// maxChars the provider's prompt limit, which the corrections are shortened to fit.
export function withFix(prompt, fix, ctx, { maxChars = MAX_PROMPT_CHARS } = {}) {
  if (!fix || (!knownReasons(fix.reasons).length && !(fix.extra || []).length)) return prompt;
  const list = corrections(fix, ctx, maxChars - prompt.length - FIX_HEADER.length - 2);
  return FIX_HEADER + list + '\n\n' + prompt;
}

// The prompt for correcting a finished cover in place. Image 1 is that cover, image 2 the child's photo.
export function touchUpPrompt(fix, ctx, { maxChars = MAX_PROMPT_CHARS } = {}) {
  const intro = 'You are correcting a finished children\'s book cover. Image 1 is the cover; image 2 is the ' +
    'photo of the real child its hero was painted from. Make ONLY the corrections listed below, painted in ' +
    'the cover\'s own illustration style, never photographic. Everything else stays exactly as in image 1: ' +
    'the hero\'s face, expression, pose, body and outfit, every other character, the background, the title ' +
    'and all other text, the colours and the composition. The small "Book to kids" logo at the bottom ' +
    'centre stays exactly where and how it is. No extra text or watermark.\n\nCORRECTIONS:\n';
  return intro + corrections(fix, ctx, maxChars - intro.length);
}
