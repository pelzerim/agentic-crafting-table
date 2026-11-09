import type { GitHubComment, GitHubResponse, PullIdentity } from '../../packages/provider-runtime/github.ts';
import { GitHubClient } from '../../packages/provider-runtime/github.ts';
import { ProviderConnections } from '../../packages/provider-runtime/connections.ts';

export const issueFixture = { id: 70, number: 7, title: 'Search ignores accents', body: 'Searching **café** finds nothing.\n\n<script>window.providerScriptExecuted=true</script>', state: 'open' as 'open' | 'closed',
  state_reason: null as string | null, user: { login: 'fixture-reporter' }, assignees: [{ login: 'fixture-developer' }], labels: [{ name: 'bug', color: 'd73a4a' }], comments: 1,
  created_at: '2026-10-01T09:00:00Z', updated_at: '2026-10-02T09:00:00Z', closed_at: null as string | null };

/** A fake GitHub behind a real client: one issue (fixture/web #7) with its comments, linked pull requests,
 * assigned list and state writes. `writes` records each PATCH as `state:reason`. */
export function githubIssueFixture() {
  const fixture = {
    issue: structuredClone(issueFixture),
    comments: [{ id: 11, body: 'Reproduced with **é** too.', user: { login: 'fixture-reviewer' }, created_at: '2026-10-02T08:00:00Z', updated_at: '2026-10-02T08:00:00Z' }] as GitHubComment[],
    pulls: [{ owner: 'fixture', repo: 'web', number: 12 }] as PullIdentity[],
    assigned: [] as { owner: string; repo: string; number: number; title: string; updated_at: string; pull_request?: object; state?: 'open' | 'closed' }[],
    viewer: 'fixture-developer', status: 200, writes: [] as string[], reads: [] as string[],
    /** Replaces GitHub's answer to the next state write. */
    stateReply: undefined as ((change: { state: string; state_reason: string }) => GitHubResponse) | undefined,
  };
  const reply = (body: unknown, status = fixture.status): GitHubResponse => ({ status, headers: new Headers(), body: status === 200 ? body : { message: 'Fixture error' } });
  const client = new GitHubClient({
    async get(path) {
      fixture.reads.push(path);
      if (path === '/user') return reply({ id: 1, login: fixture.viewer });
      if (path.startsWith('/issues?filter=assigned')) return reply(fixture.assigned.map(entry => ({ state: 'open', assignees: [{ login: 'fixture-developer' }], repository: { full_name: `${entry.owner}/${entry.repo}` }, labels: [], ...entry })));
      if (/\/issues\/7\/comments\?/.test(path)) return reply(fixture.comments);
      if (/\/issues\/7$/.test(path)) return reply({ ...fixture.issue, comments: fixture.comments.length });
      return reply({ message: 'Not Found' }, 404);
    },
    async setIssueState(_identity, change) {
      fixture.writes.push(`${change.state}:${change.state_reason}`);
      if (fixture.stateReply) { const answer = fixture.stateReply(change); fixture.stateReply = undefined; return answer; }
      Object.assign(fixture.issue, { state: change.state, state_reason: change.state_reason, closed_at: change.state === 'closed' ? '2026-10-03T09:00:00Z' : null, updated_at: '2026-10-03T09:00:00Z' });
      return reply({ ...fixture.issue, comments: fixture.comments.length });
    },
    async issuePulls() {
      fixture.reads.push('graphql:issuePulls');
      return reply({ data: { repository: { issue: { closedByPullRequestsReferences: { nodes: fixture.pulls.map(pull => ({ number: pull.number, repository: { name: pull.repo, owner: { login: pull.owner } } })) }, timelineItems: { nodes: [] } } } } });
    },
  });
  const accounts = [{ id: 'github-fixture', providerId: 'github', account: 'fixture-developer', enabled: true, isDefault: true }];
  const connections = new ProviderConnections(() => accounts, [{ id: 'github', name: 'GitHub', setupHint: 'Fixture account', accounts: async () => [{ id: 'fixture-developer', label: 'fixture-developer', active: true, available: true, credentialSource: 'test fixture' }] }]);
  return Object.assign(fixture, { client, accounts, connections });
}
