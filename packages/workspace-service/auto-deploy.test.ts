import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from './sqlite-store.ts';
import { WorkspaceControl } from '../core/control.ts';
import type { WorkspaceCommand } from '../core/control.ts';
import { applyAtHead } from './apply-at-head.ts';
import { creationConnections, creationNear, requestConnections } from '../core/resource-creation.ts';
import type { ResourceCreate } from '../core/resource-creation.ts';
import type { HostedLaunch } from '../session-runtime/agent-plan.ts';
import { discoveredLinkId } from './resources.ts';
import type { ResourceCoordinator } from './resources.ts';
import type { SessionCoordinator } from './sessions.ts';
import { rolloutDiscoveryKey } from '../provider-runtime/github-status.ts';
import type { RolloutObservation } from '../provider-runtime/github-rollout.ts';
import type { PullMergeReadiness } from '../provider-runtime/github.ts';
import { AutoDeploys, AUTO_DEPLOY_COLLECTION, autoDeployArmed } from './auto-deploy.ts';
import { AUTO_DEPLOY_OPERATION } from '../../src/resource-plugins/items/github-rollout/auto-deploy.ts';
import type { AutoDeployRecord } from '../../src/resource-plugins/items/github-rollout/auto-deploy.ts';
import { agentRuntimeRefusal } from '../core/runtime.ts';
import { humanOnlyMessage } from '../../src/resource-plugins/host.ts';
import { VALIDATION_AGENT } from '../../src/resource-plugins/items/github-rollout/validation.ts';
import type { JsonObject } from '../../src/resource-plugins/types.ts';

const T0 = Date.parse('2026-10-08T10:00:00Z'), head = 'a'.repeat(40), sha = 'c'.repeat(40);
type Outcome = 'succeeded' | 'failed' | 'unknown';

/** A pull request in a project, its merge discovering one rollout. GitHub is a script: readiness, snapshots and
 * observations the test sets, and writes journaled in the real job table the way the resource coordinator does. */
