import { plotSizeLimit } from '../../../src/graph/plots.ts';
import type { PlotView } from '../../../src/graph/plots.ts';

/** Dropped items to pin into `into`: items that end up in its project, are not members yet, and that nearness alone would
 * not bring in or keep, because another plot holds them or the plot would grow past what nearness holds in a project of `projectItems`. */
export function plotJoinIds(into: Pick<PlotView, 'projectId' | 'memberIds' | 'locked'>, landed: readonly { id: string; resourceId?: string; projectId?: string }[], plotted: ReadonlySet<string>, projectItems: number): string[] {
  const joining = landed.filter(node => node.resourceId && node.projectId === into.projectId && !into.memberIds.includes(node.id));
  const pinAll = into.locked || into.memberIds.length + joining.length > plotSizeLimit(projectItems);
  return joining.filter(node => pinAll || plotted.has(node.id)).map(node => node.id);
}
