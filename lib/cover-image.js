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
// The logo's width and its gap from the bottom edge, as shares of the cover's
// width and height. glow is the soft white halo hugging the logo's shape (its
// size as a share of the logo's height, and its strength), which keeps the
// navy lettering readable on dark art without a backing shape.
export const LOGO = { width: 0.16, bottom: 0.03, glow: 0.08, glowStrength: 5 };

let logoBytes = null;

// The transparent logo with its halo, as a PNG sized for a cover `width` wide.
async function logoBadge(sharp, width) {
  logoBytes = logoBytes || (await readFile(LOGO_FILE));
  const logo = await sharp(logoBytes).resize({ width: Math.max(1, Math.round(width * LOGO.width)) }).png().toBuffer({ resolveWithObject: true });
  const pad = Math.max(1, Math.round(logo.info.height * LOGO.glow * 2));
  const clear = { r: 0, g: 0, b: 0, alpha: 0 };
  const padded = await sharp(logo.data).extend({ top: pad, bottom: pad, left: pad, right: pad, background: clear }).png().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = padded.info;
  // The logo's own shape, blurred then boosted, as the alpha of a white layer.
  // Two pipelines, since sharp runs linear before blur within one.
  const blurred = await sharp(padded.data).extractChannel(3).blur(Math.max(0.3, pad / 2)).raw().toBuffer({ resolveWithObject: true });
  const halo = await sharp(blurred.data, { raw: blurred.info }).linear(LOGO.glowStrength, 0).raw().toBuffer({ resolveWithObject: true });
  const glow = await sharp({ create: { width: w, height: h, channels: 3, background: '#fff' } })
    .joinChannel(halo.data, { raw: halo.info })
    .png()
    .toBuffer();
  const badge = await sharp(glow).composite([{ input: padded.data }]).png().toBuffer();
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
