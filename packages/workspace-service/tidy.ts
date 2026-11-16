import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { ITEM_SIZES } from '../../src/graph/graph.ts';
import { layoutFootprints } from '../../src/graph/movement.ts';
import { mapDimensionsSchema } from '../core/item-map-sizes.ts';
import { stateSchema } from '../core/control.ts';
import type { CommandEnvelope, CommandResult, WorkspaceCommand, WorkspaceControl, WorkspaceState } from '../core/control.ts';
import { buildUndoStep, commandSubjects, planReversal, plotSnap } from '../core/map-undo.ts';
import type { UndoStep } from '../core/map-undo.ts';
import { finishedItems, newPlotKey, planTidy, tidyDrift, tidyFingerprint } from '../core/tidy.ts';
import type { TidyPlan, TidyRegroup } from '../core/tidy.ts';
import { summaryEvidence } from '../session-runtime/activity-summary.ts';
import type { ActivitySummaryClient } from '../../src/agents/activity-summary.ts';
import { buildAgentTitleRequest, normalizeAgentTitle } from '../../src/agents/agent-title.ts';
import { buildPlotNameRequest, normalizePlotName } from '../../src/agents/plot-name.ts';
import { buildProjectNameRequest, buildRegroupRequest, parseRegroupReply } from '../../src/agents/tidy-names.ts';
import { isDrawn } from '../../src/graph/archive.ts';
import type { Plots } from './plots.ts';
import type { SqliteStore } from './sqlite-store.ts';

