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
async function fixture(options: { starter?: boolean; tagging?: boolean; directory?: string; sessions?: boolean } = {}) {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), 'craft-auto-deploy-')), store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  const apply = async (commands: WorkspaceCommand[]) => control.dispatch({ commandId: randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'test' }, commands });
  if (!options.directory) await apply([
    { type: 'project.create', id: 'web', title: 'Web', summary: '', position: { x: 0, y: 0 }, workingDirectory: '/work/web' },
    { type: 'item.add', id: 'pr', resourceId: 'pr-r', pluginId: 'github.pull-request', title: 'Batch exports', projectId: 'web', position: { x: 300, y: 200 }, data: { owner: 'acme', repo: 'app', number: 42 } },
  ]);
  let now = T0;
  const readiness: PullMergeReadiness = { pullRequestId: 'PR_node42', number: 42, title: 'Batch exports', lifecycle: 'open', head, base: 'main', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', checks: 'passing', queued: false, queueEnabled: false, method: 'SQUASH' };
  const github = { readiness, failing: [] as string[], observation: undefined as RolloutObservation | undefined, outcomes: {} as Record<string, Outcome>, reads: 0,
    writes: [] as { nodeId: string; actionId: string; input: JsonObject }[], approvable: '' };
  const resources = {
    async cached(nodeId: string) {
      if (nodeId === 'pr') return { detail: { pull: { title: github.readiness.title, state: 'open', merged: false, base: { ref: 'main' }, head: { ref: 'feature/exports', sha: github.readiness.head } }, ...(github.failing.length ? { failingChecks: github.failing } : {}) } };
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
  const verdicts: { label: string; state: string; verdict?: string; resolvedBy?: string }[] = [];
  let triggerFailure: string | undefined;
  const validations = { async run(nodeId: string, input: JsonObject) {
    if (input.operation === 'list') return { validations: verdicts };
    triggers.push({ nodeId, input });
    if (triggerFailure) throw new Error(triggerFailure);
    const label = `V${triggers.length}`; if (!verdicts.some(entry => entry.label === label)) verdicts.push({ label, state: 'requested' });
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
  const discover = async (gates: RolloutObservation['gates'], jobs: RolloutObservation['jobs'], status = 'in_progress', conclusion: string | null = null) => {
    if (!(await control.read()).nodes.some(node => node.id === 'rollout')) await apply([
      { type: 'item.add', id: 'rollout', resourceId: 'rollout-r', pluginId: 'github.rollout', title: 'Web / Release', projectId: 'web', position: { x: 600, y: 200 }, data: { owner: 'acme', repo: 'app', runId: 101 } },
      { type: 'link.save', link: { id: discoveredLinkId('pr-r', rolloutDiscoveryKey(101)), sourceId: 'pr', targetId: 'rollout', kind: 'reference', label: '' } }]);
    github.observation = { workflow: 'Web / Release', url: 'https://github.com/acme/app/actions/runs/101', followsLatest: false, gates, jobs,
      run: { id: 101, name: 'Web / Release', display_title: 'Batch exports', run_number: 7, run_attempt: 1, workflow_id: 9, head_branch: 'main', head_sha: sha, status, conclusion, updated_at: '2026-10-08T10:30:00Z', repository: { full_name: 'acme/app' } } };
  };
  const job = (id: number, name: string, status = 'completed', conclusion: string | null = 'success') => ({ id, run_id: 101, name, status, conclusion, started_at: '2026-10-08T10:10:00Z', completed_at: status === 'completed' ? '2026-10-08T10:20:00Z' : null });
  const gate = (id: number, name: string) => ({ environment: { id, name }, wait_timer: 0, current_user_can_approve: true, reviewers: [{ type: 'User' }] });
  const pass = async (minutes = 1) => { now += minutes * 60_000; await deploys.reconcile(); };
  const attention = async () => (await control.read()).nodes.find(node => node.id === 'pr')?.attentionSources?.['auto-deploy'] ?? null;
  return { directory, store, control, deploys, github, triggers, verdicts, launches, prompts, run, arm, record, discover, job, gate, pass, attention, apply, failTriggers: (message: string) => { triggerFailure = message; }, setNow: (value: number) => { now = value; } };
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
  assert.deepEqual(await f.run({ operation: 'status' }, 'rollout'), { ...(await f.run({ operation: 'status' })), pullNodeId: 'pr', pullTitle: 'Batch exports' }, 'the rollout view sees the pull request it deploys');
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

test('autoDeployArmed reads the stored record: only an armed one counts', () => {
  const records = new Map<string, unknown>([['armed-pr', { state: 'armed' }], ['stopped-pr', { state: 'stopped' }]]);
  const storage = { get: (collection: string, key: string) => collection === AUTO_DEPLOY_COLLECTION && records.has(key) ? { value: records.get(key) } : undefined };
  assert.deepEqual(['armed-pr', 'stopped-pr', 'other-pr'].map(id => autoDeployArmed(storage as never, id)), [true, false, false]);
});
