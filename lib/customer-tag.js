// Tags a customer in Shopify when they exhaust their daily preview allowance.
//
// A logged-in shopper who burns all three previews in a day is the warmest
// lead we have: they wanted more covers than we gave away. Tagging them lets
// the marketing side segment on it and follow up by email.
//
// Strictly fire-and-forget: tagging is a side effect of the 429, never a
// precondition for it. Every failure path here is swallowed, so a missing
// scope, an expired token, or a Shopify outage can never turn a clean
// "you're out of previews" response into an error.
//
// Requires the `write_customers` Admin API scope (see README).

import { adminGraphQL, shopifyConfigured } from './shopify.js';

export const PREVIEW_LIMIT_TAG = 'preview-limit-hit';

const TAGS_ADD = `
  mutation TagCustomer($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }`;

// `customerId` is the bare numeric id the theme sends; the Admin API wants a GID.
export async function tagCustomerPreviewLimit(customerId) {
  const id = String(customerId || '').trim();
  if (!id || !/^\d+$/.test(id)) return false;
  if (!shopifyConfigured()) return false;

  try {
    const data = await adminGraphQL(TAGS_ADD, {
      id: 'gid://shopify/Customer/' + id,
      tags: [PREVIEW_LIMIT_TAG]
    });
    const errs = data && data.tagsAdd && data.tagsAdd.userErrors;
    if (errs && errs.length) {
      console.error('[customer-tag] tagsAdd userErrors:', JSON.stringify(errs));
      return false;
    }
    return true;
  } catch (e) {
    // Most likely a missing write_customers scope. Log, never throw.
    console.error('[customer-tag] failed:', (e && e.message) || e);
    return false;
  }
}
