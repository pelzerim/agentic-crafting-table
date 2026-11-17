import type { WorkspaceState } from './control.ts';
import type { GraphLink } from '../../src/graph/graph.ts';
import type { ItemMapSizes } from './item-map-sizes.ts';
import type { ResourcePluginRegistry } from '../../src/resource-plugins/registry.ts';
import { isDrawn } from '../../src/graph/archive.ts';
import { needsMeIds } from '../../src/graph/atlas.ts';
import { mapBadges } from '../../src/graph/badges.ts';
import { freePosition, itemFootprint } from '../../src/graph/footprints.ts';
import { ITEM_GAP, layoutFootprints } from '../../src/graph/movement.ts';
import { PLOT_COLORS, PLOT_JOIN, PLOT_LEAVE, detectPlots, plotColor } from '../../src/graph/plots.ts';
import type { PlotBox, PlotColor, PlotView } from '../../src/graph/plots.ts';
import { plotMapOrder } from '../../src/graph/project-column.ts';
import { overlaps } from '../../src/graph/spatial.ts';
import { straightConnection } from '../../src/graph/straight-connection.ts';
import type { SpatialBox } from '../../src/graph/spatial.ts';

/** Inside a plot: MAP-13 clearance with room to spare, well under PLOT_JOIN. */
export const TIDY_GAP = 24;
/** Between the plots of a project: well over PLOT_LEAVE, so detection never merges them. */
export const TIDY_GUTTER = 160;
export const TIDY_FINISHED_DAYS = 3;
const ROW_TOLERANCE = 24, DAY = 86_400_000;

export interface TidyOptions { lineUp: boolean; spacePlots: boolean; colors: boolean; archive: boolean }
/** One item to another plot of its project: an existing one, or a new plot by name. */
export interface TidyRegroup { itemId: string; plotId?: string; newPlot?: string }
type Position = { x: number; y: number };
type Node = WorkspaceState['nodes'][number];
export interface TidyInput {
  state: Pick<WorkspaceState, 'nodes' | 'resources' | 'links'>;
  registry: ResourcePluginRegistry;
  sizes?: ItemMapSizes;
  plots: readonly PlotView[];
  /** The project to tidy; the whole board when absent. */
  projectId?: string;
  now: number;
  /** Ticked regroup rows: layout and pins follow them. */
  regroup?: readonly TidyRegroup[];
  /** Ticked archive rows: they leave the layout. */
  archived?: readonly string[];
}
export interface TidyPlan {
  moves: { id: string; from: Position; to: Position }[];
  colors: { plotId: string; from: PlotColor; to: PlotColor }[];
  /** Pins written in the same batch; `new:<project>:<name>` is a plot Regroup creates. */
  pins: { plotId: string; projectId: string; memberIds: string[] }[];
  /** Finished items Tidy may archive. */
  archives: string[];
}

export const newPlotKey = (projectId: string, name: string) => `new:${projectId}:${name}`;
const top = (box: SpatialBox) => box.y - box.height / 2, left = (box: SpatialBox) => box.x - box.width / 2;
const same = (a: Position, b: Position) => Math.abs(a.x - b.x) < .5 && Math.abs(a.y - b.y) < .5;

/** Reading order: rows by top (within a small tolerance), then left to right. */
export function readingOrder<T extends SpatialBox>(boxes: readonly T[]): T[] {
  const sorted = [...boxes].sort((a, b) => top(a) - top(b) || left(a) - left(b) || a.id.localeCompare(b.id)), rows: T[][] = [];
  for (const box of sorted) {
    const row = rows.at(-1);
    if (row && top(box) - top(row[0]) < ROW_TOLERANCE) row.push(box); else rows.push([box]);
  }
  return rows.flatMap(row => row.sort((a, b) => left(a) - left(b) || a.id.localeCompare(b.id)));
}

