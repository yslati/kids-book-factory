// The cover-preview prompt and the per-order lines appended to it.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PREVIEW_PROMPT, FIX_REASONS, FixReason, HEAD_AND_SKIN, LIKENESS_FIX_MIX, MAX_FIX_NOTE_CHARS, MAX_HERO_POSE_CHARS,
  OPENAI_PREVIEW_PROMPT, PASTED_FIX_MIX, STYLE_MIX, Scene, buildPreviewPrompt, isTouchUp, knownReasons, touchUpPrompt,
  withFaceDescription, withFix, withHeroPose, withPhotoTraits
} from '../lib/prompt.js';
import { BOOK_LANGUAGES, resolveBookLanguage } from '../lib/book-languages.js';

// Higgsfield's Marketing Studio endpoints reject longer prompts.
const PROVIDER_PROMPT_LIMIT = 5000;

const TRAITS = {
  description: '', glasses: 'black rectangular glasses', headwear: 'tall black chef hat', headwearLabel: 'chef hat',
  hair: 'short light blond hair', hairHidden: true, skin: 'fair skin with a pink undertone', marks: ['gap between the front teeth']
};

test('both prompts ask for 70% real child, 30% cover style', () => {
  assert.deepEqual(STYLE_MIX, { child: 70, style: 30 });
  assert.match(DEFAULT_PREVIEW_PROMPT, /70% the real child and 30% the cover's animation style/);
  assert.match(OPENAI_PREVIEW_PROMPT, /about 70% the real child and 30% the cover's own illustration style/);
  assert.match(OPENAI_PREVIEW_PROMPT, /ILLUSTRATION STYLE \(70\/30\)/);
  for (const prompt of [DEFAULT_PREVIEW_PROMPT, OPENAI_PREVIEW_PROMPT]) assert.doesNotMatch(prompt, /90%|75%|10%/);
});

test('the default prompt names skin tone and face shape in its first lines', () => {
  const mainTask = DEFAULT_PREVIEW_PROMPT.split('\n\n')[1];
  assert.match(mainTask, /^MAIN TASK/);
  assert.match(mainTask, /Keep the child's exact skin tone and face shape/);
  assert.match(DEFAULT_PREVIEW_PROMPT, /never a lighter or darker skin/);
});

test('a likeness fix lists the features to match and moves the ratio toward the photo', () => {
  const line = FIX_REASONS.likeness.line({ name: 'Jack', traits: {} });
  for (const feature of ['face shape', 'eye shape and spacing', 'nose', 'skin tone', 'hairline and hair texture', 'age']) {
    assert.ok(line.includes(feature), feature);
  }
  assert.ok(LIKENESS_FIX_MIX.child > STYLE_MIX.child);
  assert.match(line, /80% of the real child and 20%/);
  assert.match(line, /overriding the ratio below/);
  assert.match(line, /Pose, expression, outfit, background and text still come from the cover/);
});

test('a pasted-photo fix moves the ratio toward the cover\'s style', () => {
  assert.ok(PASTED_FIX_MIX.style > STYLE_MIX.style);
  assert.match(FIX_REASONS.style.line({ name: '', traits: {} }), /60% of the real child and 40% of the cover's style/);
});

test('corrections are shortened, then dropped from the end, when the provider limit is tight', () => {
  const prompt = 'p'.repeat(100);
  const fix = { reasons: ['likeness', 'head'], note: 'his nose is wider' };
  const ctx = { name: 'Jack', traits: {} };
  const roomy = withFix(prompt, fix, ctx, { maxChars: 32000 });
  assert.ok(roomy.startsWith('FIX - the parent reported these problems with the last cover;'));
  assert.ok(roomy.includes('- ' + FIX_REASONS.likeness.line(ctx) + '\n- ' + FIX_REASONS.head.line(ctx) + '\n- The parent adds: "his nose is wider".'));
  assert.ok(roomy.endsWith('\n\n' + prompt));
  // First sentences only once the whole lines don't fit.
  const tight = withFix(prompt, fix, ctx, { maxChars: 420 });
  assert.ok(tight.length <= 420, String(tight.length));
  assert.ok(tight.includes('- Likeness: it did not look like this child.\n- Head size: the head was too big for the body.'));
  assert.doesNotMatch(tight, /Match the photo closely/);
  // With room for one, the first correction goes out alone.
  const one = withFix(prompt, fix, ctx, { maxChars: 240 });
  assert.ok(one.length <= 240, String(one.length));
  assert.ok(one.includes('- Likeness: it did not look like this child.'));
  assert.doesNotMatch(one, /Head size/);
});

test('the default prompt takes pose and expression from the cover, not the photo', () => {
  assert.match(DEFAULT_PREVIEW_PROMPT, /in the original hero's exact pose, head angle, gaze, expression and outfit/);
  assert.match(DEFAULT_PREVIEW_PROMPT, /EXPRESSION COMES FROM THE COVER, NEVER FROM THE PHOTO/);
  assert.match(DEFAULT_PREVIEW_PROMPT, /even if the photo is neutral, serious, sleepy, surprised or open-mouthed/);
  assert.doesNotMatch(DEFAULT_PREVIEW_PROMPT, /which teeth show/);
});

test('the default prompt keeps the hero\'s headwear and everyone else\'s faces', () => {
  assert.match(DEFAULT_PREVIEW_PROMPT, /If the hero wears a helmet, hat, crown or hood, the child wears that same one/);
  assert.match(DEFAULT_PREVIEW_PROMPT, /Never give anyone else the child's face, hair or age/);
});

test('appends the language, the name with its no-leftover-letters rule, and the age', () => {
  const prompt = buildPreviewPrompt('BASE', {
    language: resolveBookLanguage('fr'),
    childName: 'James',
    age: '7'
  });
  assert.ok(prompt.startsWith('BASE\n\n'));
  assert.match(prompt, /Book language: French \(fr\)\./);
  assert.match(prompt, /the child's first name is "James"/);
  assert.match(prompt, /Replace every one of them with "James"/);
  assert.match(prompt, /cap, jersey or clothing, signs, banners, scoreboards and labels/);
  assert.match(prompt, /No letter of the old name may remain anywhere/);
  assert.match(prompt, /The child is 7 years old\./);
});

test('leaves out the name and age lines when they are empty', () => {
  const prompt = buildPreviewPrompt('BASE', { language: resolveBookLanguage('en'), childName: '', age: '' });
  assert.match(prompt, /Book language: English \(en\)\./);
  assert.doesNotMatch(prompt, /first name/);
  assert.doesNotMatch(prompt, /years old/);
});

test('the longest default prompt an order can produce fits the provider limit', () => {
  const longestLanguage = Object.keys(BOOK_LANGUAGES)
    .map(resolveBookLanguage)
    .sort((a, b) => b.name.length - a.name.length)[0];
  // api/preview.js caps names at 40 characters and ages at 18.
  const prompt = buildPreviewPrompt(withHeroPose(DEFAULT_PREVIEW_PROMPT, 'x'.repeat(MAX_HERO_POSE_CHARS + 50)), {
    language: longestLanguage,
    childName: 'x'.repeat(40),
    age: '18'
  });
  assert.ok(prompt.length <= PROVIDER_PROMPT_LIMIT, `prompt is ${prompt.length} characters`);
  // A free fix adds its corrections on top, however many and with or without the parent's words.
  const ctx = { name: 'x'.repeat(40), traits: TRAITS };
  const every = Object.keys(FIX_REASONS);
  for (const reasons of [...every.map((r) => [r]), every]) {
    for (const note of ['', 'n'.repeat(MAX_FIX_NOTE_CHARS)]) {
      const fixed = withFix(prompt, { reasons, note }, ctx);
      assert.ok(fixed.length <= PROVIDER_PROMPT_LIMIT, `${reasons} fix is ${fixed.length} characters`);
      assert.ok(touchUpPrompt({ reasons, note }, ctx).length <= PROVIDER_PROMPT_LIMIT);
    }
  }
});

test('a free fix puts the reported problems first', () => {
  const ctx = { name: 'Jack', traits: TRAITS };
  assert.equal(withFix('BASE', { reasons: ['name'], note: '' }, ctx),
    'FIX - the parent reported these problems with the last cover; correct each one:\n' +
    '- Name: write "Jack" exactly, letter for letter, with no apostrophe or extra letters, everywhere the hero\'s name appears.\n\nBASE');
  // The photo's own details go into the correction.
  assert.match(withFix('BASE', { reasons: ['glasses', 'hair'], note: 'his hair is "light"\nblond' }, ctx),
    /- Glasses: the hero must wear the child's black rectangular glasses.*\n- Hair: it was wrong\. The child's hair is short light blond hair\..*\n- The parent adds: "his hair is light blond"\.\n\nBASE$/);
  assert.match(withFix('BASE', { reasons: ['other'], note: 'the dog is missing' }, ctx),
    /- Look again at the photo and fix what does not match it\.\n- The parent adds: "the dog is missing"\.\n\nBASE$/);
  // The older single reason still works; unknown ones are ignored.
  assert.match(withFix('BASE', { reasons: 'hair_skin' }, ctx), /- Hair: it was wrong.*Skin: the tone was wrong/);
  assert.equal(withFix('BASE', { reasons: ['nope'] }, ctx), 'BASE');
  assert.deepEqual(knownReasons(['head', 'nope', 'head', 'name']), ['head', 'name']);
  // The cover review's own notes are corrections too.
  assert.match(withFix('BASE', { reasons: [], extra: [{ label: 'Freckles', fix: 'Add the freckles across the nose' }] }, ctx),
    /- Add the freckles across the nose\.\n\nBASE$/);
});

test('small corrections are made on the finished cover, the rest paint it again', () => {
  assert.equal(isTouchUp({ reasons: [FixReason.GLASSES, FixReason.NAME, FixReason.HEADWEAR_ADD] }), true);
  assert.equal(isTouchUp({ reasons: [FixReason.HAIR, FixReason.SKIN] }), true);
  assert.equal(isTouchUp({ reasons: [], extra: [{ label: 'x', fix: 'y' }] }), true);
  for (const reason of [FixReason.LIKENESS, FixReason.STYLE, FixReason.HEAD, FixReason.OTHER]) {
    assert.equal(isTouchUp({ reasons: [FixReason.GLASSES, reason] }), false, reason);
  }
  assert.equal(isTouchUp({ reasons: [] }), false);
  const prompt = touchUpPrompt({ reasons: ['glasses', 'headwear_remove'], note: '' }, { name: 'Nolan', traits: TRAITS });
  assert.match(prompt, /^You are correcting a finished children's book cover\. Image 1 is the cover/);
  assert.match(prompt, /Make ONLY the corrections listed below/);
  assert.match(prompt, /CORRECTIONS:\n- Glasses: the hero must wear the child's black rectangular glasses/);
  assert.match(prompt, /- Headwear: take the tall black chef hat off the hero\. Paint the hero bare-headed, with hair that agrees with what the photo shows \(short light blond hair\)\./);
});

test('what the photo shows goes first, as rules that win over the hero\'s look', () => {
  const out = withPhotoTraits('BASE', TRAITS);
  assert.ok(out.startsWith('FROM THE PHOTO, NEVER DROPPED'));
  assert.ok(out.endsWith('\n\nBASE'));
  assert.match(out, /- Glasses: the child wears black rectangular glasses\. The hero wears the same glasses/);
  assert.match(out, /- Headwear in the photo: tall black chef hat\. If the hero on the cover is bare-headed, the hero wears it too/);
  assert.match(out, /keep the hero's and leave the photo's out/);
  assert.match(out, /- Hair: most of it is hidden in the photo; what shows is short light blond hair\./);
  assert.match(out, /- Skin: fair skin with a pink undertone\. Never lighter or darker\./);
  assert.match(out, /- Also keep: gap between the front teeth\./);
  // Visible hair is copied; a new scene has no hero headwear to defer to.
  assert.match(withPhotoTraits('BASE', { hair: 'long brown curls' }), /- Hair: long brown curls\. Keep exactly this colour/);
  assert.match(withPhotoTraits('BASE', TRAITS, { scene: Scene.NEW }), /unless the story gives them other headwear/);
  // Nothing to say, nothing added.
  assert.equal(withPhotoTraits('BASE', { glasses: '', headwear: '', hair: '', skin: '', marks: [] }), 'BASE');
  assert.equal(withPhotoTraits('BASE', null), 'BASE');
});

test('puts the book\'s hero pose first and caps its length', () => {
  const prompt = withHeroPose('BASE', '  The hero looks\n straight at the reader.  ');
  assert.ok(prompt.startsWith('THE HERO\'S HEAD ON THIS COVER - The hero looks straight at the reader. '));
  assert.ok(prompt.endsWith('\n\nBASE'));
  const long = withHeroPose('BASE', 'q'.repeat(MAX_HERO_POSE_CHARS + 50));
  assert.equal(long.split('q').length - 1, MAX_HERO_POSE_CHARS);
});

test('leaves the prompt alone when the book has no hero pose', () => {
  assert.equal(withHeroPose('BASE', ''), 'BASE');
  assert.equal(withHeroPose('BASE', null), 'BASE');
});

test('the face description goes just before LIKENESS, or at the end without it', () => {
  const out = withFaceDescription('MAIN TASK - x\n\nLIKENESS - y', 'Oval face,\n  gap teeth.');
  assert.ok(out.startsWith('MAIN TASK - x\n\nTHIS CHILD, AS THE PHOTO SHOWS THEM (identity only) - Oval face, gap teeth. '));
  assert.ok(out.endsWith('pose.\n\nLIKENESS - y'));
  assert.ok(withFaceDescription('CUSTOM', 'Round face.').startsWith('CUSTOM\n\nTHIS CHILD'));
  assert.equal(withFaceDescription('CUSTOM', ''), 'CUSTOM');
  assert.match(HEAD_AND_SKIN, /narrower than the shoulders/);
});

test('the OpenAI prompt carries pose, identity, head and name-safe sections', () => {
  for (const section of ['HEAD POSE AND EXPRESSION COME FROM THE COVER', 'LIKENESS - FACIAL IDENTITY',
    'HEAD SIZE, NECK AND BODY', 'HAIR AND HEADWEAR', 'EVERYONE ELSE STAYS', 'THE COVER IS LOCKED', 'FINAL CHECK']) {
    assert.ok(OPENAI_PREVIEW_PROMPT.includes(section), section);
  }
  assert.match(OPENAI_PREVIEW_PROMPT, /fits inside the outline of the original hero's head/);
  assert.match(OPENAI_PREVIEW_PROMPT, /a head that looks like a photograph placed on a painted body/);
  assert.match(OPENAI_PREVIEW_PROMPT, /Glasses the child wears in the photo always stay on/);
  assert.match(OPENAI_PREVIEW_PROMPT, /except the name and language changes requested below/);
  // The face description lands inside it.
  assert.ok(withFaceDescription(OPENAI_PREVIEW_PROMPT, 'Oval face.').includes('identity only) - Oval face.'));
});

test('the age sets the face, never the hero\'s body or head size', () => {
  const prompt = buildPreviewPrompt('BASE', { language: resolveBookLanguage('en'), childName: '', age: '3' });
  assert.match(prompt, /The child is 3 years old\. Paint a face of that age from the photo's features/);
  assert.match(prompt, /Head size: the child's head, hair included, is no bigger than the hero's and fits the body\./);
  // The head rule goes in even without an age.
  assert.match(buildPreviewPrompt('BASE', { language: resolveBookLanguage('en'), childName: '', age: '' }), /Head size:/);
});

test('only the hero\'s name is personalised; team names and numbers stay', () => {
  const prompt = buildPreviewPrompt('BASE', { language: resolveBookLanguage('en'), childName: 'Yassin', age: '' });
  assert.match(prompt, /Only the hero's name changes: team names on jerseys, banners and scoreboards, numbers and other names stay as they are\./);
});

test('a sports kit in the photo colours and numbers the hero\'s own kit only', () => {
  const out = withPhotoTraits('BASE', { outfit: 'yellow basketball jersey, number 10' });
  assert.match(out, /- Sports kit in the photo: yellow basketball jersey, number 10\. If the hero wears a sports jersey or kit, it takes this main colour and number/);
  assert.match(out, /everyone else keeps their own kit\. If the hero wears no sports kit, ignore this\./);
});
