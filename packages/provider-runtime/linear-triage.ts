import type { TriageAdapter } from '../workspace-service/triage.ts';
import type { ProviderConnection } from '../core/connections.ts';
import type { JsonObject } from '../../src/resource-plugins/types.ts';
import { providerCredential } from './keychain.ts';
import { LINEAR_TRIAGE_PRIORITIES, LINEAR_TRIAGE_STATE_TYPES, LinearClient, linearTransport } from './linear.ts';
import type { LinearAssignedFilter } from './linear.ts';
import { requestBudget } from './request-budget.ts';

/** The saved Linear ticket settings as an import filter. Settings saved before the filter existed
 * select every open status and any priority; a value outside the fixed lists never widens it. */
export function linearTriageFilter(settings: JsonObject): Required<LinearAssignedFilter> {
  const saved = settings.triageStateTypes, priority = settings.triagePriority;
  return { stateTypes: Array.isArray(saved) ? LINEAR_TRIAGE_STATE_TYPES.filter(type => saved.includes(type)) : [...LINEAR_TRIAGE_STATE_TYPES],
    priority: typeof priority === 'string' && Object.hasOwn(LINEAR_TRIAGE_PRIORITIES, priority) ? priority as keyof typeof LINEAR_TRIAGE_PRIORITIES : 'any' };
}

/** Linear issues assigned to the connected account in the chosen statuses, for the to-do inbox under Linear's own title. Read-only. */
export function linearTriageAdapter(clientFor?: (connection: ProviderConnection, signal: AbortSignal) => Promise<LinearClient>): TriageAdapter {
  const credential = providerCredential('linear');
  const client = clientFor ?? (async (connection, signal) => new LinearClient(linearTransport(await credential(signal), fetch, requestBudget('linear', connection.account)), connection.account));
  return {
    providerId: 'linear', pluginId: 'linear.ticket', setting: { plugin: 'linear.ticket', key: 'importAssigned' },
    keys: data => typeof data.issueId === 'string' ? [data.issueId.toLowerCase()] : [],
    scope(settings) { const filter = linearTriageFilter(settings); return filter.stateTypes.length ? `${filter.stateTypes.join(',')}/${filter.priority}` : undefined; },
    async discover(connection, signal, settings) {
      const { issues, truncated } = await (await client(connection, signal)).assignedIssues(signal, linearTriageFilter(settings));
      return { complete: !truncated, tickets: issues.map(issue => ({ key: issue.id, aliases: [issue.identifier.toLowerCase()], label: issue.identifier, title: issue.title, status: issue.state.name, url: issue.url,
        item: { title: `${issue.identifier} · ${issue.title}`, data: { issueId: issue.id } } })) };
    },
  };
}
