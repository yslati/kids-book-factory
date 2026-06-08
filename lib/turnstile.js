// Cloudflare Turnstile server-side verification. If TURNSTILE_SECRET is unset,
// verification is treated as disabled (returns true) so the backend still works
// before the challenge is configured — but you should set it in production.

export function turnstileEnabled() {
  return Boolean(process.env.TURNSTILE_SECRET);
}

export async function verifyTurnstile(token, remoteIp) {
  if (!turnstileEnabled()) return true; // disabled
  if (!token) return false;

  const body = new URLSearchParams();
  body.append('secret', process.env.TURNSTILE_SECRET);
  body.append('response', token);
  if (remoteIp) body.append('remoteip', remoteIp);

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const json = await res.json();
    return json.success === true;
  } catch (e) {
    return false;
  }
}
