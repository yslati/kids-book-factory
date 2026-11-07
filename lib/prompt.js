// Cover-preview prompt. Image 1 is the book cover, image 2 the child's photo.

// Used when a product has no `book.cover_preview_prompt` metafield of its own.
export const DEFAULT_PREVIEW_PROMPT =
  "You are editing the first image, a children's book cover. The second image is a " +
  "photo of a real child.\n\n" +
  "MAIN TASK - make THIS child the hero of the cover, painted as a character in the " +
  "cover's own art style, in the original hero's exact pose, head angle, gaze, " +
  "expression and outfit. Only the hero changes. The result must look like one " +
  "finished illustration in which the child was always the hero. No part of the " +
  "child may look like a photo pasted onto the artwork.\n\n" +
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
  "smoother skin, if that is how the cover draws people). Picture this exact child " +
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
  "- change the child's skin tone, eye colour or hair colour\n" +
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
    line: () => 'FIX: the last cover did not look like this child. Copy the face from the photo much ' +
      'more closely: face shape, eyes, nose, mouth and smile.'
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

// Puts the parent's reported problem first in the prompt. The parent's own
// words (note) are cut to whatever room MAX_PROMPT_CHARS leaves.
export function withFix(prompt, { reason, note }, childName) {
  const fix = FIX_REASONS[reason];
  if (!fix) return prompt;
  let line = fix.line(childName || 'the child');
  // 22 = the blank line after it plus ' The parent adds: "' and the closing quote.
  const room = Math.min(MAX_FIX_NOTE_CHARS, MAX_PROMPT_CHARS - prompt.length - line.length - 22);
  const words = String(note || '').replace(/["\s]+/g, ' ').trim().slice(0, Math.max(0, room));
  if (words) line += (reason === 'other' ? ': "' : ' The parent adds: "') + words + '"';
  else if (reason === 'other') line += '. Look again and fix what does not match the photo.';
  return line + '\n\n' + prompt;
}
