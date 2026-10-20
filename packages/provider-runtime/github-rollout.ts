import * as z from 'zod/v4';
import { GitHubError, checkedGitHubResponse } from './github.ts';
import type { GitHubTransport } from './github.ts';
import type { JsonObject, ResourceSnapshot } from '../../src/resource-plugins/types.ts';
import type { ResourceIndicator } from '../../src/resource-plugins/indicators.ts';
import { githubRollout } from '../../src/resource-plugins/items/github-rollout/definition.ts';

const id = z.number().int().positive().safe(), text = z.string().max(1000);
const runSchema = z.object({ id, name: text.nullable(), display_title: text, run_number: id, run_attempt: id, workflow_id: id,
  head_branch: text.nullable(), head_sha: z.string().regex(/^[a-f0-9]{40,64}$/i), status: text, conclusion: text.nullable(),
  updated_at: text, created_at: text.optional(), run_started_at: text.nullable().optional(), actor: z.object({ login: text }).nullable().optional(), event: text.optional(),
  repository: z.object({ full_name: text }) });
const jobSchema = z.object({ id, run_id: id, name: text, status: text, conclusion: text.nullable(),
  started_at: text.nullable().optional(), completed_at: text.nullable().optional() });
const gateSchema = z.object({ environment: z.object({ id, name: text }), wait_timer: z.number().nonnegative(),
  current_user_can_approve: z.boolean(), reviewers: z.array(z.object({ type: text })).max(100) });
export type RolloutRun = z.infer<typeof runSchema>;
export type RolloutJob = z.infer<typeof jobSchema>;
export type RolloutGate = z.infer<typeof gateSchema>;
const pullSchema = z.object({ number: id, title: text, html_url: text, merged_at: text.nullable().optional(), user: z.object({ login: text }).nullable().optional() });
export interface RolloutPull { number: number; title: string; url?: string; author?: string; mergedBy?: string; mergedAt?: string }
/** What a run deploys: the pull requests merged since `since`, the workflow's previous successful run on the same branch (none without one),
 * newest first; `commits` counts the commits between them and `truncated` says some pull requests or commits were left out. */