/** Top-left corners of a grid of `sizes` in order, columns as wide as their widest cell. */
function grid(sizes: readonly { width: number; height: number }[], origin: Position, gap: number): Position[] {
  const cols = Math.ceil(Math.sqrt(sizes.length)), widths: number[] = [], heights: number[] = [];
  sizes.forEach((size, i) => { const c = i % cols, r = Math.floor(i / cols); widths[c] = Math.max(widths[c] ?? 0, size.width); heights[r] = Math.max(heights[r] ?? 0, size.height); });
  const offset = (list: number[], index: number) => list.slice(0, index).reduce((sum, value) => sum + value + gap, 0);
  return sizes.map((_, i) => ({ x: origin.x + offset(widths, i % cols), y: origin.y + offset(heights, Math.floor(i / cols)) }));
}

function bounds(boxes: readonly SpatialBox[]) {
  const x0 = Math.min(...boxes.map(left)), y0 = Math.min(...boxes.map(top));
  const x1 = Math.max(...boxes.map(box => box.x + box.width / 2)), y1 = Math.max(...boxes.map(box => box.y + box.height / 2));
  return { x0, y0, width: x1 - x0, height: y1 - y0 };
}

/** Whether the segment a→b passes through `box` (Liang–Barsky clip). */
function segmentHits(a: Position, b: Position, box: SpatialBox): boolean {
  const dx = b.x - a.x, dy = b.y - a.y;
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, a.x - left(box)], [dx, box.x + box.width / 2 - a.x], [-dy, a.y - top(box)], [dy, box.y + box.height / 2 - a.y]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    if (t0 >= t1) return false;
  }
  return true;
}

// Only a backstop: a wide enough column always clears, a dozen links need about 1000.
const MAX_COLUMN_GAP = 8000, LINE_CLEARANCE = 12;

/** A plot's members anchored at its current top-left: linked members as trees growing right, each item's links in one
 * column beside it, centred on them, with columns spread until no link line crosses another card; unlinked members in a grid underneath. */
