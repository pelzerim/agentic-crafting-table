import type { GraphNode } from './graph.ts';
import type { SpatialBox } from './spatial.ts';
import { overlaps } from './spatial.ts';
import { isArchived, isBelow } from './archive.ts';
import { ITEM_GAP } from './movement.ts';
import { NEIGHBORHOOD_PADDING } from './project-neighborhoods.ts';

type Point = GraphNode['position'];
export interface Bounds { left: number; top: number; right: number; bottom: number }
const SEARCH_STEP = ITEM_GAP * 2;

export const boundsOf = (boxes: readonly SpatialBox[]): Bounds => ({
  left: Math.min(...boxes.map(box => box.x - box.width / 2)), right: Math.max(...boxes.map(box => box.x + box.width / 2)),
  top: Math.min(...boxes.map(box => box.y - box.height / 2)), bottom: Math.max(...boxes.map(box => box.y + box.height / 2)),
});
/** A project's padded neighbourhood as one box. */
export const field = (id: string, bounds: Bounds, padding: number): SpatialBox => ({ id, x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2,
  width: bounds.right - bounds.left + padding * 2, height: bounds.bottom - bounds.top + padding * 2 });

/** Undermap positions for nodes arriving below. Each project's arrivals (or a
 * whole project) move as one block, keeping their layout, to the first clear
 * spot beside that project's items already below: right, below, left, then
 * above, stepping outward. A block with nothing of its project below keeps its
 * position when that is clear. Nodes already below are never moved. */
export function belowPlacement(nodes: readonly GraphNode[], ids: readonly string[], footprint: (node: GraphNode) => SpatialBox, padding = NEIGHBORHOOD_PADDING): Map<string, Point> {
  const arriving = nodes.filter(node => ids.includes(node.id) && !isArchived(node, nodes) && !isBelow(node, nodes));
  const projects = new Set(arriving.filter(node => !node.resourceId).map(node => node.id));
  const groups = new Map<string, GraphNode[]>();
  for (const id of projects) groups.set(id, nodes.filter(node => node.id === id || node.projectId === id && !node.belowAt));
  for (const node of arriving) if (node.resourceId && !(node.projectId && projects.has(node.projectId))) {
    const key = node.projectId ?? '';
    groups.set(key, [...groups.get(key) ?? [], node]);
  }
  const below = new Set(nodes.filter(node => isBelow(node, nodes)).map(node => node.id));
  const positions = new Map<string, Point>();
  const box = (node: GraphNode) => ({ ...footprint(node), ...positions.get(node.id) });
  for (const key of [...groups.keys()].sort()) {
    const moving = groups.get(key)!, movingIds = new Set(moving.map(node => node.id));
    const visible = moving.filter(node => node.resourceId && !isArchived(node, nodes));
    const block = (visible.length ? visible : moving.filter(node => !node.resourceId)).map(box);
    const layer = nodes.filter(node => below.has(node.id) && !movingIds.has(node.id));
    const items = layer.filter(node => node.resourceId).map(box);
    const owned = (projectId: string) => layer.filter(node => node.resourceId && node.projectId === projectId);
    const cluster = key ? owned(key).map(box) : [];
    const fieldIds = new Set([...layer.filter(node => !node.resourceId).map(node => node.id), ...layer.flatMap(node => node.projectId ? [node.projectId] : [])]);
    fieldIds.delete(key);
    const fields = [...fieldIds].map(id => {
      const members = owned(id).map(box);
      return field(id, boundsOf(members.length ? members : [box(nodes.find(node => node.id === id)!)]), padding);
    });
    const clear = (dx: number, dy: number) => block.every(part => {
      const moved = { ...part, x: part.x + dx, y: part.y + dy };
      return !items.some(other => overlaps(moved, other, ITEM_GAP)) && !fields.some(other => overlaps(moved, other, 0));
    });
    const b = boundsOf(block), c = cluster.length ? boundsOf(cluster) : b;
    // The right-hand candidate always clears once it passes the outermost obstacle.
    const beside = () => { for (let k = 0; ; k++) {
      const out = k * SEARCH_STEP, found = [
        { x: c.right + ITEM_GAP - b.left + out, y: c.top - b.top },
        { x: c.left - b.left, y: c.bottom + ITEM_GAP - b.top + out },
        { x: c.left - ITEM_GAP - b.right - out, y: c.top - b.top },
        { x: c.left - b.left, y: c.top - ITEM_GAP - b.bottom - out },
      ].find(candidate => clear(candidate.x, candidate.y));
      if (found) return found;
    } };
    const offset = !cluster.length && clear(0, 0) ? { x: 0, y: 0 } : beside();
    for (const node of moving) {
      if (offset.x || offset.y) positions.set(node.id, { x: node.position.x + offset.x, y: node.position.y + offset.y });
      if (!isArchived(node, nodes)) below.add(node.id);
    }
  }
  return positions;
}