export interface RolloutShipped { since?: { runId: number; commit: string; url: string }; pulls: RolloutPull[]; commits: number; truncated?: true }
/** At most this many pull requests per run, and this many commits without a number looked up on GitHub. */
export const SHIPPED_LIMITS = { pulls: 30, lookups: 10 } as const;
const compareSchema = z.object({ total_commits: z.number().int().nonnegative(), commits: z.array(z.object({ sha: z.string().regex(/^[a-f0-9]{40,64}$/i), commit: z.object({ message: z.string().max(100_000) }) })).max(100) });
/** A pull request named by its merge commit: “Title (#123)” from a squash merge, or “Merge pull request #123 from …” and the title below it. */
export function pullFromMessage(message: string): { number: number; title: string } | undefined {
  const lines = message.split('\n'), squash = /^(.*\S)\s+\(#([1-9]\d{0,9})\)$/.exec(lines[0].trim()), merge = /^Merge pull request #([1-9]\d{0,9}) from \S+/.exec(lines[0].trim());
  if (squash) return { number: Number(squash[2]), title: squash[1] };
  if (merge) return { number: Number(merge[1]), title: lines.slice(1).map(line => line.trim()).find(Boolean) ?? `#${merge[1]}` };
}
/** Another run of the workflow, or this one, as the queue ladder shows it. */
export interface RolloutQueueRun { id: number; number: number; status: string; url: string; title?: string; createdAt?: string; startedAt?: string; actor?: string; pull?: RolloutPull;
  jobs?: { done: number; total: number; current?: string }; stuck?: { reason: 'approval' | 'protection' | 'failing'; environment?: string; since?: string } }
/** Same-workflow runs ahead of a queued rollout: running first, then queued oldest first. */
export interface RolloutQueue { ahead: RolloutQueueRun[]; you: RolloutQueueRun; branch?: string; typicalMs?: number }
export interface RolloutObservation { workflow: string; run: RolloutRun | null; jobs: RolloutJob[]; gates: RolloutGate[]; url: string; followsLatest: boolean; branch?: string; queue?: RolloutQueue }
/** Merged PRs never change, so each commit is looked up once; typical durations are kept a while. */
export interface RolloutLookups { pulls: Map<string, RolloutPull | null>; durations: Map<string, { at: number; typicalMs?: number }> }
const sharedLookups: RolloutLookups = { pulls: new Map(), durations: new Map() };
const remember = <T>(map: Map<string, T>, key: string, value: T) => { map.delete(key); map.set(key, value); if (map.size > 500) map.delete(map.keys().next().value!); };
const time = (value?: string | null) => { const parsed = Date.parse(value ?? ''); return Number.isFinite(parsed) ? parsed : undefined; };
const githubUrl = (value: string) => /^https:\/\/github\.com\/[^\s@]+$/.test(value) ? value : undefined;
const failures = new Set(['failure', 'timed_out', 'startup_failure', 'stale']);
const active = new Set(['queued', 'requested', 'pending', 'waiting', 'in_progress']);

/** A deployment gate is different from a runner queue or timer. Run success is
 * authoritative only after all observed jobs and protection gates have settled. */
export function rolloutStatus(value: RolloutObservation) {
  const { run, jobs, gates } = value;
  let state: 'no-runs' | 'ongoing' | 'queued' | 'approval' | 'waiting' | 'passed' | 'failed' | 'cancelled' | 'skipped' | 'unknown' = 'unknown';
  if (!run) state = 'no-runs';
  else if (run.status === 'completed') {
    if (failures.has(run.conclusion ?? '')) state = 'failed';
    else if (run.conclusion === 'cancelled') state = 'cancelled';
    else if (run.conclusion === 'action_required') state = 'failed';
    else if (run.conclusion === 'skipped' || run.conclusion === 'neutral') state = 'skipped';
    else if (run.conclusion === 'success' && !gates.length && jobs.length && jobs.every(j => j.status === 'completed' && ['success', 'skipped', 'neutral'].includes(j.conclusion ?? ''))) state = 'passed';
  } else if (active.has(run.status)) {
    if (gates.some(g => g.reviewers.length || g.current_user_can_approve)) state = 'approval';
    else if (gates.length || run.status === 'waiting' || jobs.some(j => j.status === 'waiting')) state = 'waiting';
    else if (jobs.some(j => failures.has(j.conclusion ?? ''))) state = 'failed';
    else state = run.status === 'in_progress' || jobs.some(j => j.status === 'in_progress') ? 'ongoing' : 'queued';
  }
  const cues: Record<typeof state, Omit<ResourceIndicator, 'id'>> = {
    'no-runs': { label: 'No runs yet', tone: 'neutral', icon: 'clock' }, ongoing: { label: 'Ongoing', tone: 'blue', icon: 'clock' },
    queued: { label: 'Queued', tone: 'blue', icon: 'clock' }, approval: { label: 'Waiting approval', tone: 'amber', icon: 'alert-triangle' },
    waiting: { label: 'Waiting on protection rules', tone: 'amber', icon: 'clock' }, passed: { label: 'Passed', tone: 'green', icon: 'check', stage: 'done' },
    failed: { label: 'Failed', tone: 'red', icon: 'x', stage: 'failing' }, cancelled: { label: 'Cancelled', tone: 'neutral', icon: 'x' },
    skipped: { label: 'Skipped / neutral', tone: 'neutral', icon: 'clock' }, unknown: { label: 'State unconfirmed', tone: 'amber', icon: 'alert-triangle' },
  };
  const finished = jobs.filter(j => j.status === 'completed').length;
  const progress = `${finished}/${jobs.length} jobs finished`;
  const indicator: ResourceIndicator = { id: 'rollout-state', ...cues[state] };
  const live = !!run && active.has(run.status);
  const reason: ResourceSnapshot['attentionReason'] = state === 'approval' ? 'input' : state === 'failed' ? 'error'
    : ['passed', 'cancelled', 'skipped'].includes(state) ? 'finished' : null;
  const approvals = gates.filter(g => g.reviewers.length || g.current_user_can_approve), gateKey = approvals.map(g => g.environment.id).sort((a,b) => a-b).join(',');
  const gateName = approvals.length === 1 ? approvals[0].environment.name.trim() : '';
  const note = state === 'approval' ? approvals.length > 1 ? `${approvals.length} jobs need approval` : gateName && [...gateName].length <= 24 ? `${gateName[0].toUpperCase()}${gateName.slice(1)} needs approval` : 'Job needs approval'
    : state === 'failed' ? 'Rollout failed' : state === 'passed' ? 'Rollout finished' : state === 'cancelled' ? 'Rollout cancelled' : state === 'skipped' ? 'Rollout skipped' : undefined;
  return { state, indicator, progress, label: `${indicator.label}${jobs.length ? ` · ${progress}` : ''}${state === 'failed' && live ? ' · still running' : ''}`,
    // Runs waiting on a gate are idle; queued runs count as work about to start.
    activity: (live && (state === 'ongoing' || state === 'queued' || (state === 'failed' && jobs.some(j => j.status === 'in_progress'))) ? 'working' : run?.status === 'completed' ? 'complete' : 'idle') as ResourceSnapshot['activity'], reason, ...(reason && note ? { note } : {}),
    eventId: run ? `${run.id}:${run.run_attempt}:${run.status === 'completed' ? 'finished' : 'active'}:${state}:${gateKey}` : 'no-runs' };
}

/** Gates the signed-in account can approve on a still-active run. */
export function approvableGates(value: RolloutObservation) {
  return value.run && active.has(value.run.status) ? value.gates.filter(gate => gate.current_user_can_approve) : [];
}
export interface RolloutApproval { runId: number; attempt: number; environmentIds: number[] }
/** GitHub answers with the deployments it created; `environment` is only a name there. */
const approvedDeployments = z.array(z.object({ id })).max(100);
const sortedIds = (ids: number[]) => [...ids].sort((a, b) => a - b).join(',');

/** Actions observer. Its only write approves the gates the user confirmed. */
export class GitHubRolloutClient {
  private transport: GitHubTransport;
  private now: () => number;
  private lookups: RolloutLookups;
  constructor(transport: GitHubTransport, now = Date.now, lookups = sharedLookups) { this.transport = transport; this.now = now; this.lookups = lookups; }
  private async get<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal) {
    signal.throwIfAborted(); const response = await this.transport.get(path, signal); signal.throwIfAborted();
    if (response.status === 404) throw new GitHubError('GITHUB_NOT_FOUND', 'Rollout unavailable. Check the URL and GitHub account access.');
    const result = schema.safeParse(checkedGitHubResponse(response, this.now()));
    if (!result.success) throw new GitHubError('GITHUB_INVALID_RESPONSE', 'GitHub returned unsupported rollout metadata.');
    return { value: result.data, headers: response.headers };
  }
  /** Re-reads the rollout and approves only if the run, attempt and approvable
   * environments still match what the user confirmed. */
  async approve(data: JsonObject, expected: RolloutApproval, signal: AbortSignal) {
    if (!this.transport.approveDeployments) throw new GitHubError('GITHUB_FORBIDDEN', 'Rollout approval is unavailable for this connection.');
    const current = await this.observe(data, signal), gates = approvableGates(current);
    if (!current.run || current.run.id !== expected.runId || current.run.run_attempt !== expected.attempt) throw new GitHubError('GITHUB_CHANGED', 'This rollout moved to another run or attempt. Review it again before approving.');
    if (!gates.length) throw new GitHubError('GITHUB_CHANGED', 'Nothing in this rollout is waiting for your approval anymore.');
    const ids = gates.map(gate => gate.environment.id);
    if (sortedIds(ids) !== sortedIds(expected.environmentIds)) throw new GitHubError('GITHUB_CHANGED', 'The environments waiting for approval changed. Review them again before approving.');
    const uncertain = () => Object.assign(new Error('GitHub may have approved this deployment. Refresh the rollout before approving again.'), { outcomeUnknown: true });
    let response;
    try { response = await this.transport.approveDeployments({ owner: String(data.owner), repo: String(data.repo), runId: current.run.id }, ids, signal); }
    catch (error) { if ((error as GitHubError).code === 'GITHUB_POST_UNCERTAIN') throw uncertain(); throw error; }
    if ([403, 404, 422].includes(response.status) && response.headers.get('x-ratelimit-remaining') !== '0' && !response.headers.get('retry-after')) throw new GitHubError('GITHUB_REJECTED', 'GitHub declined the approval. Refresh the rollout to see who can approve its current gates.');
    if (response.status >= 400 && response.status < 500) checkedGitHubResponse(response, this.now());
    if (response.status !== 200 || !approvedDeployments.safeParse(response.body).success) throw uncertain();
  }
  async observe(data: JsonObject, signal: AbortSignal): Promise<RolloutObservation> {
    if (!githubRollout.validateData(data)) throw new GitHubError('GITHUB_INVALID_PATH', 'Invalid rollout identity.');
    const repository = `${data.owner}/${data.repo}`, path = `/repos/${repository}`, followsLatest = !data.runId;
    let workflowName = '', runId = data.runId as number | undefined, workflowId: number | undefined;
    const workflowUrl = `https://github.com/${repository}/actions/workflows/${data.workflow}${data.branch ? `?query=${encodeURIComponent(`branch:${data.branch}`)}` : ''}`;
    if (!runId) {
      const { value: workflow } = await this.get(`${path}/actions/workflows/${data.workflow}`, z.object({ id, name: text }), signal);
      workflowName = workflow.name; workflowId = workflow.id;
      const { value } = await this.get(`${path}/actions/workflows/${workflow.id}/runs?per_page=1${data.branch ? `&branch=${encodeURIComponent(String(data.branch))}` : ''}`, z.object({ workflow_runs: z.array(runSchema).max(1) }), signal);
      runId = value.workflow_runs[0]?.id;
      if (!runId) return { workflow: workflowName, run: null, jobs: [], gates: [], url: workflowUrl, followsLatest, ...(data.branch ? { branch: String(data.branch) } : {}) };
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const { value: run }: { value: RolloutRun } = await this.get(`${path}/actions/runs/${runId}`, runSchema, signal);
      if (run.id !== runId || run.repository.full_name.toLowerCase() !== repository.toLowerCase() || workflowId && run.workflow_id !== workflowId || data.branch && run.head_branch !== data.branch) throw new GitHubError('GITHUB_INVALID_RESPONSE', 'The rollout identity changed during lookup.');
      const jobs: RolloutJob[] = []; let expected = 0;
      for (let page = 1; page <= 10; page++) {
        const { value, headers } = await this.get(`${path}/actions/runs/${runId}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`, z.object({ total_count: z.number().int().nonnegative(), jobs: z.array(jobSchema).max(100) }), signal);
        expected = value.total_count; jobs.push(...value.jobs);
        if (!/rel="next"/.test(headers.get('link') ?? '')) break;
        if (page === 10) throw new GitHubError('GITHUB_CONTENT_LIMIT', 'Rollout exceeds the 1,000 job observation limit.');
      }
      if (jobs.length !== expected || new Set(jobs.map(j => j.id)).size !== jobs.length || jobs.some(j => j.run_id !== runId)) throw new GitHubError('GITHUB_INVALID_RESPONSE', 'GitHub returned an incomplete rollout job list.');
      const { value: gates } = await this.get(`${path}/actions/runs/${runId}/pending_deployments`, z.array(gateSchema).max(100), signal);
      const { value: latest }: { value: RolloutRun } = await this.get(`${path}/actions/runs/${runId}`, runSchema, signal);
      // Avoid mixing jobs from one attempt with a rerun, or reporting a just-
      // completed run against a job list read before it completed.
      if (latest.id !== runId || latest.repository.full_name.toLowerCase() !== repository.toLowerCase() || latest.workflow_id !== run.workflow_id || latest.head_sha !== run.head_sha) throw new GitHubError('GITHUB_INVALID_RESPONSE', 'The rollout identity changed during refresh.');
      if (latest.run_attempt !== run.run_attempt || latest.status !== run.status || latest.conclusion !== run.conclusion) continue;
      const observation: RolloutObservation = { workflow: workflowName || run.name || 'Rollout', run, jobs, gates, url: `https://github.com/${repository}/actions/runs/${runId}`, followsLatest,
        ...(data.branch ? { branch: String(data.branch) } : {}) };
      if (rolloutStatus(observation).state !== 'queued') return observation;
      try { const queue = await this.queue(repository, run, data.branch as string | undefined, signal); return queue ? { ...observation, queue } : observation; }
      catch { signal.throwIfAborted(); return observation; }
    }
    throw new GitHubError('GITHUB_CHANGED', 'Rollout changed during refresh. The next sync will retry.');
  }

  /** The pull requests a run ships: GET-only, the workflow's last ten successful runs on its branch, one compare of the previous one's commit with
   * this run's (first 100 commits) and, for at most ten commits whose message names no pull request, GitHub's pull requests for that commit. */
  async shipped(data: JsonObject, run: Pick<RolloutRun, 'id' | 'workflow_id' | 'run_number' | 'head_sha' | 'head_branch'>, signal: AbortSignal): Promise<RolloutShipped> {
    if (!githubRollout.validateData(data)) throw new GitHubError('GITHUB_INVALID_PATH', 'Invalid rollout identity.');
    const repository = `${data.owner}/${data.repo}`, path = `/repos/${repository}`, filter = run.head_branch ? `&branch=${encodeURIComponent(run.head_branch)}` : '';
    const { value: runs } = await this.get(`${path}/actions/workflows/${run.workflow_id}/runs?status=success&per_page=10${filter}`, z.object({ workflow_runs: z.array(runSchema).max(10) }), signal);
    const previous = runs.workflow_runs.filter(entry => entry.id !== run.id && entry.workflow_id === run.workflow_id && entry.run_number < run.run_number && entry.head_branch === run.head_branch
      && entry.repository.full_name.toLowerCase() === repository.toLowerCase()).sort((a, b) => b.run_number - a.run_number)[0];
    if (!previous || previous.head_sha === run.head_sha) return { pulls: [], commits: 0 };
    const { value: compare } = await this.get(`${path}/compare/${previous.head_sha}...${run.head_sha}?per_page=100&page=1`, compareSchema, signal);
    const pulls: RolloutPull[] = [], seen = new Set<number>(); let lookups = 0, truncated = compare.total_commits > compare.commits.length;
    for (const commit of [...compare.commits].reverse()) {
      if (pulls.length >= SHIPPED_LIMITS.pulls) { truncated = true; break; }
      let found: { number: number; title: string } | undefined = pullFromMessage(commit.commit.message);
      if (!found && lookups < SHIPPED_LIMITS.lookups) {
        lookups++;
        const listed = await this.get(`${path}/commits/${commit.sha}/pulls`, z.array(pullSchema).max(100), signal).then(({ value }) => value.find(entry => entry.merged_at), () => { signal.throwIfAborted(); return undefined; });
        found = listed && { number: listed.number, title: listed.title };
      } else if (!found) truncated = true;
      if (!found || seen.has(found.number)) continue;
      seen.add(found.number); pulls.push({ number: found.number, title: found.title.slice(0, 200), url: `https://github.com/${repository}/pull/${found.number}` });
    }
    return { since: { runId: previous.id, commit: previous.head_sha, url: `https://github.com/${repository}/actions/runs/${previous.id}` }, pulls, commits: compare.total_commits, ...(truncated ? { truncated: true as const } : {}) };
  }

  /** GitHub does not expose concurrency groups: the runs ahead are the same workflow's
   * (and branch's) running or waiting runs plus those queued before this one. */
  private async queue(repository: string, run: RolloutRun, branch: string | undefined, signal: AbortSignal): Promise<RolloutQueue | undefined> {
    const path = `/repos/${repository}`, list = `${path}/actions/workflows/${run.workflow_id}/runs`, filter = branch ? `&branch=${encodeURIComponent(branch)}` : '';
    const runs = z.object({ workflow_runs: z.array(runSchema).max(10) }), listed = new Map<number, RolloutRun>();
    for (const status of ['in_progress', 'waiting', 'queued', 'pending']) {
      const { value } = await this.get(`${list}?status=${status}&per_page=10${filter}`, runs, signal);
      for (const entry of value.workflow_runs) if (entry.repository.full_name.toLowerCase() === repository.toLowerCase() && entry.workflow_id === run.workflow_id) listed.set(entry.id, entry);
    }
    const created = time(run.created_at), live = (entry: RolloutRun) => entry.status === 'in_progress' || entry.status === 'waiting';
    const ahead = [...listed.values()].filter(entry => entry.id !== run.id && (live(entry) || created !== undefined && (time(entry.created_at) ?? Infinity) < created))
      .sort((a, b) => Number(live(b)) - Number(live(a)) || (time(a.created_at) ?? 0) - (time(b.created_at) ?? 0) || a.id - b.id).slice(0, 10);
    if (!ahead.length) return undefined;
    const pull = async (sha: string) => {
      const key = `${repository.toLowerCase()}@${sha}`;
      if (this.lookups.pulls.has(key)) return this.lookups.pulls.get(key) ?? undefined;
      const { value } = await this.get(`${path}/commits/${sha}/pulls`, z.array(pullSchema).max(100), signal), found = value.find(entry => entry.merged_at) ?? value[0];
      if (!found) { remember(this.lookups.pulls, key, null); return undefined; }
      const merged = found.merged_at ? (await this.get(`${path}/pulls/${found.number}`, z.object({ merged_by: z.object({ login: text }).nullable().optional() }), signal)).value.merged_by?.login : undefined;
      const url = githubUrl(found.html_url), result: RolloutPull = { number: found.number, title: found.title, ...(url ? { url } : {}), ...(found.user?.login ? { author: found.user.login } : {}),
        ...(merged ? { mergedBy: merged } : {}), ...(found.merged_at ? { mergedAt: found.merged_at } : {}) };
      if (found.merged_at) remember(this.lookups.pulls, key, result);
      return result;
    };
    const entry = async (value: RolloutRun, detail: boolean): Promise<RolloutQueueRun> => {
      const found = await pull(value.head_sha).catch(() => { signal.throwIfAborted(); return undefined; });
      const result: RolloutQueueRun = { id: value.id, number: value.run_number, status: value.status, url: `https://github.com/${repository}/actions/runs/${value.id}`, title: value.display_title,
        ...(value.created_at ? { createdAt: value.created_at } : {}), ...(value.run_started_at ? { startedAt: value.run_started_at } : {}), ...(value.actor?.login ? { actor: value.actor.login } : {}), ...(found ? { pull: found } : {}) };
      if (!detail) return result;
      let waiting = value.status === 'waiting';
      if (value.status === 'in_progress') {
        const { value: page } = await this.get(`${path}/actions/runs/${value.id}/attempts/${value.run_attempt}/jobs?per_page=100&page=1`, z.object({ total_count: z.number().int().nonnegative(), jobs: z.array(jobSchema).max(100) }), signal);
        const jobs = page.jobs.filter(job => job.run_id === value.id), failed = jobs.filter(job => failures.has(job.conclusion ?? '')), starts = jobs.map(job => time(job.started_at)).filter((at): at is number => at !== undefined);
        const current = jobs.find(job => job.status === 'in_progress')?.name;
        result.jobs = { done: jobs.filter(job => job.status === 'completed').length, total: page.total_count, ...(current ? { current } : {}) };
        if (starts.length) result.startedAt = new Date(Math.min(...starts)).toISOString();
        if (failed.length) result.stuck = { reason: 'failing', ...(failed[0].completed_at ? { since: failed[0].completed_at } : {}) };
        waiting = !failed.length && jobs.some(job => job.status === 'waiting');
      }
      if (waiting) {
        const { value: gates } = await this.get(`${path}/actions/runs/${value.id}/pending_deployments`, z.array(gateSchema).max(100), signal);
        const approval = gates.find(entry => entry.reviewers.length || entry.current_user_can_approve), gate = approval ?? gates[0];
        result.stuck = { reason: approval ? 'approval' : 'protection', ...(gate ? { environment: gate.environment.name } : {}), since: value.updated_at };
      }
      return result;
    };
    const rows: RolloutQueueRun[] = [];
    for (const [index, value] of ahead.entries()) rows.push(await entry(value, live(value) && index < 3));
    return { ahead: rows, you: await entry(run, false), ...(branch ? { branch } : {}), ...(await this.typical(repository, list, filter, signal)) };
  }
  /** Median of the last ten successful runs, from three samples up. */
  private async typical(repository: string, list: string, filter: string, signal: AbortSignal) {
    const key = `${repository.toLowerCase()}${list}${filter}`, cached = this.lookups.durations.get(key);
    if (cached && this.now() - cached.at < 15 * 60_000) return cached.typicalMs === undefined ? {} : { typicalMs: cached.typicalMs };
    let typicalMs: number | undefined;
    try {
      const { value } = await this.get(`${list}?status=success&per_page=10${filter}`, z.object({ workflow_runs: z.array(runSchema).max(10) }), signal);
      const lengths = value.workflow_runs.map(entry => (time(entry.updated_at) ?? 0) - (time(entry.run_started_at) ?? Infinity)).filter(length => length > 0).sort((a, b) => a - b);
      if (lengths.length >= 3) typicalMs = lengths.length % 2 ? lengths[lengths.length >> 1] : (lengths[lengths.length / 2 - 1] + lengths[lengths.length / 2]) / 2;
    } catch { signal.throwIfAborted(); return {}; }
    remember(this.lookups.durations, key, { at: this.now(), ...(typicalMs === undefined ? {} : { typicalMs }) });
    return typicalMs === undefined ? {} : { typicalMs };
  }
}
