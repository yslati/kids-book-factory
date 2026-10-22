// Vercel cron requests carry "Authorization: Bearer $CRON_SECRET".

import { timingSafeEqual } from 'node:crypto';

export function cronAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const sent = Buffer.from(String(req.headers.authorization || ''));
  const expected = Buffer.from('Bearer ' + secret);
  return sent.length === expected.length && timingSafeEqual(sent, expected);
}
