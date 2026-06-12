// fal.ai cover generation. Uses FLUX.2 [pro] edit, which accepts several input
// images via `image_urls` — we pass [coverTemplate, childPhoto] so the model can
// redraw the existing book cover's character as the child. (Switched from FLUX.1
// Kontext [max] multi to roughly halve per-image cost; same [cover, child]
// multi-image input shape, so the call below is unchanged apart from the model.)
//
// Auth: FAL_KEY env var (read automatically by @fal-ai/client).

import { fal } from '@fal-ai/client';

const PRIMARY_MODEL = 'fal-ai/flux-2-pro/edit';

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