export function lineUp<T extends SpatialBox>(boxes: readonly T[], links: readonly GraphLink[] = []): T[] {
  if (!boxes.length) return [];
  const order = readingOrder(boxes), { x0, y0 } = bounds(boxes), rank = new Map(order.map((box, i) => [box.id, i]));
  const near = new Map(order.map(box => [box.id, new Set<string>()]));
  for (const link of links) if (!link.reveal && link.sourceId !== link.targetId && rank.has(link.sourceId) && rank.has(link.targetId)) {
    near.get(link.sourceId)!.add(link.targetId); near.get(link.targetId)!.add(link.sourceId);
  }
  const byRank = (a: string, b: string) => rank.get(a)! - rank.get(b)!, byId = new Map(order.map(box => [box.id, box]));
  const corners = new Map<string, Position>(), seen = new Set<string>();
  let y = y0;
  for (const start of order) {
    if (seen.has(start.id) || !near.get(start.id)!.size) continue;
    const members = [start.id];
    for (let i = 0, found = new Set(members); i < members.length; i++) for (const id of near.get(members[i])!) if (!found.has(id)) { found.add(id); members.push(id); }
    // The most linked item is the root, ties by id since a centred parent moves in reading order; breadth-first, so each item sits one column right of its nearest link to the root.
    const root = members.reduce((best, id) => near.get(id)!.size > near.get(best)!.size || (near.get(id)!.size === near.get(best)!.size && id < best) ? id : best);
    const children = new Map<string, string[]>(), depth = new Map([[root, 0]]), queue = [root];
    seen.add(root);
    for (let i = 0; i < queue.length; i++) {
      // Siblings linked to each other stack next to each other, so their line crosses no sibling between them.
      const kids: string[] = [], pool = [...near.get(queue[i])!].filter(id => !seen.has(id)).sort(byRank);
      while (pool.length) kids.push(...pool.splice(Math.max(0, pool.findIndex(id => kids.length && near.get(kids.at(-1)!)!.has(id))), 1));
      for (const id of kids) { seen.add(id); depth.set(id, depth.get(queue[i])! + 1); queue.push(id); }
      children.set(queue[i], kids);
    }
    const tops = new Map<string, number>();
    const place = (id: string, top: number): number => {
      const height = byId.get(id)!.height, kids = children.get(id)!;
      let below = top;
      for (const kid of kids) below = place(kid, below) + TIDY_GAP;
      const centre = (kid: string) => tops.get(kid)! + byId.get(kid)!.height / 2;
      tops.set(id, kids.length ? Math.max(top, (centre(kids[0]) + centre(kids.at(-1)!)) / 2 - height / 2) : top);
      return Math.max(tops.get(id)! + height, below - TIDY_GAP);
    };
    y = place(root, y) + TIDY_GAP;
    const widths: number[] = [], columns: number[] = [x0];
    for (const id of queue) widths[depth.get(id)!] = Math.max(widths[depth.get(id)!] ?? 0, byId.get(id)!.width);
    const at = (id: string): SpatialBox => ({ ...byId.get(id)!, x: columns[depth.get(id)!] + byId.get(id)!.width / 2, y: tops.get(id)! + byId.get(id)!.height / 2 });
    for (let d = 1; d < widths.length; d++) {
      const edges = queue.filter(id => depth.get(id) === d - 1).flatMap(id => children.get(id)!.map(kid => [id, kid] as const));
      const placed = queue.filter(id => depth.get(id)! <= d);
      for (let gap = TIDY_GAP; ; gap += TIDY_GAP) {
        columns[d] = columns[d - 1] + widths[d - 1] + gap;
        const crossed = edges.some(([from, to]) => {
          const line = straightConnection(at(from), at(to));
          return line && placed.some(id => id !== from && id !== to && segmentHits(line.source, line.target, { ...at(id), width: at(id).width + LINE_CLEARANCE * 2, height: at(id).height + LINE_CLEARANCE * 2 }));
        });
        if (!crossed || gap >= MAX_COLUMN_GAP) break;
      }
    }
    for (const id of queue) corners.set(id, { x: columns[depth.get(id)!], y: tops.get(id)! });
  }
  const loose = order.filter(box => !corners.has(box.id));
  grid(loose, { x: x0, y }, TIDY_GAP).forEach((corner, i) => corners.set(loose[i].id, corner));
  return order.map(box => ({ ...box, x: corners.get(box.id)!.x + box.width / 2, y: corners.get(box.id)!.y + box.height / 2 }));
}

/** The spot nearest `box` that clears every obstacle; straight down when the nearest edges are all taken. */
function clearSpot(box: SpatialBox, obstacles: readonly SpatialBox[], gap: number): Position {
  if (!obstacles.some(other => overlaps(box, other, gap))) return { x: box.x, y: box.y };
  const near = freePosition(box, obstacles, gap);
  if (near && !obstacles.some(other => overlaps({ ...box, ...near }, other, gap))) return near;
  let y = box.y;
  for (const other of [...obstacles].sort((a, b) => a.y - b.y)) if (overlaps({ ...box, y }, other, gap)) y = other.y + (other.height + box.height) / 2 + gap;
  return { x: box.x, y };
}

interface Block { key: string; boxes: SpatialBox[] }
const blockBox = (block: Block, at?: Position): SpatialBox => {
  const b = bounds(block.boxes), x0 = at?.x ?? b.x0, y0 = at?.y ?? b.y0;
  return { id: block.key, x: x0 + b.width / 2, y: y0 + b.height / 2, width: b.width, height: b.height };
};
const shifted = (block: Block, to: SpatialBox) => {
  const from = blockBox(block), dx = to.x - from.x, dy = to.y - from.y;
  return block.boxes.map(box => ({ ...box, x: box.x + dx, y: box.y + dy }));
};

