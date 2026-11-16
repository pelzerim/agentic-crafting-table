import type { WorkspaceCommand, WorkspaceState } from './control.ts';
import { resolveMapSize } from './item-map-sizes.ts';
import type { ItemMapSizes } from './item-map-sizes.ts';
import type { ResourcePluginRegistry } from '../../src/resource-plugins/registry.ts';
import type { PlotView } from '../../src/graph/plots.ts';
import { ITEM_GAP } from '../../src/graph/movement.ts';
import { overlaps } from '../../src/graph/spatial.ts';
import type { SpatialBox } from '../../src/graph/spatial.ts';

/** Map undo (MAP-34): steps live per window, in memory, and are gone on restart. */
export const UNDO_LIMIT = 50;
type Position = { x: number; y: number };
type Link = WorkspaceState['links'][number];
type ItemSize = NonNullable<WorkspaceState['nodes'][number]['mapSize']>;
export interface ItemSnap { position: Position; projectId: string | null; size?: ItemSize; mapDimensions?: { width: number; height: number }; archived: boolean; title: string; machineTitle: boolean }
/** The plot fields a step can change; `name` is absent while the plot shows its local name. */
export interface PlotSnap { id: string; projectId: string; name?: string; generated: boolean; color: string; chosenColor?: string; pinnedMemberIds: string[]; locked: boolean }
export interface UndoStep {
  label: string;
  items: { id: string; before: ItemSnap; after: ItemSnap }[];
  links: { before?: Link; after?: Link }[];
  /** `before` is absent for a plot the step created. */
  plots: { id: string; before?: PlotSnap; after: PlotSnap }[];
}
/** Only the plot fields a step changed; `null` clears one, `create` brings back a plot the step made. */
export interface PlotPatch { id: string; projectId: string; create?: true; name?: string | null; generated?: boolean; color?: string; chosenColor?: string | null; pinnedMemberIds?: string[] }
export interface Reversal {
  commands: WorkspaceCommand[];
  /** The part of the step that was put back; absent when nothing was. */
  applied?: UndoStep;
  plots: PlotPatch[];
  /** Plots the step created, removed on undo. */
  removePlots: string[];
  reverted: number;
  skipped: number;
}
const ITEM_FIELDS = ['position', 'projectId', 'size', 'mapDimensions', 'archived', 'title'] as const;
const PLOT_FIELDS = ['name', 'generated', 'color', 'chosenColor', 'pinnedMemberIds'] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const near = (a: Position | undefined, b: Position) => a !== undefined && Math.abs(a.x - b.x) < .5 && Math.abs(a.y - b.y) < .5;

export interface SnapContext { registry: ResourcePluginRegistry; sizes?: ItemMapSizes }
export function itemSnap(node: WorkspaceState['nodes'][number], state: Pick<WorkspaceState, 'resources'>, context: SnapContext): ItemSnap {
  const record = node.resourceId ? state.resources.find(resource => resource.id === node.resourceId) : undefined;
  const size = record && !node.mapDimensions ? resolveMapSize(node, record, context.registry.get(record.pluginId), context.sizes).size as ItemSize : undefined;
  return { position: node.position, projectId: node.projectId ?? null, ...size ? { size } : {}, ...node.mapDimensions ? { mapDimensions: node.mapDimensions } : {},
    archived: Boolean(node.archivedAt), title: node.title, machineTitle: node.generatedTitle === node.title };
}
export function plotSnap(plot: PlotView): PlotSnap {
  return { id: plot.id, projectId: plot.projectId, ...plot.source === 'local' ? {} : { name: plot.name }, generated: plot.source === 'generated', color: plot.color,
    ...plot.chosenColor ? { chosenColor: plot.chosenColor } : {}, pinnedMemberIds: [...plot.pinnedMemberIds].sort(), locked: Boolean(plot.locked) };
}

/** Ids a batch names; any other item it changed was displaced by collision handling. */
export function commandSubjects(commands: readonly WorkspaceCommand[]): Set<string> {
  const ids = new Set<string>();
  for (const command of commands as readonly Record<string, unknown>[]) {
    if (typeof command.id === 'string') ids.add(command.id);
    if (Array.isArray(command.ids)) for (const id of command.ids) if (typeof id === 'string') ids.add(id);
    if (Array.isArray(command.positions)) for (const entry of command.positions as { id: string }[]) ids.add(entry.id);
  }
  return ids;
}

