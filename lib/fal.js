// fal.ai cover generation. Uses FLUX.1 Kontext [max] MULTI, which accepts
// several input images — we pass [coverTemplate, childPhoto] so the model can
// place the child's face onto the existing book cover. (Single-image Kontext
// Pro/Max can't take the child as a separate reference, which is why we use the
// multi variant here.)
//
// Auth: FAL_KEY env var (read automatically by @fal-ai/client).

import { fal } from '@fal-ai/client';

const PRIMARY_MODEL = 'fal-ai/flux-pro/kontext/max/multi';

// Generate a cover. coverUrl + childUrl must be publicly fetchable by fal.
// Returns the generated image URL (hosted by fal). Throws on failure.
export async function generateCover(coverUrl, childUrl, prompt) {
  const input = {
    prompt: prompt,
    image_urls: [coverUrl, childUrl],
    num_images: 1,
    output_format: 'jpeg',
    safety_tolerance: '2'
  };

  const result = await fal.subscribe(PRIMARY_MODEL, { input, logs: false });
  const images = result && result.data && result.data.images;
  if (!images || !images.length || !images[0].url) {
    throw new Error('fal-empty');
  }
  return images[0].url;
}
