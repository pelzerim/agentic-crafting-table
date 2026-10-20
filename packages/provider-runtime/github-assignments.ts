import type { AssignmentAdapter } from '../workspace-service/assignments.ts';
import { GitHubClient, pullKey } from './github.ts';
import type { PullIdentity } from './github.ts';
import { githubCredentials, githubTransport } from './github-transport.ts';
import type { JsonObject } from '../../src/resource-plugins/types.ts';
import type { ProviderConnection } from '../core/connections.ts';

const identity = (data: JsonObject): PullIdentity => ({ owner: String(data.owner), repo: String(data.repo), number: Number(data.number) });
export function githubAssignmentAdapter(clientFor?: (connection: ProviderConnection) => GitHubClient): AssignmentAdapter {
  const credentials = githubCredentials();
  const client = clientFor ?? (connection => new GitHubClient(githubTransport(connection.account, credentials)));
  return {
    providerId: 'github', pluginId: 'github.pull-request', attentionNote: 'Assigned to you', key: data => pullKey(identity(data)), group: data => `${data.owner}/${data.repo}`.toLowerCase(),
    async discover(connection, previous, signal) {
      const api = client(connection), viewer = await api.viewer(signal);
      if (viewer.login.toLowerCase() !== connection.account.toLowerCase()) throw new Error('GitHub returned a different signed-in account. Reconnect this binding.');
      const assigned = (assignees: string[], state: string) => state === 'open' && assignees.some(login => login.toLowerCase() === connection.account.toLowerCase());
      const pulls = await api.assignedPulls(signal), seen = new Set(pulls.map(pullKey));
      const result = pulls.map(pull => ({ data: { owner: pull.owner, repo: pull.repo, number: pull.number }, title: pull.title, assigned: assigned(pull.assignees, pull.state) }));
      // Absence can mean lost access or a moving pagination boundary. Confirm
      // previously assigned PRs individually before clearing their attention.
      for (const entry of previous.filter(entry => entry.assigned && !seen.has(pullKey(identity(entry.data))))) {
        const key = identity(entry.data), pull = await api.pull(key, signal);
        result.push({ data: key, title: pull.title, assigned: assigned(pull.assignees.map(user => user.login), pull.state) });
      }
      return result;
    },
  };
}