/** Tidy runs as the person but is never the person typing: its renames stay machine names. */
export const TIDY_ACTOR = { kind: 'user', id: 'tidy' } as const;
/** Item names asked per project and run, so one Tidy never spends the hour's allowance. */
export const TIDY_RENAME_LIMIT = 8;
const id = z.string().min(1).max(200), name = z.string().trim().min(1).max(48).regex(/^[^\x00-\x1f\x7f<>`]*$/);
const options = z.object({ lineUp: z.boolean(), spacePlots: z.boolean(), colors: z.boolean(), archive: z.boolean(), rename: z.boolean(), regroup: z.boolean() });
const rename = z.object({ kind: z.enum(['item', 'plot', 'project']), id, to: name });
const regroup = z.object({ itemId: id, plotId: id.optional(), newPlot: name.optional() }).refine(row => Boolean(row.plotId) !== Boolean(row.newPlot));
const point = z.object({ x: z.number().finite(), y: z.number().finite() });
const itemSnapSchema = z.object({ position: point, projectId: id.nullable(), size: z.enum(ITEM_SIZES).optional(), mapDimensions: mapDimensionsSchema.optional(), archived: z.boolean(), title: z.string().max(500), machineTitle: z.boolean() }).strict();
const plotSnapSchema = z.object({ id, projectId: id, name: z.string().max(200).optional(), generated: z.boolean(), color: z.string().max(40), chosenColor: z.string().max(40).optional(), pinnedMemberIds: z.array(id).max(500), locked: z.boolean() }).strict();
const link = stateSchema.shape.links.element;
const stepSchema = z.object({ label: z.string().max(60), items: z.array(z.object({ id, before: itemSnapSchema, after: itemSnapSchema })).max(2000),
  links: z.array(z.object({ before: link.optional(), after: link.optional() }).refine(change => Boolean(change.before || change.after))).max(500), plots: z.array(z.object({ id, before: plotSnapSchema.optional(), after: plotSnapSchema })).max(200) });
type Commit = (envelope: CommandEnvelope, change: (state: WorkspaceState) => WorkspaceState) => CommandResult;
export const tidyRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('suggest'), projectId: id.optional(), options }),
  z.object({ operation: z.literal('apply'), projectId: id.optional(), fingerprint: z.string().min(1).max(40), options,
    archives: z.array(id).max(1000), renames: z.array(rename).max(200), regroup: z.array(regroup).max(500) }),
  z.object({ operation: z.literal('revert'), direction: z.enum(['undo', 'redo']), step: stepSchema }),
]);
export interface RenameRow { kind: 'item' | 'plot' | 'project'; id: string; from: string; to: string; ticked: boolean }
export interface RegroupRow extends TidyRegroup { title: string; plotName: string }
type Node = WorkspaceState['nodes'][number];
/** A name is the machine's only while it still equals the one a machine wrote; anything else, marked or not, was chosen. */
const machineNamed = (node: Node) => !node.titleChosen && node.generatedTitle !== undefined && node.generatedTitle === node.title;

/** Tidy (MAP-35): AI rows for the preview, then one atomic apply of exactly the ticked rows while the preview still holds. */
export class Tidy {
  private store: SqliteStore; private control: WorkspaceControl; private plots: Plots; private client: () => ActivitySummaryClient; private clock: () => number;
  constructor(store: SqliteStore, control: WorkspaceControl, plots: Plots, client: () => ActivitySummaryClient, clock: () => number = Date.now) {
    this.store = store; this.control = control; this.plots = plots; this.client = client; this.clock = clock;
  }
  async run(input: unknown) {
    const request = tidyRequestSchema.parse(input);
    if (request.operation === 'revert') return this.revert(request.step as UndoStep, request.direction);
    if (request.operation === 'apply') return this.apply(request);
    const state = await this.control.read();
    this.inScope(state, request.projectId);
    return this.suggest(state, request.projectId, request.options);
  }
  private inScope(state: WorkspaceState, projectId?: string) {
    if (projectId && !state.nodes.some(node => node.id === projectId && !node.resourceId && !node.projectId)) throw new Error('Project not found');
  }
  /** A rolled back transaction may also have dropped plot detection's writes, so detection runs again. */
  private atomic<T>(work: (state: WorkspaceState, commit: Commit) => T): T {
    try { return this.store.atomic(work); } catch (error) { this.plots.invalidate(); throw error; }
  }
  private context() { return { registry: this.control.registry, sizes: this.store.readSettings().value.itemMapSizes }; }
  /** Commits `commands` as Tidy inside the open transaction; it always takes a revision, so plot-only changes version too. */
  private land(commit: Commit, state: WorkspaceState, commands: WorkspaceCommand[]) {
    const envelope = { commandId: randomUUID(), expectedRevision: state.revision, actor: TIDY_ACTOR, commands };
    return commit(envelope, current => { const next = this.control.reduce(current, envelope); return next.revision === current.revision ? { ...next, revision: current.revision + 1 } : next; }).state;
  }

  private list(state: WorkspaceState) { return this.plots.observe(state).list; }
  private plotsIn(state: WorkspaceState, projectId?: string) { return this.list(state).filter(plot => projectId === undefined || plot.projectId === projectId); }
  private projects(state: WorkspaceState, projectId?: string) {
    return state.nodes.filter(node => !node.resourceId && !node.projectId && isDrawn(node, state.nodes) && (projectId === undefined || node.id === projectId));
  }
  private aiAllowed() {
    const settings = this.store.readSettings().value.summaries;
    if (!settings.enabled) throw new Error('Turn on AI features in Settings first.');
    return settings;
  }
  private async ask(request: Parameters<ActivitySummaryClient['complete']>[0]) {
    if (!this.store.reserveAiRequest(this.aiAllowed(), this.clock())) throw new Error('The AI allowance for this hour is used up. Try again later.');
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 20_000);
    try { return await this.client().complete(request, abort.signal); } catch { return ''; } finally { clearTimeout(timer); }
  }
  /** Items Rename may touch: agent sessions Auto-name names, never a provider-owned or person-chosen title. */
  private renamable(state: WorkspaceState, node: Node) {
    const record = state.resources.find(resource => resource.id === node.resourceId), plugin = record && this.control.registry.get(record.pluginId);
    return Boolean(plugin?.activityTitle && machineNamed(node) && isDrawn(node, state.nodes));
  }

  /** The AI rows: proposed names and regroup moves. Only names a machine wrote are offered, never a chosen or provider title. */
  private async suggest(state: WorkspaceState, projectId: string | undefined, chosen: z.infer<typeof options>) {
    const renames: RenameRow[] = [], moves: RegroupRow[] = [];
    if (!chosen.rename && !chosen.regroup) return { revision: state.revision, renames, regroup: moves };
    this.aiAllowed();
    const plots = this.plotsIn(state, projectId), byId = new Map(state.nodes.map(node => [node.id, node]));
    const evidence = (node: Node) => ({ title: summaryEvidence(node.title).slice(0, 120), ...node.summary ? { summary: summaryEvidence(node.summary).slice(0, 80) } : {} });
    for (const project of this.projects(state, projectId)) {
      const own = plots.filter(plot => plot.projectId === project.id), members = state.nodes.filter(node => node.projectId === project.id && node.resourceId && isDrawn(node, state.nodes));
      if (chosen.rename) {
        for (const node of members.filter(node => this.renamable(state, node)).slice(0, TIDY_RENAME_LIMIT)) {
          const linked = state.links.flatMap(link => link.sourceId === node.id ? [link.targetId] : link.targetId === node.id ? [link.sourceId] : []).flatMap(other => byId.get(other)?.title ?? []);
          const reply = normalizeAgentTitle(await this.ask(buildAgentTitleRequest({ provider: 'agent', status: node.activity ?? 'idle', currentTitle: node.title, linked, recentOutput: node.summary ?? node.title })));
          if (reply && reply !== 'KEEP' && reply !== node.title) renames.push({ kind: 'item', id: node.id, from: node.title, to: reply, ticked: true });
        }
        for (const plot of own.filter(plot => plot.source !== 'user' && !plot.locked)) {
          const items = plot.memberIds.flatMap(member => byId.get(member) ?? []).map(node => ({ type: 'Item', ...evidence(node) }));
          const reply = normalizePlotName(await this.ask(buildPlotNameRequest({ project: project.title, ...plot.source === 'generated' ? { currentName: plot.name } : {}, items })));
          if (reply && reply !== 'KEEP' && reply !== plot.name) renames.push({ kind: 'plot', id: plot.id, from: plot.name, to: reply, ticked: true });
        }
        if (machineNamed(project)) {
          const reply = normalizePlotName(await this.ask(buildProjectNameRequest({ currentName: project.title, plots: own.map(plot => plot.name), items: members.map(node => node.title) })));
          if (reply && reply !== 'KEEP' && reply !== project.title) renames.push({ kind: 'project', id: project.id, from: project.title, to: reply, ticked: true });
        }
      }
      if (chosen.regroup) {
        const open = own.filter(plot => !plot.locked), locked = new Set(own.filter(plot => plot.locked).flatMap(plot => plot.memberIds));
        const plotOf = new Map(own.flatMap(plot => plot.memberIds.map(member => [member, plot.id])));
        const sample = { project: project.title, plots: open.map(plot => ({ id: plot.id, name: plot.name })),
          items: members.filter(node => !locked.has(node.id)).map(node => ({ id: node.id, plot: plotOf.get(node.id) ?? null, ...evidence(node) })) };
        if (sample.items.length < 2) continue;
        for (const move of parseRegroupReply(await this.ask(buildRegroupRequest(sample)), sample))
          moves.push({ ...move, title: byId.get(move.itemId)!.title, plotName: move.newPlot ?? open.find(plot => plot.id === move.plotId)!.name });
      }
    }
    return { revision: state.revision, renames, regroup: moves };
  }

  /** Checks the preview's fingerprint and writes moves, names, archives and plots in one transaction, returning its receipt. */
  private apply(request: Extract<z.infer<typeof tidyRequestSchema>, { operation: 'apply' }>) {
    const context = this.context();
    return this.atomic((state, commit) => {
      this.inScope(state, request.projectId);
      const plots = this.plotsIn(state, request.projectId), list = this.list(state), byId = new Map(state.nodes.map(node => [node.id, node]));
      const input = { state, registry: this.control.registry, sizes: context.sizes, plots, projectId: request.projectId, now: this.clock(), regroup: request.regroup, archived: request.archives };
      if (tidyFingerprint(input, planTidy(input, request.options)) !== request.fingerprint) throw Object.assign(new Error('The map changed since this preview. Check the new preview and apply again.'), { code: 'TIDY_STALE' });
      // An item that got busy since the preview stays; the layout is planned again without archiving it.
      const finished = new Set(request.options.archive ? finishedItems(state.nodes, plots, this.clock(), request.projectId) : []);
      const archives = request.archives.filter(archived => finished.has(archived)), live = { ...input, archived: archives }, plan = planTidy(live, request.options);
      const skipped = request.archives.length - archives.length;
      const scope = new Set(this.projects(state, request.projectId).map(project => project.id));
      for (const row of request.renames) {
        const node = byId.get(row.id), plot = plots.find(entry => entry.id === row.id);
        const ok = !request.options.rename ? false : row.kind === 'item' ? node && scope.has(node.projectId ?? '') && this.renamable(state, node)
          : row.kind === 'project' ? scope.has(row.id) && machineNamed(node!) : plot && plot.source !== 'user' && !plot.locked;
        if (!ok) throw new Error('Some of these names changed since the preview. Check the new preview.');
      }
      if (request.regroup.length && !request.options.regroup) throw new Error('Regroup is off.');
      for (const pin of plan.pins) if (pin.memberIds.some(member => request.regroup.some(row => row.itemId === member) && byId.get(member)?.projectId !== pin.projectId)) throw new Error('Regroup never moves items between projects.');
      const batch = (moves: TidyPlan['moves']): WorkspaceCommand[] => [
        ...request.renames.filter(row => row.kind !== 'plot').map(row => row.kind === 'item'
          ? { type: 'node.title.generated' as const, id: row.id, title: row.to, sourceTitle: byId.get(row.id)!.title }
          : { type: 'node.update' as const, id: row.id, title: row.to }),
        ...moves.length ? [{ type: 'nodes.move' as const, positions: moves.map(move => ({ id: move.id, position: move.to })) }] : [],
        ...archives.map(archived => ({ type: 'node.archive' as const, id: archived })),
      ];
      // Checked on the map the moves really reach (solid collisions included): moves that would change a plot's members are dropped.
      let moves = plan.moves;
      for (;;) {
        const final = this.control.reduce(state, { commandId: randomUUID(), expectedRevision: state.revision, actor: TIDY_ACTOR, commands: batch(moves) });
        const drift = tidyDrift(live, request.options, { ...plan, moves }, final), off = new Set(drift.membership), kept = moves.filter(move => !off.has(move.id));
        if (off.size && kept.length < moves.length) { moves = kept; continue; }
        if (off.size) throw new Error('Tidy would change which items belong to a plot, so nothing changed.');
        if (drift.unsettled.length) throw new Error('Tidy could not settle this layout, so nothing changed.');
        break;
      }
      const commands = batch(moves), plotNames = request.renames.filter(row => row.kind === 'plot');
      if (!commands.length && !plan.colors.length && !plan.pins.length && !plotNames.length) return { revision: state.revision, moved: [], created: [], skipped };
      const after = this.land(commit, state, commands), created = this.writePlots(plan, request.renames, request.regroup);
      this.plots.invalidate();
      const touched = new Set([...plan.colors.map(change => change.plotId), ...plan.pins.map(pin => created.get(pin.plotId) ?? pin.plotId), ...plotNames.map(row => row.id)]);
      const pick = (snaps: ReturnType<typeof plotSnap>[]) => snaps.filter(plot => touched.has(plot.id));
      const step = buildUndoStep('Tidy', state, after, context, { before: pick(list.map(plotSnap)), after: pick(this.list(after).map(plotSnap)) }, commandSubjects(commands));
      return { revision: after.revision, moved: moves.map(move => move.id), created: [...created.values()], skipped, ...step ? { receipt: { items: step.items, links: step.links, plots: step.plots } } : {} };
    });
  }
  /** Colours, pins, new plots and plot names, in one store transaction; returns new plot ids by their `new:` key. */
  private writePlots(plan: TidyPlan, renames: readonly z.infer<typeof rename>[], rows: readonly TidyRegroup[]) {
    const created = new Map<string, string>(), now = this.clock();
    for (const pin of plan.pins) if (pin.plotId.startsWith('new:')) created.set(pin.plotId, randomUUID());
    const names = new Map(renames.filter(row => row.kind === 'plot').map(row => [row.id, row.to]));
    for (const row of rows) if (row.newPlot) names.set(created.get(newPlotKey(row.newPlot)) ?? '', row.newPlot);
    names.delete('');
    this.store.writeTidyPlots({ colors: new Map(plan.colors.map(change => [change.plotId, change.to])), pins: plan.pins.map(pin => ({ ...pin, plotId: created.get(pin.plotId) ?? pin.plotId, create: created.has(pin.plotId) })), names }, now);
    return created;
  }

  /** Map undo and redo (MAP-34): checks each change against the current map and puts back what still holds, in one transaction. */
  private revert(step: UndoStep, direction: 'undo' | 'redo') {
    const context = this.context();
    return this.atomic((state, commit) => {
      const simulate = (commands: WorkspaceCommand[]) => this.control.reduce(state, { commandId: randomUUID(), expectedRevision: state.revision, actor: TIDY_ACTOR, commands });
      const reversal = planReversal(step, state, this.list(state).map(plotSnap), context, direction, simulate, current => layoutFootprints(current.nodes, current.resources, context.registry, context.sizes));
      if (!reversal.applied) return { revision: state.revision, reverted: 0, skipped: reversal.skipped };
      const after = this.land(commit, state, reversal.commands);
      if (reversal.plots.length || reversal.removePlots.length) { this.store.restorePlots(reversal.plots, reversal.removePlots, this.clock()); this.plots.invalidate(); }
      // The other direction gets what this commit really did to each item, never what was aimed for.
      const ids = new Set(reversal.applied.items.map(item => item.id)), done = buildUndoStep(step.label, state, after, context, undefined, ids)?.items.filter(item => ids.has(item.id)) ?? [];
      const items = direction === 'undo' ? done.map(item => ({ id: item.id, before: item.after, after: item.before })) : done;
      return { revision: after.revision, applied: { ...reversal.applied, items }, reverted: reversal.reverted, skipped: reversal.skipped };
    });
  }
}