async function fixture(options: { starter?: boolean; tagging?: boolean; directory?: string; sessions?: boolean; validated?: { label: string; state: string; verdict?: string; stale?: boolean; finishedAt?: number; requestedAt?: number; scope: { runId: number; attempt: number; jobs?: number[]; environments?: string[] } }[] } = {}) {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), 'craft-auto-deploy-')), store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  const apply = async (commands: WorkspaceCommand[]) => control.dispatch({ commandId: randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'test' }, commands });
  if (!options.directory) await apply([
    { type: 'project.create', id: 'web', title: 'Web', summary: '', position: { x: 0, y: 0 }, workingDirectory: '/work/web' },
    { type: 'item.add', id: 'pr', resourceId: 'pr-r', pluginId: 'github.pull-request', title: 'Batch exports', projectId: 'web', position: { x: 300, y: 200 }, data: { owner: 'acme', repo: 'app', number: 42 } },
  ]);
  let now = T0;
  const readiness: PullMergeReadiness = { pullRequestId: 'PR_node42', number: 42, title: 'Batch exports', lifecycle: 'open', head, base: 'main', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', checks: 'passing', queued: false, queueEnabled: false, method: 'SQUASH' };
  const github = { readiness, failing: [] as string[], observation: undefined as RolloutObservation | undefined, outcomes: {} as Record<string, Outcome>, reads: 0,
    writes: [] as { nodeId: string; actionId: string; input: JsonObject }[], approvable: '', merged: false };
  const resources = {
    async cached(nodeId: string) {
      if (nodeId === 'pr') return { detail: { pull: { title: github.readiness.title, state: github.merged ? 'closed' : 'open', merged: github.merged, base: { ref: 'main' }, head: { ref: 'feature/exports', sha: github.readiness.head } }, ...(github.failing.length ? { failingChecks: github.failing } : {}) } };
      return github.observation ? { detail: github.observation } : null;
    },
    async execute(nodeId: string, actionId: string, input: JsonObject) {
      if (actionId === 'pr.mergeReadiness') { github.reads++; return structuredClone(github.readiness); }
      if (actionId === 'rollout.approval.options') return { current: '', context: { runId: '101', attempt: '1', environmentIds: github.approvable, sourceResourceId: 'rollout-r' }, options: [{ id: 'approve', label: 'Confirm' }] };
      github.writes.push({ nodeId, actionId, input });
      const job = store.enqueueJob(String(input.requestId), { action: 'resource.action', nodeId, arguments: { actionId, input } });
      if (job.state !== 'queued') throw new Error('The previous update could not be confirmed.');
      store.transitionJob(job.id, 'queued', 'running');
      const outcome = github.outcomes[actionId] ?? 'succeeded';
      if (outcome === 'failed') { store.transitionJob(job.id, 'running', 'failed', { error: 'GitHub declined the merge: Pull Request is not mergeable' }); throw new Error('GitHub declined the merge: Pull Request is not mergeable'); }
      if (outcome === 'unknown') { store.transitionJob(job.id, 'running', 'outcome-unknown', { error: 'GitHub may have merged it.' }); throw new Error('GitHub may have merged it.'); }
      if (actionId === 'pr.showShip') github.readiness.title = `[ship] ${github.readiness.title}`;
      if (actionId === 'pr.merge') github.readiness.lifecycle = 'merged';
      if (actionId === 'rollout.approve' && github.observation) github.observation = { ...github.observation, gates: [] };
      store.transitionJob(job.id, 'running', 'succeeded', { result: {} });
      return {};
    },
    async writing() {}, async refreshPresentation() {},
  } as unknown as ResourceCoordinator;
  const triggers: { nodeId: string; input: JsonObject }[] = [];
  const verdicts: { label: string; state: string; verdict?: string; resolvedBy?: string }[] = [], earlier = options.validated ?? [];
  let triggerFailure: string | undefined;
  const events: { runId: number; attempt: number; kind: string; environment: string; observedAt: number; actor?: string }[] = [];
  const validations = { async run(nodeId: string, input: JsonObject) {
    if (input.operation === 'list') return { validations: [...earlier, ...verdicts], events: [...github.observation?.gates.map(entry => ({ runId: 101, attempt: 1, kind: 'gate-waiting', environment: entry.environment.name })) ?? [], ...events] };
    triggers.push({ nodeId, input });
    if (triggerFailure) throw new Error(triggerFailure);
    const label = `V${triggers.length + earlier.length}`; if (!verdicts.some(entry => entry.label === label)) verdicts.push({ label, state: 'requested' });
    return { sent: true, validationId: label };
  } };
  const launches: { request: ResourceCreate; hosted: HostedLaunch }[] = [];
  const starter = { async ready() {}, fallbackDirectory: () => '/work/recent', async launch(request: ResourceCreate, hosted: HostedLaunch) {
    launches.push({ request, hosted });
    await applyAtHead(control, { commandId: `${request.requestId}:node`, actor: { kind: 'user', id: 'desktop' }, commands: [
      { type: 'item.add', id: request.nodeId, resourceId: request.resourceId, pluginId: 'agent.session', title: request.title, projectId: request.projectId, position: request.position, ...creationNear(request),
        data: { provider: 'claude', sessionId: request.requestId, cwd: request.data.cwd } }, ...creationConnections(requestConnections(request), request.nodeId)] });
  } };
  /** Agents at their prompt; what each was sent. */
  const prompts: { sessionId: string; data: string }[] = [];
  const sessions = options.sessions ? { runtime: { async call(method: string, input: { sessionId: string; data: string }) {
    if (method === 'sessions.input') prompts.push(input);
    return { session: { state: 'running', native: { status: 'idle' } }, lastSequence: 1 };
  } } } as unknown as SessionCoordinator : undefined;
  const deploys = new AutoDeploys({ storage: store.pluginStorage('github.rollout'), store, control, resources, validations, changed: async () => {}, now: () => now, readinessEveryMs: 0,
    tagging: () => options.tagging !== false, ...(sessions ? { sessions } : {}), ...(options.starter === false ? {} : { starter }) });
  const run = (input: object, nodeId = 'pr') => deploys.run(nodeId, input) as Promise<Record<string, unknown>>;
  const arm = () => run({ operation: 'set', value: 'arm', sourceResourceId: 'pr-r', requestId: randomUUID() });
  const record = () => store.pluginStorage('github.rollout').get(AUTO_DEPLOY_COLLECTION, 'pr-r')?.value as unknown as AutoDeployRecord | undefined;
  const discover = async (gates: RolloutObservation['gates'], jobs: RolloutObservation['jobs'], status = 'in_progress', conclusion: string | null = null, linked = true) => {
    if (!(await control.read()).nodes.some(node => node.id === 'rollout')) await apply([
      { type: 'item.add', id: 'rollout', resourceId: 'rollout-r', pluginId: 'github.rollout', title: 'Web / Release', projectId: 'web', position: { x: 600, y: 200 }, data: { owner: 'acme', repo: 'app', runId: 101 } },
      ...(linked ? [{ type: 'link.save' as const, link: { id: discoveredLinkId('pr-r', rolloutDiscoveryKey(101)), sourceId: 'pr', targetId: 'rollout', kind: 'reference' as const, label: '' } }] : [])]);
    github.observation = { workflow: 'Web / Release', url: 'https://github.com/acme/app/actions/runs/101', followsLatest: false, gates, jobs,
      run: { id: 101, name: 'Web / Release', display_title: 'Batch exports', run_number: 7, run_attempt: 1, workflow_id: 9, head_branch: 'main', head_sha: sha, status, conclusion, updated_at: '2026-10-08T10:30:00Z', repository: { full_name: 'acme/app' } } };
  };
  const job = (id: number, name: string, status = 'completed', conclusion: string | null = 'success') => ({ id, run_id: 101, name, status, conclusion, started_at: '2026-10-08T10:10:00Z', completed_at: status === 'completed' ? '2026-10-08T10:20:00Z' : null });
  const gate = (id: number, name: string) => ({ environment: { id, name }, wait_timer: 0, current_user_can_approve: true, reviewers: [{ type: 'User' }] });
  const pass = async (minutes = 1) => { now += minutes * 60_000; await deploys.reconcile(); };
  const attention = async (nodeId = 'pr') => (await control.read()).nodes.find(node => node.id === nodeId)?.attentionSources?.['auto-deploy'] ?? null;
  return { directory, store, control, deploys, github, triggers, verdicts, events, launches, prompts, run, arm, record, discover, job, gate, pass, attention, apply, failTriggers: (message: string) => { triggerFailure = message; }, setNow: (value: number) => { now = value; } };
}

