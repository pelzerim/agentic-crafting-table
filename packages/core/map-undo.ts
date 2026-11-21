import type { WorkspaceCommand, WorkspaceState } from './control.ts';
import { resolveMapSize } from './item-map-sizes.ts';
import type { ItemMapSizes } from './item-map-sizes.ts';
import type { ResourcePluginRegistry } from '../../src/resource-plugins/registry.ts';
import type { PlotView } from '../../src/graph/plots.ts';
import { ITEM_GAP, layoutFootprints } from '../../src/graph/movement.ts';
import { overlaps } from '../../src/graph/spatial.ts';
import { isOffMap } from '../../src/graph/archive.ts';
import type { SpatialBox } from '../../src/graph/spatial.ts';

/** Map undo (MAP-34): steps live per window, in memory, and are gone on restart. */
export const UNDO_LIMIT = 50;
/** The actor an undo or redo commits as: the person's map, but never a new step of its own. */
export const UNDO_ACTOR = { kind: 'user', id: 'map-undo' } as const;
type Position = { x: number; y: number };
type Link = WorkspaceState['links'][number];
type ItemSize = NonNullable<WorkspaceState['nodes'][number]['mapSize']>;
/** `size` is the resolved preset, `mapSize` the one the item itself holds (absent while it follows the default). */
export interface ItemSnap { position: Position; projectId: string | null; size?: ItemSize; mapSize?: ItemSize; mapDimensions?: { width: number; height: number }; archived: boolean }
/** The plot fields a step can change; `name` is absent while the plot shows its local name. */
export interface PlotSnap { id: string; projectId: string; name?: string; generated: boolean; color: string; chosenColor?: string; pinnedMemberIds: string[]; locked: boolean; lockPinnedIds?: string[] }
export interface UndoStep {
  label: string;
  /** `members`: a project's items while archived, at most UNDO_MEMBER_CAP; archiving it again needs the same ones. */
  items: { id: string; before: ItemSnap; after: ItemSnap; members?: string[] }[];
  links: { before?: Link; after?: Link }[];
  /** `before` is absent for a plot the step created, `after` for one it removed. */
  plots: { id: string; before?: PlotSnap; after?: PlotSnap }[];
  /** Unmoved items the moved ones overlapped before the step, where they stood; undo may overlap them again. */
  anchors?: { id: string; position: Position }[];
  /** [moved item, item it overlapped before the step]; a moved item with no pair here is never placed onto another. */
  pairs?: [string, string][];
}
export const UNDO_ANCHOR_CAP = 500, UNDO_PAIR_CAP = 1000, UNDO_MEMBER_CAP = 2000;
/** Only the plot fields a step changed; `null` clears one, `create` brings back a plot the step made. */
export interface PlotPatch { id: string; projectId: string; create?: true; name?: string | null; generated?: boolean; color?: string; chosenColor?: string | null; pinnedMemberIds?: string[]; locked?: boolean; lockPinnedIds?: string[] | null }
export interface Reversal {
  commands: WorkspaceCommand[];
  /** Items set exactly at these positions after `commands`, overlapping only the step's anchors (`placeExactly`). */
  place: { id: string; position: Position }[];
  /** Items whose preset goes back to following the default after `commands` (`clearMapSizes`). */
  unsize: string[];
  /** The part of the step that was put back; absent when nothing was. */
  applied?: UndoStep;
  plots: PlotPatch[];
  /** Plots the step created, removed on undo. */
  removePlots: string[];
  reverted: number;
  skipped: number;
}
const ITEM_FIELDS = ['position', 'projectId', 'size', 'mapSize', 'mapDimensions', 'archived'] as const;
const PLOT_FIELDS = ['projectId', 'name', 'generated', 'color', 'chosenColor', 'pinnedMemberIds', 'locked', 'lockPinnedIds'] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const near = (a: Position | undefined, b: Position) => a !== undefined && Math.abs(a.x - b.x) < .5 && Math.abs(a.y - b.y) < .5;

