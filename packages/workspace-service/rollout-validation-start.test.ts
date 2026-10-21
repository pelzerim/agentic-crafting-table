import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from './sqlite-store.ts';
import { WorkspaceControl } from '../core/control.ts';
import type { WorkspaceCommand } from '../core/control.ts';
import { creationConnections, creationNear, requestConnections } from '../core/resource-creation.ts';
import type { ResourceCreate } from '../core/resource-creation.ts';
import type { HostedLaunch } from '../session-runtime/agent-plan.ts';
import { applyAtHead } from './apply-at-head.ts';
import type { ResourceCoordinator } from './resources.ts';
import { discoveredLinkId } from './resources.ts';
import type { SessionCoordinator } from './sessions.ts';
import { RolloutValidations } from './rollout-validation.ts';
import { rolloutDiscoveryKey } from '../provider-runtime/github-status.ts';
import type { RolloutObservation } from '../provider-runtime/github-rollout.ts';
import { NEW_VALIDATION_AGENT, VALIDATION_AGENT } from '../../src/resource-plugins/items/github-rollout/validation.ts';
import { HIDDEN_AGENT_IDLE_MS } from './rollout-validation.ts';

const NOT_INSTALLED = 'Claude Code is not installed. Install and sign in to the Claude CLI, then retry.';
/** A rollout in a project, discovered by a merged pull request in another project, with no agent connected. The
 * starter commits a launch as the Claude provider does: one item placed by its anchors, with its connections. */
