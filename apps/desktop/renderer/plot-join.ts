import type { PlotView } from '../../../src/graph/plots.ts';

/** Dropped items to pin into `into`: items that end up in its project, are not members yet, and that nearness alone would not bring in. */
export function plotJoinIds(into: Pick<PlotView, 'projectId' | 'memberIds' | 'locked'>, landed: readonly { id: string; resourceId?: string; projectId?: string }[], plotted: ReadonlySet<string>): string[] {
  return landed.filter(node => node.resourceId && node.projectId === into.projectId && !into.memberIds.includes(node.id) && (into.locked || plotted.has(node.id))).map(node => node.id);
}
