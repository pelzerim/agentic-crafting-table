import { stateSchema } from '../../packages/core/control.ts';

type Tone = 'neutral' | 'green' | 'blue' | 'amber' | 'violet' | 'red';
export const cue = (label: string, tone: Tone, icon: string, stage?: 'ready' | 'failing' | 'done') => [{ id: 'state', label, tone, icon, ...(stage ? { stage } : {}) }];
export const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** A busy photo library project: 10 PRs, 9 tickets, 5 agents, a rollout and a note. */
export function photoLibraryProject() {
  const nodes: Record<string, unknown>[] = [{ id: 'project', title: 'Photo library', position: { x: 2300, y: 950 } }], resources: Record<string, unknown>[] = [], links: Record<string, unknown>[] = [];
  const add = (id: string, pluginId: string, title: string, x: number, y: number, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    resources.push({ id: `${id}-r`, pluginId, schemaVersion: 1, title, data });
    nodes.push({ id, resourceId: `${id}-r`, projectId: 'project', title, position: { x, y }, activity: 'idle', ...extra });
  };
  const pr = (number: number, title: string, x: number, y: number, indicators: unknown, extra: Record<string, unknown> = {}) => add(`pr-${number}`, 'github.pull-request', title, x, y, { owner: 'example', repo: 'photos', number }, { indicators, ...extra });
  const ticket = (key: string, title: string, x: number, y: number, indicators: unknown) => add(key.toLowerCase(), 'linear.ticket', `${key} · ${title}`, x, y, { issueId: key }, { indicators });
  const agent = (id: string, title: string, x: number, y: number, extra: Record<string, unknown> = {}) => add(id, 'agent.session', title, x, y, { sessionId: `static-${id}`, provider: 'claude' }, { mapSize: 'small', ...extra });
  ticket('APP-12', 'Upload timeouts', 1640, 500, cue('In review', 'blue', 'clock'));
  pr(41, 'Upload retry window', 2075, 500, cue('Approved', 'green', 'check', 'ready'));
  agent('upload', 'Upload fix', 2440, 500, { completedAt: minutesAgo(120) });
  ticket('APP-30', 'Per-album size limits', 3090, 460, cue('In review', 'blue', 'clock'));
  pr(56, 'Size limits from config', 3560, 460, cue('Queued', 'amber', 'git-merge'));
  ticket('APP-31', 'Classify failed imports', 3090, 640, cue('In progress', 'amber', 'clock'));
  ticket('APP-33', 'Thumbnail cache metrics', 3500, 640, cue('To do', 'blue', 'clock'));
  ticket('APP-9', 'Cancel propagation', 1260, 700, cue('Backlog', 'neutral', 'clock'));
  ticket('APP-11', 'Pause imports on quit', 1300, 810, cue('Done', 'green', 'check', 'done'));
  ticket('APP-40', 'Split the importer', 1940, 880, cue('In progress', 'amber', 'clock'));
  ticket('APP-41', 'Importer batches', 1940, 1015, cue('In progress', 'amber', 'clock'));
  agent('split', 'Importer split', 2390, 910, { activity: 'working', summary: 'editing importer.ts', activityAt: minutesAgo(3) });
  add('notes', 'workspace.note', 'Album handover', 2840, 915, { text: 'Album handover\nKeep the old table readable until the import finishes.' });
  pr(62, 'Album table migration', 2940, 1050, cue('Open', 'green', 'git-pull-request'), { attention: 'review' });
  pr(9, 'Graceful shutdown', 1265, 990, cue('Merged', 'violet', 'git-merge', 'done'));
  add('rollout', 'github.rollout', 'Rollout preview', 1290, 1175, { owner: 'example', repo: 'photos', runId: 77 }, { indicators: cue('Waiting approval', 'amber', 'alert-triangle'), attention: 'input' });
  pr(63, 'Importer interface', 1712, 1280, cue('Approved', 'green', 'check', 'ready'));
  pr(64, 'Thumbnail refresh loop', 2025, 1280, cue('Checks failing', 'red', 'x', 'failing'), { attentionSources: { 'provider:github.pull-request': 'checks-failing' }, attentionVersion: 1 });
  pr(65, 'Upload ordering', 2362, 1280, cue('Changes requested', 'amber', 'alert-triangle'));
  pr(66, 'Cache metrics', 2700, 1280, cue('Approved', 'green', 'check', 'ready'));
  pr(67, 'Remove old resizer', 3062, 1280, cue('Draft', 'neutral', 'clock'));
  agent('ordering', 'Ordering fixes', 2362, 1400, { activity: 'working', summary: 'running tests' });
  agent('metrics', 'Cache metrics agent', 2700, 1400, { attention: 'input' });
  agent('resizer', 'Resizer cleanup', 3062, 1400);
  ticket('APP-8', 'Upload timeout budget', 660, 1368, cue('Done', 'green', 'check', 'done'));
  pr(22, 'Upload timeout budget', 1090, 1370, cue('Merged', 'violet', 'git-merge', 'done'));
  const link = (sourceId: string, targetId: string) => links.push({ id: `${sourceId}-${targetId}`, sourceId, targetId, kind: 'reference' });
  for (const target of ['pr-63', 'pr-64', 'pr-65', 'pr-66', 'pr-67', 'pr-62', 'notes']) link('split', target);
  link('app-40', 'split'); link('app-41', 'split'); link('app-12', 'pr-41'); link('pr-41', 'upload'); link('app-30', 'pr-56');
  link('pr-9', 'rollout'); link('app-8', 'pr-22'); link('pr-65', 'ordering'); link('pr-66', 'metrics'); link('pr-67', 'resizer');
  return stateSchema.parse({ version: 1, revision: 0, nodes, resources, links, todos: [], view: {} });
}
