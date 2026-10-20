// Which days the #events daily summary still owes (api/cron/daily-summary.js),
// so a day Vercel's cron skips is posted by the next run, and a run Vercel
// repeats or overlaps posts nothing twice.
//
// kbf:ev:summary:last holds the last day summarised. A run posts each day
// after it, oldest first, up to yesterday (UTC). With nothing summarised yet,
// it starts from the earliest day with totals. One run works at a time
// (kbf:ev:summary:lock); a run that finds it taken posts nothing.
//
// A summary Discord can't take right away is saved and goes out later
// (lib/discord.js), so its day still counts as summarised and isn't posted
// again.

import { dayOf, readDay, recordedDays } from './event-stats.js';
import { postSummary } from './event-feed.js';

const LAST_KEY = 'kbf:ev:summary:last';
const LOCK_KEY = 'kbf:ev:summary:lock';
// Longer than the cron's 30 s (vercel.json), so a run can't lose the lock
// while it works; a run killed midway frees it after this.
const LOCK_MS = 60 * 1000;
// How far back a run catches up; a day's totals are kept 40 days
// (lib/event-stats.js).
const CATCH_UP_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function addDays(day, n) {
  return dayOf(new Date(Date.parse(day + 'T00:00:00Z') + n * DAY_MS));
}

// The days still owed a summary, oldest first.
async function dueDays(redis, yesterday) {
  const window = [];
  for (let n = CATCH_UP_DAYS - 1; n >= 0; n--) window.push(addDays(yesterday, -n));

  const last = String((await redis.get(LAST_KEY)) || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(last)) {
    const first = (await recordedDays(redis, window))[0] || yesterday;
    return window.filter((day) => day >= first);
  }
  const missed = Math.round((Date.parse(window[0]) - Date.parse(last)) / DAY_MS) - 1;
  if (missed > 0) {
    console.warn('[daily-summary] ' + missed + ' day(s) after ' + last + ' are more than ' + CATCH_UP_DAYS + ' days old and were not posted');
  }
  return window.filter((day) => day > last);
}

// Posts every summary still owed. Resolves to the days posted, oldest first,
// as [{ day, sent }] (sent is false when Discord didn't take it right away),
// or null when another run is already posting. A Redis error rejects, and
// the days not yet posted are left for the next run.
export async function postDueSummaries(redis, now = new Date()) {
  if (!(await redis.set(LOCK_KEY, 1, { nx: true, px: LOCK_MS }))) return null;
  try {
    const posted = [];
    for (const day of await dueDays(redis, dayOf(new Date(now.getTime() - DAY_MS)))) {
      const sent = Boolean(await postSummary(await readDay(redis, day)));
      await redis.set(LAST_KEY, day);
      posted.push({ day, sent });
    }
    return posted;
  } finally {
    await redis.del(LOCK_KEY);
  }
}
