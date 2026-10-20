import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EventEmitter } from 'node:events';
import type { BrowserWindow, Rectangle } from 'electron';

type DisplayArea = { id: number; workArea: Rectangle };
export type WindowState = { version: 1; bounds: Rectangle; displayId: number; maximized: boolean };
type WindowTarget = Pick<EventEmitter, 'on' | 'removeListener'> & Pick<BrowserWindow,
  'getNormalBounds' | 'isDestroyed' | 'isMinimized' | 'isMaximized' | 'isFullScreen'>;

function validBounds(value: unknown): value is Rectangle {
  if (!value || typeof value !== 'object') return false;
  const bounds = value as Rectangle;
  return [bounds.x, bounds.y, bounds.width, bounds.height].every(value => Number.isInteger(value) && Math.abs(value) <= 1_000_000)
    && bounds.width > 0 && bounds.height > 0;
}

export function readWindowState(file: string): WindowState | undefined {
  try {
    if (statSync(file).size > 4096) return;
    const state = JSON.parse(readFileSync(file, 'utf8')) as WindowState;
    if (state?.version === 1 && validBounds(state.bounds) && Number.isSafeInteger(state.displayId) && typeof state.maximized === 'boolean') return state;
  } catch { /* Missing/corrupt preferences must never prevent opening the app. */ }
}

function overlap(a: Rectangle, b: Rectangle) {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}

function matchingDisplay(bounds: Rectangle, displays: DisplayArea[]) {
  return displays.reduce<DisplayArea | undefined>((best, display) =>
    overlap(bounds, display.workArea) > (best ? overlap(bounds, best.workArea) : 0) ? display : best, undefined);
}

/** Electron bounds and display work areas use device-independent pixels, including
 * negative coordinates on monitors to the left/above the primary display. */
export function resolveWindowState(saved: WindowState | undefined, displays: DisplayArea[], primaryId: number) {
  const primary = displays.find(display => display.id === primaryId) ?? displays[0];
  if (!primary) throw new Error('No display available for the app window');
  const display = saved ? matchingDisplay(saved.bounds, displays) ?? displays.find(display => display.id === saved.displayId) ?? primary : primary;
  const area = display.workArea;
  const minWidth = Math.min(760, area.width), minHeight = Math.min(540, area.height);
  const width = Math.min(area.width, Math.max(minWidth, saved?.bounds.width ?? 1280));
  const height = Math.min(area.height, Math.max(minHeight, saved?.bounds.height ?? 860));
  const stillOnScreen = saved && overlap(saved.bounds, area) > 0;
  const x = stillOnScreen ? Math.max(area.x, Math.min(saved.bounds.x, area.x + area.width - width)) : area.x + Math.round((area.width - width) / 2);
  const y = stillOnScreen ? Math.max(area.y, Math.min(saved.bounds.y, area.y + area.height - height)) : area.y + Math.round((area.height - height) / 2);
  return { state: { version: 1, bounds: { x, y, width, height }, displayId: display.id, maximized: saved?.maximized ?? false } satisfies WindowState, minWidth, minHeight };
}

/** Small atomic writes are debounced during dragging and flushed synchronously at
 * close, before Electron destroys the native window. No renderer/service dependency. */
export function trackWindowState(window: WindowTarget, file: string, initial: WindowState, displays: () => DisplayArea[]) {
  let state = initial, written = '', warned = false, timer: ReturnType<typeof setTimeout> | undefined;
  const capture = () => {
    if (window.isDestroyed()) return;
    const bounds = window.getNormalBounds();
    if (!validBounds(bounds)) return;
    state = { version: 1, bounds, displayId: matchingDisplay(bounds, displays())?.id ?? state.displayId,
      maximized: window.isMinimized() || window.isFullScreen() ? state.maximized : window.isMaximized() };
  };
  const flush = () => {
    clearTimeout(timer); timer = undefined; capture();
    const contents = JSON.stringify(state);
    if (contents === written) return;
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(temporary, contents, { mode: 0o600 });
      renameSync(temporary, file); written = contents;
    } catch (error) {
      try { rmSync(temporary, { force: true }); } catch { /* Best-effort temporary cleanup. */ }
      if (!warned) { warned = true; console.warn('Window placement could not be saved:', (error as NodeJS.ErrnoException).code ?? 'unknown error'); }
    }
  };
  const schedule = () => { capture(); clearTimeout(timer); timer = setTimeout(flush, 250); };
  const events = ['move', 'resize', 'maximize', 'unmaximize', 'minimize', 'restore', 'enter-full-screen', 'leave-full-screen'];
  const dispose = () => {
    flush();
    for (const event of events) window.removeListener(event, schedule);
    window.removeListener('close', flush); window.removeListener('closed', dispose);
  };
  for (const event of events) window.on(event, schedule);
  window.on('close', flush); window.on('closed', dispose);
  return dispose;
}