/** Sends nodes below the map, saving the map position of every node that moves. */
export function sendBelow<T extends GraphNode>(nodes: readonly T[], ids: readonly string[], at: string, footprint: (node: GraphNode) => SpatialBox, padding = NEIGHBORHOOD_PADDING): T[] {
  for (const id of ids) {
    const node = nodes.find(node => node.id === id);
    if (!node) throw new Error('Node does not exist');
    if (isArchived(node, nodes)) throw new Error('Restore it from the archive first');
  }
  const positions = belowPlacement(nodes, ids, footprint, padding);
  return nodes.map(node => {
    const position = positions.get(node.id), sent = ids.includes(node.id);
    if (!position && !sent) return node;
    return { ...node, ...sent ? { belowAt: node.belowAt ?? at } : {}, ...position ? { position, mapPosition: node.position } : {} };
  });
}

/** Surfacing returns a node, and the project members that went below with it,
 * to their saved map positions. */
export function restoreMapPositions<T extends GraphNode>(nodes: readonly T[], id: string): T[] {
  return nodes.map(node => {
    if (!node.mapPosition || node.id !== id && (node.projectId !== id || node.belowAt)) return node;
    const { mapPosition, ...returned } = node;
    return { ...returned, position: mapPosition } as T;
  });
}

/** The Loose area's id in a mirror layout: items below that belong to no project. */
export const UNDERMAP_LOOSE = 'undermap:loose';
/** Mirror layout measures, in world pixels. A column holds one card up to 240 wide; wider cards span columns. */
export const MIRROR = { columns: 7, minColumns: 4, rows: 4, column: 260, gap: ITEM_GAP, line: 44, more: 40, monthGap: 12, areaGap: 48, minHeight: 112 } as const;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export interface MirrorOptions {
  /** A node's card footprint; a project's is used while it has no members on the map. */
  size(node: GraphNode): { width: number; height: number };
  padding?: number;
  /** The one month a person opened per area, by area id. View state. */
  open?: Readonly<Record<string, string>>;
  /** IANA zone months are cut in; the system's when absent. */
  timeZone?: string;
  /** Only decides whether a month label carries its year. */
  now?: string | number | Date;
}
export interface MirrorMonth {
  /** `YYYY-MM` in the layout's time zone. */
  key: string; label: string;
  /** First and last day something was sent that month, e.g. `18 Sep – 29 Sep`. */
  range: string; count: number;
  /** World y of the divider line. */
  y: number;
  /** Whether its cards are laid out; a closed month is its line alone. */
  open: boolean;
  /** Opened by a person: a closed month shown in place, or a month cut by the budget shown whole. */
  expanded: boolean;
  /** What opens or closes it: its own line (a closed month), or the row at its end (`moreY`; a month cut by the budget). */
  toggle?: 'line' | 'more';
  /** Cards it shows by itself: its share of the budget. */
  fit: number;
  shown: number; more: number; moreY?: number;
  /** Every item of the month, newest first. */
  ids: string[];
}
export interface MirrorArea {
  /** The project's id, or `UNDERMAP_LOOSE`. */
  id: string; title: string; loose: boolean; count: number; columns: number;
  left: number; top: number; width: number; height: number;
  /** Centre, as a `SpatialBox`. */
  x: number; y: number;
  months: MirrorMonth[];
}
export interface MirrorLayout {
  areas: MirrorArea[];
  /** Projects that have an area. */
  projects: string[];
  /** Centres of the cards that are laid out. */
  positions: Map<string, Point>;
  /** Laid-out cards: area by area, month by month, newest first. */
  visible: string[];
  /** Every item below. */
  count: number;
  places: Map<string, { areaId: string; month: string }>;
}

