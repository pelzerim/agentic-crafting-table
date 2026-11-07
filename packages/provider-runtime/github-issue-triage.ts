import type { TriageAdapter } from '../workspace-service/triage.ts';
import type { ProviderConnection } from '../core/connections.ts';
import { GitHubClient, issueKey } from './github.ts';
import { githubCredentials, githubTransport } from './github-transport.ts';

/** Open GitHub issues assigned to the connected account, for the to-do inbox under GitHub's own title. Read-only. */
export function githubIssueTriageAdapter(clientFor?: (connection: ProviderConnection) => GitHubClient): TriageAdapter {
  const credentials = githubCredentials();
  const client = clientFor ?? (connection => new GitHubClient(githubTransport(connection.account, credentials)));
  return {
    providerId: 'github', pluginId: 'github.issue', setting: { plugin: 'github.issue', key: 'importAssigned' },
    keys: data => { try { return [issueKey({ owner: String(data.owner), repo: String(data.repo), number: Number(data.number) })]; } catch { return []; } },
    async discover(connection, signal) {
      const api = client(connection), viewer = await api.viewer(signal);
      if (viewer.login.toLowerCase() !== connection.account.toLowerCase()) throw new Error('GitHub returned a different signed-in account. Reconnect this binding.');
      const { issues, truncated } = await api.assignedIssues(signal);
      return { complete: !truncated, tickets: issues.map(issue => ({ key: issueKey(issue), aliases: [], label: `${issue.repo}#${issue.number}`.slice(0, 60), title: issue.title, status: 'Open', url: issue.url,
        item: { title: issue.title, data: { owner: issue.owner, repo: issue.repo, number: issue.number } } })) };
    },
  };
}