async function fixture(options: { starter?: boolean; floating?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'craft-validation-start-')), store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  const apply = async (commands: WorkspaceCommand[]) => control.dispatch({ commandId: randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'test' }, commands });
  const home = options.floating ? {} : { projectId: 'web' };
  await apply([
    { type: 'project.create', id: 'web', title: 'Web', summary: '', position: { x: 0, y: 0 }, workingDirectory: '/work/web' },
    { type: 'project.create', id: 'changes', title: 'Changes', summary: '', position: { x: 4000, y: 0 }, workingDirectory: '/work/changes' },
    { type: 'item.add', id: 'rollout', resourceId: 'rollout-r', pluginId: 'github.rollout', title: 'App / Deploy', ...home, position: { x: 300, y: 200 }, data: { owner: 'acme', repo: 'app', runId: 101 } },
    { type: 'item.add', id: 'pr', resourceId: 'pr-r', pluginId: 'github.pull-request', title: 'Ship the reading list', projectId: 'changes', position: { x: 4300, y: 200 }, data: { owner: 'acme', repo: 'app', number: 42 } },
    { type: 'link.save', link: { id: discoveredLinkId('pr-r', rolloutDiscoveryKey(101)), sourceId: 'pr', targetId: 'rollout', kind: 'reference', label: '' } },
  ]);
  const inputs: unknown[] = [];
  const calls: string[] = [];
  const sessions = { runtime: { async call(method: string, input: unknown) { calls.push(method); if (method === 'sessions.input') inputs.push(input); return { session: { state: 'running', native: { status: 'idle' } } }; } } } as unknown as SessionCoordinator;
  const observation: RolloutObservation = { workflow: 'App / Deploy', url: 'https://github.com/acme/app/actions/runs/101', followsLatest: false, gates: [],
    run: { id: 101, name: 'App / Deploy', display_title: 'Ship', run_number: 28, run_attempt: 1, workflow_id: 9, head_branch: 'main', head_sha: 'a'.repeat(40), status: 'in_progress', conclusion: null, updated_at: '2026-10-07T13:00:00Z', repository: { full_name: 'acme/app' } },
    jobs: [{ id: 201, run_id: 101, name: 'deploy / env-a', status: 'in_progress', conclusion: null, started_at: '2026-10-07T13:00:00Z', completed_at: null }] };
  const resources = { async context() { return { resourceId: 'rollout-r', title: 'App / Deploy', sourceUrl: observation.url, content: 'App / Deploy\nOngoing · 0/1 jobs finished' }; },
    async cached() { return { detail: observation }; }, async refreshPresentation() {} } as unknown as ResourceCoordinator;
  const launches: { request: ResourceCreate; hosted: HostedLaunch }[] = [];
  const starter = { unready: undefined as string | undefined, failure: undefined as Error | undefined, probes: 0,
    async ready() { this.probes++; if (this.unready) throw new Error(this.unready); },
    fallbackDirectory: () => '/work/recent',
    async launch(request: ResourceCreate, hosted: HostedLaunch) {
      launches.push({ request, hosted });
      if (this.failure) throw this.failure;
      await applyAtHead(control, { commandId: `${request.requestId}:node`, actor: { kind: 'user', id: 'desktop' }, commands: [
        { type: 'item.add', id: request.nodeId, resourceId: request.resourceId, pluginId: 'agent.session', title: request.title, projectId: request.projectId, position: request.position, ...creationNear(request),
          ...(request.hidden ? { hidden: request.hidden } : {}), data: { ...hosted.data, provider: 'claude', sessionId: request.requestId, cwd: request.data.cwd } },
        ...creationConnections(requestConnections(request), request.nodeId)] });
    } };
  let now = Date.parse('2026-10-07T13:10:00Z');
  const validations = new RolloutValidations(store, control, resources, sessions, async () => {}, { now: () => now, ...(options.starter === false ? {} : { starter }) });
  const run = (input: object) => validations.run('rollout', input);
  const start = (requestId = randomUUID()) => run({ operation: 'trigger', sourceResourceId: 'rollout-r', value: NEW_VALIDATION_AGENT, requestId });
  const listed = async () => (await run({ operation: 'list' }) as any).validations as any[];
  const validate = (requestId = randomUUID()) => run({ operation: 'trigger', sourceResourceId: 'rollout-r', value: VALIDATION_AGENT, requestId });
  const node = async (id: string) => (await control.read()).nodes.find(candidate => candidate.id === id)!;
  return { control, store, apply, run, start, validate, node, listed, validations, starter, launches, inputs, calls, observation, tick(ms: number) { now += ms; }, close() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('the agent list ends with Start a new agent, which is the only entry when no agent is connected', async () => {
  const f = await fixture();
  try {
    const alone = await f.run({ operation: 'options' }) as any;
    assert.deepEqual(alone.options.map((option: any) => [option.id, option.label, Boolean(option.disabled)]), [[NEW_VALIDATION_AGENT, 'Start a new agent', false]]);
    assert.deepEqual(alone.context, { sourceResourceId: 'rollout-r' });
    await f.apply([{ type: 'item.add', id: 'watcher', resourceId: 'watcher-r', pluginId: 'agent.session', title: 'Agent watcher', projectId: 'web', position: { x: 300, y: 600 }, data: { provider: 'claude', sessionId: 'watcher-session' } },
      { type: 'link.save', link: { id: 'rollout-agent', sourceId: 'rollout', targetId: 'watcher', kind: 'context', label: '' } }, { type: 'node.update', id: 'watcher', activity: 'working' }]);
    const both = await f.run({ operation: 'options' }) as any;
    assert.deepEqual(both.options.map((option: any) => [option.id, Boolean(option.disabled)]), [['watcher', true], [NEW_VALIDATION_AGENT, false]]);
    assert.match(both.options[0].description, /^Working · connected/);
  } finally { f.close(); }
});

test('Start a new agent is unavailable with the reason when Claude cannot start, the rollout has no run, or native sessions are missing', async () => {
  const f = await fixture(), bare = await fixture({ starter: false });
  try {
    const entry = async (target: typeof f) => (await target.run({ operation: 'options' }) as any).options.at(-1);
    f.starter.unready = NOT_INSTALLED;
    assert.deepEqual(await entry(f), { id: NEW_VALIDATION_AGENT, label: 'Start a new agent', description: NOT_INSTALLED, disabled: true });
    await assert.rejects(f.start(), /Claude Code is not installed/);
    assert.equal(f.launches.length, 0); assert.deepEqual(await f.listed(), []);
    // A failed probe is not repeated on every menu read; a later one sees Claude installed.
    const probes = f.starter.probes; await entry(f); assert.equal(f.starter.probes, probes);
    f.starter.unready = undefined; f.tick(60_000);
    assert.equal((await entry(f)).disabled, undefined);
    f.observation.run = null;
    assert.deepEqual([(await entry(f)).disabled, (await entry(f)).description], [true, 'This rollout has no run to validate yet. Refresh it and try again.']);
    await assert.rejects(f.start(), /no run to validate yet/);
    assert.deepEqual([(await entry(bare)).disabled, (await entry(bare)).description], [true, 'Starting an agent is not available here: native Claude sessions are not configured.']);
    await assert.rejects(bare.start(), /native Claude sessions are not configured/);
  } finally { f.close(); bare.close(); }
});

test('starting a new agent records one validation, places the agent beside the rollout in its project and connects the rollout and its pull request', async () => {
  const f = await fixture();
  try {
    const result = await f.start() as any, state = await f.control.read();
    assert.deepEqual({ sent: result.sent, linked: result.linked, validationId: result.validationId }, { sent: true, linked: true, validationId: 'V1' });
    const agent = state.nodes.find(node => node.id === result.agentNodeId)!, rollout = state.nodes.find(node => node.id === 'rollout')!;
    assert.equal(agent.title, 'Validate · App / Deploy'); assert.equal(agent.projectId, 'web');
    assert.ok(agent.position.x > rollout.position.x && agent.position.x - rollout.position.x < 600 && Math.abs(agent.position.y - rollout.position.y) < 200, JSON.stringify(agent.position));
    assert.deepEqual(state.links.filter(link => link.targetId === agent.id).map(link => [link.sourceId, link.kind, link.label, link.reveal]).sort(), [['pr', 'context', '', undefined], ['rollout', 'context', 'Validation', 'hover']]);
    const [{ request, hosted }] = f.launches;
    assert.equal(request.pluginId, 'agent.session'); assert.equal(request.position, undefined); assert.equal(request.expectedRevision, undefined);
    assert.deepEqual(request.data, { provider: 'claude', cwd: '/work/web' });
    assert.deepEqual(hosted.data.validation, { rolloutNodeId: 'rollout', validationId: 'V1', requestId: (await f.listed())[0].requestId });
    assert.match(hosted.prompt, /^Check whether this rollout works as intended: App \/ Deploy \(https:\/\/github\.com\/acme\/app\/actions\/runs\/101\)\. It is Agentic Crafting Table item rollout\./);
    assert.match(hosted.prompt, /\n\nPull request behind this rollout: Ship the reading list \(https:\/\/github\.com\/acme\/app\/pull\/42\)\.\n\n/);
    assert.match(hosted.prompt, /This is validation V1 for run 101, attempt 1, commit aaaaaaaaaaaa, focus: whole run\./);
    assert.match(hosted.prompt, /Ongoing · 0\/1 jobs finished/);
    assert.doesNotMatch(hosted.prompt, /Do not do this in your own turn|lead subagent/, 'an agent started for the validation does it itself');
    assert.match(hosted.prompt, /You lead this validation\. You may fan out: start one subagent per data source/);
    assert.match(hosted.prompt, /Context from the table \(JSON\):\n\{\n "run": \{\n  "id": 101,/);
    assert.match(hosted.prompt, /workspace_report_validation \(rolloutNodeId "rollout", validationId "V1"\)/);
    assert.equal(f.inputs.length, 0, 'the prompt opens the session; nothing is pasted');
    assert.deepEqual((await f.listed()).map(view => [view.label, view.agentNodeId, view.state, view.agent]), [['V1', agent.id, 'requested', { title: 'Validate · App / Deploy', provider: 'claude' }]]);
    // The agent reports like any other, and a later validation offers it as a connected agent.
    await f.run({ operation: 'report', agentNodeId: agent.id, validationId: 'V1', sequence: 1, phase: 'final', verdict: 'passed', summary: 'Healthy', checks: [{ id: 'C1', title: 'Pods ready', status: 'passed' }] });
    assert.deepEqual((await f.listed()).map(view => [view.state, view.verdict]), [['final', 'passed']]);
    assert.deepEqual((await f.run({ operation: 'options' }) as any).options.map((option: any) => option.id), [agent.id, NEW_VALIDATION_AGENT]);
  } finally { f.close(); }
});

test('repeating a request starts neither a second session nor a second validation', async () => {
  const f = await fixture();
  try {
    const requestId = randomUUID(), [first, second] = await Promise.all([f.start(requestId), f.start(requestId)]);
    assert.deepEqual(second, first); assert.deepEqual(await f.start(requestId), first);
    assert.equal(f.launches.length, 1); assert.equal((await f.listed()).length, 1);
    assert.equal((await f.control.read()).nodes.filter(node => node.title.startsWith('Validate · ')).length, 1);
    assert.equal(((await f.start()) as any).validationId, 'V2'); assert.equal(f.launches.length, 2);
  } finally { f.close(); }
});

test('a launch that fails ends the validation inconclusive with the launch error and is not retried', async () => {
  const f = await fixture();
  try {
    const requestId = randomUUID();
    f.starter.failure = Object.assign(new Error('Choose an existing working directory'), { code: 'INVALID_REQUEST' });
    await assert.rejects(f.start(requestId), /^Error: The new agent could not start\. Choose an existing working directory$/);
    const [view] = await f.listed();
    assert.deepEqual([view.label, view.state, view.verdict, view.report.summary], ['V1', 'final', 'inconclusive', 'The new agent could not start. Choose an existing working directory']);
    assert.deepEqual(view.report.checks.map((check: any) => [check.status, check.observation]), [['skipped', 'Choose an existing working directory']]);
    assert.equal((await f.control.read()).nodes.some(node => node.title.startsWith('Validate · ')), false);
    f.starter.failure = undefined;
    await assert.rejects(f.start(requestId), /The new agent could not start\. Choose an existing working directory/);
    assert.equal(f.launches.length, 1); assert.equal((await f.listed()).length, 1);
    assert.equal(((await f.start()) as any).validationId, 'V2');
  } finally { f.close(); }
});

test('a launch whose outcome is unknown keeps the validation requested until the No report rule ends it', async () => {
  const f = await fixture();
  try {
    const requestId = randomUUID();
    f.starter.failure = Object.assign(new Error('socket closed'), { code: 'LAUNCH_UNCERTAIN' });
    await assert.rejects(f.start(requestId), /socket closed/);
    assert.deepEqual((await f.listed()).map(view => view.state), ['requested']);
    f.starter.failure = undefined;
    await assert.rejects(f.start(requestId), /could not be confirmed/);
    assert.equal(f.launches.length, 1);
    f.tick(3 * 60_000); await f.validations.reconcile();
    assert.deepEqual((await f.listed()).map(view => view.state), ['no-report']);
  } finally { f.close(); }
});

test('the new agent works in the folder of the rollout\'s project, else of the discovering pull request\'s project, else where launches fall back', async () => {
  const f = await fixture({ floating: true });
  try {
    await f.start();
    assert.equal(f.launches[0].request.data.cwd, '/work/changes'); assert.equal(f.launches[0].request.projectId, undefined);
    await f.apply([{ type: 'node.update', id: 'changes', workingDirectory: '' }]);
    await f.start();
    assert.equal(f.launches[1].request.data.cwd, '/work/recent');
  } finally { f.close(); }
});

const connectAgent = (f: Awaited<ReturnType<typeof fixture>>, id: string) => f.apply([
  { type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'agent.session', title: `Agent ${id}`, projectId: 'changes', position: { x: 4300, y: 900 }, data: { provider: 'claude', sessionId: `${id}-session` } },
  { type: 'link.save', link: { id: `pr-${id}`, sourceId: 'pr', targetId: id, kind: 'context', label: '' } },
  { type: 'node.update', id, activity: 'idle' },
]);

test('Auto validate starts the rollout\'s hidden validation agent, even with an agent connected, and asks that agent again for the next attempt', async () => {
  const f = await fixture();
  try {
    await connectAgent(f, 'author');
    await f.validations.reconcile(); f.tick(15_000); await f.validations.reconcile();
    assert.equal(f.launches.length, 1, 'once per attempt');
    assert.deepEqual(f.launches[0].request.hidden, { label: 'validation agent' });
    const [view] = await f.listed();
    assert.deepEqual([view.label, view.automatic, view.agentHidden, view.agentNodeId === f.launches[0].request.nodeId], ['V1', true, true, true]);
    assert.equal(f.inputs.length, 0, 'the connected agent is not asked');
    assert.match(f.launches[0].hosted.prompt, /This is validation V1 for run 101, attempt 1/);
    await f.run({ operation: 'report', agentNodeId: view.agentNodeId, validationId: 'V1', sequence: 1, ...FINAL });
    await f.apply([{ type: 'node.update', id: view.agentNodeId, activity: 'idle' }]);
    f.observation.run = { ...f.observation.run!, run_attempt: 2 }; f.observation.jobs = f.observation.jobs.map(job => ({ ...job, id: job.id + 100 }));
    await f.validations.reconcile();
    assert.equal(f.launches.length, 1, 'the idle hidden agent is asked again instead of a second session');
    assert.deepEqual((await f.listed()).map(entry => [entry.label, entry.agentNodeId === view.agentNodeId, entry.automatic]), [['V1', true, true], ['V2', true, true]]);
    assert.match(String((f.inputs[0] as { data: string }).data), /This is validation V2 for run 101, attempt 2/);
    assert.match(String((f.inputs[0] as { data: string }).data), /You lead this validation/);
  } finally { f.close(); }
});

test('Auto validate falls back to a ready connected agent only while Claude cannot start a session here', async () => {
  const f = await fixture();
  try {
    await connectAgent(f, 'author');
    f.starter.unready = NOT_INSTALLED;
    await f.validations.reconcile();
    assert.equal(f.launches.length, 0);
    assert.deepEqual((await f.listed()).map(entry => [entry.label, entry.agentNodeId, entry.automatic]), [['V1', 'author', true]]);
    assert.equal((f.inputs[0] as { sessionId: string }).sessionId, 'author-session');
  } finally { f.close(); }
  const alone = await fixture({ starter: false });
  try {
    await alone.validations.reconcile(); alone.tick(15_000); await alone.validations.reconcile();
    assert.deepEqual(await alone.listed(), [], 'nothing to ask and nothing to start');
  } finally { alone.close(); }
});

const FINAL = { phase: 'final', verdict: 'passed', summary: 'Healthy', checks: [{ id: 'C1', title: 'Pods ready', status: 'passed' }] };

test('an agent started for a validation is created hidden: placed and linked as before, reporting, and marked hidden in the list', async () => {
  const f = await fixture();
  try {
    const { agentNodeId } = await f.start() as any, agent = await f.node(agentNodeId);
    assert.deepEqual(f.launches[0].request.hidden, { label: 'validation agent' });
    assert.match(agent.hiddenAt!, /^\d{4}-/); assert.equal(agent.hideLabel, 'validation agent');
    assert.deepEqual((await f.control.read()).links.filter(link => link.targetId === agentNodeId).map(link => link.sourceId).sort(), ['pr', 'rollout']);
    const [view] = await f.listed();
    assert.equal(view.agentHidden, true); assert.equal(view.agentHideable, undefined);
    await f.run({ operation: 'report', agentNodeId, validationId: 'V1', sequence: 1, ...FINAL });
    assert.deepEqual((await f.listed()).map(entry => entry.verdict), ['passed']);
  } finally { f.close(); }
});

test('Show validation agent puts the agent beside the rollout and Hide takes it off again, without stopping it', async () => {
  const f = await fixture();
  try {
    const { agentNodeId } = await f.start() as any, hidden = await f.node(agentNodeId);
    await assert.rejects(f.run({ operation: 'show', validationId: 'V9' }), /V9 was not requested/);
    assert.deepEqual(await f.run({ operation: 'show', validationId: 'V1' }), { agentNodeId, shown: true });
    const shown = await f.node(agentNodeId), rollout = await f.node('rollout');
    assert.equal(shown.hiddenAt, undefined); assert.equal(shown.hideLabel, 'validation agent');
    assert.ok(Math.abs(shown.position.x - rollout.position.x) < 700 && Math.abs(shown.position.y - rollout.position.y) < 400, JSON.stringify([shown.position, hidden.position]));
    assert.deepEqual((await f.listed()).map(view => [view.agentHidden, view.agentHideable]), [[undefined, true]]);
    assert.deepEqual(await f.run({ operation: 'hide', validationId: 'V1' }), { agentNodeId, hidden: true });
    assert.match((await f.node(agentNodeId)).hiddenAt!, /^\d{4}-/);
    assert.ok(!f.calls.includes('sessions.stop'), 'hiding never stops the session');
  } finally { f.close(); }
});

test('one click asks an idle hidden validation agent of this rollout again, else starts a hidden one', async () => {
  const f = await fixture();
  try {
    const first = await f.validate() as any;
    assert.deepEqual([first.validationId, f.launches.length], ['V1', 1]);
    await f.run({ operation: 'report', agentNodeId: first.agentNodeId, validationId: 'V1', sequence: 1, ...FINAL });
    await f.apply([{ type: 'node.update', id: first.agentNodeId, activity: 'idle' }]);
    const again = await f.validate() as any;
    assert.deepEqual([again.validationId, again.sent, f.launches.length], ['V2', true, 1]);
    assert.equal((await f.listed()).at(-1).agentNodeId, first.agentNodeId);
    const pasted = String((f.inputs[0] as { data: string }).data);
    assert.match(pasted, /This is validation V2/); assert.match(pasted, /You lead this validation/); assert.doesNotMatch(pasted, /Do not do this in your own turn/);
    // One that works, or that a person put on the map, is not taken: a new hidden one starts.
    await f.apply([{ type: 'node.update', id: first.agentNodeId, activity: 'working' }]);
    const busy = await f.validate() as any;
    assert.equal(f.launches.length, 2); assert.notEqual(busy.agentNodeId, first.agentNodeId);
    await f.run({ operation: 'report', agentNodeId: busy.agentNodeId, validationId: busy.validationId, sequence: 1, ...FINAL });
    await f.apply([{ type: 'node.update', id: busy.agentNodeId, activity: 'idle' }]);
    await f.run({ operation: 'show', validationId: busy.validationId });
    await f.validate();
    assert.equal(f.launches.length, 3);
  } finally { f.close(); }
});

test('a hidden validation agent idle at its prompt is archived once its validations settled and the grace ran out; a shown one never is', async () => {
  const f = await fixture();
  try {
    const { agentNodeId } = await f.start() as any, archived = async () => Boolean((await f.node(agentNodeId)).archivedAt);
    const pass = async (ms = 0) => { f.tick(ms); await f.validations.reconcile(); };
    await f.apply([{ type: 'node.update', id: agentNodeId, activity: 'working' }]);
    await pass(HIDDEN_AGENT_IDLE_MS);
    assert.equal(await archived(), false, 'a working agent with an open validation is kept');
    await f.run({ operation: 'report', agentNodeId, validationId: 'V1', sequence: 1, ...FINAL });
    await f.apply([{ type: 'node.update', id: agentNodeId, activity: 'idle' }]);
    await pass(); await pass(HIDDEN_AGENT_IDLE_MS - 60_000);
    assert.equal(await archived(), false, 'within the grace');
    await f.run({ operation: 'report', agentNodeId, validationId: 'V1', sequence: 2, ...FINAL, phase: 'followup' });
    await pass(HIDDEN_AGENT_IDLE_MS - 60_000);
    assert.equal(await archived(), false, 'a follow-up starts the grace again');
    await f.apply([{ type: 'node.update', id: agentNodeId, beside: 1 }]);
    await pass(2 * 60_000);
    assert.equal(await archived(), false, 'background work keeps it');
    await f.apply([{ type: 'node.update', id: agentNodeId, beside: 0 }]);
    await pass(); await pass(HIDDEN_AGENT_IDLE_MS);
    assert.equal(await archived(), true);
    assert.deepEqual((await f.listed()).map(view => [view.label, view.verdict, view.agentHidden]), [['V1', 'passed', true]]);
    // Show brings it back from the archive; on the map it stays however long it idles, until it is hidden again.
    await f.run({ operation: 'show', validationId: 'V1' });
    assert.deepEqual([(await f.node(agentNodeId)).archivedAt, (await f.node(agentNodeId)).hiddenAt], [undefined, undefined]);
    await pass(); await pass(2 * HIDDEN_AGENT_IDLE_MS);
    assert.equal(await archived(), false);
    await f.run({ operation: 'hide', validationId: 'V1' });
    await pass(); await pass(HIDDEN_AGENT_IDLE_MS - 60_000);
    assert.equal(await archived(), false, 'hiding starts the grace');
    await pass(60_000);
    assert.equal(await archived(), true);
  } finally { f.close(); }
});
