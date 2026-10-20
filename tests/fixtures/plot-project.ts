import { stateSchema } from '../../packages/core/control.ts';
import { cue, minutesAgo } from './photo-library-project.ts';

/** A plots sample: Photos with three obvious groups (thumbnail refresh, billing,
 * upload stalls) and two loose items, 13 items in all; `color` is Photos' neighborhood color. Sample data only. */
export function plotProject(color?: string) {
  const nodes: Record<string, unknown>[] = [{ id: 'photos', title: 'Photos', position: { x: 640, y: 420 }, ...(color ? { color } : {}) }], resources: Record<string, unknown>[] = [], links: Record<string, unknown>[] = [];
  const add = (id: string, pluginId: string, title: string, x: number, y: number, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    resources.push({ id: `${id}-r`, pluginId, schemaVersion: 1, title, data });
    nodes.push({ id, resourceId: `${id}-r`, projectId: 'photos', title, position: { x, y }, activity: 'idle', ...extra });
  };
  add('thumb-agent', 'agent.session', 'Fix thumbnail refresh loop', 220, 230, { sessionId: 'static-thumb', provider: 'claude' }, { mapSize: 'small', activity: 'working', summary: 'Patching retry delay', activityAt: minutesAgo(4) });
  add('thumb-pr', 'github.pull-request', 'Thumbnail refresh loop', 470, 230, { owner: 'example', repo: 'photos', number: 64 }, { indicators: cue('Checks running', 'amber', 'clock') });
  add('thumb-ticket', 'linear.ticket', 'APP-12 · Thumbnail expiry', 220, 330, { issueId: 'APP-12' }, { indicators: cue('In progress', 'amber', 'clock') });
  add('thumb-note', 'workspace.note', 'Retry delay', 470, 340, { text: 'Retry delay' });
  add('billing-pr', 'github.pull-request', 'Plan switcher', 900, 200, { owner: 'example', repo: 'web', number: 48 }, { indicators: cue('Review requested', 'amber', 'alert-triangle'), attention: 'review' });
  add('billing-agent', 'agent.session', 'Billing proration', 1150, 200, { sessionId: 'static-billing', provider: 'claude' }, { mapSize: 'small', activity: 'working', summary: 'Writing invoice tests', activityAt: minutesAgo(1) });
  add('billing-rollout', 'github.rollout', 'billing-api release', 900, 310, { owner: 'example', repo: 'billing-api', runId: 91 }, { indicators: cue('Waiting', 'neutral', 'clock') });
  add('billing-terminal', 'workspace.note', 'webhook replay', 1150, 300, { text: 'webhook replay' });
  add('upload-terminal', 'workspace.note', 'upload size check', 500, 640, { text: 'upload size check' });
  add('upload-ticket', 'linear.ticket', 'APP-30 · Upload stalls', 750, 640, { issueId: 'APP-30' }, { indicators: cue('To do', 'blue', 'clock') });
  add('upload-note', 'workspace.note', 'Upload samples', 500, 750, { text: 'Upload samples' });
  add('changelog', 'workspace.note', 'Update changelog', 160, 980, { text: 'Update changelog' });
  add('ideas', 'workspace.note', 'Ideas', 1200, 980, { text: 'Ideas' });
  links.push({ id: 'l1', sourceId: 'thumb-agent', targetId: 'thumb-pr', kind: 'context' }, { id: 'l2', sourceId: 'thumb-pr', targetId: 'thumb-note', kind: 'reference' },
    { id: 'l3', sourceId: 'thumb-pr', targetId: 'upload-ticket', kind: 'reference' }, { id: 'l4', sourceId: 'billing-pr', targetId: 'billing-agent', kind: 'context' },
    { id: 'l5', sourceId: 'upload-terminal', targetId: 'upload-ticket', kind: 'reference' });
  return stateSchema.parse({ version: 1, revision: 1, nodes, resources, links, todos: [], view: {} });
}
