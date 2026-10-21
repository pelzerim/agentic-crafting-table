import { createContext, useContext, useSyncExternalStore } from 'react';
import type { RailSlot } from './tool-rail.tsx';

/** Which rail tool shows its sheet, which one is pinned open, the pinned tool a
 * hover peek covered, to show again when the peek ends, and the tool a right-click
 * holds open through every close until it is released. */
export interface RailSnapshot { open?: RailSlot; pinned?: RailSlot; resume?: RailSlot; held?: RailSlot }

/** One sheet at a time across every rail tool. Pinning a tool unpins the others;
 * hovering another tool peeks over a pinned one without unpinning it. */
export class RailState {
  private value: RailSnapshot = {};
  private listeners = new Set<() => void>();
  snapshot = () => this.value;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(next: RailSnapshot) {
    if (next.open === this.value.open && next.pinned === this.value.pinned && next.resume === this.value.resume && next.held === this.value.held) return;
    this.value = Object.fromEntries(Object.entries(next).filter(([, slot]) => slot)) as RailSnapshot; for (const listener of this.listeners) listener();
  }
  open(slot: RailSlot) {
    const { open, pinned, resume } = this.value;
    if (open === slot) return;
    this.set({ open: slot, pinned, resume: pinned === slot ? undefined : open && open === pinned ? pinned : resume, held: this.value.held });
  }
  close(slot: RailSlot) {
    const { held } = this.value;
    if (this.value.open !== slot || held === slot) return;
    this.set(held && this.value.resume === held ? { open: held, pinned: held, held } : { pinned: this.value.pinned, open: this.value.resume, held });
  }
  pin(slot: RailSlot) { const { held } = this.value; this.set({ open: slot, pinned: slot, resume: held && held !== slot ? held : undefined, held }); }
  unpin(slot: RailSlot) { if (this.value.pinned === slot && this.value.held !== slot) this.set({ open: this.value.open, resume: this.value.resume, held: this.value.held }); }
  clear() { const { held } = this.value; this.set(held ? { open: held, pinned: held, held } : {}); }
  /** Right-click: hold this tool open, or release and close it when it is the held one. */
  hold(slot: RailSlot) { this.set(this.value.held === slot ? {} : { open: slot, pinned: slot, held: slot }); }
}

export const RAIL_DWELL_MS = 250;
const DWELL_SLOP = 4;
/** Hover opens a slot only once the pointer rests on it, so passing along the rail
 * to another slot opens nothing. One open per visit; a click decides the visit. */
export class RailDwell {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private anchor = { x: 0, y: 0 };
  private settled = false;
  private readonly open: () => void;
  constructor(open: () => void) { this.open = open; }
  enter(x: number, y: number) { this.settled = false; this.restart(x, y); }
  move(x: number, y: number) {
    if (this.settled || (this.timer && Math.hypot(x - this.anchor.x, y - this.anchor.y) < DWELL_SLOP)) return;
    this.restart(x, y);
  }
  leave() { this.settled = false; this.dispose(); }
  click() { this.settled = true; this.dispose(); }
  dispose() { clearTimeout(this.timer); this.timer = undefined; }
  private restart(x: number, y: number) {
    clearTimeout(this.timer); this.anchor = { x, y };
    this.timer = setTimeout(() => { this.timer = undefined; this.settled = true; this.open(); }, RAIL_DWELL_MS);
  }
}

export const RailContext = createContext(new RailState());
export function useRail() { const rail = useContext(RailContext); return { rail, ...useSyncExternalStore(rail.subscribe, rail.snapshot) }; }
export function useRailTool(slot: RailSlot) { const { rail, open, pinned, held } = useRail(); return { rail, open: open === slot, pinned: pinned === slot, held: held === slot }; }