/** Plots (and loose items) of one project, packed in reading order with even gutters, or kept where they are. */
function arrange(blocks: readonly Block[], obstacles: readonly SpatialBox[], space: boolean, original: readonly SpatialBox[]): SpatialBox[] {
  if (!blocks.length) return [];
  if (!space) {
    // Only reshaped plots can need room: each keeps its corner unless a member would come near something.
    const placed: SpatialBox[] = [], current = blocks.flatMap(block => block.boxes);
    for (const block of blocks) {
      const others = [...obstacles, ...placed, ...current.filter(box => !block.boxes.some(own => own.id === box.id) && !placed.some(done => done.id === box.id))];
      // A reshaped plot keeps a gutter from everything else, so no loose item or other plot joins it.
      const gap = block.key.startsWith('item:') || !block.boxes.some(box => original.some(was => was.id === box.id && (was.x !== box.x || was.y !== box.y))) ? ITEM_GAP : TIDY_GUTTER;
      const clear = !block.boxes.some(box => others.some(other => overlaps(box, other, gap)));
      const at = clear ? blockBox(block) : { ...blockBox(block), ...clearSpot(blockBox(block), others, gap) };
      placed.push(...shifted(block, at));
    }
    return placed;
  }
  // Rows of the grid in reading order; an obstacle only pushes the rest of its row right, so a packed board packs the same again.
  const order = readingOrder(blocks.map(block => ({ ...blockBox(block), block }))), cols = Math.ceil(Math.sqrt(order.length));
  const origin = { x: Math.min(...order.map(left)), y: Math.min(...order.map(top)) }, placed: SpatialBox[] = [];
  for (let first = 0, rowTop = origin.y; first < order.length; first += cols) {
    const row = order.slice(first, first + cols);
    let cursor = origin.x;
    for (const entry of row) {
      let at = blockBox(entry.block, { x: cursor, y: rowTop });
      for (let hits = obstacles.filter(other => overlaps(at, other, TIDY_GUTTER)); hits.length; hits = obstacles.filter(other => overlaps(at, other, TIDY_GUTTER))) {
        cursor = Math.min(...hits.map(other => other.x + other.width / 2)) + TIDY_GUTTER;
        at = blockBox(entry.block, { x: cursor, y: rowTop });
      }
      placed.push(...shifted(entry.block, at));
      cursor += at.width + TIDY_GUTTER;
    }
    rowTop += Math.max(...row.map(entry => entry.height)) + TIDY_GUTTER;
  }
  return placed;
}

/** Finished work Tidy may archive: done or closed more than TIDY_FINISHED_DAYS ago, never working, waiting in Needs me or in a locked plot. */
export function finishedItems(nodes: readonly Node[], plots: readonly PlotView[], now: number, projectId?: string): string[] {
  const needs = needsMeIds(nodes), locked = new Set(plots.filter(plot => plot.locked).flatMap(plot => plot.memberIds));
  const old = (at?: string) => at !== undefined && now - Date.parse(at) > TIDY_FINISHED_DAYS * DAY;
  return nodes.filter(node => node.resourceId && node.projectId && (projectId === undefined || node.projectId === projectId) && isDrawn(node, nodes)
    && node.activity !== 'working' && !node.rework && !needs.has(node.id) && !locked.has(node.id)
    && (old(node.completedAt) || (node.activity === 'complete' && old(node.activityAt)))).map(node => node.id).sort();
}

/** Duplicate plot colours within a project change, fewest first; a chosen colour or a locked plot never changes. */
function plotColors(plots: readonly PlotView[], nodes: readonly Node[]): TidyPlan['colors'] {
  const changes: TidyPlan['colors'] = [];
  for (const projectId of [...new Set(plots.map(plot => plot.projectId))].sort()) {
    const own = plots.filter(plot => plot.projectId === projectId), byId = new Map(own.map(plot => [plot.id, plot]));
    const fixed = own.filter(plot => plot.chosenColor !== undefined || plot.locked), used = new Set(fixed.map(plotColor));
    const rest = plotMapOrder(own.filter(plot => !fixed.includes(plot)), nodes).map(id => byId.get(id)!);
    rest.forEach((plot, i) => {
      if (!used.has(plot.color)) { used.add(plot.color); return; }
      const later = new Set(rest.slice(i + 1).map(other => other.color)), free = PLOT_COLORS.find(color => !used.has(color) && !later.has(color));
      if (!free) return;
      used.add(free); changes.push({ plotId: plot.id, from: plot.color, to: free });
    });
  }
  return changes;
}