test('arming from the menu confirms what will happen, is idempotent, and Stop ends it before the next step', async () => {
  const f = await fixture();
  f.github.readiness.checks = 'pending'; f.github.readiness.title = '[ship] Batch exports';
  const options = await f.run({ operation: 'options' }) as { prompt: string; context: JsonObject; options: { id: string; confirm?: { prompt: string; note?: string; action: string } }[] };
  assert.deepEqual(options.context, { sourceResourceId: 'pr-r' });
  assert.equal(options.options[0].id, 'arm');
  assert.equal(options.options[0].confirm?.action, 'Start auto deploy');
  assert.match(options.options[0].confirm!.note!, /\[ship\].*merges it into main.*approves/);
  assert.deepEqual(await f.run({ operation: 'status' }), { state: 'off' });
  const requestId = randomUUID(), armed = await f.run({ operation: 'set', value: 'arm', sourceResourceId: 'pr-r', requestId });
  assert.deepEqual([armed.state, armed.line], ['armed', 'Auto deploy · waiting for checks']);
  await f.run({ operation: 'set', value: 'arm', sourceResourceId: 'pr-r', requestId: randomUUID() });
  assert.equal(f.record()!.id, requestId, 'arming an armed pull request keeps the running auto deploy');
  assert.equal((await f.run({ operation: 'options' }) as { options: { id: string }[] }).options[0].id, 'stop');
  await assert.rejects(f.run({ operation: 'set', value: 'arm', sourceResourceId: 'other', requestId: randomUUID() }), /another item/);
  const stopped = await f.run({ operation: 'set', value: 'stop', sourceResourceId: 'pr-r', requestId: randomUUID() });
  assert.deepEqual([stopped.state, stopped.line], ['stopped', 'Auto deploy · stopped']);
  f.github.readiness.checks = 'passing';
  await f.pass();
  assert.deepEqual(f.github.writes, [], 'a stopped auto deploy writes nothing');
  assert.equal(await f.attention(), null);
});

test('the whole flow: tag, merge, validate before the gate, approve, validate the whole run, done; each write exactly once', async () => {
  const f = await fixture();
  await f.arm(); await f.pass();
  assert.deepEqual(f.github.writes.map(write => [write.nodeId, write.actionId, write.input.value]), [['pr', 'pr.showShip', 'ship'], ['pr', 'pr.merge', 'SQUASH']]);
  assert.equal(f.github.writes[0].input.expectedTitle, 'Batch exports');
  assert.deepEqual([f.github.writes[1].input.pullRequestId, f.github.writes[1].input.expectedHeadOid, f.github.writes[1].input.sourceResourceId], ['PR_node42', head, 'pr-r']);
  assert.equal(f.record()!.step, 'waiting-rollout');
  await f.pass();
  assert.equal(f.github.writes.length, 2, 'nothing is written again while waiting for the deploy run');

  await f.discover([f.gate(7, 'live')], [f.job(1, 'preview / ship'), f.job(2, 'live / ship', 'waiting', null)]);
  await f.pass();
  assert.deepEqual(f.triggers.map(entry => [entry.nodeId, entry.input.operation, entry.input.value, entry.input.sourceResourceId, entry.input.phase]), [['rollout', 'trigger', VALIDATION_AGENT, 'rollout-r', { focus: 'before live (live / ship)', jobs: [1] }]], 'the validation is asked for this phase: what ran before the gate');
  assert.deepEqual([f.record()!.step, f.record()!.detail, (await f.run({ operation: 'status' })).line], ['validating', 'before live (live / ship)', 'Auto deploy · validating before live (live / ship)']);
  const seen = await f.run({ operation: 'status' }, 'rollout');
  assert.deepEqual({ ...seen, track: undefined, next: undefined, events: undefined }, { ...(await f.run({ operation: 'status' })), pullNodeId: 'pr', pullTitle: 'Batch exports', pullNumber: 42, track: undefined, next: undefined, events: undefined }, 'the rollout view sees the pull request it deploys');
  await f.pass();
  assert.equal(f.triggers.length, 1, 'one validation per phase');
  f.verdicts[0].state = 'final'; f.verdicts[0].verdict = 'passed'; f.github.approvable = '7';
  await f.pass();
  assert.deepEqual(f.github.writes.slice(2).map(write => [write.nodeId, write.actionId, write.input.value, write.input.environmentIds, write.input.runId, write.input.attempt]), [['rollout', 'rollout.approve', 'approve', '7', '101', '1']]);

  await f.discover([], [f.job(1, 'preview / ship'), f.job(2, 'live / ship')], 'completed', 'success');
  await f.pass();
  assert.equal(f.triggers.length, 2); assert.equal(f.record()!.detail, 'whole run');
  assert.deepEqual(f.triggers[1].input.phase, { focus: 'whole run', jobs: [2] }, 'the last validation covers only what the first did not');
  f.verdicts[1].state = 'final'; f.verdicts[1].verdict = 'passed';
  await f.pass();
  assert.deepEqual([f.record()!.state, (await f.run({ operation: 'status' })).line], ['done', 'Auto deploy · done']);
  assert.equal(await f.attention(), 'finished');
  await f.pass();
  assert.deepEqual(f.github.writes.map(write => write.actionId), ['pr.showShip', 'pr.merge', 'rollout.approve']);
  assert.equal(new Set(f.github.writes.map(write => write.input.requestId)).size, 3);
});

