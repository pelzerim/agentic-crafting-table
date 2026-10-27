import { TICKET_REFERENCE } from './reference.ts';

/** Plots (MAP-24): groups of a project's items that sit close together or are linked.
 * Derived from committed layout and links only; geometry is never persisted. All distances are world pixels. */
export const PLOT_JOIN = 72, PLOT_LEAVE = 120, PLOT_BRIDGE = 240, PLOT_MIN_ITEMS = 3, PLOT_MIN_LINKED = 2, PLOT_MAX_ITEMS = 12, PLOT_MAX_SHARE = .6, PLOT_MAX_PER_PROJECT = 6, PLOT_SAME = .5, PLOT_SETTLE_PASSES = 8;

/** A member footprint, centred like map positions. */
export interface PlotBox { id: string; projectId: string; x: number; y: number; width: number; height: number }
/** Any link between two items; its kind does not matter. */
export interface PlotLink { sourceId: string; targetId: string }
export interface Plot { id: string; projectId: string; memberIds: string[] }
/** The members a person pinned in a plot of `projectId`. */
export interface PlotPin { plotId: string; projectId: string; memberIds: readonly string[] }
/** A plot's color slot, in assignment order. The ids are stored; what each slot shows depends on the
 * project's neighborhood color (`plotPalette`). */
export const PLOT_COLORS = ['rose', 'sky', 'citron', 'orchid', 'clay', 'slate'] as const;
export type PlotColor = typeof PLOT_COLORS[number];
export const isPlotColor = (value: unknown): value is PlotColor => PLOT_COLORS.includes(value as PlotColor);
/** What the map, dashboards and MCP read. `source` says who owns the name: the local fallback, the title helper or the user.
 * `color` is the assigned slot, `chosenColor` a person's override: a slot or a custom `#rrggbb`. `pinnedMemberIds` are the
 * members a person pinned in it; a plot with any is a pinned plot. */
export interface PlotView extends Plot { name: string; source: 'local' | 'generated' | 'user'; hidden: boolean; color: PlotColor; chosenColor?: PlotColor | string; pinnedMemberIds: string[] }
/** The color a plot shows: a slot, or a custom `#rrggbb`. */
export const plotColor = (plot: Pick<PlotView, 'color' | 'chosenColor'>): PlotColor | string => plot.chosenColor ?? plot.color;
/** `revision` changes when names or hiding change without a workspace revision. */
export interface PlotSnapshot { list: PlotView[]; hiddenProjects: string[]; revision: number }

/** Distance between two footprints' edges; zero when they touch or overlap. */
export function plotGap(a: PlotBox, b: PlotBox) {
  const dx = Math.max(0, Math.abs(a.x - b.x) - (a.width + b.width) / 2), dy = Math.max(0, Math.abs(a.y - b.y) - (a.height + b.height) / 2);
  return Math.hypot(dx, dy);
}
function groupGap(a: readonly PlotBox[], b: readonly PlotBox[]) {
  let gap = Infinity;
  for (const one of a) for (const other of b) gap = Math.min(gap, plotGap(one, other));
  return gap;
}

export function jaccard(a: readonly string[], b: readonly string[]) {
  const set = new Set(a), shared = b.filter(id => set.has(id)).length;
  return shared / (a.length + b.length - shared || 1);
}

