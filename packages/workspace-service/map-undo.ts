import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { ITEM_SIZES } from '../../src/graph/graph.ts';
import { layoutFootprints } from '../../src/graph/movement.ts';
import { mapDimensionsSchema } from '../core/item-map-sizes.ts';
import { stateSchema } from '../core/control.ts';
import type { CommandEnvelope, CommandResult, WorkspaceCommand, WorkspaceControl, WorkspaceState } from '../core/control.ts';
import { UNDO_ACTOR, UNDO_ANCHOR_CAP, UNDO_MEMBER_CAP, UNDO_PAIR_CAP, buildUndoStep, clearMapSizes, placeExactly, planReversal } from '../core/map-undo.ts';
import type { UndoStep } from '../core/map-undo.ts';
import type { Plots } from './plots.ts';
import type { SqliteStore } from './sqlite-store.ts';

const id = z.string().min(1).max(200);
const point = z.object({ x: z.number().finite(), y: z.number().finite() });
const itemSnapSchema = z.object({ position: point, projectId: id.nullable(), size: z.enum(ITEM_SIZES).optional(), mapSize: z.enum(ITEM_SIZES).optional(), mapDimensions: mapDimensionsSchema.optional(), archived: z.boolean() }).strict();
const plotSnapSchema = z.object({ id, projectId: id, name: z.string().max(200).optional(), generated: z.boolean(), color: z.string().max(40), chosenColor: z.string().max(40).optional(), pinnedMemberIds: z.array(id).max(500), locked: z.boolean(), lockPinnedIds: z.array(id).max(500).optional() }).strict();
const link = stateSchema.shape.links.element;
const stepSchema = z.object({ label: z.string().max(60), items: z.array(z.object({ id, before: itemSnapSchema, after: itemSnapSchema, members: z.array(id).max(UNDO_MEMBER_CAP).optional() })).max(2000),
  links: z.array(z.object({ before: link.optional(), after: link.optional() }).refine(change => Boolean(change.before || change.after))).max(500),
  plots: z.array(z.object({ id, before: plotSnapSchema.optional(), after: plotSnapSchema.optional() }).refine(change => Boolean(change.before || change.after))).max(200),
  anchors: z.array(z.object({ id, position: point })).max(UNDO_ANCHOR_CAP).optional(), pairs: z.array(z.tuple([id, id])).max(UNDO_PAIR_CAP).optional() });
export const undoRequestSchema = z.object({ direction: z.enum(['undo', 'redo']), step: stepSchema });
type Commit = (envelope: CommandEnvelope, change: (state: WorkspaceState) => WorkspaceState) => CommandResult;

/** Map undo and redo (MAP-34): checks each change against the current map and puts back what still holds, in one transaction. */
export class MapUndo {
  private store: SqliteStore; private control: WorkspaceControl; private plots: Plots; private clock: () => number;
  constructor(store: SqliteStore, control: WorkspaceControl, plots: Plots, clock: () => number = Date.now) {
    this.store = store; this.control = control; this.plots = plots; this.clock = clock;
  }
  /** A rolled back transaction may also have dropped plot detection's writes, so detection runs again. */
  private atomic<T>(work: (state: WorkspaceState, commit: Commit) => T): T {
    try { return this.store.atomic(work); } catch (error) { this.plots.invalidate(); throw error; }
  }
  /** Commits `commands` inside the open transaction; it always takes a revision, so plot-only changes version too. */
  private land(commit: Commit, state: WorkspaceState, commands: WorkspaceCommand[], place: Parameters<typeof placeExactly>[1] = [], unsize: readonly string[] = []) {
    const envelope = { commandId: randomUUID(), expectedRevision: state.revision, actor: UNDO_ACTOR, commands };
    return commit(envelope, current => { const next = clearMapSizes(placeExactly(this.control.reduce(current, envelope), place), unsize); return next.revision === current.revision ? { ...next, revision: current.revision + 1 } : next; }).state;
  }
  run(input: unknown) {
    const { step, direction } = undoRequestSchema.parse(input) as { step: UndoStep; direction: 'undo' | 'redo' };
    const context = { registry: this.control.registry, sizes: this.store.readSettings().value.itemMapSizes };
    return this.atomic((state, commit) => {
      const simulate = (commands: WorkspaceCommand[]) => this.control.reduce(state, { commandId: randomUUID(), expectedRevision: state.revision, actor: UNDO_ACTOR, commands });
      const reversal = planReversal(step, state, this.plots.snaps(state), context, direction, simulate, current => layoutFootprints(current.nodes, current.resources, context.registry, context.sizes));
      if (!reversal.applied) return { revision: state.revision, reverted: 0, skipped: reversal.skipped };
      const after = this.land(commit, state, reversal.commands, reversal.place, reversal.unsize);
      if (reversal.plots.length || reversal.removePlots.length) { this.store.restorePlots(reversal.plots, reversal.removePlots, this.clock()); this.plots.invalidate(); }
      // The other direction gets what this commit really did to each item, never what was aimed for.
      const ids = new Set(reversal.applied.items.map(item => item.id)), done = buildUndoStep(step.label, state, after, context, undefined, ids)?.items.filter(item => ids.has(item.id)) ?? [];
      const items = direction === 'undo' ? done.map(item => ({ ...item, before: item.after, after: item.before })) : done;
      // Plots likewise: the side this reversal produced is what is stored now, so the other direction's guards match it.
      const stored = new Map(this.plots.snaps(after).map(plot => [plot.id, plot]));
      const plots = reversal.applied.plots.map(change => { const now = stored.get(change.id); return direction === 'undo' ? { id: change.id, ...now ? { before: now } : {}, ...change.after ? { after: change.after } : {} } : { id: change.id, ...change.before ? { before: change.before } : {}, ...now ? { after: now } : {} }; })
        .filter(change => change.before || change.after);
      return { revision: after.revision, applied: { ...reversal.applied, items, plots }, reverted: reversal.reverted, skipped: reversal.skipped };
    });
  }
}