/** What Tidy reads: the projects in scope, their plots, the items on the ground, and who belongs where once regroup rows apply. */
function prepare(input: TidyInput) {
  const { nodes, resources, links } = input.state, sizes = input.sizes ?? {}, registry = input.registry;
  const badges = mapBadges(nodes, resources, links).attached, archived = new Set(input.archived ?? []);
  const projects = nodes.filter(node => !node.resourceId && !node.projectId && isDrawn(node, nodes) && (input.projectId === undefined || node.id === input.projectId));
  const scope = new Set(projects.map(project => project.id)), plots = input.plots.filter(plot => scope.has(plot.projectId));
  const onGround = (node: Node) => Boolean(node.resourceId && node.projectId && scope.has(node.projectId) && isDrawn(node, nodes) && !badges.has(node.id) && !archived.has(node.id));
  const footprint = (node: Node) => itemFootprint(node, resources, registry, sizes);
  const groupOf = new Map<string, string>();
  for (const plot of plots) if (!plot.locked) for (const id of plot.memberIds) groupOf.set(id, plot.id);
  const lockedIds = new Set(plots.filter(plot => plot.locked).flatMap(plot => plot.memberIds));
  const regrouped = new Map<string, string>();
  for (const row of input.regroup ?? []) {
    const node = nodes.find(candidate => candidate.id === row.itemId), target = row.plotId ?? (row.newPlot && node?.projectId ? newPlotKey(node.projectId, row.newPlot) : undefined);
    const plot = row.plotId ? plots.find(candidate => candidate.id === row.plotId) : undefined;
    if (!node || !target || lockedIds.has(node.id) || !onGround(node) || (row.plotId && (!plot || plot.locked || plot.projectId !== node.projectId))) continue;
    groupOf.set(node.id, target); regrouped.set(node.id, target);
  }
  return { nodes, resources, links, sizes, registry, archived, projects, plots, onGround, footprint, groupOf, lockedIds, regrouped };
}

/** The whole Tidy plan: deterministic, and empty for a board Tidy just tidied. Plot membership never changes except by
 * `regroup`; where detection could still split or merge a plot, its membership is pinned in the same batch. */
export function planTidy(input: TidyInput, options: TidyOptions): TidyPlan {
  const { nodes, resources, links, sizes, registry, projects, plots, onGround, footprint, groupOf, lockedIds, regrouped, archived } = prepare(input);
  const planned = new Map<string, Position>();
  if (options.lineUp || options.spacePlots) {
    const world = layoutFootprints(nodes, resources, registry, sizes);
    const anchors = projects.map(project => ({ project, boxes: nodes.filter(node => node.projectId === project.id && onGround(node)).map(footprint) })).filter(entry => entry.boxes.length);
    for (const { project, boxes } of anchors.sort((a, b) => { const ba = bounds(a.boxes), bb = bounds(b.boxes); return ba.y0 - bb.y0 || ba.x0 - bb.x0 || a.project.id.localeCompare(b.project.id); })) {
      const free = boxes.filter(box => !lockedIds.has(box.id)), freeIds = new Set(free.map(box => box.id));
      const groups = new Map<string, SpatialBox[]>();
      for (const box of free) { const key = groupOf.get(box.id) ?? `item:${box.id}`; groups.set(key, [...groups.get(key) ?? [], box]); }
      const blocks = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, members]) => ({ key, boxes: options.lineUp && !key.startsWith('item:') ? lineUp(members, links) : members }));
      const obstacles = world.filter(box => !freeIds.has(box.id) && !archived.has(box.id)).map(box => planned.has(box.id) ? { ...box, ...planned.get(box.id)! } : box);
      for (const box of arrange(blocks, obstacles, options.spacePlots, free)) planned.set(box.id, { x: box.x, y: box.y });
    }
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  const moves = [...planned].flatMap(([id, to]) => { const from = byId.get(id)!.position; return same(from, to) ? [] : [{ id, from, to }]; }).sort((a, b) => a.id.localeCompare(b.id));
  return { moves, colors: options.colors ? plotColors(plots, nodes) : [], pins: membershipPins(input, plots, groupOf, regrouped, planned, onGround), archives: options.archive ? finishedItems(nodes, plots, input.now, input.projectId) : [] };
}

