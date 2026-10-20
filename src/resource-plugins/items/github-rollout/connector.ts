import { createHash } from 'node:crypto';
import type { ResourcePluginConnector, ResourceRecord, JsonObject, JsonValue } from '../../types.ts';
import { approvableGates, rolloutStatus } from '../../../../packages/provider-runtime/github-rollout.ts';
import type { GitHubRolloutClient } from '../../../../packages/provider-runtime/github-rollout.ts';

const positive = (value: unknown) => { const number = Number(value); if (!/^[1-9]\d{0,15}$/.test(String(value)) || !Number.isSafeInteger(number)) throw new Error('This approval is incomplete. Review the rollout again.'); return number; };

export function githubRolloutConnector(clientFor: (resource: ResourceRecord) => GitHubRolloutClient): ResourcePluginConnector {
  const connector: ResourcePluginConnector = {
    pollIntervalMs: 60_000,
    async load(resource, signal) {
      const observation = await clientFor(resource).observe(resource.data, signal), status = rolloutStatus(observation);
      return { title: observation.workflow, activity: status.activity, attention: 'none', connection: 'connected',
        label: status.label, indicators: [status.indicator], attentionReason: status.reason, ...(status.note ? { attentionNote: status.note } : {}), attentionEventId: createHash('sha256').update(status.eventId).digest('hex'),
        observedAt: new Date().toISOString(), detail: { ...observation, state: status.state, approvable: approvableGates(observation).length > 0 } as unknown as JsonObject };
    },
    actions: () => [
      { id: 'rollout.approval.options', label: 'Deployments awaiting your approval', readOnly: true },
      { id: 'rollout.shipped', label: 'Pull requests this run ships', readOnly: true, description: 'Pull requests merged since the previous successful run of the workflow.',
        inputFields: { runId: { label: 'Run ID', kind: 'number', integer: true, min: 1, required: true }, workflowId: { label: 'Workflow ID', kind: 'number', integer: true, min: 1, required: true },
          runNumber: { label: 'Run number', kind: 'number', integer: true, min: 1, required: true }, head: { label: 'Head commit', kind: 'text', required: true, pattern: '^[a-fA-F0-9]{40,64}$' }, branch: { label: 'Branch', kind: 'text', pattern: '^\\S{1,250}$' } } },
      { id: 'rollout.approve', label: 'Approve deployment', readOnly: false, updatesSnapshot: true, humanOnly: true,
        description: 'Approve the pending deployment gates on GitHub. Only a person can confirm this in the app.',
        inputFields: Object.fromEntries(['value', 'runId', 'attempt', 'environmentIds', 'sourceResourceId', 'requestId'].map(key => [key, { label: key, kind: 'text' as const, required: true }])) },
    ],
    async execute(resource, action, signal, input = {}): Promise<JsonValue> {
      const client = clientFor(resource);
      if (action === 'rollout.approval.options') {
        const observation = await client.observe(resource.data, signal), gates = approvableGates(observation);
        if (!observation.run || !gates.length) throw new Error('Nothing in this rollout is waiting for your approval.');
        return { current: '', prompt: `Approve ${gates.map(gate => gate.environment.name).join(', ')} for run #${observation.run.run_number}?`,
          context: { runId: String(observation.run.id), attempt: String(observation.run.run_attempt), environmentIds: gates.map(gate => gate.environment.id).join(','), sourceResourceId: resource.id },
          options: [{ id: 'approve', label: 'Confirm' }] };
      }
      if (action === 'rollout.shipped') return await client.shipped(resource.data, { id: positive(input.runId), workflow_id: positive(input.workflowId), run_number: positive(input.runNumber), head_sha: String(input.head),
        head_branch: typeof input.branch === 'string' ? input.branch : null }, signal) as unknown as JsonValue;
      if (action !== 'rollout.approve') throw new Error('Unknown rollout action');
      if (input.sourceResourceId !== resource.id || input.value !== 'approve') throw new Error('This approval belongs to another item. Review the rollout again.');
      const environmentIds = String(input.environmentIds).split(',').map(positive);
      await client.approve(resource.data, { runId: positive(input.runId), attempt: positive(input.attempt), environmentIds }, signal);
      try { return { snapshot: await connector.load!(resource, signal) } as unknown as JsonValue; }
      catch { throw Object.assign(new Error('Approved, but refresh failed. Check GitHub before approving again.'), { outcomeUnknown: true }); }
    },
    async getContext(resource, signal) {
      const value = await clientFor(resource).observe(resource.data, signal), status = rolloutStatus(value);
      return { resourceId: resource.id, title: value.workflow, sourceUrl: value.url,
        content: `${value.workflow}\n${status.label}\n${value.followsLatest ? 'Following latest run' : 'Pinned run'}\n${value.run ? `Run ${value.run.id}, attempt ${value.run.run_attempt}, branch ${value.run.head_branch}, commit ${value.run.head_sha}` : 'No runs yet'}\n${value.gates.map(g => `Waiting: ${g.environment.name}${g.reviewers.length ? ' (approval)' : ' (protection rules)'}`).join('\n')}\n${value.jobs.map(j => `${j.name}: ${j.conclusion ?? j.status}`).join('\n')}` };
    },
  };
  return connector;
}
