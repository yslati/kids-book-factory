// Shared CORS + preflight handling. The storefront calls these endpoints
// cross-origin from the browser, so every response needs the right headers.

const ALLOWED = (process.env.ALLOWED_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function resolveOrigin(req) {
  const origin = req.headers.origin || '';
  if (!ALLOWED.length) return null;
  return ALLOWED.indexOf(origin) !== -1 ? origin : null;
}

// Applies CORS headers. Returns true if the request was a handled preflight
// (caller should stop). For disallowed origins we still answer but without the
// allow-origin header, so the browser blocks the response.
export function applyCors(req, res) {
  const origin = resolveOrigin(req);
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

export function isOriginAllowed(req) {
  return resolveOrigin(req) !== null;
}
