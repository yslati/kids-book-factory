// The requests sheet (SHEET_WEBHOOK_URL): one row per cover asked for, from
// the product pages (/api/preview) and the custom story page
// (/api/custom-story), so every answer can be sorted, filtered and counted in
// Google Sheets. The preview page fills in the occasion and the add to cart
// on that row later. The sheet's Apps Script (sheet/apps-script.js) writes
// the rows and adds a column for any field it hasn't seen yet.
//
// Like #previews, a row holds the child's name, age and a link to their photo
// (gone once R2 deletes it), so the sheet must stay private to the team.

import {
  COLORS, code, codeBlock, countryName, deviceSummary, envTag, field, finish, postToDiscord, redact, visitorOf
} from './discord.js';
import { OCCASIONS } from './custom-prompt.js';

// Apps Script answers in 1-3 s; past this the change is dropped and reported.
const TIMEOUT_MS = 8000;
// A follow-up can beat the preview's own row to the sheet: that row is
// written after the /preview response, while the preview page is loading.
const RETRY_MS = 5000;

export function sheetConfigured() {
  return Boolean(process.env.SHEET_WEBHOOK_URL && process.env.SHEET_WEBHOOK_SECRET);
}

// The row for one request. request: { form, book, hero, childName, age,
// language, occasion, brief, photoUrl, customerId, generationId, startedAt };
// outcome: { coverUrl, bookTitle } or { error }. Every row has the same
// columns in the same order, whichever form sent it.
export function requestRow(req, request, outcome) {
  const v = visitorOf(req);
  const failed = Boolean(outcome.error);
  const age = parseInt(request.age, 10);
  return {
    Date: new Date().toISOString(),
    Form: request.form,
    Status: failed ? 'Failed' : 'Ready',
    'Book / world': outcome.bookTitle || request.book || '',
    Hero: request.hero || '',
    "Child's name": request.childName || '',
    Age: Number.isFinite(age) ? age : '',
    Language: request.language || '',
    Occasion: request.occasion || '',
    'Story idea': request.brief || '',
    Photo: request.photoUrl || '',
    Cover: failed ? '' : outcome.coverUrl || '',
    'Added to cart': '',
    Seconds: request.startedAt ? Math.round((Date.now() - request.startedAt) / 100) / 10 : '',
    Customer: request.customerId ? 'Signed in · ' + request.customerId : 'Guest',
    Country: /^[A-Z]{2}$/.test(v.country) ? countryName(v.country) : '',
    City: v.city || '',
    Device: deviceSummary(v.userAgent),
    Error: failed ? redact(String(outcome.error)).slice(0, 300) : '',
    Generation: request.generationId || ''
  };
}

function oneLine(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// The preview page's follow-up (api/preview.js): { action: 'occasion',
// generation_id, occasion } when the parent picks or clears an occasion, and
// { action: 'cart', generation_id, occasion?, variant } when they add the
// book to the cart. A cart message only sets the occasion when it has one,
// so a shared link opened elsewhere can't clear the parent's answer.
// Returns { value: { generationId, fields } } or { error } for a 400.
export function previewFollowUp(body) {
  const b = body && typeof body === 'object' ? body : {};
  const generationId = oneLine(b.generation_id, 64);
  const occasion = oneLine(b.occasion, 40);
  if (b.action !== 'occasion' && b.action !== 'cart') return { error: 'bad-action' };
  if (!/^[A-Za-z0-9-]{1,64}$/.test(generationId)) return { error: 'bad-generation-id' };
  if (occasion && !OCCASIONS.includes(occasion)) return { error: 'bad-occasion' };

  const fields = {};
  if (b.action === 'occasion' || occasion) fields.Occasion = occasion;
  if (b.action === 'cart') fields['Added to cart'] = oneLine(b.variant, 40) || 'Yes';
  return { value: { generationId, fields } };
}

// Posts to the sheet's script. Resolves to { ok, error, status }; never throws.
async function callSheet(payload) {
  try {
    const res = await fetch(process.env.SHEET_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: process.env.SHEET_WEBHOOK_SECRET, ...payload }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const json = await res.json().catch(() => null);
    if (res.ok && json && json.ok === true) return { ok: true };
    return { ok: false, status: res.status, error: (json && json.error) || '' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function reason(result) {
  return result.status ? 'sheet answered ' + result.status + (result.error ? ' ' + result.error : '') : result.error;
}

// #logs never shows the child's name or photo; the generation id finds the
// request in #previews or #custom-generation. Needed because these changes
// run after the response, where withReporting no longer looks.
function reportLost(title, why, form, generationId) {
  console.warn('[sheet] ' + title + ':', why);
  return postToDiscord('logs', {
    embeds: [finish({
      color: COLORS.warn,
      author: { name: 'Requests sheet' + envTag() },
      title: '⚠️ ' + title,
      description: codeBlock(redact(why), 600),
      fields: [form && field('Form', form), field('Generation', code(generationId, 64))],
      timestamp: new Date().toISOString()
    })]
  }).catch(() => null);
}

// Appends one row. Resolves true once the sheet has it, false otherwise;
// never throws and does nothing while the sheet is off, so a sheet problem
// can't fail a paid generation.
export async function appendRow(row) {
  if (!sheetConfigured()) return false;
  const result = await callSheet({ row });
  if (result.ok) return true;
  await reportLost('Row not added to the requests sheet', reason(result), row.Form || '—', row.Generation);
  return false;
}

// Sets fields on the row for this generation, trying once more if the row
// isn't there yet. A row that never turns up (a preview from before the
// sheet existed) is left alone without a report. Same guarantees as appendRow.
export async function updateRow(generationId, fields) {
  if (!sheetConfigured()) return false;
  let result = await callSheet({ update: { generation: generationId, set: fields } });
  if (!result.ok && result.error === 'not-found') {
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    result = await callSheet({ update: { generation: generationId, set: fields } });
  }
  if (result.ok) return true;
  if (result.error === 'not-found') {
    console.info('[sheet] no row for generation', generationId);
    return false;
  }
  await reportLost('Row not updated in the requests sheet', reason(result), '', generationId);
  return false;
}
