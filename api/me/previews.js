// GET  /api/me/previews  → { previews: [...] }
// POST /api/me/previews  → { previews: [...], saved: n }   (bulk upsert)
//
// The signed-in shopper's preview history, so it follows the account across
// devices instead of living only in one browser's localStorage.
//
// Identity is the same HMAC the rest of the backend uses (lib/customer-token.js):
// the theme signs "{customer_id}:{YYYY-MM-DD}" in Liquid with the shared secret
// and sends { customer_id, token_date, customer_token }. There is no session
// here - an unverified caller is simply anonymous and gets a 401, so one
// customer can never read another's list.
//
// GET takes the token as query params, since a GET has no body.

import { applyCors, isOriginAllowed } from '../../lib/cors.js';
import { verifyCustomerToken, customerTokensEnabled } from '../../lib/customer-token.js';
import { listPreviews, savePreviews, userPreviewsEnabled } from '../../lib/user-previews.js';
import { withReporting } from '../../lib/report.js';

export default withReporting(handler);

async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (!isOriginAllowed(req)) return res.status(403).json({ error: 'forbidden-origin' });

  // Both are optional features; when either is off the theme keeps working
  // device-locally and just never syncs.
  if (!customerTokensEnabled()) return res.status(503).json({ error: 'tokens-not-configured' });
  if (!userPreviewsEnabled()) return res.status(503).json({ error: 'storage-not-configured' });

  if (req.method === 'GET') {
    const customer = verifyCustomerToken({
      customer_id: req.query && req.query.customer_id,
      token_date: req.query && req.query.token_date,
      customer_token: req.query && req.query.customer_token
    });
    if (!customer.valid) return res.status(401).json({ error: 'not-signed-in' });

    const previews = await listPreviews(customer.customerId);
    return res.status(200).json({ previews });
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};

    const customer = verifyCustomerToken(body);
    if (!customer.valid) return res.status(401).json({ error: 'not-signed-in' });

    const saved = await savePreviews(customer.customerId, body.previews);
    // Return the merged list so the client can adopt it wholesale rather than
    // reconciling a second time.
    const previews = await listPreviews(customer.customerId);
    return res.status(200).json({ previews, saved });
  }

  return res.status(405).json({ error: 'method-not-allowed' });
}