/** Single linkage over grid buckets; `reach` is at most PLOT_BRIDGE. Each cluster is sorted by id. */
function clusters(members: readonly PlotBox[], reach: (a: PlotBox, b: PlotBox) => number) {
  const parent = members.map((_, i) => i), find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const cell = PLOT_BRIDGE * 2, buckets = new Map<string, number[]>();
  members.forEach((box, i) => {
    const x0 = Math.floor((box.x - box.width / 2 - PLOT_BRIDGE / 2) / cell), x1 = Math.floor((box.x + box.width / 2 + PLOT_BRIDGE / 2) / cell);
    const y0 = Math.floor((box.y - box.height / 2 - PLOT_BRIDGE / 2) / cell), y1 = Math.floor((box.y + box.height / 2 + PLOT_BRIDGE / 2) / cell);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const key = `${x},${y}`, bucket = buckets.get(key) ?? [];
      for (const j of bucket) if (find(i) !== find(j) && plotGap(box, members[j]) <= reach(box, members[j])) parent[find(i)] = find(j);
      bucket.push(i); buckets.set(key, bucket);
    }
  });
  const result = new Map<number, PlotBox[]>();
  members.forEach((box, i) => { const root = find(i); result.set(root, [...result.get(root) ?? [], box]); });
  return [...result.values()].map(group => group.sort((a, b) => a.id.localeCompare(b.id)));
}
const bySize = (a: readonly PlotBox[], b: readonly PlotBox[]) => b.length - a.length || a[0].id.localeCompare(b[0].id);

/** The groups of members a plot is painted as, largest first: linked members a
 * little apart share one patch, so a plot reads as one field; only members
 * further than PLOT_BRIDGE from the rest get a patch of their own, so a long link
 * never paints over unrelated cards. */
export function plotPatches(boxes: readonly PlotBox[]) {
  return clusters(boxes, () => PLOT_BRIDGE).sort(bySize);
}

interface PlotGroup { ids: string[]; linked: boolean; pinned?: string }

/** One pass over a project. `together` says which plot each member is in already, `pinnedIn` which
 * plot a person pinned it in. Units are proximity clusters; a cluster past the caps is a pile and
 * each of its items is a unit of its own. A pinned plot's members are one unit wherever they sit,
 * and an unpinned unit within reach of one joins the nearest. Links join units, except between two plots. */