/** What one commit changed; an item it did not name, and whose project stayed, records only its position. */
export function buildUndoStep(label: string, before: Pick<WorkspaceState, 'nodes' | 'resources' | 'links'>, after: Pick<WorkspaceState, 'nodes' | 'resources' | 'links'>, context: SnapContext,
  plots: { before: readonly PlotSnap[]; after: readonly PlotSnap[] } = { before: [], after: [] }, named?: ReadonlySet<string>): UndoStep | undefined {
  const earlier = new Map(before.nodes.map(node => [node.id, node]));
  const items = after.nodes.flatMap(node => {
    const old = earlier.get(node.id);
    if (!old) return [];
    const from = itemSnap(old, before, context), to = itemSnap(node, after, context);
    if (named && !named.has(node.id) && same(from.projectId, to.projectId)) return same(from.position, to.position) ? [] : [{ id: node.id, before: { ...to, position: from.position }, after: to }];
    return ITEM_FIELDS.some(field => !same(from[field], to[field])) ? [{ id: node.id, before: from, after: to }] : [];
  });
  const linksBefore = new Map(before.links.map(link => [link.id, link])), linksAfter = new Map(after.links.map(link => [link.id, link]));
  const links = [...new Set([...linksBefore.keys(), ...linksAfter.keys()])].flatMap(id => same(linksBefore.get(id), linksAfter.get(id)) ? [] : [{ before: linksBefore.get(id), after: linksAfter.get(id) }]);
  const plotsBefore = new Map(plots.before.map(plot => [plot.id, plot]));
  const plotChanges = plots.after.flatMap(plot => { const old = plotsBefore.get(plot.id); return old && PLOT_FIELDS.every(field => same(old[field], plot[field])) ? [] : [{ id: plot.id, ...old ? { before: old } : {}, after: plot }]; });
  return items.length || links.length || plotChanges.length ? { label, items, links, plots: plotChanges } : undefined;
}

/** Item fields an undo guards and restores together. */
const GROUPS = { position: ['position'], projectId: ['projectId'], size: ['size', 'mapDimensions'], archived: ['archived'], title: ['title'] } as const satisfies Record<string, readonly (keyof ItemSnap)[]>;
type Group = keyof typeof GROUPS;
const GROUP_NAMES = Object.keys(GROUPS) as Group[];
/** Groups that place an item on the map, where it could land on another item. */
const placing = (group: Group, to: ItemSnap) => group === 'position' || group === 'size' || (group === 'archived' && !to.archived);
type Footprints = (state: Pick<WorkspaceState, 'nodes' | 'resources'>) => SpatialBox[];

