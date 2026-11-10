/** Lookups by id over workspace lists. A frozen list (the store's shared read) cannot change, so its index is built once and kept
 * with it; any other list, such as a command's draft, is searched each time. */
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

/** The first entry with this id; an id that is not a string matches nothing. */
export function findById<T extends { id: string }>(list: readonly T[], id: unknown): T | undefined {
  if (typeof id !== 'string') return undefined;
  const index = indexed(list);
  return index ? index.byId.get(id) as T | undefined : list.find(entry => entry.id === id);
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