function projectGroups(members: readonly PlotBox[], links: readonly PlotLink[], together: ReadonlyMap<string, string>, pinnedIn: ReadonlyMap<string, string>): PlotGroup[] {
  const limit = Math.min(PLOT_MAX_ITEMS, members.length * PLOT_MAX_SHARE);
  const capped = (cluster: PlotBox[], split: (cluster: PlotBox[]) => PlotBox[][]) => cluster.length > limit ? split(cluster) : [cluster];
  const reach = (a: PlotBox, b: PlotBox) => together.has(a.id) && together.get(a.id) === together.get(b.id) ? PLOT_LEAVE : PLOT_JOIN;
  // The leave gap only holds a plot together: where it would push a cluster past the caps, the join gap decides.
  const free = clusters(members.filter(box => !pinnedIn.has(box.id)), reach)
    .flatMap(held => capped(held, () => clusters(held, () => PLOT_JOIN).flatMap(joined => capped(joined, () => joined.map(box => [box])))));
  const pinnedUnits = new Map<string, PlotBox[]>();
  for (const box of members) { const plot = pinnedIn.get(box.id); if (plot !== undefined) pinnedUnits.set(plot, [...pinnedUnits.get(plot) ?? [], box]); }
  const pinned = [...pinnedUnits.keys()].sort(), held = pinned.map(plot => pinnedUnits.get(plot)!), rest: PlotBox[][] = [];
  for (const unit of free) {
    let nearest: { index: number; gap: number } | undefined;
    held.forEach((core, index) => {
      let gap = Infinity;
      for (const one of unit) for (const other of core) { const between = plotGap(one, other); if (between <= reach(one, other)) gap = Math.min(gap, between); }
      if (gap < (nearest?.gap ?? Infinity)) nearest = { index, gap };
    });
    if (nearest) held[nearest.index] = [...held[nearest.index], ...unit]; else rest.push(unit);
  }
  const units = [...held.map(unit => [...unit].sort((a, b) => a.id.localeCompare(b.id))), ...rest];
  const unitOf = new Map<string, number>();
  units.forEach((unit, i) => { for (const box of unit) unitOf.set(box.id, i); });
  // Plots that now share a proximity cluster are one territory. With no plots yet, clusters of PLOT_MIN_ITEMS or more are.
  // A pinned plot is a territory of its own that never merges with another pinned one; the plot its
  // members were in is part of it.
  const merged = new Map<string, string>(), same = (key: string): string => merged.has(key) ? same(merged.get(key)!) : key;
  const pinnedLabels = pinned.map(plot => `pinned ${plot}`), isPinned = new Set(pinnedLabels), heldBy = new Map<string, string>();
  held.forEach((unit, i) => { for (const box of unit) { const key = together.get(box.id); if (key !== undefined && !heldBy.has(key)) heldBy.set(key, pinnedLabels[i]); } });
  const first = !rest.some(unit => unit.some(box => together.has(box.id)));
  const label = units.map((unit, i) => {
    if (i < pinned.length) return pinnedLabels[i];
    if (first) return unit.length >= PLOT_MIN_ITEMS ? `cluster ${i}` : undefined;
    const keys = [...new Set(unit.flatMap(box => { const key = together.get(box.id); return key === undefined ? [] : [same(heldBy.get(key) ?? key)]; }))].sort();
    const root = keys.find(key => isPinned.has(key)) ?? keys[0];
    for (const key of keys) if (key !== root && !isPinned.has(key)) merged.set(key, root);
    return root;
  });
  const territory = label.map((key, i) => key === undefined || i < pinned.length ? key : same(key));
  const parent = units.map((_, i) => i), find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const linked = units.map(() => false), beside = new Map<number, Set<number>>(), reaches = new Map<number, Set<number>>();
  const note = (map: Map<number, Set<number>>, from: number, to: number) => { map.set(from, (map.get(from) ?? new Set()).add(to)); };
  for (const link of links) {
    const a = unitOf.get(link.sourceId), b = unitOf.get(link.targetId);
    if (a === undefined || b === undefined) continue;
    if (a === b) { linked[a] = true; continue; }
    if (territory[a] !== undefined && territory[b] !== undefined) {
      if (territory[a] === territory[b]) { parent[find(a)] = find(b); linked[a] = linked[b] = true; }
    } else if (territory[a] === undefined && territory[b] === undefined) { note(beside, a, b); note(beside, b, a); }
    else if (territory[a] === undefined) note(reaches, a, b); else note(reaches, b, a);
  }
  const anchored = new Map<number, PlotBox[]>();
  units.forEach((unit, i) => { if (territory[i] !== undefined) anchored.set(find(i), [...anchored.get(find(i)) ?? [], ...unit]); });
  const lowest = (boxes: readonly PlotBox[]) => boxes.reduce((id, box) => box.id < id ? box.id : id, boxes[0].id);
  // Each chain of loose units joins as a whole, in an order that does not depend on the input's.
  const visited = new Set<number>(), chains: number[][] = [];
  units.forEach((_, start) => {
    if (territory[start] !== undefined || visited.has(start) || !(beside.has(start) || reaches.has(start))) return;
    const chain = [start]; visited.add(start);
    for (let at = 0; at < chain.length; at++) for (const other of beside.get(chain[at]) ?? []) if (!visited.has(other)) { visited.add(other); chain.push(other); }
    chains.push(chain);
  });
  for (const chain of chains) {
    for (const unit of chain) { linked[unit] = true; parent[find(unit)] = find(chain[0]); }
    const doors = new Map<number, number[]>();
    for (const unit of chain) for (const target of reaches.get(unit) ?? []) doors.set(find(target), [...doors.get(find(target)) ?? [], unit]);
    if (!doors.size) continue;
    const boxes = chain.flatMap(unit => units[unit]);
    // Hops: links from each of the chain's items to the plot, summed.
    const candidates = [...doors].map(([plot, entries]) => {
      const distance = new Map(entries.map(unit => [unit, 1])), queue = [...distance.keys()];
      for (let at = 0; at < queue.length; at++) for (const other of beside.get(queue[at]) ?? []) if (!distance.has(other)) { distance.set(other, distance.get(queue[at])! + 1); queue.push(other); }
      return { plot, hops: chain.reduce((sum, unit) => sum + distance.get(unit)! * units[unit].length, 0), id: lowest(anchored.get(plot)!) };
    });
    const fewest = Math.min(...candidates.map(candidate => candidate.hops));
    const nearest = candidates.filter(candidate => candidate.hops === fewest).map(candidate => ({ ...candidate, gap: groupGap(boxes, anchored.get(candidate.plot)!) }))
      .sort((a, b) => a.gap - b.gap || a.id.localeCompare(b.id))[0];
    parent[find(chain[0])] = nearest.plot;
  }
  const groups = new Map<number, PlotGroup>();
  units.forEach((unit, i) => {
    const group = groups.get(find(i)) ?? { ids: [], linked: false };
    group.ids.push(...unit.map(box => box.id)); group.linked ||= linked[i]; groups.set(find(i), group);
    if (i < pinned.length) group.pinned = pinned[i];
  });
  const kept = (group: PlotGroup) => group.linked || group.pinned !== undefined;
  const valid = [...groups.values()].filter(group => group.pinned !== undefined || group.ids.length >= (group.linked ? PLOT_MIN_LINKED : PLOT_MIN_ITEMS));
  for (const group of valid) group.ids.sort();
  valid.sort((a, b) => b.ids.length - a.ids.length || a.ids[0].localeCompare(b.ids[0]));
  let places = PLOT_MAX_PER_PROJECT - valid.filter(kept).length;
  return valid.filter(group => kept(group) || places-- > 0);
}

