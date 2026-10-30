import { useSyncExternalStore } from 'react';
import { DEFAULT_TERMINAL_SCROLLBACK } from '../../../packages/core/settings.ts';
import type { AppSettings, SettingsSnapshot } from '../../../packages/core/settings.ts';

export type TerminalSettings = AppSettings['terminal'];
export interface TerminalPreferences { screenReaderMode: boolean; scrollback: number; rightClickCloses: TerminalSettings['rightClickCloses'] }

/** xterm options for every terminal view. Screen reader support keeps a second,
 * DOM copy of the visible rows up to date, so it stays off unless chosen or
 * a screen reader is running. */
export function terminalOptions(settings: TerminalSettings | undefined, assistive: boolean): TerminalPreferences {
  return { screenReaderMode: assistive || settings?.screenReader === true, scrollback: settings?.scrollback ?? DEFAULT_TERMINAL_SCROLLBACK, rightClickCloses: settings?.rightClickCloses ?? 'anywhere' };
}

/** Recorded bytes per scrollback line that a fresh view replays. Agent CLIs
 * redraw their live region and colour every span, so a retained line costs far
 * more than its printable text; 200 bytes/line keeps the earlier 2 MiB tail for
 * the earlier 10,000 lines. Replay is parsed by xterm on the renderer thread and
 * scales with bytes, so a shorter scrollback also opens large sessions faster.
 * Bounds: 512 KiB still covers several full-screen redraws for short scrollback;
 * 4 MiB caps the cost of opening a 25,000-line view (the huge-replay journey
 * requires under 4 MiB written). Older output stays in the recording. */
const TAIL_BYTES_PER_LINE = 200, MIN_TAIL = 512 * 1024, MAX_TAIL = 4 * 1024 * 1024;
export function replayTailBytes(scrollback: number) {
  return Math.max(MIN_TAIL, Math.min(MAX_TAIL, Math.round(scrollback * TAIL_BYTES_PER_LINE)));
}

let settings: TerminalSettings | undefined, assistive = false, revision = -1;
let current = terminalOptions(undefined, false), ready: Promise<void> | undefined;
const listeners = new Set<() => void>();
const publish = () => {
  const next = terminalOptions(settings, assistive);
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;
  for (const listener of listeners) listener();
};
/** One subscription per window, shared by all terminal views (each native view has its own React root). */
function start() {
  if (ready || typeof window === 'undefined' || !window.craftingTable) return ready;
  const bridge = window.craftingTable;
  const receive = (snapshot: SettingsSnapshot) => {
    if (snapshot.revision < revision) return;
    revision = snapshot.revision; settings = snapshot.value.terminal; publish();
  };
  bridge.onSettings(receive);
  bridge.onAssistiveTechnology(enabled => { assistive = enabled; publish(); });
  ready = Promise.all([
    bridge.settingsRead().then(receive),
    bridge.assistiveTechnology().then(enabled => { assistive = enabled; publish(); }),
  ]).then(() => {}, () => {});
  return ready;
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function terminalPreferences() { start(); return current; }
/** Resolves once saved settings and the assistive technology report have arrived (or failed). */
export function terminalPreferencesReady() { return start() ?? Promise.resolve(); }
export function useTerminalPreferences() { start(); return useSyncExternalStore(subscribe, () => current); }