export interface SnapContext { registry: ResourcePluginRegistry; sizes?: ItemMapSizes }
export function itemSnap(node: WorkspaceState['nodes'][number], state: Pick<WorkspaceState, 'resources'>, context: SnapContext): ItemSnap {
  const record = node.resourceId ? state.resources.find(resource => resource.id === node.resourceId) : undefined;
  const size = record && !node.mapDimensions ? resolveMapSize(node, record, context.registry.get(record.pluginId), context.sizes).size as ItemSize : undefined;
  return { position: node.position, projectId: node.projectId ?? null, ...size ? { size } : {}, ...node.mapSize && !node.mapDimensions ? { mapSize: node.mapSize } : {}, ...node.mapDimensions ? { mapDimensions: node.mapDimensions } : {},
    archived: Boolean(node.archivedAt) };
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
    if (!ITEM_FIELDS.some(field => !same(from[field], to[field]))) return [];
    const members = !node.resourceId && from.archived !== to.archived ? (to.archived ? after : before).nodes.filter(member => member.projectId === node.id).map(member => member.id).sort() : undefined;
    return [{ id: node.id, before: from, after: to, ...members && members.length <= UNDO_MEMBER_CAP ? { members } : {} }];
  });
  const linksBefore = new Map(before.links.map(link => [link.id, link])), linksAfter = new Map(after.links.map(link => [link.id, link]));
  const links = [...new Set([...linksBefore.keys(), ...linksAfter.keys()])].flatMap(id => same(linksBefore.get(id), linksAfter.get(id)) ? [] : [{ before: linksBefore.get(id), after: linksAfter.get(id) }]);
  const plotsBefore = new Map(plots.before.map(plot => [plot.id, plot])), plotsAfter = new Map(plots.after.map(plot => [plot.id, plot]));
  const plotChanges = [...new Set([...plotsBefore.keys(), ...plotsAfter.keys()])].flatMap(id => {
    const old = plotsBefore.get(id), now = plotsAfter.get(id);
    return old && now && PLOT_FIELDS.every(field => same(old[field], now[field])) ? [] : [{ id, ...old ? { before: old } : {}, ...now ? { after: now } : {} }];
  });
  const { anchors, pairs } = overlapPairs(before, context, items);
  return items.length || links.length || plotChanges.length ? { label, items, links, plots: plotChanges, ...pairs.length ? { anchors, pairs } : {} } : undefined;
}

/** Overlaps of each moved item's old footprint (an older layout Clear overlaps repaired); an item past the caps records none. */
function overlapPairs(before: Pick<WorkspaceState, 'nodes' | 'resources'>, context: SnapContext, items: UndoStep['items']) {
  const moved = new Set(items.filter(item => !same(item.before.position, item.after.position)).map(item => item.id));
  const anchors = new Map<string, Position>(), pairs: [string, string][] = [];
  if (!moved.size) return { anchors: [], pairs };
  const boxes = layoutFootprints(before.nodes, before.resources, context.registry, context.sizes), byId = new Map(before.nodes.map(node => [node.id, node]));
  for (const box of boxes.filter(box => moved.has(box.id))) {
    const hits = boxes.filter(other => other.id !== box.id && overlaps(box, other, ITEM_GAP)), added = hits.filter(other => !moved.has(other.id) && !anchors.has(other.id));
    if (anchors.size + added.length > UNDO_ANCHOR_CAP || pairs.length + hits.length > UNDO_PAIR_CAP) continue;
    for (const other of added) anchors.set(other.id, byId.get(other.id)!.position);
    for (const other of hits) pairs.push([box.id, other.id]);
  }
  return { anchors: [...anchors].map(([id, position]) => ({ id, position })), pairs };
}

/** `state` with these items set at exactly these positions, with no collision handling. */
export function placeExactly<T extends Pick<WorkspaceState, 'nodes'>>(state: T, place: readonly { id: string; position: Position }[]): T {
  if (!place.length) return state;
  const at = new Map(place.map(entry => [entry.id, entry.position]));
  return { ...state, nodes: state.nodes.map(node => at.has(node.id) ? { ...node, position: at.get(node.id)! } : node) };
}

/** `state` with these items following their default preset again; `node.resize` can only set one. */
export function clearMapSizes<T extends Pick<WorkspaceState, 'nodes'>>(state: T, ids: readonly string[]): T {
  if (!ids.length) return state;
  const clear = new Set(ids);
  return { ...state, nodes: state.nodes.map(node => clear.has(node.id) && node.mapSize ? (({ mapSize: _, ...rest }) => rest)(node) : node) };
}