/** Plots whose members detection would not find again at the planned layout get those members pinned. */
function membershipPins(input: TidyInput, plots: readonly PlotView[], groupOf: ReadonlyMap<string, string>, regrouped: ReadonlyMap<string, string>, planned: ReadonlyMap<string, Position>, onGround: (node: Node) => boolean): TidyPlan['pins'] {
  const { nodes, resources, links } = input.state, projectOf = new Map(nodes.map(node => [node.id, node.projectId]));
  const expected = new Map<string, { projectId: string; memberIds: string[] }>();
  for (const plot of plots) if (!plot.locked) expected.set(plot.id, { projectId: plot.projectId, memberIds: [] });
  for (const [id, key] of groupOf) {
    if (!onGround(nodes.find(node => node.id === id)!)) continue;
    const entry = expected.get(key) ?? { projectId: projectOf.get(id)!, memberIds: [] };
    entry.memberIds.push(id); expected.set(key, entry);
  }
  const boxes: PlotBox[] = nodes.filter(onGround).map(node => ({ ...itemFootprint(node, resources, input.registry, input.sizes), ...planned.get(node.id), projectId: node.projectId! }));
  const pinned = [...expected].filter(([key]) => key.startsWith('new:') || [...regrouped.values()].includes(key));
  const previous = [...expected].map(([id, entry]) => ({ id, projectId: entry.projectId, memberIds: entry.memberIds }));
  const pins = [...plots.filter(plot => plot.pinnedMemberIds.length || plot.locked).map(plot => ({ plotId: plot.id, projectId: plot.projectId, memberIds: plot.locked ? plot.memberIds : plot.pinnedMemberIds.filter(id => groupOf.get(id) === plot.id), locked: plot.locked })),
    ...pinned.map(([plotId, entry]) => ({ plotId, projectId: entry.projectId, memberIds: entry.memberIds }))];
  let counter = 0;
  const detected = new Map(detectPlots(boxes, previous, () => `detected:${counter++}`, links, pins).map(plot => [plot.id, plot.memberIds]));
  const sameMembers = (a: readonly string[] = [], b: readonly string[]) => a.length === b.length && [...a].sort().every((id, i) => id === [...b].sort()[i]);
  return [...expected].filter(([key, entry]) => entry.memberIds.length && (pinned.some(([id]) => id === key) || !sameMembers(detected.get(key), entry.memberIds)))
    .map(([plotId, entry]) => ({ plotId, projectId: entry.projectId, memberIds: [...entry.memberIds].sort() })).sort((a, b) => a.plotId.localeCompare(b.plotId));
}

/** What applying `plan` leaves at the `final` map: items whose plot changed (with every member of the plots involved), and items a
 * second Tidy would move again. Detection runs with the pins the apply writes; the plan is good when both are empty. */
