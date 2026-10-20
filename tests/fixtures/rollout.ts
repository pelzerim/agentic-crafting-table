import { GitHubRolloutClient } from '../../packages/provider-runtime/github-rollout.ts';
import type { RolloutRun, RolloutJob, RolloutGate } from '../../packages/provider-runtime/github-rollout.ts';

/** Other runs of the workflow, by status, and what GitHub knows about their commits. */
export interface QueueFixture { runs: RolloutRun[]; successes: RolloutRun[]; pulls: Record<string, unknown[]>; merged: Record<number, unknown>; jobs: Record<number, RolloutJob[]>; gates: Record<number, RolloutGate[]>; fail?: boolean;
  /** What comparing two commits returns. */
  compare?: { total_commits: number; commits: { sha: string; commit: { message: string } }[] } }
import { ProviderConnections } from '../../packages/provider-runtime/connections.ts';
import { ResourcePluginHost } from '../../src/resource-plugins/host.ts';
import { githubRolloutConnector } from '../../src/resource-plugins/items/github-rollout/connector.ts';
import type { ResourcePluginRegistry } from '../../src/resource-plugins/registry.ts';
import { rolloutPresentation } from '../../src/resource-plugins/items/github-rollout/service.ts';

export function rolloutFixture() {
  let run: RolloutRun = { id: 101, name: 'Web / Release', display_title: 'Ship faster thumbnails', run_number: 28, run_attempt: 1, workflow_id: 9,
    head_branch: 'main', head_sha: 'a'.repeat(40), status: 'in_progress', conclusion: null, updated_at: '2026-09-28T10:00:00Z', repository: { full_name: 'fixture/web' } };
  let jobs: RolloutJob[] = [
    { id: 201, run_id: 101, name: 'deploy-staging / region-a', status: 'completed', conclusion: 'success' },
    { id: 202, run_id: 101, name: 'deploy-production / region-a', status: 'in_progress', conclusion: null },
    { id: 203, run_id: 101, name: 'deploy-production / region-b', status: 'queued', conclusion: null },
  ];
  let gates: RolloutGate[] = [], code = 200, headers: Record<string, string> = {}, noRuns = false;
  const queue: QueueFixture = { runs: [], successes: [], pulls: {}, merged: {}, jobs: {}, gates: {} };
  const approvals: { path: string; environmentIds: number[] }[] = [];
  let approvalReply: (() => { status: number; body: unknown; headers?: Record<string, string> }) | undefined;
  const paths: string[] = [], accounts = [{ id: 'github-fixture', providerId: 'github', account: 'fixture-user', enabled: true, isDefault: true }];
  const connections = new ProviderConnections(() => accounts, [{ id: 'github', name: 'GitHub', setupHint: 'Fixture account', accounts: async () => [{ id: 'fixture-user', label: 'fixture-user', active: true, available: true, credentialSource: 'fixture' }] }]);
  const transport = { async get(path: string, signal: AbortSignal) {
    signal.throwIfAborted(); paths.push(path);
    const query = new URL(`https://api.github.com${path}`).searchParams, page = Number(query.get('page') ?? 1), status = query.get('status');
    const other = Number(/\/actions\/runs\/(\d+)/.exec(path)?.[1]), blocker = other && other !== run.id ? other : undefined;
    if (queue.fail && (status || path.includes('/commits/') || blocker)) return { status: 502, body: null, headers: new Headers() };
    const body = path.includes('/compare/') ? queue.compare ?? { total_commits: 0, commits: [] } : status ? { workflow_runs: (status === 'success' ? queue.successes : queue.runs.filter(entry => entry.status === status)).slice(0, 10) }
      : /\/commits\/[a-f0-9]+\/pulls$/.test(path) ? queue.pulls[path.split('/')[5]] ?? [] : /\/pulls\/\d+$/.test(path) ? queue.merged[Number(path.split('/').pop())]
        : path.includes('/jobs?') ? blocker ? { total_count: queue.jobs[blocker]?.length ?? 0, jobs: queue.jobs[blocker] ?? [] } : { total_count: jobs.length, jobs: jobs.slice((page-1)*100, page*100) }
          : path.endsWith('/pending_deployments') ? blocker ? queue.gates[blocker] ?? [] : gates : path.includes('/runs?') ? { workflow_runs: noRuns ? [] : [run] }
            : /\/workflows\/[^/]+$/.test(path) ? { id: 9, name: 'Web / Release' } : run;
    const responseHeaders = new Headers(headers);
    if (path.includes('/jobs?') && jobs.length > page*100) responseHeaders.set('link', '<https://untrusted.invalid/ignored>; rel="next"');
    return { status: code, body: structuredClone(body), headers: responseHeaders };
  }, async approveDeployments(target: { owner: string; repo: string; runId: number }, environmentIds: number[], signal: AbortSignal) {
    signal.throwIfAborted(); approvals.push({ path: `/repos/${target.owner}/${target.repo}/actions/runs/${target.runId}/pending_deployments`, environmentIds });
    const custom = approvalReply?.();
    if (custom) return { status: custom.status, body: custom.body, headers: new Headers(custom.headers) };
    const approved = gates.filter(gate => environmentIds.includes(gate.environment.id));
    gates = gates.filter(gate => !environmentIds.includes(gate.environment.id));
    if (!gates.length) { run.status = 'in_progress'; jobs = jobs.map(job => job.status === 'waiting' ? { ...job, status: 'in_progress' } : job); }
    // GitHub returns the created deployments; `environment` is the environment name.
    return { status: 200, body: approved.map(gate => ({ id: 1000 + gate.environment.id, sha: run.head_sha, ref: run.head_branch, task: 'deploy', environment: gate.environment.name, original_environment: gate.environment.name, created_at: '2026-09-29T20:00:00Z' })), headers: new Headers() };
  } };
  const client = new GitHubRolloutClient(transport, Date.now, { pulls: new Map(), durations: new Map() });
  return { client, transport, paths, accounts, connections, approvals, queue, replyToApproval(reply: typeof approvalReply) { approvalReply = reply; },
    get run() { return run; }, set run(value) { run = value; }, get jobs() { return jobs; }, set jobs(value) { jobs = value; },
    get gates() { return gates; }, set gates(value) { gates = value; }, set noRuns(value: boolean) { noRuns = value; },
    fail(status: number, extra: Record<string, string> = {}) { code = status; headers = extra; },
    host(registry: ResourcePluginRegistry) { const host = new ResourcePluginHost(registry); host.register('github.rollout', githubRolloutConnector(resource => { connections.resolve('github', resource.connectionId); return client; })); host.present('github.rollout', rolloutPresentation); return host; },
  };
}