test('a restart resumes from the saved record without sending a confirmed write again', async () => {
  const first = await fixture();
  await first.arm(); await first.pass();
  assert.deepEqual(first.github.writes.map(write => write.actionId), ['pr.showShip', 'pr.merge']);
  first.deploys.close();
  const again = await fixture({ directory: first.directory });
  again.github.readiness.lifecycle = 'merged'; again.github.readiness.title = '[ship] Batch exports';
  await again.pass();
  assert.deepEqual(again.github.writes, []);
  assert.equal(again.record()!.step, 'waiting-rollout');
});

test('a write whose outcome is unknown, before or after a restart, halts and is never sent again', async () => {
  const f = await fixture({ tagging: false });
  f.github.outcomes['pr.merge'] = 'unknown';
  await f.arm(); await f.pass();
  assert.equal(f.github.writes.length, 1);
  assert.deepEqual([f.record()!.state, f.record()!.halt?.code], ['halted', 'outcome-unknown']);
  assert.match((await f.run({ operation: 'status' })).line as string, /^Auto deploy · halted: The merge could not be confirmed/);
  assert.equal(await f.attention(), 'error');
  await f.pass(); assert.equal(f.github.writes.length, 1);

  const crashed = await fixture({ tagging: false });
  await crashed.arm();
  const saved = crashed.record()!, requestId = randomUUID();
  crashed.store.pluginStorage('github.rollout').put(AUTO_DEPLOY_COLLECTION, 'pr-r', { ...saved, writes: [{ key: 'merge', kind: 'merge', requestId, at: T0, state: 'sending' }] } as never);
  const interrupted = crashed.store.enqueueJob(requestId, { action: 'resource.action', nodeId: 'pr', arguments: {} });
  crashed.store.transitionJob(interrupted.id, 'queued', 'running');
  crashed.store.recoverInterruptedJobs();
  const restarted = await fixture({ directory: crashed.directory, tagging: false });
  await restarted.pass();
  assert.deepEqual(restarted.github.writes, []);
  assert.deepEqual([restarted.record()!.state, restarted.record()!.halt?.code], ['halted', 'outcome-unknown']);

  const confirmed = await fixture({ tagging: false });
  await confirmed.arm();
  const before = confirmed.record()!, done = randomUUID();
  confirmed.store.pluginStorage('github.rollout').put(AUTO_DEPLOY_COLLECTION, 'pr-r', { ...before, writes: [{ key: 'merge', kind: 'merge', requestId: done, at: T0, state: 'sending' }] } as never);
  const job = confirmed.store.enqueueJob(done, { action: 'resource.action', nodeId: 'pr', arguments: {} });
  confirmed.store.transitionJob(job.id, 'queued', 'running'); confirmed.store.transitionJob(job.id, 'running', 'succeeded', { result: {} });
  const resumed = await fixture({ directory: confirmed.directory, tagging: false });
  resumed.github.readiness.lifecycle = 'merged';
  await resumed.pass();
  assert.deepEqual(resumed.github.writes, [], 'a merge the journal confirms is not sent again');
  assert.equal(resumed.record()!.step, 'waiting-rollout');
});

test('GitHub declining a write halts with its reason', async () => {
  const f = await fixture({ tagging: false });
  f.github.outcomes['pr.merge'] = 'failed';
  await f.arm(); await f.pass();
  assert.deepEqual([f.record()!.state, f.record()!.halt], ['halted', { code: 'declined', reason: 'GitHub declined the merge: Pull Request is not mergeable', at: T0 + 60_000 }]);
  assert.equal(await f.attention(), 'error');
});

