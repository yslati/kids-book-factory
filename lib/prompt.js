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

// The book's prompt plus this order's language, name and age.
// language is a lib/book-languages.js entry; childName and age may be empty.
export function buildPreviewPrompt(basePrompt, { language, childName, age }) {
  let prompt = basePrompt;
  prompt += '\n\nBook language: ' + language.name + ' (' + language.code + '). ' +
    'Translate all visible cover text into this language while preserving the ' +
    'existing typography, layout, colours, and the child\'s name.';
  if (childName) {
    // Models tend to keep the placeholder's letter count ("MASSON" -> "IJAMES").
    prompt += '\n\nPersonalise the cover: the child\'s first name is "' + childName +
      '". If the title shows a character or placeholder name, replace the whole name ' +
      'with "' + childName + '" in the same font, size, colour, and position. No letter ' +
      'of the old name may remain; re-centre the new name in the space the old one ' +
      'used. Apart from the requested language translation, do not change any other ' +
      'words or letters.';
  }
  if (age) {
    prompt += '\n\nThe child is ' + age + ' years old. Use this only to set the ' +
      'character\'s body proportions and height; the facial features still come from ' +
      'the photo, not from a generic child of that age.';
  }
  return prompt;
}
