import { useMemo, useRef } from 'react';
import { UndoHistory, reversalNotice } from '../../../packages/core/map-undo.ts';
import type { Receipt, UndoStep } from '../../../packages/core/map-undo.ts';
import type { WorkspaceState } from '../../../packages/core/control.ts';
import type { PlotView } from '../../../src/graph/plots.ts';

export interface HistorySeen { state: WorkspaceState; plots?: { list: readonly PlotView[] } }
export interface HistoryHost {
  /** False while the window shows a layer map undo does not cover. */
  active(): boolean;
  /** The service puts back what still holds, in one transaction, and returns the part it put back. */
  revert(step: UndoStep, direction: 'undo' | 'redo'): Promise<{ applied?: UndoStep; reverted: number; skipped: number }>;
  /** Reads the map back after a revert landed. */
  refresh(): Promise<void>;
  notify(text: string): void;
  fail(message: string): void;
  /** Shows the board a step lands on before it is reverted. */
  focus?(step: UndoStep, direction: 'undo' | 'redo'): void;
}

/** Names one recorded change for an Undo button. */
export type UndoToken = { readonly label: string };

/** The window's map undo and redo (MAP-34): each step is the receipt the service returned for the person's own commit. */
export function createMapHistory(host: () => HistoryHost) {
  const history = new UndoHistory();
  let busy = false, failing: UndoStep | undefined;
  // A recorded change keeps its token while undo and redo replace its step with the part put back.
  const tokenOf = new WeakMap<UndoStep, UndoToken>(), stepOf = new WeakMap<UndoToken, UndoStep>();
  const bind = (token: UndoToken, step: UndoStep) => { tokenOf.set(step, token); stepOf.set(token, step); };
  /** Runs `work` and records its receipt, if any; resolves with the recorded change's token. */
  const trackStep = async (label: string, work: () => Promise<{ receipt?: Receipt } | void>): Promise<UndoToken | undefined> => {
    const active = host().active(), result = await work();
    if (!active || !result?.receipt) return undefined;
    const recorded = { label, ...result.receipt }, token = { label };
    history.record(recorded); bind(token, recorded); return token;
  };
  /** `chosen` reverses that change wherever it is in the history, as an Undo button names it; one already reversed does nothing. */
  const step = async (direction: 'undo' | 'redo', chosen?: UndoToken) => {
    const { active, revert, refresh, notify, fail, focus } = host(), picked = chosen === undefined ? undefined : stepOf.get(chosen), next = picked ?? history.peek(direction);
    if (busy || !active() || (chosen !== undefined && (!picked || !history.holds(direction, picked)))) return;
    if (!next) { notify(`Nothing to ${direction}`); return; }
    busy = true; focus?.(next, direction);
    const recorded = history.recorded;
    try {
      let result: Awaited<ReturnType<HistoryHost['revert']>>;
      try { result = await revert(next, direction); }
      catch (error) {
        // A step refused twice in a row is dropped, so it never blocks the older ones.
        if (failing === next) { history.settle(direction, next); failing = undefined; } else failing = next;
        fail((error as Error).message);
        return;
      }
      failing = undefined;
      // A change recorded while the undo ran cleared redo; the undo must not refill it.
      const filed = direction === 'undo' && history.recorded !== recorded ? undefined : result.applied, token = tokenOf.get(next);
      history.settle(direction, next, filed);
      if (token !== undefined) { if (filed) bind(token, filed); else stepOf.delete(token); }
      try { await refresh(); notify(reversalNotice(next, result, direction)); } catch (error) { fail((error as Error).message); }
    } finally { busy = false; }
  };
  const track = async (label: string, work: () => Promise<{ receipt?: Receipt } | void>): Promise<void> => { await trackStep(label, work); };
  return { track, trackStep, undo: (chosen?: UndoToken) => step('undo', chosen), redo: () => step('redo') };
}

export function useMapHistory(host: HistoryHost) {
  const latest = useRef(host); latest.current = host;
  return useMemo(() => createMapHistory(() => latest.current), []);
}