test('failing checks start an agent beside the pull request to fix them, twice at most', async () => {
  const f = await fixture({ tagging: false });
  f.github.readiness.checks = 'failing'; f.github.failing = ['unit'];
  await f.arm(); await f.pass();
  assert.equal(f.launches.length, 1);
  const [launch] = f.launches;
  assert.match(launch.hosted.prompt, /Fix the failing checks of pull request Batch exports \(https:\/\/github\.com\/acme\/app\/pull\/42\)/);
  assert.match(launch.hosted.prompt, /feature\/exports/); assert.match(launch.hosted.prompt, /unit/); assert.match(launch.hosted.prompt, /Do not merge/);
  assert.deepEqual([launch.request.projectId, launch.request.data.cwd, launch.request.placedBy], ['web', '/work/web', 'pr']);
  assert.ok(requestConnections(launch.request).some(connection => connection.otherId === 'pr'));
  assert.equal((await f.run({ operation: 'status' })).line, 'Auto deploy · fixing CI (1/2)');
  await f.pass(); assert.equal(f.launches.length, 1, 'one request per failing head');
  f.github.readiness.checks = 'pending'; f.github.readiness.head = 'b'.repeat(40);
  await f.pass(); assert.equal(f.record()!.step, 'waiting-checks');
  f.github.readiness.checks = 'failing';
  await f.pass();
  assert.equal(f.launches.length, 2, 'the first fixer cannot take a prompt here (stopped), so a new one starts');
  assert.notEqual(f.launches[1].request.requestId, f.launches[0].request.requestId);
  assert.equal((await f.run({ operation: 'status' })).line, 'Auto deploy · fixing CI (2/2)');
  f.github.readiness.head = 'd'.repeat(40);
  await f.pass();
  assert.deepEqual([f.record()!.state, f.record()!.halt?.code, f.launches.length], ['halted', 'ci-failing', 2]);
  assert.deepEqual(f.github.writes, [], 'nothing was merged');
});

test('a ready agent connected to the pull request gets the fix request as a prompt instead of a new session', async () => {
  const f = await fixture({ tagging: false, sessions: true });
  await f.apply([{ type: 'item.add', id: 'helper', resourceId: 'helper-r', pluginId: 'agent.session', title: 'Helper', projectId: 'web', position: { x: 300, y: 500 }, data: { provider: 'claude', sessionId: 'session-helper' } },
    { type: 'link.save', link: { id: 'pr-helper', sourceId: 'pr', targetId: 'helper', kind: 'context', label: '' } }, { type: 'node.update', id: 'helper', activity: 'idle' }]);
  f.github.readiness.checks = 'failing'; f.github.failing = ['lint'];
  await f.arm(); await f.pass();
  assert.equal(f.launches.length, 0);
  assert.deepEqual(f.prompts.map(prompt => prompt.sessionId), ['session-helper', 'session-helper']);
  assert.match(f.prompts[0].data, /Fix the failing checks of pull request Batch exports/);
  assert.deepEqual([f.record()!.fixes[0].agentNodeId, f.record()!.writes[0].state], ['helper', 'sent']);
});

test('a ready agent connected to the pull request is not asked to validate: the rollout\'s hidden validation agent is', async () => {
  const f = await fixture({ tagging: false, sessions: true });
  await f.apply([{ type: 'item.add', id: 'helper', resourceId: 'helper-r', pluginId: 'agent.session', title: 'Helper', projectId: 'web', position: { x: 300, y: 500 }, data: { provider: 'claude', sessionId: 'session-helper' } },
    { type: 'link.save', link: { id: 'pr-helper', sourceId: 'pr', targetId: 'helper', kind: 'context', label: '' } }, { type: 'node.update', id: 'helper', activity: 'idle' }]);
  await f.arm(); await f.pass();
  await f.discover([f.gate(7, 'live')], [f.job(1, 'preview / ship'), f.job(2, 'live / ship', 'waiting', null)]);
  await f.pass();
  assert.deepEqual(f.triggers.map(entry => [entry.nodeId, entry.input.value]), [['rollout', VALIDATION_AGENT]]);
  assert.equal(f.record()!.checks[0].agent, VALIDATION_AGENT);
  assert.equal(f.prompts.length, 0, 'the connected agent is not prompted');
});

test('no agent to fix CI or to validate halts instead of waiting forever', async () => {
  const ci = await fixture({ tagging: false, starter: false });
  ci.github.readiness.checks = 'failing';
  await ci.arm(); await ci.pass();
  assert.deepEqual([ci.record()!.state, ci.record()!.halt?.code], ['halted', 'agent-unavailable']);
  const validation = await fixture({ tagging: false });
  await validation.arm(); await validation.pass();
  await validation.discover([], [validation.job(1, 'preview / ship')], 'completed', 'success');
  validation.failTriggers('Claude Code is not installed.');
  await validation.pass();
  assert.deepEqual([validation.record()!.state, validation.record()!.halt?.code], ['halted', 'agent-unavailable']);
  assert.match(validation.record()!.halt!.reason, /Claude Code is not installed/);
});

test('agents may read an auto deploy but only a person arms or stops it', () => {
  assert.equal(agentRuntimeRefusal({ action: AUTO_DEPLOY_OPERATION, arguments: { operation: 'status' } }), undefined);
  assert.equal(agentRuntimeRefusal({ action: AUTO_DEPLOY_OPERATION, arguments: { operation: 'options' } }), undefined);
  for (const value of ['arm', 'stop']) assert.equal(agentRuntimeRefusal({ action: AUTO_DEPLOY_OPERATION, arguments: { operation: 'set', value } }), humanOnlyMessage);
});