/** Undo or redo of a step on the current map: per-field guards, and items outside it are never pushed. */
export function planReversal(step: UndoStep, current: Pick<WorkspaceState, 'nodes' | 'resources' | 'links'>, currentPlots: readonly PlotSnap[], context: SnapContext, direction: 'undo' | 'redo',
  simulate: (commands: WorkspaceCommand[]) => Pick<WorkspaceState, 'nodes' | 'resources'>, footprints: Footprints): Reversal {
  const back = direction === 'undo', nodes = new Map(current.nodes.map(node => [node.id, node]));
  const eligible = new Map<string, Set<Group>>(), skipped = new Set<string>();
  for (const change of step.items) {
    const from = back ? change.after : change.before, node = nodes.get(change.id), now = node && itemSnap(node, current, context);
    const changed = GROUP_NAMES.filter(group => GROUPS[group].some(field => !same(change.before[field], change.after[field])));
    const ok = now ? changed.filter(group => GROUPS[group].every(field => same(now[field], from[field]))) : [];
    if (ok.length < changed.length) skipped.add(change.id);
    if (ok.length) eligible.set(change.id, new Set(ok));
  }
  const toOf = new Map(step.items.map(change => [change.id, back ? change.before : change.after]));
  const build = (only?: ReadonlySet<string>) => {
    const restore: WorkspaceCommand[] = [], attach: WorkspaceCommand[] = [], resize: WorkspaceCommand[] = [], titles: WorkspaceCommand[] = [], archive: WorkspaceCommand[] = [];
    const positions: { id: string; position: Position }[] = [];
    for (const [id, groups] of eligible) {
      if (only && !only.has(id)) continue;
      const to = toOf.get(id)!, node = nodes.get(id)!;
      if (groups.has('archived')) (to.archived ? archive : restore).push({ type: to.archived ? 'node.archive' : 'node.restore', id });
      if (groups.has('projectId')) attach.push({ type: 'node.attach', id, projectId: to.projectId });
      if (groups.has('size')) resize.push(to.mapDimensions ? { type: 'node.resize', id, dimensions: to.mapDimensions, position: groups.has('position') ? to.position : node.position } : { type: 'node.resize', id, size: to.size });
      if (groups.has('title')) titles.push(to.machineTitle && to.title.length <= 48 ? { type: 'node.title.generated', id, title: to.title, sourceTitle: node.title } : { type: 'node.update', id, title: to.title });
      if (groups.has('position')) positions.push({ id, position: to.position });
    }
    return [...restore, ...attach, ...resize, ...titles, ...positions.length ? [{ type: 'nodes.move' as const, positions }] : [], ...archive];
  };
  const runs = (commands: WorkspaceCommand[]) => { try { return simulate(commands); } catch { return undefined; } };
  const drop = (id: string, groups = GROUP_NAMES) => {
    const own = eligible.get(id);
    if (!own) return;
    for (const group of groups) own.delete(group);
    skipped.add(id);
    if (!own.size) eligible.delete(id);
  };
  // A change that can no longer run (its project archived, a link end deleted) is skipped; projects go first so their items can follow.
  if (eligible.size && !runs(build())) {
    const kept = new Set<string>();
    for (const id of [...eligible.keys()].sort((a, b) => Number(Boolean(nodes.get(a)?.resourceId)) - Number(Boolean(nodes.get(b)?.resourceId)))) {
      kept.add(id);
      if (!runs(build(kept))) { kept.delete(id); drop(id); }
    }
  }
  // Items outside the reversal are fixed: whatever would push one, or cannot reach its exact spot, keeps its place instead.
  const aim = (id: string) => eligible.get(id)!.has('position') ? toOf.get(id)!.position : nodes.get(id)!.position;
  for (let round = 0; round <= step.items.length; round++) {
    const movers = new Set([...eligible].filter(([id, groups]) => [...groups].some(group => placing(group, toOf.get(id)!))).map(([id]) => id));
    if (!movers.size) break;
    const simulated = runs(build()), after = new Map(simulated?.nodes.map(node => [node.id, node]));
    const pushed = current.nodes.filter(node => !movers.has(node.id) && !same(node.position, after.get(node.id)?.position));
    const unreached = [...movers].filter(id => !near(after.get(id)?.position, aim(id)));
    if (simulated && !pushed.length && !unreached.length) break;
    const fixed = footprints(current).filter(box => !movers.has(box.id));
    const aimed = simulated ? footprints({ ...simulated, nodes: simulated.nodes.map(node => movers.has(node.id) ? { ...node, position: aim(node.id) } : node) }).filter(box => movers.has(box.id)) : [];
    const culprits = new Set([...aimed.filter(box => fixed.some(other => overlaps(box, other, ITEM_GAP))).map(box => box.id),
      ...pushed.flatMap(node => node.projectId && movers.has(node.projectId) ? [node.projectId] : [])]);
    for (const id of culprits.size ? culprits : unreached.length ? unreached : movers) drop(id, GROUP_NAMES.filter(group => placing(group, toOf.get(id)!)));
  }
  const links: WorkspaceCommand[] = [], appliedLinks: UndoStep['links'] = [], items = build();
  for (const change of step.links) {
    const from = back ? change.after : change.before, to = back ? change.before : change.after, id = (from ?? to)!.id;
    const command: WorkspaceCommand = to ? { type: 'link.save', link: to } : { type: 'link.remove', id };
    if (!same(current.links.find(link => link.id === id), from) || !runs([...items, ...links, command])) { skipped.add(`link:${id}`); continue; }
    appliedLinks.push(change); links.push(command);
  }
  const chosen: { change: UndoStep['plots'][number]; from?: PlotSnap; to?: PlotSnap; fields: (typeof PLOT_FIELDS)[number][] }[] = [], shown = new Map(currentPlots.map(plot => [plot.id, plot]));
  for (const change of step.plots) {
    const from = back ? change.after : change.before, to = back ? change.before : change.after, now = shown.get(change.id);
    const fields = PLOT_FIELDS.filter(field => !same(change.before?.[field], change.after[field]));
    // A plot locked or unlocked since the step is the person's later word on it.
    if (from ? !now || [...fields, 'locked' as const].some(field => !same(now[field], from[field])) : now !== undefined) { skipped.add(`plot:${change.id}`); continue; }
    chosen.push({ change, from, to, fields });
  }
  // Pins never take an item from a plot outside the reversal, nor pin one whose own change was skipped.
  const applying = new Set(chosen.map(entry => entry.change.id)), elsewhere = new Set(currentPlots.filter(plot => !applying.has(plot.id)).flatMap(plot => plot.pinnedMemberIds));
  const plots: PlotPatch[] = [], removePlots: string[] = [], appliedPlots: UndoStep['plots'] = [];
  for (const { change, from, to, fields } of chosen) {
    const had = new Set(from?.pinnedMemberIds), fits = (id: string) => had.has(id) || (!elsewhere.has(id) && !skipped.has(id));
    const kept = to && fields.includes('pinnedMemberIds') ? { ...to, pinnedMemberIds: to.pinnedMemberIds.filter(id => fits(id) || (skipped.add(id), false)) } : to;
    appliedPlots.push(!kept ? change : back ? { ...change, before: kept } : { ...change, after: kept });
    if (!kept) removePlots.push(change.id);
    else plots.push(from ? { id: change.id, projectId: kept.projectId, ...Object.fromEntries(fields.map(field => [field, kept[field] ?? null])) } : { ...kept, create: true });
  }
  // The step left for the other direction holds only what was put back, so redo never replays a skipped change.
  const appliedItems = step.items.flatMap(change => {
    const groups = eligible.get(change.id);
    if (!groups) return [];
    const fields = [...groups].flatMap(group => group === 'title' ? ['title', 'machineTitle'] as const : GROUPS[group]);
    return [{ id: change.id, before: { ...change.after, ...Object.fromEntries(fields.map(field => [field, change.before[field]])) } as ItemSnap, after: change.after }];
  });
  const reverted = appliedItems.length + appliedLinks.length + appliedPlots.length;
  return { commands: [...items, ...links], plots, removePlots, reverted, skipped: skipped.size,
    ...reverted ? { applied: { label: step.label, items: appliedItems, links: appliedLinks, plots: appliedPlots } } : {} };
}

