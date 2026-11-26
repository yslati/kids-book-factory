// The generated cover as stored in R2. Higgsfield only returns PNGs, which are
// several times the size of a JPEG that looks the same at 1024px. 4:4:4 chroma
// keeps coloured title edges and small highlights crisp; the usual 4:2:0
// visibly blurs them.
//
// sharp is loaded on first use, inside the try, so a missing or broken native
// binary only loses the saving: the original bytes are stored instead, and a
// paid generation is never lost. The same goes for the logo: a cover it can't
// be added to is stored without it.

import { readFile } from 'node:fs/promises';

const JPEG_OPTIONS = { quality: 88, chromaSubsampling: '4:4:4', progressive: true };
const LOGO_FILE = new URL('../assets/cover-logo.png', import.meta.url);
// The badge's logo width and its gap from the bottom edge, as shares of the
// cover's width and height. Its white pill keeps the logo readable on any art.
export const LOGO = { width: 0.2, bottom: 0.03, padX: 0.16, padY: 0.2, opacity: 0.92 };

let logoBytes = null;

// The white pill with the logo on it, as a PNG sized for a cover `width` wide.
async function logoBadge(sharp, width) {
  logoBytes = logoBytes || (await readFile(LOGO_FILE));
  const logo = await sharp(logoBytes).resize({ width: Math.max(1, Math.round(width * LOGO.width)) }).png().toBuffer({ resolveWithObject: true });
  const padX = Math.round(logo.info.height * LOGO.padX * 2);
  const padY = Math.round(logo.info.height * LOGO.padY);
  const w = logo.info.width + padX * 2;
  const h = logo.info.height + padY * 2;
  const pill = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
    '<rect width="' + w + '" height="' + h + '" rx="' + h / 2 + '" fill="#fff" fill-opacity="' + LOGO.opacity + '"/></svg>'
  );
  const badge = await sharp(pill).composite([{ input: logo.data, left: padX, top: padY }]).png().toBuffer();
  return { badge, w, h };
}

// The cover with the logo badge at the bottom centre, as a JPEG.
async function withLogo(sharp, buf) {
  const { width, height } = await sharp(buf).metadata();
  const { badge, w, h } = await logoBadge(sharp, width);
  const left = Math.round((width - w) / 2);
  const top = height - h - Math.round(height * LOGO.bottom);
  if (left < 0 || top < 0) throw new Error('cover too small for the logo');
  return sharp(buf).flatten({ background: '#ffffff' }).composite([{ input: badge, left, top }]).jpeg(JPEG_OPTIONS).toBuffer();
}

// Returns { body, contentType, ext } for putObject and previewKey. logo adds
// the brand badge (lib/cover-store.js); covers stored elsewhere may carry it
// already.
export async function coverForStorage(buf, contentType, { logo = false } = {}) {
  try {
    const { default: sharp } = await import('sharp');
    if (logo) {
      try {
        return { body: await withLogo(sharp, buf), contentType: 'image/jpeg', ext: 'jpg' };
      } catch (err) {
        console.error('[cover] logo not added, storing the cover without it:', (err && err.message) || err);
      }
    }
    // sharp converts to sRGB and drops all metadata (EXIF, ICC, XMP) by default.
    // JPEG has no alpha, so any transparency goes onto white rather than black.
    const body = await sharp(buf).flatten({ background: '#ffffff' }).jpeg(JPEG_OPTIONS).toBuffer();
    return { body, contentType: 'image/jpeg', ext: 'jpg' };
  } catch (err) {
    console.warn('[cover] JPEG conversion failed, storing the original:', (err && err.message) || err);
    const type = contentType || 'image/jpeg';
    return { body: buf, contentType: type, ext: type.indexOf('png') !== -1 ? 'png' : 'jpg' };
  }
}
