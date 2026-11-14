// Cover-preview prompt. Image 1 is the book cover, image 2 the child's photo.

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
  "viewer). Keep it natural, never an exaggerated cartoon face.\n\n" +
  "HAIR AND HEADWEAR - copy the child's real hair: the same length, shape, style, " +
  "parting, colour and texture, replacing the hero's hairstyle. If the hero wears a " +
  "helmet, hat, crown or hood, the child wears that same one, on their head in the " +
  "same place, and their hair shows only where it peeks out. Match the child's " +
  "gender: a boy if the photo is a boy, a girl if it is a girl.\n\n" +
  "STYLE - about 75% the real child and 25% the cover's animation style. Paint the " +
  "child with the cover's own rendering - the same technique, skin shading, level of " +
  "detail, lighting, rim light, colour grading and finish as the rest of the cover - " +
  "so they belong in the scene. The cover's style may only soften and stylise the " +
  "child's features slightly (for example a little larger, more expressive eyes or " +
  "smoother skin, if that is how the cover draws people, never a lighter or darker " +
  "skin). Picture this exact child " +
  "as the hero of this animated film.\n\n" +
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

// Close-up photos (cropped to the face, or portraits) led to heads painted
// bigger than the hero's, and to faces in the child's skin tone on arms and
// legs left in the hero's.
export const HEAD_AND_SKIN =
  'HEAD SIZE AND SKIN - The photo is cropped close to the face, so the head fills it; that says nothing ' +
  'about size. Keep the hero\'s head exactly as big as on the cover and keep the cover\'s head-to-body ' +
  'proportions: the new head is no larger than the original hero\'s, sits naturally on the neck and fits ' +
  'the helmet, hat or hood the hero wears. Every bit of the hero\'s visible skin - neck, arms, hands, legs ' +
  'and knees - takes the child\'s own skin tone from the photo, exactly like the face, so face and body ' +
  'read as one child.';

// The cover prompt sent to OpenAI, which takes 32k characters: the
// structure BookToKids' own GPT prompt uses, plus what the tests of
// 2026-11-14 taught (head turn, tilt, gaze and expression from the cover;
// names everywhere; a smile even from a neutral photo). Higgsfield and fal,
// limited to 5,000, keep DEFAULT_PREVIEW_PROMPT. The face description goes
// in just before the LIKENESS section (withFaceDescription).
export const OPENAI_PREVIEW_PROMPT = [
  'ROLE - You are an expert children\'s book illustrator and a specialist in preserving a real child\'s ' +
  'identity. You personalise an existing illustrated book cover with the real photograph of a customer\'s ' +
  'child. The result must look like the original, professionally designed cover, with its main character ' +
  'now accurately representing this child.',

  'INPUT IMAGES - Image 1 is the original book cover, the master design: illustration style, the hero\'s ' +
  'body and pose, head angle, gaze and expression, clothing and accessories, background, lighting, ' +
  'composition, camera angle, typography and colours. Image 2 is the photograph of the child: the identity ' +
  'reference only. It says WHO the child is, never how they stand, turn, look or smile.',

  'PRIMARY OBJECTIVE - Replace the main character\'s face and hair with an accurate, lightly illustrated ' +
  'portrait of the child in the photograph: about 90% the real child\'s features and 10% soft children\'s ' +
  'book illustration. The parents must recognise their child at once. Likeness comes before making the ' +
  'character beautiful, symmetrical or cartoon-like.',

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

  'ILLUSTRATION STYLE (90/10) - Only subtle stylisation: slightly smoother skin, gentle shading, soft ' +
  'integration with the cover\'s rendering, lighting and colour grading. Avoid oversized cartoon eyes, ' +
  'exaggerated cheeks, enlarged smiles, doll-like or generic animated-film faces, plastic skin, excess ' +
  'symmetry and adult proportions. The 10% is never permission to redesign the face. The child must look ' +
  'naturally illustrated, never like a photo pasted onto the artwork.',

  'HEAD, NECK AND BODY - The photo is cropped close to the face, so the head fills it; that says nothing ' +
  'about size. Keep the hero\'s head exactly as big as on the cover, with the cover\'s head-to-body ' +
  'proportions, a natural neck, consistent perspective and lighting. Every bit of visible skin - face, ears, ' +
  'neck, arms, hands, legs and knees - is the child\'s own skin tone, so face and body read as one child. ' +
  'Never an oversized or floating head, a disconnected neck, mismatched skin or an unnatural head angle.',

  'HAIR AND HEADWEAR - Use the child\'s real hair, replacing the hero\'s hairstyle, wherever the cover ' +
  'shows hair. If the hero wears a helmet, hat, crown or hood, keep it exactly where it is, fitting the ' +
  'child\'s head, with any chin strap fastened; show only the hair that would naturally peek out, never ' +
  'hair through or floating above it. Match the child\'s gender: a boy if the photo is a boy, a girl if ' +
  'it is a girl.',

  'EVERYONE ELSE STAYS - Personalise only the main character. Teammates, friends, siblings, the crowd and ' +
  'adults keep their own faces, hair, skin, age, size, outfits and number exactly as on the cover; never ' +
  'give anyone else the child\'s face.',

  'THE COVER IS LOCKED - Do not change the background, environment, other characters, the hero\'s body ' +
  'pose, clothing, accessories, objects, decorations, lighting, colour palette, camera angle, composition ' +
  'or text, except the name and language changes requested below. The result must be one cohesive, ' +
  'professional illustration: the same cover with a personalised hero, no extra text or watermark.',

  'FINAL CHECK - Before finishing, check that the parents would recognise their child at once (eyes, nose, ' +
  'mouth, teeth, cheeks, face shape, skin tone, hair); that the head has the hero\'s turn, tilt, gaze and ' +
  'expression and the hero\'s size; that skin matches from face to hands; and that nothing else on the ' +
  'cover changed. If the likeness is weak, fix the likeness rather than adding style.'
].join('\n\n');

