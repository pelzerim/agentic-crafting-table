import { useSyncExternalStore } from 'react';

/** One shared half-minute clock for ages shown as text ("4h"). Components subscribe only
 * while they show an age, so an idle map schedules nothing. */
let now = Date.now(), timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) { now = Date.now(); timer = setInterval(() => { now = Date.now(); for (const notify of listeners) notify(); }, 30_000); }
  return () => { listeners.delete(listener); if (!listeners.size) { clearInterval(timer); timer = undefined; } };
}
const idle = () => () => {};
const read = () => now;

/** The time of the last tick; ticks every 30 s while any `active` caller is mounted. */
export function useNow(active: boolean): number {
  return useSyncExternalStore(active ? subscribe : idle, read);
}