test('a failed validation halts before any approval', async () => {
  const f = await fixture({ tagging: false });
  await f.arm(); await f.pass();
  await f.discover([f.gate(7, 'live')], [f.job(1, 'preview / ship')]);
  await f.pass();
  f.verdicts[0].state = 'final'; f.verdicts[0].verdict = 'failed'; f.github.approvable = '7';
  await f.pass();
  assert.deepEqual([f.record()!.state, f.record()!.halt?.code], ['halted', 'validation-failed']);
  assert.deepEqual(f.github.writes.map(write => write.actionId), ['pr.merge']);
});

type Pick = { field: string; label: string; options: { id: string; label: string; note?: string; plan?: { name: string; text: string; tone?: string }[]; foot?: string }[] };
type Offer = { prompt: string; context: JsonObject; options: { id: string; label: string; description?: string; disabled?: boolean; confirm?: { prompt: string; action: string; pick?: Pick } }[] };
const midRollout = (f: Awaited<ReturnType<typeof fixture>>, linked = true) => f.discover([f.gate(7, 'production')],
  [f.job(1, 'build'), f.job(2, 'deploy-preview / ship'), f.job(3, 'deploy-staging / ship'), f.job(4, 'deploy-prod (eu-west)', 'waiting', null)], 'waiting', null, linked);
const passedPreview = [{ label: 'V1', state: 'final', verdict: 'passed', finishedAt: T0, scope: { runId: 101, attempt: 1, jobs: [1, 2] } }];

