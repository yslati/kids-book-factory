// fal.ai cover generation. Uses Nano Banana 2 edit (Google Gemini 3.1 Flash Image),
// which accepts several input images via `image_urls` — we pass [coverTemplate,
// childPhoto] so the model can redraw the existing book cover's character as the
// child. Chosen for strong art-style matching + character consistency at a
// predictable flat price ($0.08/image at 1K resolution). Cost scales with
// `resolution` (0.5K = 0.75x, 2K = 1.5x, 4K = 2x), so we keep 1K to stay well under
// budget. Same [cover, child] multi-image input shape and `images[].url` output, so
// the rest of the call is unchanged apart from the model + params.
//
// Auth: FAL_KEY env var (read automatically by @fal-ai/client).

import { fal } from '@fal-ai/client';

const PRIMARY_MODEL = 'fal-ai/nano-banana-2/edit';

// Generate a cover. coverUrl + childUrl must be publicly fetchable by fal.
// Returns the generated image URL (hosted by fal). Throws on failure.
export async function generateCover(coverUrl, childUrl, prompt) {
  const input = {
    prompt: prompt,
    image_urls: [coverUrl, childUrl],
    num_images: 1,
    aspect_ratio: 'auto',  // preserve the cover's (portrait) aspect ratio
    resolution: '1K',      // $0.08/image; 2K would be 1.5x and exceed budget
    output_format: 'jpeg'
  };

  const result = await fal.subscribe(PRIMARY_MODEL, { input, logs: false });
  const images = result && result.data && result.data.images;
  if (!images || !images.length || !images[0].url) {
    throw new Error('fal-empty');
  }
  return images[0].url;
}
