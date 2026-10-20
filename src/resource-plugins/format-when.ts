/** How a moment is written in item views:
 * - `relative`: "just now", "18 min ago", "3 h ago" within a day, then `short`
 * - `stamp`: "14:02" on the same day, then `short`
 * - `time`: "14:02" always, for columns whose rows carry the date elsewhere
 * - `short`: "Sep 25, 14:13" (the year only when it differs)
 * - `day`: "Sep 25" (the year only when it differs)
 * - `full`: "Sep 25, 2026, 14:13", for tooltips
 * Seconds are never shown. Invalid input yields an empty string. */
export type WhenMode = 'relative' | 'stamp' | 'time' | 'short' | 'day' | 'full';

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

export function whenDate(at: string | number | Date | undefined | null): Date | undefined {
  if (at === undefined || at === null || at === '') return undefined;
  const date = at instanceof Date ? at : new Date(at);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

export function formatWhen(at: string | number | Date | undefined | null, mode: WhenMode = 'relative', now: number = Date.now()): string {
  const date = whenDate(at);
  if (!date) return '';
  const age = now - date.getTime(), sameYear = date.getFullYear() === new Date(now).getFullYear();
  if (mode === 'relative' && age > -MINUTE && age < DAY) {
    if (age < MINUTE) return 'just now';
    if (age < HOUR) return `${Math.floor(age / MINUTE)} min ago`;
    return `${Math.floor(age / HOUR)} h ago`;
  }
  const time = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  if (mode === 'time' || mode === 'stamp' && new Date(now).toDateString() === date.toDateString()) return time;
  const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear && mode !== 'full' ? {} : { year: 'numeric' }) });
  return mode === 'day' ? day : `${day}, ${time}`;
}
