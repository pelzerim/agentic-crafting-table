import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from './sqlite-store.ts';
import { WorkspaceControl } from '../core/control.ts';
import type { WorkspaceCommand } from '../core/control.ts';
import type { ResourceCoordinator } from './resources.ts';
import type { SessionCoordinator } from './sessions.ts';
import { connectedAgents, RolloutValidations } from './rollout-validation.ts';
import { discoveredLinkId } from './resources.ts';
import { rolloutDiscoveryKey } from '../provider-runtime/github-status.ts';
import type { RolloutObservation } from '../provider-runtime/github-rollout.ts';
import { parseStageRules } from '../../src/resource-plugins/items/github-rollout/stages.ts';
import type { StageRule } from '../../src/resource-plugins/items/github-rollout/stages.ts';

const STAGED = parseStageRules(JSON.stringify([{ id: 'web-release', workflow: '^web\\s*/\\s*release$', stages: [
  { key: 'preview', environment: 'preview' }, { key: 'live', environment: 'live' }, { key: 'settle', environment: 'live', delayMinutes: 10 }] }]));

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'craft-rollout-validation-')), store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  const apply = async (commands: WorkspaceCommand[]) => control.dispatch({ commandId: randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'test' }, commands });
  const agent = (id: string, x: number) => ({ type: 'item.add' as const, id, resourceId: `${id}-r`, pluginId: 'agent.session', title: `Agent ${id}`, position: { x, y: 600 }, data: { provider: 'claude', sessionId: `${id}-session` } });
  await apply([
    { type: 'item.add', id: 'rollout', resourceId: 'rollout-r', pluginId: 'github.rollout', title: 'App / Deploy', position: { x: 0, y: 0 }, data: { owner: 'acme', repo: 'app', runId: 101 } },
    { type: 'item.add', id: 'ticket', resourceId: 'ticket-r', pluginId: 'workspace.note', title: 'Ticket', position: { x: 400, y: 0 }, data: { text: 'Ship the reading list' } },
    agent('direct', 0), agent('indirect', 400), agent('busy', 800), agent('below', 1200),
    { type: 'link.save', link: { id: 'rollout-direct', sourceId: 'rollout', targetId: 'direct', kind: 'context', label: '' } },
    { type: 'link.save', link: { id: 'ticket-rollout', sourceId: 'ticket', targetId: 'rollout', kind: 'reference', label: '' } },
    { type: 'link.save', link: { id: 'ticket-indirect', sourceId: 'ticket', targetId: 'indirect', kind: 'context', label: '' } },
    { type: 'link.save', link: { id: 'ticket-busy', sourceId: 'ticket', targetId: 'busy', kind: 'context', label: '' } },
    { type: 'link.save', link: { id: 'ticket-below', sourceId: 'ticket', targetId: 'below', kind: 'context', label: '' } },
    ...['direct', 'indirect', 'below'].map(id => ({ type: 'node.update' as const, id, activity: 'idle' as const })), { type: 'node.update', id: 'busy', activity: 'working' },
    { type: 'node.below', id: 'below' },
  ]);
  const inputs: { sessionId: string; data: string }[] = [];
  const terminals = new Map<string, { state: string; lastSequence: number; decisiveInputAt?: number; decisiveInputSequence?: number }>();
  const sessions = { runtime: { async call(method: string, input: { sessionId: string; data: string }) {
    if (method === 'sessions.input') { inputs.push(input); return {}; }
    const terminal = terminals.get(input.sessionId);
    if (terminal) { const { lastSequence, ...session } = terminal; return { session, chunks: [], firstSequence: 0, lastSequence, truncated: false }; }
    return { session: { state: 'running', native: { status: 'idle' } } };
  } } } as unknown as SessionCoordinator;
  const job = (id: number, name: string, status: string, conclusion: string | null) => ({ id, run_id: 101, name, status, conclusion, started_at: '2026-09-30T13:00:00Z', completed_at: status === 'completed' ? '2026-09-30T13:05:00Z' : null });
  const observation: RolloutObservation = { workflow: 'App / Deploy', url: 'https://github.com/acme/app/actions/runs/101', followsLatest: false, gates: [],
    run: { id: 101, name: 'App / Deploy', display_title: 'Ship', run_number: 28, run_attempt: 1, workflow_id: 9, head_branch: 'main', head_sha: 'a'.repeat(40), status: 'in_progress', conclusion: null, updated_at: '2026-09-30T13:00:00Z', repository: { full_name: 'acme/app' } },
    jobs: [job(201, 'deploy / env-a', 'completed', 'success'), job(202, 'deploy / env-b', 'in_progress', null)] };
  let presented = 0, held: Promise<void> | undefined;
  const reads: { nodeId: string; actionId: string; input: object }[] = [], files = ['services/api/billing/invoices.ts', 'services/api/billing/export.ts'];
  const shipped = { since: { runId: 95, commit: 'c'.repeat(40), url: 'https://github.com/acme/app/actions/runs/95' }, commits: 3, truncated: true,
    pulls: [{ number: 32, title: 'Export invoices as CSV', url: 'https://github.com/acme/app/pull/32' }, { number: 28, title: 'Batch billing exports', url: 'https://github.com/acme/app/pull/28' }] };
  const resources = { async context() { return { resourceId: 'rollout-r', title: 'App / Deploy', sourceUrl: 'https://github.com/acme/app/actions/runs/101', content: 'App / Deploy\nPassed · 3/3 jobs finished' }; },
    async cached(nodeId: string) { return nodeId === 'pr' ? { detail: { pull: { head: { sha: 'c'.repeat(40) }, base: { sha: 'b'.repeat(40) } } } } : { detail: observation }; },
    async content(nodeId: string, actionId: string, input: object) { reads.push({ nodeId, actionId, input });
      return { content: actionId === 'rollout.shipped' ? shipped : { files: files.map(filename => ({ filename })) } }; },
    async refreshPresentation() { presented++; await held; } } as unknown as ResourceCoordinator;
  let now = Date.parse('2026-09-30T13:10:00Z'), broadcasts = 0, rules: readonly StageRule[] = STAGED;
  const create = () => new RolloutValidations(store, control, resources, sessions, async () => { broadcasts++; }, { now: () => now, stageRules: () => rules });
  let validations = create();
  const run = (input: object) => validations.run('rollout', input);
  return { control, store, inputs, run, get validations() { return validations; }, terminals, apply, reads, now: () => now, observation, presented: () => presented, broadcasts: () => broadcasts, tick(ms: number) { now += ms; }, stageRules(next: readonly StageRule[]) { rules = next; }, hold(until: Promise<void>) { held = until; },
    async restart() { await validations.close(); validations = create(); }, close() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('connected agents include indirect ones with their path, but never Undermap items', async () => {
  const f = await fixture();
  try {
    const agents = connectedAgents(await f.control.read(), 'rollout');
    assert.deepEqual(agents.map(agent => [agent.nodeId, agent.direct]), [['direct', true], ['indirect', false], ['busy', false]]);
    assert.deepEqual(agents[1].path, { nodes: ['rollout', 'ticket', 'indirect'], links: ['ticket-rollout', 'ticket-indirect'] });
  } finally { f.close(); }
});

test('validation options mark busy agents; triggering links an indirect agent once and prompts it with the rollout context', async () => {
  const f = await fixture();
  try {
    const options = await f.run({ operation: 'options' }) as any;
    assert.deepEqual(options.options.map((option: any) => [option.id, Boolean(option.disabled)]), [['direct', false], ['indirect', false], ['busy', true], ['new-agent', true]]);
    assert.deepEqual(options.options[1].highlight.links, ['ticket-rollout', 'ticket-indirect']);
    await assert.rejects(f.run({ operation: 'trigger', ...options.context, value: 'busy', requestId: randomUUID() }), /ready/);
    await assert.rejects(f.run({ operation: 'trigger', ...options.context, value: 'below', requestId: randomUUID() }), /connected/);
    const requestId = randomUUID();
    assert.deepEqual(await f.run({ operation: 'trigger', ...options.context, value: 'indirect', requestId }), { sent: true, linked: true, validationId: 'V1' });
    const state = await f.control.read();
    assert.deepEqual(state.links.filter(link => link.sourceId === 'rollout' && link.targetId === 'indirect').map(link => [link.kind, link.label, link.reveal]), [['context', 'Validation', 'hover']]);
    assert.equal(f.inputs.length, 2); assert.equal(f.inputs[0].sessionId, 'indirect-session');
    assert.match(f.inputs[0].data, /^I asked for this from the Agentic Crafting Table\. Check the rollout as the pasted request describes: \x1b\[200~/);
    assert.match(f.inputs[0].data, /Check whether this rollout works as intended/);
    assert.match(f.inputs[0].data, /Hand this whole validation to one lead subagent running in the background/);
    assert.match(f.inputs[0].data, /The lead may fan out: it starts one subagent per data source/);
    assert.match(f.inputs[0].data, /Only the lead sends the reports, with workspace_report_validation/); assert.match(f.inputs[0].data, /Passed · 3\/3 jobs finished/);
    assert.doesNotMatch(f.inputs[0].data, /ONE background subagent|one subagent running in the background/);
    assert.match(f.inputs[0].data, /send a "followup" report for the same validationId with a higher sequence/);
    assert.match(f.inputs[0].data, /This is validation V1 for run 101, attempt 1, commit aaaaaaaaaaaa, focus: whole run\./);
    assert.match(f.inputs[0].data, /workspace_report_validation \(rolloutNodeId "rollout", validationId "V1"\)/);
    assert.doesNotMatch(f.inputs[0].data, /attention\.set/);
    assert.match(f.inputs[0].data, /Do not approve, rerun, cancel or change deployments/);
    assert.match(f.inputs[0].data, /as long as the rollout takes/);
    assert.match(f.inputs[0].data, /at least every 2 minutes/);
    assert.match(f.inputs[0].data, /summary: one sentence with the verdict and why, then at most two more/); assert.match(f.inputs[0].data, /observation: one or two sentences, then any details as "- " bullet lines/);
    assert.match(f.inputs[0].data, /never sleep longer than 30 seconds in one command/);
    assert.doesNotMatch(f.inputs[0].data, /at most 8 minutes|Be quick/);
    assert.match(f.inputs[0].data, /Send a first report with an interim verdict within 2 minutes from what is checkable now; list checks that need a settled window as pending with the earliest time; then update\./);
    assert.doesNotMatch(f.inputs[0].data, /as soon as everything that matters is checked/);
    assert.deepEqual(await f.run({ operation: 'trigger', ...options.context, value: 'indirect', requestId }), { sent: true, linked: true, validationId: 'V1' });
    assert.equal(f.inputs.length, 2, 'a replayed request never sends again');
    assert.equal((await f.control.read()).links.length, state.links.length, 'nor adds another link');
    assert.deepEqual(await f.run({ operation: 'trigger', ...options.context, value: 'direct', requestId: randomUUID() }), { sent: true, linked: false, validationId: 'V2' });
  } finally { f.close(); }
});

test('a trigger for an approval phase scopes the validation to it: the phase is its focus, its jobs are in the scope and the prompt names them', async () => {
  const f = await fixture();
  try {
    const options = await f.run({ operation: 'options' }) as any;
    await f.run({ operation: 'trigger', ...options.context, value: 'direct', requestId: randomUUID(), phase: { focus: 'before env-b (deploy / env-b)', jobs: [201] } });
    const view = ((await f.run({ operation: 'list' }) as any).validations as any[])[0];
    assert.deepEqual([view.label, view.scope.focus, view.scope.jobs, view.scope.stage], ['V1', 'before env-b (deploy / env-b)', [201], undefined]);
    assert.match(f.inputs[0].data, /This is validation V1 for run 101, attempt 1, commit aaaaaaaaaaaa, focus: before env-b \(deploy \/ env-b\)\./);
    assert.match(f.inputs[0].data, /one validation per approval phase of this rollout.*This one covers before env-b \(deploy \/ env-b\): judge what these jobs deployed: deploy \/ env-a\./);
    assert.match(f.inputs[0].data, /Earlier phases were validated separately and stay final on the table/);
  } finally { f.close(); }
});

const report = (validationId: string, sequence: number, extra: object = {}) => ({ operation: 'report', validationId, sequence, phase: 'progress', summary: 'Checking', checks: [{ id: 'C1', title: 'Error rate', status: 'pending' }], ...extra });
const final = (verdict: string) => ({ phase: 'final', verdict, summary: `Release ${verdict}`, checks: [{ id: 'C1', title: 'Error rate', status: verdict === 'passed' ? 'passed' : 'concern' }] });
const attention = async (f: Awaited<ReturnType<typeof fixture>>) => { const node = (await f.control.read()).nodes.find(node => node.id === 'rollout')!; return { sources: node.attentionSources ?? {}, events: node.attentionEvents ?? {}, notes: node.attentionNotes ?? {} }; };

test('only the requested agent can report its validation; sequences are idempotent, final is locked and scope narrows to the attempt', async () => {
  const f = await fixture();
  try {
    const options = await f.run({ operation: 'options' }) as any;
    await f.run({ operation: 'trigger', ...options.context, value: 'direct', requestId: randomUUID() });
    await assert.rejects(f.run({ ...report('V1', 1), agentNodeId: 'indirect' }), /requested from another agent/);
    const first = await f.run({ ...report('V1', 2, { scope: { jobs: [202, 999] } }), agentNodeId: 'direct' }) as any;
    assert.equal(first.state, 'running'); assert.deepEqual(first.warnings, ['dropped job 999: not in the validated attempt']);
    assert.equal((await f.run({ ...report('V1', 1), agentNodeId: 'direct' }) as any).ignored, true, 'an older sequence is ignored');
    await assert.rejects(f.run({ ...report('V1', 3, { phase: 'final' }), agentNodeId: 'direct' }), /needs a verdict/);
    const done = await f.run({ ...report('V1', 3, final('concerns')), agentNodeId: 'direct' }) as any;
    assert.deepEqual([done.state, done.stale, done.accepted], ['final', false, { checks: 1, evidence: 0 }]);
    await assert.rejects(f.run({ ...report('V1', 4, final('passed')), agentNodeId: 'direct' }), /already final\. Send phase "followup"/);
    const list = await f.run({ operation: 'list' }) as any;
    assert.deepEqual(list.validations.map((view: any) => [view.label, view.verdict, view.scope.jobs, view.reports, view.agent.title]), [['V1', 'concerns', [202], 2, 'Agent direct']]);
    await assert.rejects(f.run({ operation: 'report', validationId: 'V1', sequence: 1, phase: 'progress', checks: [] }), /agent/);
  } finally { f.close(); }
});

test('a current concerns verdict raises Needs me with the validation reason; a later pass withdraws it, a failed one raises error and a new attempt makes it stale', async () => {
  const f = await fixture();
  try {
    const options = await f.run({ operation: 'options' }) as any;
    await f.run({ operation: 'trigger', ...options.context, value: 'direct', requestId: randomUUID() });
    await f.run({ ...report('V1', 1, final('concerns')), agentNodeId: 'direct' });
    assert.deepEqual(await attention(f), { sources: { 'validation:direct': 'validation' }, events: { 'validation:direct': `${(await f.run({ operation: 'list' }) as any).validations[0].id}:concerns` }, notes: { 'validation:direct': 'Validation found concerns' } });
    assert.ok(f.presented() > 0, 'the map card is repainted');
    await f.run({ operation: 'trigger', ...options.context, value: 'indirect', requestId: randomUUID() });
    await f.run({ ...report('V2', 1, final('passed')), agentNodeId: 'indirect' });
    assert.deepEqual((await attention(f)).sources, {}, 'a later pass on the same scope withdraws it without marking it seen');
    await f.run({ operation: 'trigger', ...options.context, value: 'direct', requestId: randomUUID() });
    await f.run({ ...report('V3', 1, final('failed')), agentNodeId: 'direct' });
    assert.deepEqual((await attention(f)).sources, { 'validation:direct': 'error' }); assert.deepEqual((await attention(f)).notes, { 'validation:direct': 'Validation failed' });
    f.observation.run = { ...f.observation.run!, run_attempt: 2 }; f.observation.jobs = f.observation.jobs.map(job => ({ ...job, id: job.id + 100 }));
    await f.validations.reconcile();
    assert.deepEqual((await attention(f)).sources, {}, 'stale withdraws it');
    const list = await f.run({ operation: 'list' }) as any;
    assert.deepEqual(list.validations.map((view: any) => view.stale), [true, true, true]);
    assert.deepEqual(list.events.filter((event: any) => event.kind === 'attempt-started').map((event: any) => event.attempt), [1, 2]);
    assert.equal(list.events.filter((event: any) => event.kind === 'jobs-snapshot' && event.attempt === 1).length, 1, 'attempt 1 keeps its jobs');
  } finally { f.close(); }
});

test('a requested validation becomes No report after its agent stays idle, accepts a late final report, and Ask to report prompts the agent again', async () => {
  const f = await fixture();
  try {
    const options = await f.run({ operation: 'options' }) as any;
    await f.run({ operation: 'trigger', ...options.context, value: 'direct', requestId: randomUUID() });
    await f.validations.reconcile(); f.tick(60_000); await f.validations.reconcile();
    assert.equal((await f.run({ operation: 'list' }) as any).validations[0].state, 'requested');
    await assert.rejects(f.run({ operation: 'ask', validationId: 'V1', requestId: randomUUID() }), /still/);
    f.tick(61_000); await f.validations.reconcile();
    assert.equal((await f.run({ operation: 'list' }) as any).validations[0].state, 'no-report');
    const requestId = randomUUID(), sent = f.inputs.length;
    assert.deepEqual(await f.run({ operation: 'ask', validationId: 'V1', requestId }), { sent: true, validationId: 'V1' });
    assert.equal(f.inputs.length, sent + 2); assert.match(f.inputs[sent].data, /validation V1/); assert.match(f.inputs[sent].data, /workspace_report_validation/);
    await f.run({ operation: 'ask', validationId: 'V1', requestId }); assert.equal(f.inputs.length, sent + 2, 'a replayed ask never sends twice');
    assert.equal((await f.run({ operation: 'list' }) as any).validations[0].state, 'requested');
    f.tick(121_000); await f.validations.reconcile(); f.tick(121_000); await f.validations.reconcile();
    assert.equal((await f.run({ operation: 'list' }) as any).validations[0].state, 'no-report');
    assert.equal((await f.run({ ...report('V1', 1, final('passed')), agentNodeId: 'direct' }) as any).state, 'final', 'a late final report is still accepted');
  } finally { f.close(); }
});

test('an agent sitting at Claude\'s idle prompt has not reported: its validation becomes No report two minutes after it went idle, while one at a permission prompt keeps running', async () => {
  const f = await fixture();
  try {
    await f.run({ operation: 'trigger', sourceResourceId: 'rollout-r', value: 'direct', requestId: randomUUID() });
    await f.run({ operation: 'trigger', sourceResourceId: 'rollout-r', value: 'indirect', requestId: randomUUID() });
    await f.run({ ...report('V1', 1), agentNodeId: 'direct' }); await f.run({ ...report('V2', 1), agentNodeId: 'indirect' });
    const waiting = { activity: 'idle' as const, attention: 'input' as const, summary: 'Waiting for your input' };
    await f.apply([{ type: 'node.update', id: 'direct', ...waiting, attentionNote: 'Agent waiting' }, { type: 'node.update', id: 'indirect', ...waiting, attentionNote: 'Agent needs permission' }]);
    f.store.observeAgent('direct-session', f.now(), 'Notification:idle_prompt'); f.store.observeAgent('indirect-session', f.now(), 'Notification:permission_prompt');
    const states = async () => ((await f.run({ operation: 'list' }) as any).validations as any[]).map(view => view.state);
    await f.validations.reconcile(); f.tick(119_000); await f.validations.reconcile();
    assert.deepEqual(await states(), ['running', 'running']);
    f.tick(1_000); await f.validations.reconcile();
    assert.deepEqual(await states(), ['no-report', 'running'], 'a permission prompt waits on the person, not on the agent');
  } finally { f.close(); }
});

test('the idle clock starts when the agent reached its idle prompt, so a validation already abandoned before a restart ends on the first pass', async () => {
  const f = await fixture();
  try {
    await f.run({ operation: 'trigger', sourceResourceId: 'rollout-r', value: 'direct', requestId: randomUUID() });
    await f.apply([{ type: 'node.update', id: 'direct', activity: 'working' }]);
    await f.run({ ...report('V1', 1), agentNodeId: 'direct' });
    f.tick(60_000); f.store.observeAgent('direct-session', f.now(), 'Notification:idle_prompt');
    await f.apply([{ type: 'node.update', id: 'direct', activity: 'idle', attention: 'input', attentionNote: 'Agent waiting', summary: 'Waiting for your input' }]);
    f.tick(5 * 60_000); await f.validations.reconcile();
    assert.equal((await f.run({ operation: 'list' }) as any).validations[0].state, 'no-report');
  } finally { f.close(); }
});

test('a validation without any report for 15 minutes becomes No report even while its agent looks busy, and a late report is still accepted', async () => {
  const f = await fixture();
  try {
    await f.run({ operation: 'trigger', sourceResourceId: 'rollout-r', value: 'direct', requestId: randomUUID() });
    await f.apply([{ type: 'node.update', id: 'direct', activity: 'working' }]);
    await f.run({ ...report('V1', 1), agentNodeId: 'direct' });
    f.tick(14 * 60_000); await f.validations.reconcile();
    await f.run({ ...report('V1', 2), agentNodeId: 'direct' });
    f.tick(14 * 60_000); await f.validations.reconcile();
    assert.equal((await f.run({ operation: 'list' }) as any).validations[0].state, 'running', 'each report restarts the clock');
    f.tick(60_000); await f.validations.reconcile();
    assert.equal((await f.run({ operation: 'list' }) as any).validations[0].state, 'no-report');
    assert.equal((await f.run({ ...report('V1', 3, final('passed')), agentNodeId: 'direct' }) as any).state, 'final');
  } finally { f.close(); }
});

test('a newer validation of the same attempt that turns final ends an older one still open, which shows as resolved by it', async () => {
  const f = await fixture();
  try {
    await f.apply([{ type: 'node.update', id: 'direct', activity: 'working' }]);
    await f.run({ operation: 'trigger', sourceResourceId: 'rollout-r', value: 'indirect', requestId: randomUUID() });
    await f.run({ ...report('V1', 1), agentNodeId: 'indirect' });
    await f.apply([{ type: 'node.update', id: 'indirect', activity: 'working' }, { type: 'node.update', id: 'direct', activity: 'idle' }]);
    await f.run({ operation: 'trigger', sourceResourceId: 'rollout-r', value: 'direct', requestId: randomUUID() });
    await f.run({ ...report('V2', 1, final('passed')), agentNodeId: 'direct' });
    const list = await f.run({ operation: 'list' }) as any;
    assert.deepEqual(list.validations.map((view: any) => [view.label, view.state, view.resolvedBy ?? '', view.current]), [['V1', 'no-report', 'V2', false], ['V2', 'final', '', true]]);
    await assert.rejects(f.run({ operation: 'ask', validationId: 'V1', requestId: randomUUID() }), /V2/, 'nothing to ask for once a newer validation answered');
  } finally { f.close(); }
});

test('rows left running by an agent that stopped reporting, beside a newer final one, are repaired by the first pass after a restart', async () => {
  const f = await fixture();
  try {
    const old = f.now() - 60 * 60_000, scope = { runId: 101, attempt: 1, headSha: 'a'.repeat(40), focus: 'whole run' }, agent = { title: 'Validate · Rollout', provider: 'claude' };
    const stuck = f.store.createRolloutValidation({ id: randomUUID(), rolloutResourceId: 'rollout-r', agentNodeId: 'direct', agent, requestId: randomUUID(), scope, requestedAt: old });
    f.store.updateRolloutValidation(stuck.id, 0, { state: 'running', sequence: 2, reports: 2, startedAt: old + 60_000, report: { summary: 'Still queued', checks: [{ id: 'C1', title: 'Intent', status: 'passed' }], recommendations: [] } }, old + 3 * 60_000);
    const done = f.store.createRolloutValidation({ id: randomUUID(), rolloutResourceId: 'rollout-r', agentNodeId: 'indirect', agent, requestId: randomUUID(), scope, requestedAt: old + 10 * 60_000 });
    f.store.updateRolloutValidation(done.id, 0, { state: 'final', verdict: 'passed', sequence: 4, reports: 4, finishedAt: old + 20 * 60_000, report: { summary: 'Passed', verdict: 'passed', checks: [{ id: 'C1', title: 'Intent', status: 'passed' }], recommendations: [] } }, old + 20 * 60_000);
    const lone = f.store.createRolloutValidation({ id: randomUUID(), rolloutResourceId: 'rollout-r', agentNodeId: 'direct', agent, requestId: randomUUID(), scope, requestedAt: old + 30 * 60_000 });
    f.store.updateRolloutValidation(lone.id, 0, { state: 'running', sequence: 2, reports: 2, report: { summary: 'Waiting for the window', checks: [{ id: 'C1', title: 'Image', status: 'running' }], recommendations: [] } }, old + 32 * 60_000);
    await f.apply([{ type: 'node.update', id: 'direct', activity: 'idle', attention: 'input', attentionNote: 'Agent waiting', summary: 'Waiting for your input' }]);
    f.store.observeAgent('direct-session', old + 34 * 60_000, 'Notification:idle_prompt');
    f.validations.start(); await f.validations.close();
    const list = await f.run({ operation: 'list' }) as any;
    assert.deepEqual(list.validations.map((view: any) => [view.label, view.state, view.resolvedBy ?? '']), [['V1', 'no-report', 'V2'], ['V2', 'final', ''], ['V3', 'no-report', '']]);
  } finally { f.close(); }
});

test('listing validations returns what is stored without waiting for a reconcile pass in progress', async () => {
  const f = await fixture();
  try {
    await f.run({ operation: 'trigger', sourceResourceId: 'rollout-r', value: 'direct', requestId: randomUUID() });
    let release!: () => void;
    f.hold(new Promise<void>(resolve => { release = resolve; }));
    const pass = f.validations.reconcile();
    const listed = await Promise.race([f.run({ operation: 'list' }), new Promise(resolve => setTimeout(() => resolve('waited'), 500))]) as any;
    release(); await pass;
    assert.notEqual(listed, 'waited'); assert.deepEqual(listed.validations.map((view: any) => view.label), ['V1']);
  } finally { f.close(); }
});

test('an agent stuck on an answered permission prompt can be validated after the person\'s answer and a quiet terminal', async () => {
  const f = await fixture();
  try {
    await f.apply([{ type: 'node.update', id: 'direct', activity: 'idle', attention: 'input', attentionNote: 'Agent needs permission', summary: 'Waiting for your input' }]);
    const terminal: NonNullable<ReturnType<typeof f.terminals.get>> = { state: 'running', lastSequence: 40 };
    f.terminals.set('direct-session', terminal);
    f.store.observeAgent('direct-session', f.now(), 'Notification:permission_prompt');
    const ready = async () => !(await f.run({ operation: 'options' }) as any).options.find((option: any) => option.id === 'direct').disabled;
    assert.equal(await ready(), false);
    f.tick(60_000); assert.equal(await ready(), false, 'a quiet terminal may still show the dialog');
    await assert.rejects(f.run({ operation: 'trigger', sourceResourceId: 'rollout-r', value: 'direct', requestId: randomUUID() }), /Answer the prompt/);
    f.tick(1_000); terminal.decisiveInputAt = f.now(); terminal.decisiveInputSequence = 40; terminal.lastSequence = 44;
    assert.equal(await ready(), false, 'the command is still printing');
    f.tick(19_999); assert.equal(await ready(), false);
    f.tick(1); assert.equal(await ready(), true);
    assert.deepEqual(await f.run({ operation: 'trigger', sourceResourceId: 'rollout-r', value: 'direct', requestId: randomUUID() }), { sent: true, linked: false, validationId: 'V1' });
    assert.deepEqual(f.inputs.map(input => input.sessionId), ['direct-session', 'direct-session']);
    assert.ok(f.inputs.every(input => !('source' in input)), 'a delivered prompt is not the person\'s input');
  } finally { f.close(); }
});

test('the validation picker says why an agent cannot take a prompt', async () => {
  const f = await fixture();
  try {
    await f.apply([{ type: 'node.update', id: 'indirect', activity: 'idle', attention: 'input', attentionNote: 'Agent needs permission', summary: 'Waiting for your input' }]);
    f.terminals.set('indirect-session', { state: 'running', lastSequence: 1 });
    f.store.observeAgent('indirect-session', f.now(), 'Notification:permission_prompt');
    const descriptions = async () => Object.fromEntries((await f.run({ operation: 'options' }) as any).options.slice(0, -1).map((option: any) => [option.id, option.description]));
    assert.deepEqual(await descriptions(), {
      direct: 'Ready · connected',
      indirect: 'Waiting for you to answer a prompt in its terminal · connected through another item; a direct connection will be added',
      busy: 'Working · connected through another item; a direct connection will be added',
    });
    f.terminals.set('busy-session', { state: 'exited', lastSequence: 1 });
    assert.equal((await descriptions()).busy, 'Stopped · connected through another item; a direct connection will be added');
    for (const [value, reason] of [['indirect', /Answer the prompt in the agent's terminal first/], ['busy', /stopped\. Resume it/]] as const)
      await assert.rejects(f.run({ operation: 'trigger', sourceResourceId: 'rollout-r', value, requestId: randomUUID() }), reason);
    f.terminals.delete('busy-session');
    await assert.rejects(f.run({ operation: 'trigger', sourceResourceId: 'rollout-r', value: 'busy', requestId: randomUUID() }), /Wait until the agent is ready for a new prompt/);
  } finally { f.close(); }
});

test('whatever the service stores for a rollout advances the workspace cursor and is announced, so an open view follows at once', async () => {
  const f = await fixture();
  try {
    const cursor = async () => (await f.store.snapshot()).cursor;
    await f.validations.reconcile();
    let before = await cursor(), announced = f.broadcasts();
    await f.validations.reconcile();
    assert.deepEqual([await cursor(), f.broadcasts()], [before, announced], 'an unchanged rollout announces nothing');
    await f.run({ operation: 'trigger', sourceResourceId: 'rollout-r', value: 'direct', requestId: randomUUID() });
    before = await cursor(); announced = f.broadcasts();
    await f.run({ ...report('V1', 1), agentNodeId: 'direct' });
    assert.ok(await cursor() > before, 'a progress report'); assert.ok(f.broadcasts() > announced);
    before = await cursor();
    assert.equal((await f.run({ ...report('V1', 1), agentNodeId: 'direct' }) as any).ignored, true);
    assert.equal(await cursor(), before, 'an ignored report stores nothing');
    await f.validations.reconcile(); f.tick(121_000);
    before = await cursor(); announced = f.broadcasts();
    await f.validations.reconcile();
    assert.equal((await f.run({ operation: 'list' }) as any).validations[0].state, 'no-report');
    assert.ok(await cursor() > before, 'a validation that went without a report'); assert.ok(f.broadcasts() > announced);
    f.observation.jobs = f.observation.jobs.map(job => ({ ...job, status: 'completed', conclusion: 'success', completed_at: '2026-09-30T13:09:00Z' })); f.observation.run = { ...f.observation.run!, status: 'completed', conclusion: 'success' };
    before = await cursor(); announced = f.broadcasts();
    await f.validations.reconcile();
    assert.ok(await cursor() > before, 'a recorded rollout event'); assert.ok(f.broadcasts() > announced);
  } finally { f.close(); }
});

/** A merged pull request that discovered the fixture's rollout, with its own agent. */
const merged = (f: Awaited<ReturnType<typeof fixture>>, data: object = {}) => f.apply([
  { type: 'item.add', id: 'pr', resourceId: 'pr-r', pluginId: 'github.pull-request', title: 'Ship the reading list', position: { x: 0, y: 300 }, data: { owner: 'acme', repo: 'app', number: 42, ...data } },
  { type: 'link.save', link: { id: discoveredLinkId('pr-r', rolloutDiscoveryKey(101)), sourceId: 'pr', targetId: 'rollout', kind: 'reference', label: '' } },
  { type: 'item.add', id: 'author', resourceId: 'author-r', pluginId: 'agent.session', title: 'Agent author', position: { x: 0, y: 900 }, data: { provider: 'claude', sessionId: 'author-session' } },
  { type: 'link.save', link: { id: 'pr-author', sourceId: 'pr', targetId: 'author', kind: 'context', label: '' } },
  { type: 'node.update', id: 'author', activity: 'idle' },
]);
const listed = async (f: Awaited<ReturnType<typeof fixture>>) => ((await f.run({ operation: 'list' }) as any).validations as any[]).map(view => [view.label, view.agentNodeId, view.scope.attempt, view.automatic === true]);

test('Auto validate without a starter: a rollout a pull request discovered is validated once per attempt, by a ready agent connected through that pull request', async () => {
  const f = await fixture();
  try {
    await merged(f);
    await f.validations.reconcile();
    assert.deepEqual(await listed(f), [['V1', 'author', 1, true]]);
    assert.deepEqual(f.inputs.map(input => input.sessionId), ['author-session', 'author-session']);
    assert.match(f.inputs[0].data, /This is validation V1 for run 101, attempt 1, commit aaaaaaaaaaaa, focus: whole run\./);
    assert.match(f.inputs[0].data, /workspace_report_validation \(rolloutNodeId "rollout", validationId "V1"\)/);
    const state = await f.control.read();
    assert.ok(state.links.some(link => link.sourceId === 'rollout' && link.targetId === 'author' && link.kind === 'context'), 'the direct connection is added as for a manual trigger');
    const jobs = f.store.listJobs().filter(job => job.requestKey.startsWith('rollout-validation:'));
    assert.deepEqual(jobs.map(job => [job.state, job.input.action, job.input.nodeId, job.input.arguments.value]), [['succeeded', 'rollout.validation', 'rollout', 'author']]);
    assert.ok(f.broadcasts() > 0);
    await f.validations.reconcile(); f.tick(20_000); await f.validations.reconcile();
    assert.equal(f.inputs.length, 2, 'never twice for the same attempt');
    await f.run({ ...report('V1', 1, final('passed')), agentNodeId: 'author' });
    await f.validations.reconcile();
    assert.equal(f.inputs.length, 2, 'a finished validation still covers the attempt');
    f.observation.run = { ...f.observation.run!, run_attempt: 2 }; f.observation.jobs = f.observation.jobs.map(job => ({ ...job, id: job.id + 100 }));
    await f.validations.reconcile();
    assert.deepEqual(await listed(f), [['V1', 'author', 1, true], ['V2', 'author', 2, true]]);
    await f.run({ operation: 'trigger', sourceResourceId: 'rollout-r', value: 'direct', requestId: randomUUID() });
    assert.deepEqual((await listed(f)).at(-1), ['V3', 'direct', 2, false], 'a validation a person asked for is not automatic');
  } finally { f.close(); }
});

test('Auto validate without a starter waits for a ready agent on each tick until the run completes, then gives up for that attempt', async () => {
  const f = await fixture();
  try {
    await merged(f);
    await f.apply(['direct', 'indirect', 'author'].map(id => ({ type: 'node.update' as const, id, activity: 'working' as const })));
    await f.validations.reconcile(); await f.validations.reconcile();
    assert.deepEqual(await listed(f), []); assert.equal(f.inputs.length, 0);
    await f.apply([{ type: 'node.update', id: 'indirect', activity: 'idle' }]);
    await f.validations.reconcile();
    assert.deepEqual(await listed(f), [['V1', 'indirect', 1, true]], 'any ready connected agent when none is ready through the pull request');

    f.observation.run = { ...f.observation.run!, run_attempt: 2 }; f.observation.jobs = f.observation.jobs.map(job => ({ ...job, id: job.id + 100 }));
    await f.apply([{ type: 'node.update', id: 'indirect', activity: 'working' }]);
    await f.validations.reconcile();
    f.observation.run = { ...f.observation.run!, status: 'completed', conclusion: 'success' };
    await f.validations.reconcile();
    await f.apply(['direct', 'indirect', 'author'].map(id => ({ type: 'node.update' as const, id, activity: 'idle' as const })));
    await f.validations.reconcile(); f.tick(20_000); await f.validations.reconcile();
    assert.deepEqual(await listed(f), [['V1', 'indirect', 1, true]], 'attempt 2 completed without a ready agent and is left alone');
  } finally { f.close(); }
});

test('Auto validate covers a run first seen already completed, but never a rollout that was known before', async () => {
  const done = await fixture();
  try {
    done.observation.run = { ...done.observation.run!, status: 'completed', conclusion: 'success' };
    await merged(done);
    await done.validations.reconcile();
    assert.deepEqual(await listed(done), [['V1', 'author', 1, true]]);
  } finally { done.close(); }
  const known = await fixture();
  try {
    known.observation.run = { ...known.observation.run!, status: 'completed', conclusion: 'success' };
    await known.validations.reconcile();
    await merged(known);
    await known.validations.reconcile(); await known.validations.reconcile();
    assert.deepEqual(await listed(known), []); assert.equal(known.inputs.length, 0);
  } finally { known.close(); }
});

test('Auto validate stays out when the box is unchecked, a validation already covers the attempt, or the pull request did not discover the rollout', async () => {
  const unchecked = await fixture();
  try {
    await merged(unchecked, { autoValidate: false });
    await unchecked.validations.reconcile();
    assert.deepEqual(await listed(unchecked), []);
    await unchecked.apply([{ type: 'item.update', id: 'pr', data: { owner: 'acme', repo: 'app', number: 42 } }]);
    await unchecked.validations.reconcile();
    assert.deepEqual(await listed(unchecked), [['V1', 'author', 1, true]], 'checking the box again validates a run still in progress');
  } finally { unchecked.close(); }
  const covered = await fixture();
  try {
    await covered.run({ operation: 'trigger', sourceResourceId: 'rollout-r', value: 'direct', requestId: randomUUID() });
    await merged(covered);
    await covered.validations.reconcile();
    assert.deepEqual(await listed(covered), [['V1', 'direct', 1, false]]);
  } finally { covered.close(); }
  const linked = await fixture();
  try {
    await linked.apply([
      { type: 'item.add', id: 'pr', resourceId: 'pr-r', pluginId: 'github.pull-request', title: 'Ship the reading list', position: { x: 0, y: 300 }, data: { owner: 'acme', repo: 'app', number: 42 } },
      { type: 'link.save', link: { id: 'by-hand', sourceId: 'pr', targetId: 'rollout', kind: 'reference', label: '' } },
    ]);
    await linked.validations.reconcile();
    assert.deepEqual(await listed(linked), []);
  } finally { linked.close(); }
});

/** The fixture's rollout as a run of the staged Web / Release workflow: preview and live jobs, each finished at the given time. */
function staged(f: Awaited<ReturnType<typeof fixture>>, preview?: number, live?: number) {
  const step = (id: number, name: string, done?: number) => ({ id, run_id: 101, name, status: done === undefined ? 'in_progress' : 'completed', conclusion: done === undefined ? null : 'success',
    started_at: '2026-09-30T13:00:00Z', completed_at: done === undefined ? null : new Date(done).toISOString() });
  f.observation.workflow = 'Web / Release'; f.observation.run = { ...f.observation.run!, name: 'Web / Release' };
  f.observation.jobs = [step(201, 'preview / ship', preview), step(202, 'live / ship', live)];
}
const stages = async (f: Awaited<ReturnType<typeof fixture>>) => ((await f.run({ operation: 'list' }) as any).validations as any[]).map(view => [view.label, view.scope.stage ?? '', view.state, view.automatic === true]);
const prompts = (f: Awaited<ReturnType<typeof fixture>>) => f.inputs.filter((_, index) => index % 2 === 0).map(input => input.data);
const payloadOf = (prompt: string) => JSON.parse(/Context from the table \(JSON\):\n(\{\n[\s\S]*?\n\})\n/.exec(prompt)![1]);

test('a staged deploy run is validated once per stage: preview done, live done, then 10 minutes after live, each with its own id', async () => {
  const f = await fixture();
  try {
    staged(f); await merged(f);
    await f.validations.reconcile();
    assert.deepEqual(await stages(f), [], 'no whole-run validation when the attempt starts');
    staged(f, f.now() - 60_000);
    await f.validations.reconcile(); await f.validations.reconcile();
    assert.deepEqual(await stages(f), [['V1', 'preview', 'requested', true]]);
    assert.match(prompts(f)[0], /This is validation V1 for run 101, attempt 1, commit aaaaaaaaaaaa, focus: preview\./);
    assert.match(prompts(f)[0], /The table asks for one validation per stage of this rollout/);
    assert.equal(prompts(f).length, 1);

    staged(f, f.now() - 60_000, f.now());
    await f.validations.reconcile();
    assert.deepEqual((await stages(f)).length, 1, 'live waits while the preview validation is still open');
    await f.run({ ...report('V1', 1, final('passed')), agentNodeId: 'author' });
    await f.validations.reconcile();
    assert.deepEqual(await stages(f), [['V1', 'preview', 'final', true], ['V2', 'live', 'requested', true]]);
    assert.match(prompts(f)[1], /validationId "V2"/); assert.match(prompts(f)[1], /focus: live\./);
    assert.deepEqual([payloadOf(prompts(f)[1]).previous.validationId, payloadOf(prompts(f)[1]).previous.verdict, payloadOf(prompts(f)[1]).previous.stage], ['V1', 'passed', 'preview']);
    await f.run({ ...report('V2', 1, final('passed')), agentNodeId: 'author' });

    f.tick(10 * 60_000 - 1_000); await f.validations.reconcile();
    assert.equal((await stages(f)).length, 2, 'not before 10 minutes have passed');
    f.tick(1_000); await f.validations.reconcile(); await f.validations.reconcile();
    assert.deepEqual((await stages(f)).map(row => row.slice(0, 3)), [['V1', 'preview', 'final'], ['V2', 'live', 'final'], ['V3', 'settle', 'requested']]);
    assert.match(prompts(f)[2], /focus: live, 10 minutes after it finished\./);
    assert.equal(prompts(f).length, 3);
    const views = (await f.run({ operation: 'list' }) as any).validations as any[];
    assert.deepEqual(views.map(view => view.scope.environments), [['preview'], ['live'], ['live']]);
    assert.deepEqual(views.map(view => view.scope.label), ['preview done', 'live done', 'live +10 min'], 'the card names each stage from its rule');
  } finally { f.close(); }
});

test('without stage rules a run of the same workflow keeps one whole-run validation per attempt', async () => {
  const f = await fixture();
  try {
    f.stageRules([]); staged(f, f.now() - 60_000); await merged(f);
    await f.validations.reconcile(); await f.validations.reconcile();
    assert.deepEqual(await stages(f), [['V1', '', 'requested', true]]);
    assert.match(prompts(f)[0], /focus: whole run\./);
  } finally { f.close(); }
});

test('a restart neither loses nor repeats a stage: the settle is due from the persisted live finish, and each stage is asked once', async () => {
  const f = await fixture();
  try {
    staged(f, f.now() - 30 * 60_000, f.now() - 60_000); await merged(f);
    await f.validations.reconcile();
    assert.deepEqual(await stages(f), [['V1', 'live', 'requested', true]], 'preview gives way to live, which finished since');
    await f.restart(); await f.validations.reconcile();
    assert.equal(prompts(f).length, 1, 'the restarted service does not ask again');
    await f.run({ ...report('V1', 1, final('passed')), agentNodeId: 'author' });
    await f.restart();
    f.tick(10 * 60_000); await f.validations.reconcile();
    await f.restart(); await f.validations.reconcile();
    assert.deepEqual(await stages(f), [['V1', 'live', 'final', true], ['V2', 'settle', 'requested', true]]);
    assert.equal(prompts(f).length, 2);
  } finally { f.close(); }
});

test('a staged stage without a starter waits for a ready agent and prefers the agent that validated the previous stage', async () => {
  const f = await fixture();
  try {
    staged(f, f.now() - 60_000); await merged(f);
    await f.apply([{ type: 'node.update', id: 'author', activity: 'working' }]);
    await f.validations.reconcile();
    assert.deepEqual((await listed(f)), [['V1', 'direct', 1, true]], 'any ready connected agent when the pull request\'s agent is busy');
    await f.run({ ...report('V1', 1, final('passed')), agentNodeId: 'direct' });
    await f.apply([{ type: 'node.update', id: 'author', activity: 'idle' }]);
    staged(f, f.now() - 60_000, f.now());
    await f.validations.reconcile();
    assert.deepEqual((await listed(f)).at(-1), ['V2', 'direct', 1, true]);
  } finally { f.close(); }
});

test('a validation a person asked for after a stage finished covers that stage; the box unchecked keeps every stage quiet', async () => {
  const f = await fixture();
  try {
    staged(f, f.now() - 60_000); await merged(f, { autoValidate: false });
    await f.validations.reconcile();
    assert.deepEqual(await stages(f), []);
    await f.run({ operation: 'trigger', sourceResourceId: 'rollout-r', value: 'direct', requestId: randomUUID() });
    await f.run({ ...report('V1', 1, final('passed')), agentNodeId: 'direct' });
    await f.apply([{ type: 'item.update', id: 'pr', data: { owner: 'acme', repo: 'app', number: 42 } }]);
    await f.validations.reconcile();
    assert.deepEqual(await stages(f), [['V1', '', 'final', false]]);
    f.tick(60_000); staged(f, f.now() - 120_000, f.now());
    await f.validations.reconcile();
    assert.deepEqual((await stages(f)).at(-1), ['V2', 'live', 'requested', true]);
  } finally { f.close(); }
});

test('the request carries the context the table has: pull requests, the run, jobs per environment, the previous final report and the component', async () => {
  const f = await fixture();
  try {
    staged(f); await merged(f);
    await f.run({ operation: 'trigger', sourceResourceId: 'rollout-r', value: 'direct', requestId: randomUUID() });
    await f.run({ ...report('V1', 1, { ...final('concerns'), checks: [{ id: 'C1', title: 'Error rate', status: 'concern', observation: 'Response time rose 8%.' }] }), agentNodeId: 'direct' });
    f.tick(2 * 60_000); staged(f, f.now() - 60_000);
    await f.validations.reconcile();
    assert.match(prompts(f).at(-1)!, /validationId "V2"/);
    const prompt = prompts(f).at(-1)!, context = payloadOf(prompt);
    assert.ok(prompt.split('\n').every(line => line.length < 1000), 'no line runs long, so a terminal in canonical mode takes every line');
    assert.deepEqual(context, {
      run: { id: 101, attempt: 1, commit: 'a'.repeat(40), workflow: 'Web / Release', url: 'https://github.com/acme/app/actions/runs/101' },
      stage: { name: 'preview', environment: 'preview', finishedAt: '2026-09-30T13:11:00.000Z' },
      pullRequests: [{ number: 42, title: 'Ship the reading list', url: 'https://github.com/acme/app/pull/42' }],
      environments: [
        { name: 'preview', status: 'succeeded', finishedAt: '2026-09-30T13:11:00.000Z', jobs: [{ id: 201, name: 'preview / ship', status: 'completed', conclusion: 'success' }] },
        { name: 'live', status: 'running', jobs: [{ id: 202, name: 'live / ship', status: 'in_progress', conclusion: null }] },
      ],
      previous: { validationId: 'V1', verdict: 'concerns', summary: 'Release concerns', checks: [{ id: 'C1', title: 'Error rate', status: 'concern', observation: 'Response time rose 8%.' }] },
      component: { path: 'services/api/billing', files: ['services/api/billing/invoices.ts', 'services/api/billing/export.ts'], total: 2 },
      merged: { since: { run: 95, commit: 'c'.repeat(40), url: 'https://github.com/acme/app/actions/runs/95' }, commits: 3, truncated: true,
        pullRequests: [{ number: 32, title: 'Export invoices as CSV', url: 'https://github.com/acme/app/pull/32' }, { number: 28, title: 'Batch billing exports', url: 'https://github.com/acme/app/pull/28' }] },
    });
    assert.deepEqual([...new Set(f.reads.filter(read => read.actionId === 'files').map(read => JSON.stringify(read)))], [JSON.stringify({ nodeId: 'pr', actionId: 'files', input: { head: 'c'.repeat(40), base: 'b'.repeat(40) } })],
      'changed files come from the pull request\'s cached read-only files action');
    assert.deepEqual(f.reads.find(read => read.actionId === 'rollout.shipped'), { nodeId: 'rollout', actionId: 'rollout.shipped', input: { runId: 101, workflowId: 9, runNumber: 28, head: 'a'.repeat(40), branch: 'main' } },
      'what the run ships comes from the rollout\'s cached read-only action');
  } finally { f.close(); }
});

test('a follow-up on a final validation is stored with a higher sequence and may change the verdict; other reports after final are refused', async () => {
  const f = await fixture();
  try {
    await f.run({ operation: 'trigger', sourceResourceId: 'rollout-r', value: 'direct', requestId: randomUUID() });
    await f.run({ ...report('V1', 2, final('passed')), agentNodeId: 'direct' });
    assert.deepEqual((await attention(f)).sources, {});
    f.tick(60_000);
    await assert.rejects(f.run({ ...report('V1', 3), agentNodeId: 'direct' }), /already final\. Send phase "followup"/);
    const followup = { phase: 'followup', verdict: 'concerns', summary: 'Response times crept up after the settle window.', checks: [{ id: 'C1', title: 'Error rate', status: 'concern' }] };
    assert.equal((await f.run({ ...report('V1', 2, followup), agentNodeId: 'direct' }) as any).ignored, true, 'a follow-up still needs a higher sequence');
    const saved = await f.run({ ...report('V1', 3, followup), agentNodeId: 'direct' }) as any;
    assert.deepEqual([saved.state, saved.sequence], ['final', 3]);
    const view = (await f.run({ operation: 'list' }) as any).validations[0];
    assert.deepEqual([view.verdict, view.reports, view.report.followup, view.finishedAt], ['concerns', 2, { at: f.now(), previous: 'passed', count: 1 }, f.now()]);
    assert.deepEqual((await attention(f)).sources, { 'validation:direct': 'validation' }, 'the changed verdict raises Needs me');
    await assert.rejects(f.run({ ...report('V1', 4, followup), agentNodeId: 'indirect' }), /requested from another agent/);
  } finally { f.close(); }
});

test('a report for an id nobody requested is accepted: the validation is created for the reporting agent and labelled unrequested', async () => {
  const f = await fixture();
  try {
    const receipt = await f.run({ ...report('V4', 1), agentNodeId: 'direct' }) as any;
    assert.deepEqual([receipt.validationId, receipt.state], ['V4', 'running']);
    assert.match(receipt.warnings.join(' '), /V4 was not requested/);
    const [view] = (await f.run({ operation: 'list' }) as any).validations;
    assert.deepEqual([view.label, view.agentNodeId, view.unrequested, view.automatic, view.scope.runId], ['V4', 'direct', true, undefined, 101]);
    assert.equal((await f.run({ ...report('V4', 2, final('passed')), agentNodeId: 'direct' }) as any).state, 'final');
    assert.deepEqual(await f.run({ operation: 'trigger', sourceResourceId: 'rollout-r', value: 'direct', requestId: randomUUID() }), { sent: true, linked: false, validationId: 'V5' }, 'the next request takes the next id');
    await assert.rejects(f.run({ ...report('V9', 1), agentNodeId: 'ticket' }), /agent/, 'only an agent on the map can report');
  } finally { f.close(); }
});

test('a report without an id starts a validation from chat: the next id, for the stage the run has reached, labelled and kept for the agent\'s next reports', async () => {
  const f = await fixture();
  try {
    staged(f, f.now() - 30 * 60_000, f.now() - 60_000);
    const { validationId, ...unnamed } = report('V1', 1);
    const first = await f.run({ ...unnamed, agentNodeId: 'direct' }) as any;
    assert.deepEqual([first.validationId, first.state], ['V1', 'running']);
    assert.match(first.warnings.join(' '), /started from chat as V1/); assert.match(first.warnings.join(' '), /validationId "V1"/);
    const [view] = (await f.run({ operation: 'list' }) as any).validations;
    assert.deepEqual([view.label, view.agentNodeId, view.chat, view.unrequested, view.automatic, view.scope.stage, view.scope.environments, view.scope.focus], ['V1', 'direct', true, undefined, undefined, 'live', ['live'], 'live']);
    assert.equal((await f.run({ ...unnamed, sequence: 2, agentNodeId: 'direct' }) as any).validationId, 'V1', 'a later report without an id goes to the same validation');
    assert.equal((await f.run({ ...unnamed, ...final('passed'), sequence: 3, agentNodeId: 'direct' }) as any).state, 'final');
    const amended = await f.run({ ...unnamed, phase: 'followup', verdict: 'concerns', summary: 'Latency crept up', checks: [{ id: 'C1', title: 'Error rate', status: 'concern' }], sequence: 4, agentNodeId: 'direct' }) as any;
    assert.deepEqual([amended.validationId, amended.state], ['V1', 'final'], 'a follow-up without an id amends the agent\'s latest final validation');
    const second = await f.run({ ...unnamed, agentNodeId: 'indirect' }) as any;
    assert.equal(second.validationId, 'V2', 'another agent starts its own');
  } finally { f.close(); }
});

test('a run without stages gets a whole-run validation from chat', async () => {
  const f = await fixture();
  try {
    const { validationId, ...unnamed } = report('V1', 1);
    assert.equal((await f.run({ ...unnamed, agentNodeId: 'direct' }) as any).validationId, 'V1');
    const [view] = (await f.run({ operation: 'list' }) as any).validations;
    assert.deepEqual([view.chat, view.scope.stage, view.scope.focus], [true, undefined, 'whole run']);
    await assert.rejects(f.run({ ...unnamed, agentNodeId: 'ticket' }), /agent/, 'only an agent on the map can report');
    await f.run({ operation: 'trigger', sourceResourceId: 'rollout-r', value: 'indirect', requestId: randomUUID(), rerun: 'V1' });
    const asked = await f.run({ ...unnamed, agentNodeId: 'indirect' }) as any;
    assert.equal(asked.validationId, 'V2', 'an agent asked for a validation reports it without an id');
    assert.equal(((await f.run({ operation: 'list' }) as any).validations as any[]).find(view => view.label === 'V2').chat, undefined);
  } finally { f.close(); }
});

test('asking from the item for a stage a chat validation covers attaches to it while it runs and for 15 minutes after its final report; Re-run asks again', async () => {
  const f = await fixture();
  try {
    staged(f, f.now() - 30 * 60_000, f.now() - 60_000);
    const { validationId, ...unnamed } = report('V1', 1);
    await f.run({ ...unnamed, agentNodeId: 'direct' });
    const options = await f.run({ operation: 'options' }) as any;
    assert.match(options.prompt, /V1, started from chat, covers live/);
    assert.equal(options.context.rerun, 'V1');
    assert.deepEqual([options.options[0].id, options.options[0].label], ['attach', 'Show V1']);
    assert.match(options.options.find((option: any) => option.id === 'direct').description, /^Re-run · Ready/);
    const sent = f.inputs.length;
    const attached = await f.run({ operation: 'trigger', sourceResourceId: 'rollout-r', value: 'direct', requestId: randomUUID() }) as any;
    assert.deepEqual([attached.sent, attached.attached, attached.validationId], [false, true, 'V1']);
    assert.match(attached.pending, /V1, started from chat, is still running/);
    assert.equal((await f.run({ operation: 'trigger', sourceResourceId: 'rollout-r', value: 'attach', requestId: randomUUID() }) as any).validationId, 'V1');
    assert.equal(f.inputs.length, sent, 'nothing was sent'); assert.equal((await stages(f)).length, 1, 'and nothing recorded');
    await f.run({ ...unnamed, ...final('passed'), sequence: 2, agentNodeId: 'direct' });
    f.tick(5 * 60_000);
    assert.equal((await f.run({ operation: 'trigger', sourceResourceId: 'rollout-r', value: 'indirect', requestId: randomUUID() }) as any).attached, true, 'a final report 5 minutes old still answers');
    const rerun = await f.run({ operation: 'trigger', sourceResourceId: 'rollout-r', value: 'indirect', requestId: randomUUID(), rerun: 'V1' }) as any;
    assert.deepEqual([rerun.sent, rerun.validationId], [true, 'V2'], 'Re-run starts a second validation');
    assert.equal(f.inputs.length, sent + 2);
  } finally { f.close(); }
});

test('a chat validation stops answering 15 minutes after its final report, or once the run reached another stage', async () => {
  const f = await fixture();
  try {
    const { validationId, ...unnamed } = report('V1', 1);
    await f.run({ ...unnamed, ...final('passed'), agentNodeId: 'direct' });
    f.tick(15 * 60_000 - 1);
    assert.equal((await f.run({ operation: 'options' }) as any).context.rerun, 'V1');
    f.tick(1);
    const options = await f.run({ operation: 'options' }) as any;
    assert.deepEqual([options.context.rerun, options.options[0].id], [undefined, 'direct']);
    assert.equal((await f.run({ operation: 'trigger', sourceResourceId: 'rollout-r', value: 'direct', requestId: randomUUID() }) as any).validationId, 'V2');
  } finally { f.close(); }
  const g = await fixture();
  try {
    staged(g, g.now() - 60_000);
    const { validationId, ...unnamed } = report('V1', 1);
    await g.run({ ...unnamed, ...final('passed'), agentNodeId: 'direct' });
    staged(g, g.now() - 120_000, g.now());
    assert.equal((await g.run({ operation: 'trigger', sourceResourceId: 'rollout-r', value: 'direct', requestId: randomUUID() }) as any).validationId, 'V2', 'preview was validated from chat; live is asked for');
    await assert.rejects(g.run({ operation: 'trigger', sourceResourceId: 'rollout-r', value: 'attach', requestId: randomUUID() }), /no longer/);
  } finally { g.close(); }
});

test('Auto validate counts a chat validation of a stage as covering it', async () => {
  const f = await fixture();
  try {
    staged(f, f.now() - 30 * 60_000, f.now() - 60_000); await merged(f);
    const { validationId, ...unnamed } = report('V1', 1);
    await f.run({ ...unnamed, ...final('passed'), agentNodeId: 'author' });
    await f.validations.reconcile(); await f.validations.reconcile();
    assert.deepEqual(await stages(f), [['V1', 'live', 'final', false]]);
    assert.equal(f.inputs.length, 0, 'live is not asked for again');
    f.tick(10 * 60_000); await f.validations.reconcile();
    assert.deepEqual((await stages(f)).at(-1), ['V2', 'settle', 'requested', true], 'the settle still is');
  } finally { f.close(); }
});

/** The fixture's run as a phased rollout: staging, then two production phases behind the same gate. */
function phased(f: Awaited<ReturnType<typeof fixture>>, done: number, gated: boolean, completed = false) {
  const names = ['apply (staging)', 'apply (prod-1)', 'apply (prod-2)'];
  f.observation.jobs = names.map((name, index) => ({ id: 301 + index, run_id: 101, name, status: index < done ? 'completed' : index === done && gated ? 'waiting' : index === done ? 'in_progress' : 'queued',
    conclusion: index < done ? 'success' : null, started_at: '2026-09-30T13:00:00Z', completed_at: index < done ? '2026-09-30T13:05:00Z' : null }));
  f.observation.gates = gated ? [{ environment: { id: 7, name: 'production' }, wait_timer: 0, current_user_can_approve: true, reviewers: [] }] as RolloutObservation['gates'] : [];
  f.observation.run = { ...f.observation.run!, status: completed ? 'completed' : 'in_progress', conclusion: completed ? 'success' : null };
}
const phases = async (f: Awaited<ReturnType<typeof fixture>>) => ((await f.run({ operation: 'list' }) as any).validations as any[]).map(view => [view.label, view.scope.focus, view.scope.jobs, view.automatic === true]);

test('Auto validate on a gated run validates each phase once its gate waits, and the rest when the run ends: each approval leads to the next validation', async () => {
  const f = await fixture();
  try {
    phased(f, 0, true); await merged(f);
    await f.validations.reconcile();
    assert.deepEqual(await phases(f), [], 'a gate before anything ran asks nothing');
    phased(f, 1, true); await f.validations.reconcile();
    assert.deepEqual(await phases(f), [['V1', 'before production (apply (prod-1))', [301], true]]);
    assert.match(f.inputs[0].data, /focus: before production \(apply \(prod-1\)\)\./);
    await f.run({ ...report('V1', 1, final('passed')), agentNodeId: 'author' }); await f.apply([{ type: 'node.update', id: 'author', activity: 'idle' }]);
    phased(f, 1, false); await f.validations.reconcile(); await f.validations.reconcile();
    assert.equal((await phases(f)).length, 1, 'approved: nothing while the next phase runs');
    phased(f, 2, true); await f.validations.reconcile();
    assert.deepEqual((await phases(f)).at(-1), ['V2', 'before production (apply (prod-2))', [302], true], 'the second gate on the same environment is its own phase');
    await f.validations.reconcile();
    assert.equal((await phases(f)).length, 2, 'once per phase');
    await f.run({ ...report('V2', 1, final('passed')), agentNodeId: 'author' }); await f.apply([{ type: 'node.update', id: 'author', activity: 'idle' }]);
    phased(f, 3, false, true); await f.validations.reconcile();
    assert.deepEqual((await phases(f)).at(-1), ['V3', 'whole run', [303], true]);
    await f.validations.reconcile();
    assert.equal((await phases(f)).length, 3);
  } finally { f.close(); }
});

test('one click scopes to the phase that ran since the last validation, even right after an approval, and is not swallowed by a chat validation', async () => {
  const f = await fixture();
  try {
    phased(f, 1, true);
    const { validationId, ...unnamed } = report('V1', 1);
    await f.run({ ...unnamed, agentNodeId: 'direct' });
    const click = () => f.run({ operation: 'trigger', sourceResourceId: 'rollout-r', value: 'direct', requestId: randomUUID(), phased: true }) as Promise<any>;
    await f.run({ ...report('V1', 2, final('passed')), agentNodeId: 'direct' });
    phased(f, 2, false);
    const second = await click();
    assert.equal(second.attached, undefined, 'a chat validation does not answer a phased request');
    assert.deepEqual((await phases(f)).at(-1), ['V2', 'through apply (prod-1)', [301, 302], false]);
    await f.run({ ...report('V2', 1, final('passed')), agentNodeId: 'direct' });
    const again = await click();
    assert.deepEqual([again.sent, again.attached, again.validationId], [false, true, 'V2'], 'nothing new ran: the last phase validation is shown');
  } finally { f.close(); }
});

test('a phased request sent again with its id answers as the first time, even after its phase was covered', async () => {
  const f = await fixture();
  try {
    phased(f, 1, true);
    const requestId = randomUUID(), click = () => f.run({ operation: 'trigger', sourceResourceId: 'rollout-r', value: 'direct', requestId, phased: true });
    const first = await click();
    assert.deepEqual(await click(), first);
    assert.equal(f.inputs.length, 2, 'sent once');
  } finally { f.close(); }
});
