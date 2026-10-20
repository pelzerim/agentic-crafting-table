import type { GraphNode } from '../../../../src/graph/graph.ts';

export interface ComboOption { value: string; label: string; group?: string; meta?: string }
const FLOATING = 'No project';

/** Map items as combobox choices: one group per project, the project itself first, floating items last. */
export function itemOptions<N extends Pick<GraphNode, 'id' | 'title' | 'resourceId' | 'projectId'>>(nodes: readonly N[], include: (node: N) => boolean): (ComboOption & { group: string })[] {
  const projects = new Map(nodes.filter(node => !node.resourceId).map(node => [node.id, node.title]));
  return nodes.filter(include).map(node => node.resourceId
    ? { value: node.id, label: node.title, group: projects.get(node.projectId ?? '') ?? FLOATING }
    : { value: node.id, label: node.title, group: node.title, meta: 'whole project' })
    .sort((a, b) => Number(a.group === FLOATING) - Number(b.group === FLOATING) || a.group.localeCompare(b.group) || Number(Boolean(b.meta)) - Number(Boolean(a.meta)));
}

export function matchOptions<T extends ComboOption>(options: readonly T[], query: string): T[] {
  const words = query.trim().toLowerCase();
  return words ? options.filter(option => `${option.label} ${option.group ?? ''}`.toLowerCase().includes(words)) : [...options];
}
