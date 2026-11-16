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
  notify(text: string): void;
  fail(message: string): void;
}

/** The window's map undo and redo (MAP-34): each step is the receipt the service returned for the person's own commit. */
export function createMapHistory(host: () => HistoryHost) {
  const history = new UndoHistory();
  let busy = false;
  const track = async (label: string, work: () => Promise<{ receipt?: Receipt } | void>): Promise<void> => {
    const active = host().active(), result = await work();
    if (active && result?.receipt) history.record({ label, ...result.receipt });
  };
  const step = async (direction: 'undo' | 'redo') => {
    const { active, revert, notify, fail } = host(), next = history.peek(direction);
    if (busy || !active()) return;
    if (!next) { notify(`Nothing to ${direction}`); return; }
    busy = true;
    try {
      const result = await revert(next, direction);
      history.settle(direction, next, result.applied);
      notify(reversalNotice(next, result, direction));
    } catch (error) { history.settle(direction, next); fail((error as Error).message); }
    finally { busy = false; }
  };
  return { track, undo: () => step('undo'), redo: () => step('redo') };
}

export function useMapHistory(host: HistoryHost) {
  const latest = useRef(host); latest.current = host;
  return useMemo(() => createMapHistory(() => latest.current), []);
}
