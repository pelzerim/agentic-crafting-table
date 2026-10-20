import { stateSchema } from '../../packages/core/control.ts';
import { minutesAgo, photoLibraryProject } from './photo-library-project.ts';

/** The photo library project with one item for every Needs me tier and Working combination
 * (STATE-02), plus a small second project that can be muted. Static records only. */
export function stateLanguageProject() {
  const base = photoLibraryProject();
  const raised = (minutes: number, extra: Record<string, unknown>) => ({ attentionVersion: 1, attentionAt: minutesAgo(minutes), ...extra });
  const changes: Record<string, Record<string, unknown>> = {
    // Asking me: something is stopped until I act.
    metrics: raised(240, { attention: 'input', attentionNote: 'Needs permission to run npm test' }),
    rollout: raised(6, { attention: 'input', attentionNote: 'Gate needs approval' }),
    // Working and asking at once.
    ordering: raised(1, { activity: 'working', summary: 'running tests', attention: 'input', attentionNote: 'Needs permission to push' }),
    // My turn: work waits on me, nothing is stopped.
    'pr-62': raised(1440, { attention: 'review' }),
    'pr-64': raised(20, { attentionSources: { 'provider:github.pull-request': 'checks-failing' } }),
    'pr-65': raised(120, { attentionSources: { 'provider:comments': 'comment' }, attentionNotes: { 'provider:comments': '3 new comments' } }),
    // Finished: for my information.
    resizer: raised(9, { attentionSources: { completion: 'finished' } }),
    'pr-66': raised(30, { attentionSources: { 'provider:review': 'approved' } }),
    // Working and finished: a turn ended while the agent kept going.
    upload: raised(2, { completedAt: undefined, activity: 'working', summary: 'watching CI', attentionSources: { completion: 'finished' }, attentionNotes: { completion: 'Finished a turn' } }),
    split: { activity: 'working', summary: 'editing importer.ts', activityAt: minutesAgo(3) },
    // A ticket as the Linear connector saves it: its status cue asks for a label.
    'app-40': { indicators: [{ id: 'state', label: 'In progress', tone: 'amber', icon: 'clock', showLabel: true }] },
  };
  const nodes: Record<string, unknown>[] = base.nodes.map(node => ({ ...node, ...changes[node.id] }));
  const resources: Record<string, unknown>[] = [...base.resources];
  nodes.push({ id: 'billing', title: 'Billing', position: { x: 4500, y: 950 } });
  const add = (id: string, pluginId: string, title: string, x: number, y: number, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    resources.push({ id: `${id}-r`, pluginId, schemaVersion: 1, title, data });
    nodes.push({ id, resourceId: `${id}-r`, projectId: 'billing', title, position: { x, y }, activity: 'idle', ...extra });
  };
  add('invoice-agent', 'agent.session', 'Invoice agent', 4300, 880, { sessionId: 'static-invoice', provider: 'claude' }, raised(12, { mapSize: 'small', attention: 'input', attentionNote: 'Needs an answer about rounding' }));
  add('pr-91', 'github.pull-request', 'Invoice rounding', 4680, 880, { owner: 'example', repo: 'billing', number: 91 }, raised(45, { attention: 'review' }));
  add('tax-agent', 'agent.session', 'Tax agent', 4480, 1040, { sessionId: 'static-tax', provider: 'claude' }, { mapSize: 'small', activity: 'working', summary: 'reading rates' });
  return stateSchema.parse({ ...base, nodes, resources });
}