/** Per project: proximity clusters (members of one `previous` plot stay together up to
 * PLOT_LEAVE, everyone else joins within PLOT_JOIN) joined by the links between the
 * project's items, so linked items always share a plot whatever its size. The one
 * exception is a link between two plots that exist already (`previous`, or on a first
 * detection two clusters of PLOT_MIN_ITEMS or more): it never joins them. The result is
 * settled: passed back as `previous` it comes out unchanged. A result keeps the id of
 * the previous plot it shares at least half its members with.
 *
 * `pinned` is the membership a person chose. A pinned plot holds its pinned members of its
 * own project that are on the map, wherever they sit, and keeps its id; its pinned members
 * act as one linked group that is never cut, never merged into another plot and kept before
 * the other plots of the project. An id in `pinned` is never given to another group. An item
 * pinned in two plots stays in the first by id. */
export function detectPlots(boxes: readonly PlotBox[], previous: readonly Plot[], newId: () => string, links: readonly PlotLink[] = [], pinned: readonly PlotPin[] = []): Plot[] {
  const byProject = new Map<string, PlotBox[]>(), projectOf = new Map(boxes.map(box => [box.id, box.projectId])), linksOf = new Map<string, PlotLink[]>();
  for (const box of boxes) { const group = byProject.get(box.projectId) ?? []; group.push(box); byProject.set(box.projectId, group); }
  for (const link of links) {
    const projectId = projectOf.get(link.sourceId);
    if (projectId !== undefined && projectId === projectOf.get(link.targetId)) linksOf.set(projectId, [...linksOf.get(projectId) ?? [], link]);
  }
  const pins = [...pinned].sort((a, b) => a.plotId.localeCompare(b.plotId)), reserved = new Set(pins.map(pin => pin.plotId));
  const result: Plot[] = [];
  for (const [projectId, members] of [...byProject].sort(([a], [b]) => a.localeCompare(b))) {
    const earlier = previous.filter(plot => plot.projectId === projectId), between = linksOf.get(projectId) ?? [];
    const pinnedIn = new Map<string, string>();
    for (const pin of pins) if (pin.projectId === projectId) for (const id of pin.memberIds) if (projectOf.get(id) === projectId && !pinnedIn.has(id)) pinnedIn.set(id, pin.plotId);
    const key = (list: readonly PlotGroup[]) => list.map(group => group.ids.join(',')).join(';');
    let settled = projectGroups(members, between, new Map(earlier.flatMap(plot => plot.memberIds.map(id => [id, plot.id]))), pinnedIn);
    for (let pass = 0; pass < PLOT_SETTLE_PASSES; pass++) {
      const next = projectGroups(members, between, new Map(settled.flatMap((group, i) => group.ids.map(id => [id, String(i)]))), pinnedIn);
      const done = key(next) === key(settled);
      settled = next;
      if (done) break;
    }
    const groups = settled.map(group => group.ids), open = earlier.filter(plot => !reserved.has(plot.id));
    const pairs = groups.flatMap((ids, group) => settled[group].pinned === undefined ? open.map(plot => ({ group, plot, score: jaccard(ids, plot.memberIds) })) : [])
      .filter(pair => pair.score >= PLOT_SAME).sort((a, b) => b.score - a.score || a.plot.id.localeCompare(b.plot.id));
    const matched = new Map<number, string>(), used = new Set<string>();
    for (const pair of pairs) if (!matched.has(pair.group) && !used.has(pair.plot.id)) { matched.set(pair.group, pair.plot.id); used.add(pair.plot.id); }
    groups.forEach((ids, group) => result.push({ id: settled[group].pinned ?? matched.get(group) ?? newId(), projectId, memberIds: ids }));
  }
  return result;
}

