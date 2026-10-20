import type { JsonValue, ResourcePluginConnector, ResourceRecord, ResourceSnapshot } from '../../types.ts';
import type { LinearClient, LinearIssue } from '../../../../packages/provider-runtime/linear.ts';
const title = (issue: LinearIssue) => `${issue.identifier} · ${issue.title}`;
const finished = (type: string) => type === 'completed' || type === 'canceled';
function snapshot(issue: LinearIssue): ResourceSnapshot {
  const type = issue.state.type;
  const tone = issue.archived ? 'neutral' : type === 'completed' ? 'green' : type === 'canceled' ? 'red' : type === 'started' ? 'amber' : type === 'unstarted' ? 'blue' : 'neutral';
  const label = issue.archived ? 'Archived in Linear' : issue.state.name;
  return { title: title(issue), done: finished(type), activity: issue.archived || ['completed', 'canceled'].includes(type) ? 'complete' : 'idle', attention: 'none', connection: 'connected', observedAt: new Date().toISOString(), label,
    indicators: [{ id: 'workflow', label, tone, icon: type === 'completed' ? 'check' : type === 'canceled' ? 'x' : 'clock', showLabel: true, ...(issue.archived || ['completed', 'canceled'].includes(type) ? { stage: 'done' as const } : {}) }],
    resolution: { data: { issueId: issue.id }, aliases: [issue.identifier, ...issue.previousIdentifiers].map(issueId => ({ issueId })) }, detail: { ...issue, state: { ...issue.state } } };
}
export function linearTicketConnector(clientFor: (resource: ResourceRecord, signal: AbortSignal) => Promise<LinearClient>): ResourcePluginConnector {
  const workspace = (resource: ResourceRecord) => typeof resource.data.workspaceKey === 'string' ? resource.data.workspaceKey : undefined;
  const read = async (resource: ResourceRecord, signal: AbortSignal) => (await clientFor(resource, signal)).issue(String(resource.data.issueId), typeof resource.data.workspaceKey === 'string' ? resource.data.workspaceKey : undefined, signal);
  return {
    pollIntervalMs: 60_000,
    async load(resource, signal) {
      const issue = await read(resource, signal);
      return snapshot(issue);
    },
    actions: () => [
      { id: 'linear.status.options', label: 'Available statuses', readOnly: true },
      { id: 'linear.status.set', label: 'Change Linear status', readOnly: false, updatesSnapshot: true,
        description: 'Update this issue in Linear. Use fresh options and a unique requestId; never retry an uncertain request with a new ID.',
        inputFields: Object.fromEntries(['value', 'expectedStateId', 'expectedUpdatedAt', 'sourceResourceId', 'requestId'].map(key => [key, { label: key, kind: 'text' as const, required: true }])) },
      { id: 'linear.status.complete', label: 'Mirror Mark done to Linear', readOnly: false, updatesSnapshot: true, completion: true,
        description: 'Mark done moves the issue to the team’s first completed status; Reopen returns it to the status it had before, else the first started one.' },
    ],
    async execute(resource, actionId, signal, input = {}) {
      const client = await clientFor(resource, signal);
      if (actionId === 'linear.status.options') {
        const { issue, states } = await client.workflow(String(resource.data.issueId), workspace(resource), signal);
        return { current: issue.state.id, context: { expectedStateId: issue.state.id, expectedUpdatedAt: issue.updatedAt, sourceResourceId: resource.id }, options: states.map(state => ({ id: state.id, label: state.name })) };
      }
      if (!['linear.status.set', 'linear.status.complete'].includes(actionId) || input.sourceResourceId !== resource.id) throw new Error('This Linear status action belongs to another item.');
      if (actionId === 'linear.status.complete') {
        const { issue, states } = await client.workflow(String(resource.data.issueId), workspace(resource), signal, true), done = input.done === 'true';
        if (finished(issue.state.type) === done) return { snapshot: snapshot(issue) } as unknown as JsonValue;
        const target = done ? states.find(state => state.type === 'completed')
          : states.find(state => state.id === input.restore && !finished(state.type)) ?? states.find(state => state.type === 'started') ?? states.find(state => state.type === 'unstarted');
        if (!target) throw new Error(done ? 'This Linear team has no completed status.' : 'This Linear team has no open status to return to.');
        const changed = await client.setState(String(resource.data.issueId), workspace(resource), { value: target.id, expectedStateId: issue.state.id, expectedUpdatedAt: issue.updatedAt }, signal);
        return { snapshot: snapshot(changed), ...(done ? { restore: issue.state.id } : {}) } as unknown as JsonValue;
      }
      const issue = await client.setState(String(resource.data.issueId), workspace(resource), input as { value: string; expectedStateId: string; expectedUpdatedAt: string }, signal);
      return { snapshot: snapshot(issue) } as unknown as JsonValue;
    },
    async getContext(resource, signal) {
      const issue = await read(resource, signal), content = [title(issue), `Linear · ${issue.state.name}${issue.archived ? ' · archived' : ''} · ${issue.updatedAt}`, issue.description].join('\n\n');
      return { resourceId: resource.id, title: title(issue), sourceUrl: issue.url, content: content.length > 32_000 ? content.slice(0, 31_940) + '\n[Context excerpt ends here; open the issue for the rest.]' : content };
    },
  };
}
