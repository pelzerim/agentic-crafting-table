import { LinearClient, linearAccount } from '../../packages/provider-runtime/linear.ts';
import type { LinearTransport } from '../../packages/provider-runtime/linear.ts';
export const linearIssueId = '11111111-1111-4111-8111-111111111111';
export function linearFixture() {
  const data = { viewer: { id: '22222222-2222-4222-8222-222222222222', name: 'Fixture Developer' }, organization: { id: '33333333-3333-4333-8333-333333333333', name: 'Fixture Team', urlKey: 'fixture', previousUrlKeys: ['old-fixture'] },
    issue: { id: linearIssueId, identifier: 'BIL-128', previousIdentifiers: ['OLD-42'], title: 'Make plan changes predictable', description: 'Keep the current billing cycle.\n\n<script>window.linearInjected=true</script>', url: 'https://linear.app/fixture/issue/BIL-128/plan-changes', updatedAt: '2026-09-26T12:00:00.000Z', archivedAt: null as string | null, team: { id: '55555555-5555-4555-8555-555555555555' }, state: { id: '44444444-4444-4444-8444-444444444444', name: 'In Progress', type: 'started' } } };
  const states = [
    { id: '66666666-6666-4666-8666-666666666666', name: 'Todo', type: 'unstarted', position: 0 },
    { ...data.issue.state, position: 1 },
    { id: '77777777-7777-4777-8777-777777777777', name: 'In Review', type: 'started', position: 2 },
    { id: '88888888-8888-4888-8888-888888888888', name: 'Done', type: 'completed', position: 3 },
  ];
  const calls: string[] = [], writes: { id: string; stateId: string }[] = [], filters: { states?: readonly string[]; priorities?: readonly number[] }[] = [];
  // Open issues assigned to the fixture user, in provider order. Tests may edit, remove or add entries.
  const assigned: { id: string; identifier: string; title: string; url: string; updatedAt: string; priority: number; state: { id: string; name: string; type: string }; team: { id: string; key: string; name: string } }[] = [];
  // `unfiltered` answers like a server that ignored the query filter.
  const paging = { repeatCursor: false, size: 50, unfiltered: false };
  const assign = (count: number) => {
    for (let number = assigned.length + 1; count > 0; count--, number++) assigned.push({ id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(number).padStart(12, '0')}`, identifier: `BIL-${number}`, title: `Assigned ticket ${number}`, url: `https://linear.app/fixture/issue/BIL-${number}/assigned-ticket-${number}`,
      updatedAt: '2026-09-26T12:00:00.000Z', priority: 2, state: { id: states[0].id, name: states[0].name, type: states[0].type }, team: { id: data.issue.team.id, key: 'BIL', name: 'Billing team' } });
    return assigned;
  };
  const transport: LinearTransport = { async read(operation, variables, signal) {
      signal.throwIfAborted(); calls.push(`${operation}:${variables.id ?? variables.after ?? ''}`);
      if (operation === 'assigned') {
        filters.push({ states: variables.states, priorities: variables.priorities });
        const matching = paging.unfiltered ? assigned : assigned.filter(issue => variables.states?.includes(issue.state.type) && variables.priorities?.includes(issue.priority));
        const start = Number(variables.after ?? 0), nodes = matching.slice(start, start + paging.size), more = start + paging.size < matching.length;
        return structuredClone({ viewer: { ...data.viewer, assignedIssues: { nodes, pageInfo: { hasNextPage: more, endCursor: more ? String(paging.repeatCursor ? paging.size : start + paging.size) : null } } }, organization: data.organization });
      }
      const ticket = operation === 'issue' ? assigned.find(issue => issue.id === variables.id || issue.identifier === variables.id) : undefined;
      if (ticket) return structuredClone({ ...data, issue: { ...ticket, previousIdentifiers: [], description: `Description of ${ticket.identifier}.`, archivedAt: null, team: { id: ticket.team.id } } });
      return structuredClone(operation === 'workflow' ? { ...data, team: { id: data.issue.team.id, states: { nodes: states, pageInfo: { hasNextPage: false } } } } : data);
    },
    async updateState(id, stateId, signal) {
      signal.throwIfAborted(); writes.push({ id, stateId });
      const state = states.find(state => state.id === stateId); if (!state) throw new Error('Unknown fixture state');
      data.issue.state = { id: state.id, name: state.name, type: state.type }; data.issue.updatedAt = new Date(Date.parse(data.issue.updatedAt) + 1000).toISOString();
      return { issueUpdate: { success: true, issue: structuredClone(data.issue) } };
    },
  };
  return { data, calls, writes, filters, states, assigned, assign, paging, transport, account: linearAccount(data), client: new LinearClient(transport, linearAccount(data).id) };
}

import { ProviderConnections } from '../../packages/provider-runtime/connections.ts';
import { ResourcePluginHost } from '../../src/resource-plugins/host.ts';
import { linearTriageAdapter } from '../../packages/provider-runtime/linear-triage.ts';
import { linearTicketConnector } from '../../src/resource-plugins/items/linear-ticket/connector.ts';
import type { ResourcePluginRegistry } from '../../src/resource-plugins/registry.ts';
/** `assigned` turns on the assigned-ticket import with that many open tickets; without it no import runs. */
export function linearProviders(options: { assigned?: number } = {}) {
  const fixture = linearFixture(), accounts = [{ id: 'linear-fixture', providerId: 'linear', account: fixture.account.id, enabled: true, isDefault: true }];
  const connections = new ProviderConnections(() => accounts, [{ id: 'linear', name: 'Linear', setupHint: 'Local fixture only', accounts: async () => [{ id: accounts[0].account, label: 'Fixture Team · Fixture Developer', active: true, available: true, credentialSource: 'Fixture' }] }]);
  if (options.assigned !== undefined) fixture.assign(options.assigned);
  const triage = options.assigned === undefined ? undefined : { adapters: [linearTriageAdapter(async () => fixture.client)], connections: () => accounts };
  return { ...fixture, accounts, connections, ...(triage ? { triage } : {}), host(registry: ResourcePluginRegistry) {
    const host = new ResourcePluginHost(registry); host.register('linear.ticket', linearTicketConnector(async resource => { const connection = connections.resolve('linear', resource.connectionId); return new LinearClient(fixture.transport, connection.account); })); return host;
  } };
}