test('auto deploy from a rollout a pull request discovered: the confirm offers both catch-ups with their plan, the record is the pull request\'s, and staging is validated before production is approved', async () => {
  const f = await fixture({ tagging: false, validated: passedPreview });
  f.github.merged = true; f.github.readiness.lifecycle = 'merged';
  await midRollout(f);
  const offer = await f.run({ operation: 'options' }, 'rollout') as unknown as Offer;
  assert.equal(offer.prompt, 'Auto deploy run #7 from here?');
  assert.deepEqual(offer.context, { sourceResourceId: 'rollout-r', from: 'here' });
  const [start] = offer.options, pick = start.confirm!.pick!;
  assert.deepEqual([start.id, start.label, start.disabled, start.confirm!.action, pick.field], ['arm', 'Start auto deploy', undefined, 'Start auto deploy', 'catchUp']);
  assert.deepEqual(pick.options.map(option => [option.id, option.label]), [['validate', 'Validate what shipped first'], ['accept', 'Start from the next phase']]);
  const [validate, accept] = pick.options;
  assert.deepEqual(validate.plan!.map(row => [row.name, row.text.replace(/\d\d:\d\d/, 'hh:mm'), row.tone]), [['preview', 'V1 passed at hh:mm · counts', undefined], ['staging', 'deployed hh:mm · validate now', 'do'], ['production', 'approve after staging passes, then validate once deployed', 'do']]);
  assert.equal(validate.foot, 'One validation (staging) before production. Validates production after it deploys. Any doubt halts.');
  assert.deepEqual(accept.plan!.map(row => [row.name, row.text.replace(/\d\d:\d\d/, 'hh:mm'), row.tone]), [['preview', 'V1 passed at hh:mm · counts', undefined], ['staging', 'deployed hh:mm · counts as accepted, not validated', 'risk'], ['production', 'approve now, then validate once deployed', 'do']]);
  assert.equal(accept.foot, 'Approves production at once. Validates production after it deploys. Any doubt halts.');

  const armed = await f.run({ operation: 'set', value: 'arm', from: 'here', catchUp: 'validate', sourceResourceId: 'rollout-r', requestId: randomUUID() }, 'rollout');
  assert.equal(armed.state, 'armed');
  const record = f.record()!;
  assert.deepEqual([record.pullResourceId, record.mergedAt, record.takeover?.catchUp, record.takeover?.rolloutNodeIds, record.takeover?.counts], ['pr-r', T0, 'validate', ['rollout'], ['V1']]);
  await f.pass();
  assert.deepEqual(f.triggers.map(entry => (entry.input.phase as JsonObject).jobs), [[3]], 'only staging is validated: V1 already covered preview');
  assert.equal(f.github.writes.length, 0, 'nothing is approved before the catch-up passed');
  const status = await f.run({ operation: 'status' }, 'rollout') as { pullNodeId?: string; pullNumber?: number; line?: string; next?: string; track: { phases: { name: string; check?: { id?: string; state: string } }[]; current?: number }; events: { kind: string; text: string }[] };
  assert.deepEqual([status.pullNodeId, status.pullNumber, status.line], ['pr', 42, 'Auto deploy · validating before production (deploy-prod (eu-west))']);
  assert.deepEqual(status.track.phases.map(phase => [phase.name, phase.check?.id, phase.check?.state]), [['build', undefined, undefined], ['preview', 'V1', 'passed'], ['staging', 'V2', 'running'], ['production', undefined, 'none']]);
  assert.deepEqual([status.track.current, status.next], [2, 'approve production']);
  assert.deepEqual(status.events.map(event => event.text), ['armed by you from here · V1 counts', 'asked Claude to validate before production (deploy-prod (eu-west)) · V2']);
  f.verdicts[0].state = 'final'; f.verdicts[0].verdict = 'passed'; f.github.approvable = '7';
  await f.pass();
  assert.deepEqual(f.github.writes.map(write => [write.nodeId, write.actionId, write.input.environmentIds]), [['rollout', 'rollout.approve', '7']]);
  assert.equal(f.record()!.writes[0].label, 'production');

  const again = await f.run({ operation: 'options' }, 'rollout') as unknown as Offer;
  assert.match(again.prompt, /^Under auto deploy from #42 · /);
  assert.deepEqual(again.options.map(option => option.id), ['stop']);
  await f.run({ operation: 'set', value: 'stop', from: 'here', sourceResourceId: 'rollout-r', requestId: randomUUID() }, 'rollout');
  assert.equal(f.record()!.state, 'stopped');
});

test('a rollout no auto deploy follows has a phase track of its own: checks from its validations, gates from GitHub, Auto validate from the pull request that discovered it', async () => {
  const f = await fixture({ tagging: false, validated: [{ label: 'V1', state: 'final', verdict: 'passed', finishedAt: T0, requestedAt: T0 + 30 * 60_000, scope: { runId: 101, attempt: 1, environments: ['staging'] } }] });
  await midRollout(f);
  type Status = { state: string; track: { phases: { name: string; check?: { id?: string; state: string }; gate?: { state: string; at?: number } }[]; current?: number; currentGate?: true; plain?: true; autoValidate?: true } };
  const shape = (status: Status) => status.track.phases.map(phase => [phase.name, phase.check?.id, phase.check?.state, phase.gate?.state]);
  const off = await f.run({ operation: 'status' }, 'rollout') as unknown as Status;
  assert.equal(off.state, 'off');
  assert.deepEqual(shape(off), [['build', undefined, undefined, undefined], ['preview', undefined, 'none', undefined], ['staging', 'V1', 'passed', undefined], ['production', undefined, 'none', 'you']]);
  assert.deepEqual([off.track.current, off.track.currentGate, off.track.plain, off.track.autoValidate], [3, true, true, true]);
  await f.run({ operation: 'set', value: 'arm', from: 'here', catchUp: 'validate', sourceResourceId: 'rollout-r', requestId: randomUUID() }, 'rollout');
  assert.equal(((await f.run({ operation: 'status' }, 'rollout')) as unknown as Status).track.plain, undefined, 'an armed record draws its own track');
  await f.run({ operation: 'set', value: 'stop', from: 'here', sourceResourceId: 'rollout-r', requestId: randomUUID() }, 'rollout');
  const stopped = await f.run({ operation: 'status' }, 'rollout') as unknown as Status;
  assert.deepEqual([stopped.state, stopped.track.plain, shape(stopped)[2][1]], ['stopped', true, 'V1']);
  f.events.push({ runId: 101, attempt: 1, kind: 'gate-approved', environment: 'production', observedAt: T0 + 5 * 60_000 });
  await f.discover([], [f.job(1, 'build'), f.job(2, 'deploy-preview / ship'), f.job(3, 'deploy-staging / ship'), f.job(4, 'deploy-prod (eu-west)', 'in_progress', null)], 'in_progress', null, false);
  f.events.push({ runId: 101, attempt: 1, kind: 'gate-waiting', environment: 'production', observedAt: T0 });
  const approved = await f.run({ operation: 'status' }, 'rollout') as unknown as Status;
  assert.deepEqual([approved.track.phases[3].gate?.state, approved.track.phases[3].gate?.at, approved.track.current], ['approved', T0 + 5 * 60_000, 3]);
});

test('a rollout no pull request on the map discovered has no Auto validate on its track', async () => {
  const f = await fixture({ tagging: false });
  await midRollout(f, false);
  assert.equal(((await f.run({ operation: 'status' }, 'rollout')) as { track: { autoValidate?: true } }).track.autoValidate, undefined);
});

test('auto deploy from a rollout no pull request discovered: the record is the rollout\'s, accepting approves the waiting gate at once, and a halt raises Needs me on the rollout', async () => {
  const f = await fixture({ tagging: false });
  await midRollout(f, false);
  await f.run({ operation: 'set', value: 'arm', from: 'here', catchUp: 'accept', sourceResourceId: 'rollout-r', requestId: randomUUID() }, 'rollout');
  const own = f.store.pluginStorage('github.rollout').get(AUTO_DEPLOY_COLLECTION, 'rollout-r')?.value as unknown as AutoDeployRecord;
  assert.deepEqual([own.pullResourceId, own.rolloutResourceId, own.rolloutNodeId, own.takeover?.catchUp], [undefined, 'rollout-r', 'rollout', 'accept']);
  assert.equal(f.record(), undefined, 'the pull request has no record');
  f.github.approvable = '7';
  await f.pass();
  assert.deepEqual(f.github.writes.map(write => write.actionId), ['rollout.approve']);
  assert.deepEqual(f.triggers, [], 'what deployed before arming counts as accepted');
  const status = await f.run({ operation: 'status' }, 'rollout') as { state: string; pullNodeId?: string; events: { text: string }[] };
  assert.deepEqual([status.state, status.pullNodeId, status.events[0].text], ['armed', undefined, 'armed by you from here · what already deployed counts as accepted']);
  await f.discover([], [f.job(1, 'build'), f.job(2, 'deploy-preview / ship'), f.job(3, 'deploy-staging / ship'), f.job(4, 'deploy-prod (eu-west)', 'completed', 'failure')], 'completed', 'failure', false);
  await f.pass();
  const halted = f.store.pluginStorage('github.rollout').get(AUTO_DEPLOY_COLLECTION, 'rollout-r')?.value as unknown as AutoDeployRecord;
  assert.deepEqual([halted.state, halted.halt?.code], ['halted', 'deploy-failed']);
  assert.deepEqual([await f.attention('rollout'), await f.attention('pr')], ['error', null]);
});

test('auto deploy from a rollout is refused on a finished, failed or missing run, and on one already followed', async () => {
  const f = await fixture({ tagging: false });
  const refusal = async () => { const offer = await f.run({ operation: 'options' }, 'rollout') as unknown as Offer; return [offer.options[0].disabled, offer.options[0].description]; };
  await f.discover([], [f.job(1, 'deploy-preview / ship')], 'completed', 'success', false);
  assert.deepEqual(await refusal(), [true, 'Already deployed.']);
  await assert.rejects(f.run({ operation: 'set', value: 'arm', from: 'here', catchUp: 'validate', sourceResourceId: 'rollout-r', requestId: randomUUID() }, 'rollout'), /Already deployed/);
  await f.discover([], [f.job(1, 'deploy-preview / ship', 'completed', 'failure')], 'completed', 'failure', false);
  assert.deepEqual(await refusal(), [true, 'The run failed. Re-run it on GitHub first.']);
  f.github.observation = undefined;
  assert.deepEqual(await refusal(), [true, 'Waiting for the deploy run.']);
  await midRollout(f, false);
  await f.run({ operation: 'set', value: 'arm', from: 'here', catchUp: 'validate', sourceResourceId: 'rollout-r', requestId: randomUUID() }, 'rollout');
  const followed = await f.run({ operation: 'options' }, 'rollout') as unknown as Offer;
  assert.match(followed.prompt, /^Under auto deploy · /);
  assert.deepEqual(followed.options.map(option => [option.id, option.label]), [['stop', 'Stop auto deploy']]);
  await assert.rejects(f.run({ operation: 'set', value: 'arm', from: 'here', catchUp: 'validate', sourceResourceId: 'other', requestId: randomUUID() }, 'rollout'), /another item/);
});

test('a merged pull request offers auto deploy of the running rollout its merge discovered, and arms the same takeover', async () => {
  const f = await fixture({ tagging: false });
  f.github.merged = true; f.github.readiness.lifecycle = 'merged';
  const before = await f.run({ operation: 'options' }) as unknown as Offer;
  assert.deepEqual([before.options[0].disabled, before.options[0].description], [true, 'Already merged.']);
  await midRollout(f);
  const offer = await f.run({ operation: 'options' }) as unknown as Offer;
  assert.equal(offer.prompt, 'Deploy #42 automatically?');
  assert.deepEqual(offer.context, { sourceResourceId: 'pr-r', from: 'here' });
  assert.deepEqual([offer.options[0].label, offer.options[0].description, offer.options[0].confirm?.prompt, offer.options[0].confirm?.pick?.options.length], ['Auto deploy its rollout', 'run #7', 'Auto deploy run #7 from here?', 2]);
  await f.run({ operation: 'set', value: 'arm', from: 'here', catchUp: 'accept', sourceResourceId: 'pr-r', requestId: randomUUID() });
  assert.deepEqual([f.record()!.takeover?.rolloutNodeIds, f.record()!.mergedAt, f.record()!.step], [['rollout'], T0, 'deploying']);
  f.github.approvable = '7';
  await f.pass();
  assert.deepEqual(f.github.writes.map(write => write.actionId), ['rollout.approve'], 'no tag and no merge on a merged pull request');
});

test('autoDeployArmed reads the stored record: only an armed one counts', () => {
  const records = new Map<string, unknown>([['armed-pr', { state: 'armed' }], ['stopped-pr', { state: 'stopped' }]]);
  const storage = { get: (collection: string, key: string) => collection === AUTO_DEPLOY_COLLECTION && records.has(key) ? { value: records.get(key) } : undefined };
  assert.deepEqual(['armed-pr', 'stopped-pr', 'other-pr'].map(id => autoDeployArmed(storage as never, id)), [true, false, false]);
});
