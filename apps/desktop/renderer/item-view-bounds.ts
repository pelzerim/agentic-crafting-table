export type ViewPlace = { x: number; y: number };
export type ViewSize = { width: number; height: number };
export type ItemViewBounds = Record<string, Partial<ViewPlace & ViewSize>>;

export const VIEW_BOUNDS_LIMIT = 400;

/** The place and size a person gave each opened item, split into the two maps the canvas keeps. */
export function splitViewBounds(saved: ItemViewBounds | undefined) {
  const positions: Record<string, ViewPlace> = {}, sizes: Record<string, ViewSize> = {};
  for (const [id, bounds] of Object.entries(saved ?? {})) {
    if (bounds.x !== undefined && bounds.y !== undefined) positions[id] = { x: bounds.x, y: bounds.y };
    if (bounds.width !== undefined && bounds.height !== undefined) sizes[id] = { width: bounds.width, height: bounds.height };
  }
  return { positions, sizes };
}

/** What to save: this canvas's items replace their saved entries, items shown on another
 * layer keep theirs, and entries of items that no longer exist are dropped. */
export function mergeViewBounds(saved: ItemViewBounds | undefined, shown: ReadonlySet<string>, existing: ReadonlySet<string>, positions: Record<string, ViewPlace>, sizes: Record<string, ViewSize>): ItemViewBounds {
  const next: ItemViewBounds = {};
  for (const [id, bounds] of Object.entries(saved ?? {})) if (existing.has(id) && !shown.has(id)) next[id] = bounds;
  for (const id of new Set([...Object.keys(positions), ...Object.keys(sizes)])) if (existing.has(id)) next[id] = { ...positions[id], ...sizes[id] };
  return Object.fromEntries(Object.entries(next).slice(-VIEW_BOUNDS_LIMIT));
}

export type ItemViewValue = string | number | boolean;
export type ItemViewState = Record<string, Record<string, ItemViewValue>>;

/** One item's view state with a patch applied: null removes a key, an emptied item goes, and so do items that no longer exist. */
export function patchItemViewState(saved: ItemViewState | undefined, nodeId: string, patch: Record<string, ItemViewValue | null>, existing: ReadonlySet<string>): ItemViewState {
  const next: ItemViewState = Object.fromEntries(Object.entries(saved ?? {}).filter(([id]) => existing.has(id) && id !== nodeId));
  const own = { ...saved?.[nodeId] };
  for (const [key, value] of Object.entries(patch)) if (value === null) delete own[key]; else own[key] = value;
  if (existing.has(nodeId) && Object.keys(own).length) next[nodeId] = own;
  return Object.fromEntries(Object.entries(next).slice(-VIEW_BOUNDS_LIMIT));
}

export const sameViewBounds =(a: ItemViewBounds | undefined, b: ItemViewBounds | undefined) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
