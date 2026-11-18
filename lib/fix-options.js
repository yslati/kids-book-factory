// The fix buttons the preview page shows under a cover, chosen from what the
// photo shows (lib/face-check.js traits) and what the cover review found.

import { Seen } from './face-check.js';
import { FixReason } from './prompt.js';

// The id of the review's n-th own note, as the page sends it back.
export const noteId = (n) => 'note_' + n;
const NOTE_ID = /^note_(\d)$/;

// The review notes a fix request names, from those kept on the cover's record.
export function pickedNotes(ids, notes) {
  const list = Array.isArray(notes) ? notes : [];
  return [...new Set((Array.isArray(ids) ? ids : []).map(String))]
    .map((id) => NOTE_ID.exec(id))
    .filter(Boolean)
    .map((m) => list[Number(m[1])])
    .filter(Boolean);
}

// Letters only, lower case, accents dropped.
function plainName(text) {
  return String(text || '').normalize('NFD').replace(/[^\p{L}]/gu, '').toLowerCase();
}

// true when the cover's title clearly carries another name than the child's.
function nameIsWrong(review, childName) {
  const wanted = plainName(childName);
  const written = plainName(review.titleName);
  return Boolean(wanted && written) && !written.includes(wanted);
}

// [{ id, label?, spotted }] for a cover: what the review spotted first, then
// the rest. label is only set where the theme has no text of its own.
// traits and review may be null.
export function fixOptions(traits, review, { childName = '' } = {}) {
  const t = traits || {};
  const r = review || null;
  const options = [];
  const add = (id, spotted, label) => options.push({ id, spotted: Boolean(spotted), ...(label ? { label } : {}) });

  // No head-size button: the prompt's head rule handles it, and the review's
  // flag still reaches the logs through reviewSummary.
  add(FixReason.LIKENESS, false);
  add(FixReason.STYLE, r && r.pasted);
  if (t.glasses || (r && r.glasses === Seen.DIFFERENT)) {
    add(FixReason.GLASSES, r && (r.glasses === Seen.MISSING || r.glasses === Seen.DIFFERENT));
  }
  if (t.headwear) {
    // On the cover already: offer to take it off. Otherwise: offer to add it.
    if (r && r.headwear === Seen.MATCH) add(FixReason.HEADWEAR_REMOVE, false, t.headwearLabel);
    else add(FixReason.HEADWEAR_ADD, r && r.headwear === Seen.MISSING, t.headwearLabel);
  }
  add(FixReason.HAIR, r && r.hair === Seen.DIFFERENT);
  add(FixReason.SKIN, r && r.skin === Seen.DIFFERENT);
  ((r && r.notes) || []).forEach((note, n) => add(noteId(n), true, note.label));
  add(FixReason.NAME, r && nameIsWrong(r, childName));
  add(FixReason.OTHER, false);

  return options.filter((o) => o.spotted).concat(options.filter((o) => !o.spotted));
}

// What the review found wrong, as a few words for the logs and #previews; '' when nothing.
// review (may be null) adds what has no button of its own.
export function reviewSummary(options, review = null) {
  const spotted = (options || []).filter((o) => o.spotted).map((o) => o.label || o.id);
  return (review && review.headTooBig ? ['head too big'] : []).concat(spotted).join(', ');
}
