// The generated cover as stored in R2. Higgsfield only returns PNGs, which are
// several times the size of a JPEG that looks the same at 1024px. 4:4:4 chroma
// keeps coloured title edges and small highlights crisp; the usual 4:2:0
// visibly blurs them.
//
// sharp is loaded on first use, inside the try, so a missing or broken native
// binary only loses the saving: the original bytes are stored instead, and a
// paid generation is never lost.

const JPEG_OPTIONS = { quality: 88, chromaSubsampling: '4:4:4', progressive: true };

// Returns { body, contentType, ext } for putObject and previewKey.
export async function coverForStorage(buf, contentType) {
  try {
    const { default: sharp } = await import('sharp');
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