/** Colors for the plots without one, in input order; `color` is what a plot shows now. A plot takes
 * the first palette color no other plot of its project shows. With all six taken it takes the color
 * whose nearest plot is farthest from its members, then the first in the palette. Others never change. */
export function assignPlotColors(plots: readonly (Plot & { color?: PlotColor })[], boxes: readonly PlotBox[]): Map<string, PlotColor> {
  const byId = new Map(boxes.map(box => [box.id, box])), membersOf = (plot: Plot) => plot.memberIds.flatMap(id => byId.get(id) ?? []);
  const shown = new Map(plots.flatMap(plot => plot.color ? [[plot.id, plot.color] as const] : [])), assigned = new Map<string, PlotColor>();
  for (const plot of plots) {
    if (plot.color) continue;
    const others = plots.filter(other => other.projectId === plot.projectId && shown.has(other.id)), members = membersOf(plot);
    const free = PLOT_COLORS.find(color => !others.some(other => shown.get(other.id) === color));
    const color = free ?? PLOT_COLORS.map(color => ({ color, gap: Math.min(...others.filter(other => shown.get(other.id) === color).map(other => groupGap(members, membersOf(other)))) }))
      .reduce((best, entry) => entry.gap > best.gap ? entry : best).color;
    shown.set(plot.id, color); assigned.set(plot.id, color);
  }
  return assigned;
}

const STOPWORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'from', 'at', 'by', 'is', 'it', 'this', 'that', 'new', 'fix', 'add', 'update', 'item', 'items', 'session', 'claude', 'codex', 'terminal', 'note', 'pr', 'api']);
const REFERENCE = new RegExp(`^(?:${TICKET_REFERENCE}|[\\w.-]*#\\d+)`);
/** The name a plot shows without AI: a ticket or PR reference shared by two or more
 * titles, otherwise the word most titles share, plus the count. */
export function plotFallbackName(titles: readonly string[]) {
  const count = `${titles.length} items`, references = new Map<string, number>(), words = new Map<string, { count: number; text: string }>();
  for (const title of titles) {
    const reference = title.trim().match(REFERENCE)?.[0];
    if (reference) references.set(reference, (references.get(reference) ?? 0) + 1);
    for (const word of new Set(title.split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 2 && !STOPWORDS.has(word.toLowerCase()) && !/^\d+$/.test(word)))) {
      const key = word.toLowerCase(), entry = words.get(key) ?? { count: 0, text: word[0].toUpperCase() + word.slice(1).toLowerCase() };
      entry.count++; words.set(key, entry);
    }
  }
  const reference = [...references].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  if (reference) return `${reference} · ${count}`;
  const word = [...words.values()].filter(entry => entry.count >= 2).sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))[0];
  return word ? `${word.text} · ${count}` : count;
}