// The prompt with a written description of the child's face
// (lib/face-check.js) put just before the LIKENESS section, or at the end of
// a prompt without one (custom stories). Only for providers with room for it.
export function withFaceDescription(prompt, description) {
  const text = String(description || '').replace(/\s+/g, ' ').trim();
  if (!text) return prompt;
  const block = 'THIS CHILD, AS THE PHOTO SHOWS THEM (identity only) - ' + text + ' These features say who ' +
    'the child is; they never change the hero\'s head turn, tilt, gaze, expression or pose.';
  const at = prompt.indexOf('LIKENESS - ');
  if (at < 0) return prompt + '\n\n' + block;
  return prompt.slice(0, at) + block + '\n\n' + prompt.slice(at);
}

// The book's prompt plus this order's language, name and age.
// language is a lib/book-languages.js entry; childName and age may be empty.
export function buildPreviewPrompt(basePrompt, { language, childName, age }) {
  let prompt = basePrompt;
  prompt += '\n\nBook language: ' + language.name + ' (' + language.code + '). ' +
    'Translate all visible cover text into this language while preserving the ' +
    'existing typography, layout, colours, and the child\'s name.';
  if (childName) {
    // Models tend to keep the placeholder's letter count ("MASSON" -> "IJAMES"),
    // and to change only the title while the old name stays on caps and jerseys.
    prompt += '\n\nPersonalise the cover: the child\'s first name is "' + childName +
      '". The hero\'s old name can appear more than once: in the title and also on ' +
      'the hero\'s cap, jersey or clothing, signs, banners, scoreboards and labels. ' +
      'Replace every one of them with "' + childName + '", each in its own font, size, ' +
      'colour, and position. No letter of the old name may remain anywhere; re-centre ' +
      'the new name in the space the old one used. Team names, numbers and other ' +
      'characters\' names stay as they are. Apart from the requested language ' +
      'translation, do not change any other words or letters.';
  }
  if (age) {
    prompt += '\n\nThe child is ' + age + ' years old. Use this only to set the ' +
      'character\'s body proportions and height; the facial features still come from ' +
      'the photo, not from a generic child of that age.';
  }
  return prompt;
}

// The theme's note box allows this much.
export const MAX_FIX_NOTE_CHARS = 200;

// What a parent can report under a cover (theme: kb-my-book). label is what
// the requests sheet shows; line(name) is put first in the free retry's prompt.
export const FIX_REASONS = {
  likeness: {
    label: 'Doesn\'t look like my child',
    // Sentences in priority order: withFix drops the last ones when the
    // provider's prompt limit leaves no room.
    line: () => 'FIX: the last cover did not look like this child. Match the photo closely in face ' +
      'shape, cheeks and chin, eye shape and spacing, nose, mouth and smile, skin tone, hairline and ' +
      'hair texture, and age. This time keep about 90% of the real child and 10% of the cover\'s ' +
      'style, overriding the ratio below; reduce the stylisation if needed and do not beautify or ' +
      'replace any feature. Pose, expression, outfit, background and text still come from the cover.'
  },
  name: {
    label: 'Name is wrong',
    line: (name) => 'FIX: the name was wrong last time. Write "' + name + '" exactly, letter for letter, ' +
      'with no apostrophe or extra letters.'
  },
  head: {
    label: 'Head or face looks off',
    line: () => 'FIX: the head did not fit the body last time. Set it on the hero\'s neck at the ' +
      'hero\'s exact angle and gaze, ignoring the photo\'s angle.'
  },
  hair_skin: {
    label: 'Hair or skin colour is wrong',
    line: () => 'FIX: the hair or skin was wrong last time. Copy the photo\'s exact hair colour, length ' +
      'and texture and its exact skin tone.'
  },
  other: {
    label: 'Something else',
    line: () => 'FIX: the parent says the last cover was wrong'
  }
};

const LOOK_AGAIN = '. Look again and fix what does not match the photo.';

// The longest start of text, cut at a sentence end, within max characters;
// the first sentence always survives.
function wholeSentences(text, max) {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf('. ', max - 1);
  return cut > 0 ? text.slice(0, cut + 1) : text.slice(0, text.indexOf('. ') + 1);
}

// Puts the parent's reported problem first in the prompt. maxChars is the
// provider's prompt limit: the fix line loses its last sentences, and then
// the parent's own words (note), to fit under it.
export function withFix(prompt, { reason, note }, childName, { maxChars = MAX_PROMPT_CHARS } = {}) {
  const fix = FIX_REASONS[reason];
  if (!fix) return prompt;
  let line = wholeSentences(fix.line(childName || 'the child'), maxChars - prompt.length - 2);
  // 22 = the blank line after it plus ' The parent adds: "' and the closing quote.
  const room = Math.min(MAX_FIX_NOTE_CHARS, maxChars - prompt.length - line.length - 22 - LOOK_AGAIN.length);
  const words = String(note || '').replace(/["\s]+/g, ' ').trim().slice(0, Math.max(0, room));
  if (words) line += (reason === 'other' ? ': "' : ' The parent adds: "') + words + '"';
  // Parents' notes are short, so a note alone still gets the general check.
  if (reason === 'other') line += LOOK_AGAIN;
  return line + '\n\n' + prompt;
}
