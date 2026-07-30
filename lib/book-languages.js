export const BOOK_LANGUAGES = Object.freeze({
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese'
});

export function resolveBookLanguage(value) {
  const code = String(value || 'en').trim().toLowerCase();
  const name = BOOK_LANGUAGES[code];
  return name ? { code, name } : null;
}
