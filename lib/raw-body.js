// The exact bytes a request sent, for functions that check a signature over
// them (bodyParser off). Vercel's Node helpers read the body first and replay
// it to 'data' and 'end' listeners only, so the stream can't be iterated
// directly.
export function rawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
