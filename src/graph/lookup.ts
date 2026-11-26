/** Lookups by id over workspace lists. A frozen list (the store's shared read) cannot change, so its index is built once and kept
 * with it; any other list, such as a command's draft or a list the window derived, gets a checked index of positions. */
type Indexed = { byId: Map<string, unknown>; byResource?: Map<string, unknown[]> };
const indexes = new WeakMap<readonly unknown[], Indexed>();

function indexed<T extends { id: string }>(list: readonly T[]): Indexed | undefined {
  if (!Object.isFrozen(list)) return undefined;
  let index = indexes.get(list);
  if (!index) {
    const byId = new Map<string, unknown>();
    for (const entry of list) if (!byId.has(entry.id)) byId.set(entry.id, entry);
    index = { byId }; indexes.set(list, index);
  }
  return index;
}

/** Where each id stood in a list that may still change, built when the same list is asked a second time. An answer is
 * only taken from it after checking that the entry still stands there; anything else is searched as before, so a list
 * changed in place stays correct and a list asked once costs one search. */
const positions = new WeakMap<readonly unknown[], Map<string, number> | null>();
function positioned<T extends { id: string }>(list: readonly T[], id: string): T | undefined {
  const known = positions.get(list);
  if (known === undefined) { positions.set(list, null); return list.find(entry => entry.id === id); }
  let byId = known;
  if (!byId || byId.size > list.length) {
    byId = new Map<string, number>();
    for (let index = 0; index < list.length; index++) if (!byId.has(list[index].id)) byId.set(list[index].id, index);
    positions.set(list, byId);
  }
  const at = byId.get(id), entry = at === undefined ? undefined : list[at];
  if (entry?.id === id) return entry;
  const found = list.findIndex(candidate => candidate.id === id);
  if (found < 0) return undefined;
  byId.set(id, found);
  return list[found];
}

/** The first entry with this id; an id that is not a string matches nothing. */
export function findById<T extends { id: string }>(list: readonly T[], id: unknown): T | undefined {
  if (typeof id !== 'string') return undefined;
  const index = indexed(list);
  return index ? index.byId.get(id) as T | undefined : positioned(list, id);
}

/** The nodes showing this resource, in list order; a resource id that is not a string matches nothing. */
export function nodesOfResource<T extends { id: string; resourceId?: string }>(nodes: readonly T[], resourceId: unknown): readonly T[] {
  if (typeof resourceId !== 'string') return [];
  const index = indexed(nodes);
  if (!index) return nodes.filter(node => node.resourceId === resourceId);
  if (!index.byResource) {
    const byResource = new Map<string, T[]>();
    for (const node of nodes) if (node.resourceId !== undefined) { const list = byResource.get(node.resourceId); if (list) list.push(node); else byResource.set(node.resourceId, [node]); }
    for (const list of byResource.values()) Object.freeze(list);
    index.byResource = byResource as Map<string, unknown[]>;
  }
  return (index.byResource.get(resourceId) ?? []) as T[];
}