/** Item fields an undo guards and restores together. */
const GROUPS = { position: ['position'], projectId: ['projectId'], size: ['size', 'mapSize', 'mapDimensions'], archived: ['archived'] } as const satisfies Record<string, readonly (keyof ItemSnap)[]>;
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
  const drop = (id: string, groups = GROUP_NAMES) => {
    const own = eligible.get(id);
    if (!own) return;
    for (const group of groups) own.delete(group);
    skipped.add(id);
    if (!own.size) eligible.delete(id);
  };
  // Putting an item back into a project archived, sent to Undermap or gone since would take it off the map, so it stays where it is.
  const restoring = new Set([...eligible].filter(([id, groups]) => groups.has('archived') && !toOf.get(id)!.archived).map(([id]) => id));
  for (const [id, groups] of [...eligible]) {
    const projectId = toOf.get(id)!.projectId, project = projectId ? nodes.get(projectId) : undefined;
    if (groups.has('projectId') && projectId && (!project || (restoring.has(projectId) ? Boolean(project.belowAt) : isOffMap(project, current.nodes)))) drop(id);
  }
  // Archiving a project again hides its items, so it runs only while they are the ones the step archived.
  for (const [id, groups] of [...eligible]) {
    if (!groups.has('archived') || !toOf.get(id)!.archived || nodes.get(id)?.resourceId) continue;
    const members = step.items.find(change => change.id === id)!.members;
    if (!members || !same(members, current.nodes.filter(node => node.projectId === id).map(node => node.id).sort())) drop(id, ['archived']);
  }
  // Items placed exactly, before any simulation: nodes.move refuses a request whose positions overlap.
  const exact = new Set<string>();
  // Projects before their items: an item cannot be restored while its project is still archived.
  const projectsFirst = (a: string, b: string) => Number(Boolean(nodes.get(a)?.resourceId)) - Number(Boolean(nodes.get(b)?.resourceId));
  const build = (only?: ReadonlySet<string>) => {
    const restore: string[] = [], attach: WorkspaceCommand[] = [], resize: WorkspaceCommand[] = [], archive: WorkspaceCommand[] = [];
    const positions: { id: string; position: Position }[] = [];
    for (const [id, groups] of eligible) {
      if (only && !only.has(id)) continue;
      const to = toOf.get(id)!, node = nodes.get(id)!;
      if (groups.has('archived')) { if (to.archived) archive.push({ type: 'node.archive', id }); else restore.push(id); }
      if (groups.has('projectId')) attach.push({ type: 'node.attach', id, projectId: to.projectId });
      if (groups.has('size')) resize.push(to.mapDimensions ? { type: 'node.resize', id, dimensions: to.mapDimensions, position: groups.has('position') ? to.position : node.position } : { type: 'node.resize', id, size: to.size });
      if (groups.has('position') && !exact.has(id)) positions.push({ id, position: to.position });
    }
    // One restore for the whole group, so placement sees each project with its returning items.
    return [...restore.length ? [{ type: 'nodes.action' as const, ids: restore, action: 'restore' as const }] : [], ...attach, ...resize, ...positions.length ? [{ type: 'nodes.move' as const, positions }] : [], ...archive];
  };
  // An item goes back onto what it overlapped only while every one of those is in place or placed with it.
  const anchored = new Set((step.anchors ?? []).filter(anchor => near(nodes.get(anchor.id)?.position, anchor.position)).map(anchor => anchor.id));
  const partners = new Map<string, Set<string>>();
  for (const [id, other] of back ? step.pairs ?? [] : []) partners.set(id, (partners.get(id) ?? new Set()).add(other));
  // A project with no members at all is a footprint of its own, so it can be placed exactly too.
  const standalone = (id: string) => Boolean(nodes.get(id)?.resourceId) || (nodes.has(id) && !current.nodes.some(node => node.projectId === id));
  const only = (id: string) => eligible.get(id)?.size === 1 && eligible.get(id)!.has('position') && standalone(id);
  for (const id of partners.keys()) if (only(id)) exact.add(id);
  const placed = (id: string) => exact.has(id) && Boolean(eligible.get(id)?.has('position'));
  const paired = (a: string, b: string) => Boolean(partners.get(a)?.has(b) || partners.get(b)?.has(a));
  const settleExact = () => {
    for (let lost = true; lost;) {
      lost = false;
      for (const id of exact) if (placed(id) && [...partners.get(id)!].some(other => !anchored.has(other) && !placed(other))) { drop(id); lost = true; }
    }
  };
  settleExact();
  const place = () => [...exact].filter(id => eligible.get(id)?.has('position')).map(id => ({ id, position: toOf.get(id)!.position }));
  const runs = (commands: WorkspaceCommand[]) => { try { return placeExactly(simulate(commands), place()); } catch { return undefined; } };
  // A change that can no longer run (its project archived, a link end deleted) is skipped; projects go first so their items can follow.
  if (eligible.size && !runs(build())) {
    const kept = new Set<string>();
    for (const id of [...eligible.keys()].sort(projectsFirst)) {
      kept.add(id);
      if (!runs(build(kept))) { kept.delete(id); drop(id); }
    }
  }
  const aim = (id: string) => eligible.get(id)!.has('position') ? toOf.get(id)!.position : nodes.get(id)!.position;
  // Items outside the reversal are fixed: whatever would push one, or cannot reach its exact spot, keeps its place instead.
  const blocks = (box: SpatialBox, other: SpatialBox) => box.id !== other.id && overlaps(box, other, ITEM_GAP) && !(placed(box.id) && paired(box.id, other.id) && (anchored.has(other.id) || placed(other.id)));
  for (let round = 0; round <= step.items.length; round++) {
    settleExact();
    const movers = new Set([...eligible].filter(([id, groups]) => [...groups].some(group => placing(group, toOf.get(id)!))).map(([id]) => id));
    if (!movers.size) break;
    const simulated = runs(build()), after = new Map(simulated?.nodes.map(node => [node.id, node]));
    const pushed = current.nodes.filter(node => !movers.has(node.id) && !same(node.position, after.get(node.id)?.position));
    const unreached = [...movers].filter(id => !near(after.get(id)?.position, aim(id)));
    // Collision handling never sees an exactly placed item, so its overlaps are checked here.
    const landed = simulated ? footprints(simulated) : [], stacked = landed.filter(box => exact.has(box.id) && movers.has(box.id) && landed.some(other => blocks(box, other))).map(box => box.id);
    if (simulated && !pushed.length && !unreached.length && !stacked.length) break;
    const fixed = footprints(current).filter(box => !movers.has(box.id));
    const aimed = simulated ? footprints({ ...simulated, nodes: simulated.nodes.map(node => movers.has(node.id) ? { ...node, position: aim(node.id) } : node) }).filter(box => movers.has(box.id)) : [];
    const culprits = new Set([...aimed.filter(box => fixed.some(other => blocks(box, other))).map(box => box.id),
      ...pushed.flatMap(node => node.projectId && movers.has(node.projectId) ? [node.projectId] : [])]);
    for (const id of culprits.size ? culprits : stacked.length ? stacked : unreached.length ? unreached : movers) drop(id, GROUP_NAMES.filter(group => placing(group, toOf.get(id)!)));
  }
  const links: WorkspaceCommand[] = [], appliedLinks: UndoStep['links'] = [], items = build();
  for (const change of step.links) {
    const from = back ? change.after : change.before, to = back ? change.before : change.after, id = (from ?? to)!.id;
    const command: WorkspaceCommand = to ? { type: 'link.save', link: to } : { type: 'link.remove', id };
    if (!same(current.links.find(link => link.id === id), from) || !runs([...items, ...links, command])) { skipped.add(`link:${id}`); continue; }
    appliedLinks.push(change); links.push(command);
  }
  const chosen: { change: UndoStep['plots'][number]; from?: PlotSnap; to?: PlotSnap; now?: PlotSnap; fields: (typeof PLOT_FIELDS)[number][] }[] = [], shown = new Map(currentPlots.map(plot => [plot.id, plot]));
  const final = new Map(runs([...items, ...links])?.nodes.map(node => [node.id, node]));
  // A plot goes back to a project only with its members, and never into one archived since; an archived pin stays dormant wherever it is.
  const strands = (from: PlotSnap | undefined, to: PlotSnap) => {
    const project = final.get(to.projectId), followers = new Set(step.items.filter(change => (back ? change.before : change.after).projectId === to.projectId && (back ? change.after : change.before).projectId === from?.projectId).map(change => change.id));
    return !project || Boolean(project.archivedAt) || [...to.pinnedMemberIds, ...followers].some(id => final.has(id) && final.get(id)!.projectId !== to.projectId && (followers.has(id) || !final.get(id)!.archivedAt));
  };
  for (const change of step.plots) {
    const from = back ? change.after : change.before, to = back ? change.before : change.after, now = shown.get(change.id);
    const fields = PLOT_FIELDS.filter(field => !same(change.before?.[field], change.after?.[field]));
    // A plot locked or unlocked since the step is the person's later word on it.
    if (from ? !now || [...fields, 'locked' as const].some(field => !same(now[field], from[field])) : now !== undefined) { skipped.add(`plot:${change.id}`); continue; }
    if (to && fields.includes('projectId') && strands(from, to)) { skipped.add(`plot:${change.id}`); continue; }
    chosen.push({ change, from, to, now, fields });
  }
  // Pins never take an item from a plot outside the reversal, nor pin one whose own change was skipped.
  const applying = new Set(chosen.map(entry => entry.change.id)), elsewhere = new Set(currentPlots.filter(plot => !applying.has(plot.id)).flatMap(plot => plot.pinnedMemberIds));
  const plots: PlotPatch[] = [], removePlots: string[] = [], appliedPlots: UndoStep['plots'] = [];
  for (const { change, from, to, now, fields } of chosen) {
    const had = new Set(from?.pinnedMemberIds), fits = (id: string) => had.has(id) || (!elsewhere.has(id) && !skipped.has(id));
    const pins = to && fields.includes('pinnedMemberIds') ? to.pinnedMemberIds.filter(id => fits(id) || (skipped.add(id), false)) : undefined, lockPins = pins && to?.lockPinnedIds?.filter(id => pins.includes(id));
    const kept = to && pins ? { ...to, pinnedMemberIds: pins, ...lockPins?.length ? { lockPinnedIds: lockPins } : { lockPinnedIds: undefined } } : to;
    appliedPlots.push(!kept ? change : back ? { ...change, before: kept } : { ...change, after: kept });
    if (!kept) removePlots.push(change.id);
    else plots.push(from ? { id: change.id, projectId: (now ?? kept).projectId, ...Object.fromEntries(fields.map(field => [field, kept[field] ?? null])) } : { ...kept, create: true });
  }
  // The step left for the other direction holds only what was put back, so redo never replays a skipped change.
  const appliedItems = step.items.flatMap(change => {
    const groups = eligible.get(change.id);
    if (!groups) return [];
    const fields = [...groups].flatMap(group => GROUPS[group]);
    return [{ id: change.id, before: { ...change.after, ...Object.fromEntries(fields.map(field => [field, change.before[field]])) } as ItemSnap, after: change.after, ...change.members ? { members: change.members } : {} }];
  });
  const reverted = appliedItems.length + appliedLinks.length + appliedPlots.length;
  const unsize = [...eligible].filter(([id, groups]) => groups.has('size') && !toOf.get(id)!.mapSize && !toOf.get(id)!.mapDimensions).map(([id]) => id);
  return { commands: [...items, ...links], place: place(), unsize, plots, removePlots, reverted, skipped: skipped.size,
    ...reverted ? { applied: { label: step.label, items: appliedItems, links: appliedLinks, plots: appliedPlots, ...step.pairs ? { anchors: step.anchors ?? [], pairs: step.pairs } : {} } } : {} };
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
  /** Counts recorded changes, so an undo that lands after one knows its redo is stale. */
  recorded = 0;
  record(step: UndoStep | undefined) { if (!step) return; this.done.push(step); if (this.done.length > UNDO_LIMIT) this.done.shift(); this.undone = []; this.recorded++; }
  peek(direction: 'undo' | 'redo') { return (direction === 'undo' ? this.done : this.undone).at(-1); }
  holds(direction: 'undo' | 'redo', step: UndoStep) { return (direction === 'undo' ? this.done : this.undone).includes(step); }
  /** Takes `step` off its list, wherever a change made meanwhile left it, and files what was put back on the other. */
  settle(direction: 'undo' | 'redo', step: UndoStep, applied?: UndoStep) {
    const from = direction === 'undo' ? this.done : this.undone, to = direction === 'undo' ? this.undone : this.done, at = from.lastIndexOf(step);
    if (at >= 0) from.splice(at, 1);
    if (applied) { to.push(applied); if (to.length > UNDO_LIMIT) to.shift(); }
  }
  get sizes() { return { undo: this.done.length, redo: this.undone.length }; }
}