type LocalDay = { year: number; month: number; day: number };
const zoneFormats = new Map<string, Intl.DateTimeFormat>();
function localDay(time: number, timeZone?: string): LocalDay {
  if (!timeZone) { const date = new Date(time); return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() }; }
  let format = zoneFormats.get(timeZone);
  if (!format) zoneFormats.set(timeZone, format = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }));
  const parts = Object.fromEntries(format.formatToParts(time).map(part => [part.type, Number(part.value)]));
  return { year: parts.year, month: parts.month, day: parts.day };
}
const shortDay = (day: LocalDay) => `${day.day} ${MONTH_NAMES[day.month - 1].slice(0, 3)}`;

/** The Undermap as a mirror of the map (MAP-18). Every project with something below gets an area at the
 * place its members have on the map: centred under them, starting at their top edge. Inside, items are
 * grouped by the month they were sent below, newest month first, each under a divider line, newest item
 * first, packed into columns. An area shows `columns × rows` cards, newest first: the month that budget runs
 * out in shows its newest and ends in "+N more", and every older month is its line alone until a person opens it. Items of no project share the Loose area at the
 * lower left of the map. Nothing is read from positions stored below, so the layout is a pure function
 * of the nodes, the footprints and the opened months. */
export function mirrorLayout(nodes: readonly GraphNode[], options: MirrorOptions): MirrorLayout {
  const padding = options.padding ?? NEIGHBORHOOD_PADDING, zone = options.timeZone;
  const projects = new Map(nodes.filter(node => !node.resourceId && !node.archivedAt).map(node => [node.id, node]));
  const archivedProjects = new Set(nodes.filter(node => !node.resourceId && node.archivedAt).map(node => node.id));
  const boxAt = (node: GraphNode): Bounds => { const { width, height } = options.size(node), at = node.mapPosition ?? node.position; return { left: at.x - width / 2, right: at.x + width / 2, top: at.y - height / 2, bottom: at.y + height / 2 }; };
  const grow = (bounds: Bounds | undefined, box: Bounds): Bounds => bounds ? { left: Math.min(bounds.left, box.left), right: Math.max(bounds.right, box.right), top: Math.min(bounds.top, box.top), bottom: Math.max(bounds.bottom, box.bottom) } : box;
  type Entry = { node: GraphNode; time: number };
  const members = new Map<string, Bounds>(), items = new Map<string, Entry[]>();
  let floating: Bounds | undefined, looseOrigin: Bounds | undefined;
  for (const node of nodes) {
    if (!node.resourceId || node.archivedAt || (node.projectId && archivedProjects.has(node.projectId))) continue;
    const project = node.projectId ? projects.get(node.projectId) : undefined;
    // What did not go below by itself marks its project's place: on the map, or where it lay when the project went below.
    if (project && !node.belowAt) members.set(project.id, grow(members.get(project.id), boxAt(node)));
    const sentAt = node.belowAt ?? project?.belowAt;
    if (!sentAt) { if (!project) floating = grow(floating, boxAt(node)); continue; }
    const key = project ? project.id : UNDERMAP_LOOSE, list = items.get(key) ?? [];
    if (!project) looseOrigin = grow(looseOrigin, boxAt(node));
    list.push({ node, time: Date.parse(sentAt) }); items.set(key, list);
  }
  const year = localDay(options.now === undefined ? Date.now() : new Date(options.now).getTime(), zone).year;
  type Draft = { id: string; title: string; loose: boolean; anchor: { x: number; top: number }; list: Entry[]; columns: number };
  const drafts: Draft[] = [];
  let map = floating;
  for (const project of projects.values()) {
    const bounds = members.get(project.id) ?? boxAt(project);
    if (!project.belowAt) map = grow(map, bounds);
    if (!project.belowAt && !items.has(project.id)) continue;
    drafts.push({ id: project.id, title: project.title, loose: false, anchor: { x: (bounds.left + bounds.right) / 2, top: bounds.top }, list: items.get(project.id) ?? [], columns: MIRROR.columns });
  }
  // Side-by-side neighbours share the room between their centres; four columns are kept even when that is too little.
  const nominal = MIRROR.rows * (132 + MIRROR.gap) + MIRROR.line * 2 + padding * 2;
  for (const draft of drafts) for (const other of drafts) {
    const apart = Math.abs(draft.anchor.x - other.anchor.x);
    if (other === draft || !apart || Math.abs(draft.anchor.top - other.anchor.top) >= nominal) continue;
    draft.columns = Math.max(MIRROR.minColumns, Math.min(draft.columns, Math.floor((apart - padding * 2 - MIRROR.areaGap + MIRROR.gap) / MIRROR.column)));
  }
  drafts.sort((a, b) => a.anchor.top - b.anchor.top || a.anchor.x - b.anchor.x || a.id.localeCompare(b.id));
  const loose = items.get(UNDERMAP_LOOSE);
  if (loose) {
    const origin = map ?? looseOrigin!, width = MIRROR.columns * MIRROR.column - MIRROR.gap;
    drafts.push({ id: UNDERMAP_LOOSE, title: 'Loose', loose: true, columns: MIRROR.columns, list: loose,
      anchor: { x: origin.left + width / 2, top: map ? map.bottom + padding * 2 + MIRROR.areaGap : origin.top } });
  }
  const layout: MirrorLayout = { areas: [], projects: [], positions: new Map(), visible: [], count: 0, places: new Map() };
  const placed: Bounds[] = [];
  for (const draft of drafts) {
    const width = draft.columns * MIRROR.column - MIRROR.gap, left = draft.anchor.x - width / 2, budget = draft.columns * MIRROR.rows;
    const groups = new Map<string, (Entry & { day: LocalDay })[]>();
    for (const entry of draft.list) {
      const day = Number.isFinite(entry.time) ? localDay(entry.time, zone) : { year: 0, month: 0, day: 0 };
      const key = `${String(day.year).padStart(4, '0')}-${String(day.month).padStart(2, '0')}`, group = groups.get(key) ?? [];
      group.push({ ...entry, day }); groups.set(key, group);
    }
    const keys = [...groups.keys()].sort().reverse(), opened = options.open?.[draft.id];
    // Laid out from y 0, then moved to the area's place.
    let y = 0, room = budget;
    const cards: { id: string; x: number; y: number }[] = [];
    const months = keys.map((key): MirrorMonth => {
      const group = groups.get(key)!.sort((a, b) => b.time - a.time || a.node.id.localeCompare(b.node.id));
      const first = group.at(-1)!.day, last = group[0].day;
      const label = first.year ? `${MONTH_NAMES[first.month - 1].toUpperCase()}${first.year === year ? '' : ` ${first.year}`}` : 'UNDATED';
      const range = !first.year ? '' : first.day === last.day ? shortDay(first) : `${shortDay(first)} – ${shortDay(last)}`;
      // The budget is spent newest first. The month it runs out in shows what is left of it; the months after are closed.
      const fit = Math.min(group.length, room), closed = fit === 0, partial = !closed && fit < group.length;
      room -= fit;
      // A month a person opened is extra, so the others stay as they were.
      const expanded = opened === key && (closed || partial), open = !closed || expanded, shown = expanded ? group.length : fit;
      const month: MirrorMonth = { key, label, range, count: group.length, y, open, expanded, toggle: closed ? 'line' : partial ? 'more' : undefined, fit, shown, more: group.length - shown, ids: group.map(entry => entry.node.id) };
      for (const entry of group) layout.places.set(entry.node.id, { areaId: draft.id, month: key });
      y += MIRROR.line;
      if (!open) return month;
      let column = 0, rowHeight = 0;
      for (const entry of group.slice(0, shown)) {
        const size = options.size(entry.node), span = Math.min(draft.columns, Math.max(1, Math.ceil((size.width + MIRROR.gap) / MIRROR.column)));
        if (column + span > draft.columns) { y += rowHeight + MIRROR.gap; column = 0; rowHeight = 0; }
        cards.push({ id: entry.node.id, x: left + column * MIRROR.column + size.width / 2, y: y + size.height / 2 });
        column += span; rowHeight = Math.max(rowHeight, size.height);
      }
      if (shown) y += rowHeight + MIRROR.gap;
      if (month.toggle === 'more') { month.moreY = y; y += MIRROR.more; }
      y += MIRROR.monthGap;
      return month;
    });
    const height = Math.max(MIRROR.minHeight, y);
    // An area lower down yields to the ones already placed; nothing above it ever moves.
    let top = draft.anchor.top;
    for (let moved = true; moved;) {
      moved = false;
      for (const other of placed) {
        if (left - padding >= other.right + MIRROR.areaGap || left + width + padding <= other.left - MIRROR.areaGap || top - padding >= other.bottom + MIRROR.areaGap || top + height + padding <= other.top - MIRROR.areaGap) continue;
        top = other.bottom + MIRROR.areaGap + padding; moved = true;
      }
    }
    placed.push({ left: left - padding, right: left + width + padding, top: top - padding, bottom: top + height + padding });
    for (const month of months) { month.y += top; if (month.moreY !== undefined) month.moreY += top; }
    for (const card of cards) { layout.positions.set(card.id, { x: card.x, y: card.y + top }); layout.visible.push(card.id); }
    layout.areas.push({ id: draft.id, title: draft.title, loose: draft.loose, count: draft.list.length, columns: draft.columns, left, top, width, height, x: left + width / 2, y: top + height / 2, months });
    if (!draft.loose) layout.projects.push(draft.id);
    layout.count += draft.list.length;
  }
  return layout;
}

/** The area and month an item below lies in, laid out or not. */
export const mirrorPlace = (layout: MirrorLayout, id: string) => layout.places.get(id);

export interface UndermapMatch { id: string; title: string; project: string; month: string; monthKey: string; areaId: string }
/** Items below whose title, project or month contain every word of the query; newest first. */
export function searchUndermap(layout: MirrorLayout, nodes: readonly GraphNode[], query: string, limit = 8): UndermapMatch[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const titles = new Map(nodes.map(node => [node.id, node.title]));
  const matches: (UndermapMatch & { place: number })[] = [];
  for (const area of layout.areas) for (const month of area.months) for (const [place, id] of month.ids.entries()) {
    const title = titles.get(id) ?? '', text = `${title} ${area.title} ${month.label}`.toLowerCase();
    if (words.every(word => text.includes(word))) matches.push({ id, title, project: area.title, month: month.label, monthKey: month.key, areaId: area.id, place });
  }
  // Month keys sort as text, so the newest month of any project leads; inside a month each area keeps its order.
  return matches.sort((a, b) => b.monthKey.localeCompare(a.monthKey) || a.areaId.localeCompare(b.areaId) || a.place - b.place).slice(0, limit).map(({ place, ...match }) => match);
}
