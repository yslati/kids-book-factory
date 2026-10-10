// fal account balance, read so lib/generate.js can hand generation to Higgsfield
// before fal runs dry.
//
// Needs its own key. The inference key (FAL_KEY) gets a 403 from the billing
// endpoint, so FAL_BILLING_KEY must be a fal key created on the BILLING preset
// (fal dashboard → Keys). Unset, or any failed check, reads as null ("unknown"),
// which keeps fal first - the error fallback in lib/generate.js still covers a
// locked account.

const BILLING_URL = 'https://api.fal.ai/v1/account/billing?expand=credits';
// One check per minute per warm instance: fresh enough to switch providers
// within a minute of the balance crossing the threshold (or of a top-up), and
// it keeps the check off most requests' critical path.
const CACHE_MS = 60 * 1000;
const TIMEOUT_MS = 2500;

let cachedBalance = null;
let checkedAt = 0;
let inflight = null;

async function fetchBalance(key) {
  let balance = null;
  try {
    const res = await fetch(BILLING_URL, {
      headers: { Authorization: 'Key ' + key },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (res.ok) {
      const json = await res.json();
      const value = json && json.credits && json.credits.current_balance;
      if (typeof value === 'number' && Number.isFinite(value)) balance = value;
    } else {
      console.warn('[fal-balance] check failed: HTTP ' + res.status);
    }
  } catch (err) {
    console.warn('[fal-balance] check failed:', (err && err.message) || err);
  }
  // Failures are cached too, so a bad key costs one slow request a minute
  // rather than one per preview.
  cachedBalance = balance;
  checkedAt = Date.now();
  return balance;
}

// Current fal credit balance in USD, or null when unknown.
export async function falBalance() {
  const key = process.env.FAL_BILLING_KEY;
  if (!key) return null;
  if (checkedAt && Date.now() - checkedAt < CACHE_MS) return cachedBalance;
  if (!inflight) {
    inflight = fetchBalance(key).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

// For tests: forget the cached balance.
export function resetFalBalanceCache() {
  cachedBalance = null;
  checkedAt = 0;
  inflight = null;
}