export function tidyDrift(input: TidyInput, options: TidyOptions, plan: TidyPlan, final: TidyInput['state']): { membership: string[]; unsettled: string[] } {
  const { nodes, plots, onGround } = prepare(input), finalById = new Map(final.nodes.map(node => [node.id, node]));
  const repinned = new Set(plan.pins.flatMap(pin => pin.memberIds)), planned = new Map(plan.pins.map(pin => [pin.plotId, pin.memberIds]));
  const pins = [...plots.map(plot => ({ plotId: plot.id, projectId: plot.projectId, memberIds: [...new Set([...plot.pinnedMemberIds.filter(id => !repinned.has(id)), ...planned.get(plot.id) ?? []])], locked: plot.locked }))
    .filter(pin => pin.memberIds.length || pin.locked), ...plan.pins.filter(pin => !plots.some(plot => plot.id === pin.plotId))];
  const previous = plots.map(plot => ({ id: plot.id, projectId: plot.projectId, memberIds: plot.memberIds }));
  const detect = (state: TidyInput['state']) => {
    const byId = new Map(state.nodes.map(node => [node.id, node])), boxes: PlotBox[] = nodes.filter(onGround).map(node => ({ ...itemFootprint(byId.get(node.id) ?? node, state.resources, input.registry, input.sizes), projectId: node.projectId! }));
    let counter = 0;
    return detectPlots(boxes, previous, () => `detected:${counter++}`, state.links, pins);
  };
  // A plot is known by its id, or by its members when detection made it up.
  const membership = (found: ReturnType<typeof detect>) => new Map(found.flatMap(plot => plot.memberIds.map(id => [id, { key: plot.id.startsWith('detected:') ? [...plot.memberIds].sort().join() : plot.id, members: plot.memberIds }] as const)));
  const before = membership(detect(input.state)), after = membership(detect(final)), drift = new Set<string>();
  for (const node of nodes.filter(onGround)) {
    const was = before.get(node.id), now = after.get(node.id);
    if (was?.key !== now?.key) for (const id of [node.id, ...was?.members ?? [], ...now?.members ?? []]) drift.add(id);
  }
  const moved = new Set(plan.moves.map(move => move.id)), views = new Map(plots.map(plot => [plot.id, plot]));
  const settled = detect(final).map(plot => ({ ...views.get(plot.id) ?? { name: plot.id, source: 'local' as const, color: PLOT_COLORS[0], hidden: false }, ...plot,
    pinnedMemberIds: pins.find(pin => pin.plotId === plot.id)?.memberIds.filter(id => plot.memberIds.includes(id)) ?? [] })) as PlotView[];
  const again = planTidy({ ...input, state: { ...input.state, ...final }, plots: settled, regroup: [], archived: [] }, options);
  return { membership: [...drift].sort(), unsettled: again.moves.map(move => move.id).filter(id => moved.has(id)) };
}

export const PLOT_DISTANCES = { join: PLOT_JOIN, leave: PLOT_LEAVE } as const;

/** A 53-bit string hash (cyrb53): equal inputs give equal fingerprints in the window and the service. */
function hash(text: string) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** What a preview read in its scope and planned; status and activity are left out so a busy board still tidies. */
export function tidyFingerprint(input: TidyInput, plan: TidyPlan): string {
  const { nodes, resources } = input.state;
  const scope = new Set(nodes.filter(node => !node.resourceId && !node.projectId && isDrawn(node, nodes) && (input.projectId === undefined || node.id === input.projectId)).map(node => node.id));
  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  // Only items on the map: a window holds just its layer, without most Undermap items.
  const items = nodes.filter(node => node.resourceId && node.projectId && scope.has(node.projectId) && isDrawn(node, nodes)).sort(byId).map(node => {
    const box = itemFootprint(node, resources, input.registry, input.sizes ?? {});
    return [node.id, box.x, box.y, box.width, box.height, node.projectId, Boolean(node.archivedAt), Boolean(node.belowAt), node.title, node.generatedTitle ?? null, Boolean(node.titleChosen)];
  });
  const projects = nodes.filter(node => scope.has(node.id)).sort(byId).map(node => [node.id, node.title, node.generatedTitle ?? null, Boolean(node.titleChosen)]);
  const plots = input.plots.filter(plot => scope.has(plot.projectId)).sort(byId).map(plot => [plot.id, plot.projectId, [...plot.memberIds].sort(), [...plot.pinnedMemberIds].sort(), Boolean(plot.locked), plot.color, plot.chosenColor ?? null, plot.name, plot.source]);
  const planned = { moves: plan.moves.map(move => [move.id, move.to.x, move.to.y]), colors: plan.colors.map(change => [change.plotId, change.to]), pins: plan.pins };
  return hash(JSON.stringify([input.projectId ?? null, input.sizes ?? {}, projects, items, plots, planned]));
}