/** What a person's own commit did, for their undo history. */
export type Receipt = Omit<UndoStep, 'label'>;

/** The notice after an undo or redo. */
export function reversalNotice(step: UndoStep, reversal: Pick<Reversal, 'reverted' | 'skipped'>, direction: 'undo' | 'redo') {
  const verb = direction === 'undo' ? 'Undid' : 'Redid';
  if (!reversal.reverted) return `Nothing to ${direction}: ${step.label.toLowerCase()} was changed since`;
  if (!reversal.skipped) return `${verb} ${step.label.toLowerCase()}`;
  return `${verb} ${step.label.toLowerCase()} · ${reversal.skipped} ${reversal.skipped === 1 ? 'item' : 'items'} changed since, left in place`;
}

/** A per-window undo and redo history; a new change clears redo. */
export class UndoHistory {
  private done: UndoStep[] = [];
  private undone: UndoStep[] = [];
  record(step: UndoStep | undefined) { if (!step) return; this.done.push(step); if (this.done.length > UNDO_LIMIT) this.done.shift(); this.undone = []; }
  peek(direction: 'undo' | 'redo') { return (direction === 'undo' ? this.done : this.undone).at(-1); }
  /** Takes `step` off its list, wherever a change made meanwhile left it, and files what was put back on the other. */
  settle(direction: 'undo' | 'redo', step: UndoStep, applied?: UndoStep) {
    const from = direction === 'undo' ? this.done : this.undone, to = direction === 'undo' ? this.undone : this.done, at = from.lastIndexOf(step);
    if (at >= 0) from.splice(at, 1);
    if (applied) { to.push(applied); if (to.length > UNDO_LIMIT) to.shift(); }
  }
  get sizes() { return { undo: this.done.length, redo: this.undone.length }; }
}
