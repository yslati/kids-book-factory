// Shape + validation for one stored preview entry. Dependency-free and pure, so
// it is testable without Upstash installed - and it is the part that handles
// untrusted input (entries are posted by the browser), which is what most needs
// the coverage.

export const TTL_DAYS = 30;
export const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;
export const MAX_ENTRIES = 50;

// Normalises one entry to the shape the theme keeps in localStorage, so the
// merge on the client is a straight comparison. Returns null if unusable.
export function normaliseEntry(raw, now) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const k = String(raw.k || '').trim().slice(0, 120);
  const coverUrl = String(raw.coverUrl || '').trim();
  if (!k || !coverUrl) return null;
  // Only ever hand back https URLs - never a javascript:/data: payload.
  if (!/^https:\/\//i.test(coverUrl)) return null;

  const parsed = Date.parse(raw.createdAt || '');
  const created = Number.isFinite(parsed) ? parsed : (now || Date.now());

  return {
    k,
    book: String(raw.book || '').slice(0, 120),
    themeId: String(raw.themeId || '').slice(0, 120),
    bookTitle: String(raw.bookTitle || '').slice(0, 160),
    childName: String(raw.childName || '').slice(0, 40),
    age: String(raw.age || '').slice(0, 3),
    coverUrl: coverUrl.slice(0, 500),
    createdAt: new Date(created).toISOString(),
    expiresAt: new Date(created + TTL_MS).toISOString()
  };
}
