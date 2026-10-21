import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from './sqlite-store.ts';
import { WorkspaceControl } from '../core/control.ts';
import type { WorkspaceCommand } from '../core/control.ts';
import type { SessionCoordinator } from './sessions.ts';
import type { ReviewResult } from './reviews.ts';
import { ReviewFindingsCoordinator } from './review-findings.ts';
import type { AgentSpawner } from './review-findings.ts';
import { sampleReview } from '../../tests/fixtures/review-findings.ts';
import { attentionItems } from '../../src/graph/attention.ts';

async function fixture(output = JSON.stringify(sampleReview), spawner?: AgentSpawner) {
  const directory = mkdtempSync(join(tmpdir(), 'craft-review-findings-')), store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  const apply = async (commands: WorkspaceCommand[]) => control.dispatch({ commandId: randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'test' }, commands });
  const agent = (id: string, x: number) => ({ type: 'item.add' as const, id, resourceId: `${id}-r`, pluginId: 'agent.session', title: `Claude · ${id}`, position: { x, y: 600 }, data: { provider: 'claude', sessionId: `${id}-session` } });
  await apply([
    { type: 'item.add', id: 'pr', resourceId: 'pr-r', pluginId: 'github.pull-request', title: 'Resize thumbnails', position: { x: 0, y: 0 }, data: { owner: 'acme', repo: 'app', number: 42 } },
    { type: 'item.create', id: 'review', position: { x: 300, y: 0 }, resource: { id: 'review-r', pluginId: 'code.review', schemaVersion: 1, title: 'Claude review · #42', data: { provider: 'claude', model: 'opus', sessionId: 'run-1', sourcePrId: 'pr', baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40), launchMode: 'review' } } },
    { type: 'item.add', id: 'note', resourceId: 'note-r', pluginId: 'workspace.note', title: 'Note', position: { x: 600, y: 0 }, data: { text: 'Unrelated' } },
    agent('impl', 0), agent('tests', 400), agent('docs', 800), agent('far', 1200), agent('below', 1600),
    { type: 'link.save', link: { id: 'pr-review', sourceId: 'pr', targetId: 'review', kind: 'reference', label: 'Review' } },
    { type: 'link.save', link: { id: 'review-impl', sourceId: 'review', targetId: 'impl', kind: 'context', label: '' } },
    { type: 'link.save', link: { id: 'pr-tests', sourceId: 'pr', targetId: 'tests', kind: 'context', label: '' } },
    { type: 'link.save', link: { id: 'pr-docs', sourceId: 'pr', targetId: 'docs', kind: 'context', label: '' } },
    { type: 'link.save', link: { id: 'review-note', sourceId: 'review', targetId: 'note', kind: 'reference', label: '' } },
    { type: 'link.save', link: { id: 'note-far', sourceId: 'note', targetId: 'far', kind: 'context', label: '' } },
    { type: 'link.save', link: { id: 'pr-below', sourceId: 'pr', targetId: 'below', kind: 'context', label: '' } },
    { type: 'node.update', id: 'review', activity: 'complete' },
    ...['impl', 'tests', 'far', 'below'].map(id => ({ type: 'node.update' as const, id, activity: 'idle' as const })), { type: 'node.update', id: 'docs', activity: 'working' },
    { type: 'node.below', id: 'below' },
  ]);
  const inputs: { sessionId: string; data: string }[] = [], stopped = new Set<string>();
  const sessions = { runtime: { async call(method: string, input: { sessionId: string; data: string }) {
    if (method === 'sessions.input') { inputs.push(input); return {}; }
    return { session: { state: stopped.has(input.sessionId) ? 'exited' : 'running', native: { status: 'idle' } } };
  } } } as unknown as SessionCoordinator;
  let result: ReviewResult = { state: 'complete', markdown: output, truncated: false };
  const findings = new ReviewFindingsCoordinator(store, control, async () => result, sessions, async () => {}, () => true, spawner);
  const run = (input: object, nodeId = 'review') => findings.run(nodeId, input) as Promise<any>;
  const prompts = () => inputs.filter(input => input.data !== '\r');
  return { control, store, apply, inputs, prompts, stopped, findings, run, setResult(next: ReviewResult) { result = next; }, close() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('recipients are agents linked to the review or its PR, never through other items or from the Undermap', async () => {
  const f = await fixture();
  try {
    const options = await f.run({ operation: 'options' });
    assert.deepEqual(options.agents.map((agent: any) => [agent.nodeId, agent.via, agent.status]), [['impl', 'review', 'idle'], ['tests', 'pr', 'idle'], ['docs', 'pr', 'working']]);
    assert.equal(options.suggested, 'impl'); assert.equal(options.prLabel, '#42');
    const list = await f.run({ operation: 'list' });
    assert.equal(list.format, 'findings'); assert.equal(list.review.findings.length, 3); assert.equal(list.repository, 'acme/app');
    assert.deepEqual(list.statuses, { F1: 'open', F2: 'open', F3: 'open' });
  } finally { f.close(); }
});

test('sending to an idle agent pastes only the chosen findings as the task with the full review, once per request', async () => {
  const f = await fixture();
  try {
    const requestId = randomUUID(), send = { operation: 'send', requestId, reviewSessionId: 'run-1', findingIds: ['F1', 'F2'], agentNodeId: 'tests', note: 'Keep the sync path' };
    const result = await f.run(send);
    assert.equal(result.state, 'sent'); assert.equal(result.linked, true);
    assert.equal(f.prompts().length, 1); assert.equal(f.prompts()[0].sessionId, 'tests-session');
    const [task, context] = f.prompts()[0].data.split('<review>');
    assert.match(task, /Fix only F1, F2/); assert.doesNotMatch(task, /Tokens are logged/); assert.match(context, /Tokens are logged/);
    assert.match(task, /Note from the user: Keep the sync path/); assert.match(f.prompts()[0].data, /^I asked for this from the Agentic Crafting Table\. Please handle the review findings as the pasted request describes: \x1b\[200~/);
    assert.deepEqual((await f.run(send)).state, 'sent');
    assert.equal(f.prompts().length, 1, 'a replayed request never pastes again');
    await assert.rejects(f.run({ ...send, findingIds: ['F3'] }), /reused/);
    const state = await f.control.read();
    assert.equal(state.links.filter(link => link.sourceId === 'review' && link.targetId === 'tests' && link.kind === 'context').length, 1);
    const list = await f.run({ operation: 'list' });
    assert.deepEqual(list.statuses, { F1: 'sent', F2: 'sent', F3: 'open' });
    assert.equal(list.history.F1.at(-1).agentTitle, 'Claude · tests');
    await assert.rejects(f.run({ ...send, requestId: randomUUID(), agentNodeId: 'far' }), /connected to this review/);
    await assert.rejects(f.run({ ...send, requestId: randomUUID(), findingIds: ['F9'] }), /F9/);
    await assert.rejects(f.run({ ...send, requestId: randomUUID(), reviewSessionId: 'old-run' }), /changed/);
  } finally { f.close(); }
});

test('a working agent queues the findings; they are delivered once it becomes idle and cancellable before that', async () => {
  const f = await fixture();
  try {
    const queued = await f.run({ operation: 'send', requestId: randomUUID(), reviewSessionId: 'run-1', findingIds: ['F3'], agentNodeId: 'docs' });
    assert.equal(queued.state, 'queued'); assert.equal(f.prompts().length, 0);
    assert.deepEqual((await f.run({ operation: 'list' })).statuses.F3, 'queued');
    await assert.rejects(f.run({ operation: 'send', requestId: randomUUID(), reviewSessionId: 'run-1', findingIds: ['F3'], agentNodeId: 'impl' }), /already queued/);
    await f.findings.reconcile(); assert.equal(f.prompts().length, 0, 'still working');
    await f.apply([{ type: 'node.update', id: 'docs', activity: 'idle' }]);
    await f.findings.reconcile(); await f.findings.reconcile();
    assert.equal(f.prompts().length, 1); assert.match(f.prompts()[0].data, /Fix only F3/);
    assert.equal(f.store.reviewSend(queued.sendId)?.state, 'sent'); assert.equal((await f.run({ operation: 'list' })).statuses.F3, 'sent');
    await assert.rejects(f.run({ operation: 'cancel', sendId: queued.sendId }), /already delivered/);
    await f.apply([{ type: 'node.update', id: 'docs', activity: 'working' }]);
    const second = await f.run({ operation: 'send', requestId: randomUUID(), reviewSessionId: 'run-1', findingIds: ['F1'], agentNodeId: 'docs' });
    const cancelled = await f.run({ operation: 'cancel', sendId: second.sendId });
    assert.equal(cancelled.state, 'cancelled'); assert.equal((await f.run({ operation: 'list' })).statuses.F1, 'open');
    await f.apply([{ type: 'node.update', id: 'docs', activity: 'idle' }]); await f.findings.reconcile();
    assert.equal(f.prompts().length, 1, 'a cancelled send is never delivered');
  } finally { f.close(); }
});

test('a queued send fails visibly when its agent is archived or sent to the Undermap; stopped agents keep waiting', async () => {
  const f = await fixture();
  try {
    f.stopped.add('tests-session');
    const waiting = await f.run({ operation: 'send', requestId: randomUUID(), reviewSessionId: 'run-1', findingIds: ['F2'], agentNodeId: 'tests' });
    assert.equal(waiting.state, 'queued');
    const doomed = await f.run({ operation: 'send', requestId: randomUUID(), reviewSessionId: 'run-1', findingIds: ['F1'], agentNodeId: 'docs' });
    await f.apply([{ type: 'node.archive', id: 'docs' }]);
    await f.findings.reconcile();
    const failed = f.store.reviewSend(doomed.sendId)!;
    assert.equal(failed.state, 'failed'); assert.match(failed.error!, /Claude · docs was archived/);
    const list = await f.run({ operation: 'list' });
    assert.equal(list.statuses.F1, 'open'); assert.equal(list.statuses.F2, 'queued');
    assert.match(list.sends.find((send: any) => send.id === doomed.sendId).error, /archived/);
    await f.apply([{ type: 'node.below', id: 'tests' }]); await f.findings.reconcile();
    assert.match(f.store.reviewSend(waiting.sendId)!.error!, /Undermap/);
    assert.equal(f.prompts().length, 0);
  } finally { f.close(); }
});

test('only the agent a finding was sent to can report it fixed; the user can override either way', async () => {
  const f = await fixture();
  try {
    await f.run({ operation: 'send', requestId: randomUUID(), reviewSessionId: 'run-1', findingIds: ['F1', 'F3'], agentNodeId: 'impl' });
    await assert.rejects(f.run({ operation: 'report', agentNodeId: 'tests', findingIds: ['F1'] }), /F1 was not sent to this agent/);
    await assert.rejects(f.run({ operation: 'report', agentNodeId: 'impl', findingIds: ['F2'] }), /F2 was not sent to an agent/);
    await assert.rejects(f.run({ operation: 'report', agentNodeId: 'impl', findingIds: ['F7'] }), /F7/);
    await assert.rejects(f.run({ operation: 'report', agentNodeId: 'impl', findingIds: ['F1'], commit: 'not a sha' }), /commit/);
    await assert.rejects(f.run({ operation: 'report', agentNodeId: 'impl', findingIds: ['F1'] }, 'pr'), /not a code review/);
    const reported = await f.run({ operation: 'report', agentNodeId: 'impl', findingIds: ['F1'], commit: 'abc1234', note: 'Resized asynchronously' });
    assert.deepEqual(reported.statuses, { F1: 'fixed', F2: 'open', F3: 'sent' });
    const history = (await f.run({ operation: 'list' })).history.F1;
    assert.deepEqual(history.map((event: any) => [event.status, event.actor]), [['queued', 'user'], ['sent', 'system'], ['fixed', 'agent']]);
    assert.equal(history.at(-1).commit, 'abc1234');
    await f.run({ operation: 'mark', reviewSessionId: 'run-1', findingIds: ['F1'], status: 'open' });
    await f.run({ operation: 'mark', reviewSessionId: 'run-1', findingIds: ['F2'], status: 'fixed' });
    const listed = await f.run({ operation: 'list' });
    assert.deepEqual(listed.statuses, { F1: 'open', F2: 'fixed', F3: 'sent' });
    assert.deepEqual(listed.ignored, ['F2']);
    assert.equal((await f.control.read()).nodes.find(node => node.id === 'review')!.summary.split('\n')[1], '1 sent · 1 ignored');
    await f.run({ operation: 'mark', reviewSessionId: 'run-1', findingIds: ['F2'], status: 'open' });
    assert.deepEqual((await f.run({ operation: 'list' })).ignored, []);
  } finally { f.close(); }
});

test('the roll-up reaches the map card, the PR summary and Needs me; restarts never resend an unconfirmed delivery', async () => {
  const f = await fixture();
  try {
    await f.findings.reconcile();
    let state = await f.control.read(), node = state.nodes.find(node => node.id === 'review')!, data = state.resources.find(resource => resource.id === 'review-r')!.data as any;
    assert.equal(data.findings.sessionId, 'run-1'); assert.equal(data.findings.counts, '3 findings · 1 critical · 1 low · 1 hard.');
    assert.deepEqual(data.findings.pips.map((pip: any) => pip.tone), ['critical', 'low', 'hardening']);
    assert.equal(node.summary, '3 findings · 1 critical · 1 low · 1 hard.\nNone sent yet');
    assert.equal(node.attentionSources?.findings, 'review', 'critical findings need me'); assert.equal(node.attentionNotes?.findings, 'Review found urgent issues');
    const revision = state.revision; await f.findings.reconcile();
    assert.equal((await f.control.read()).revision, revision, 'an unchanged roll-up is not rewritten');
    await f.run({ operation: 'send', requestId: randomUUID(), reviewSessionId: 'run-1', findingIds: ['F3'], agentNodeId: 'impl' });
    await f.findings.reconcile();
    state = await f.control.read(); data = state.resources.find(resource => resource.id === 'review-r')!.data;
    assert.equal(data.findings.progress, '1 sent'); assert.equal(data.findings.recipient, 'Claude · impl'); assert.equal(data.findings.pips[0].style, 'sent');
    await f.apply([{ type: 'node.update', id: 'docs', activity: 'working' }]);
    const stuck = await f.run({ operation: 'send', requestId: randomUUID(), reviewSessionId: 'run-1', findingIds: ['F1'], agentNodeId: 'docs' });
    f.store.transitionReviewSend(stuck.sendId, ['queued'], 'delivering', Date.now());
    f.findings.recover(); await f.apply([{ type: 'node.update', id: 'docs', activity: 'idle' }]); await f.findings.reconcile();
    assert.equal(f.store.reviewSend(stuck.sendId)!.state, 'uncertain'); assert.equal(f.prompts().length, 1);
  } finally { f.close(); }
});

test('text reviews can be sent whole; unparsable output keeps the reason', async () => {
  const f = await fixture('## Review complete\n\n- **P2** `file.ts:12` — check it.');
  try {
    const list = await f.run({ operation: 'list' });
    assert.equal(list.format, 'text'); assert.match(list.reason, /no findings JSON/i); assert.match(list.markdown, /Review complete/);
    const sent = await f.run({ operation: 'send', requestId: randomUUID(), reviewSessionId: 'run-1', findingIds: [], agentNodeId: 'impl' });
    assert.equal(sent.state, 'sent'); assert.match(f.prompts()[0].data, /text review without individual finding IDs/); assert.match(f.prompts()[0].data, /Review complete/);
    await assert.rejects(f.run({ operation: 'send', requestId: randomUUID(), reviewSessionId: 'run-1', findingIds: ['F1'], agentNodeId: 'impl' }), /F1/);
    await f.findings.reconcile();
    assert.equal((await f.control.read()).nodes.find(node => node.id === 'review')!.summary, 'Result as text');
    f.setResult({ state: 'running' });
  } finally { f.close(); }
});

test('Run in new agent starts a linked agent in the project directory and queues the findings for it', async () => {
  const created: any[] = [];
  let control: WorkspaceControl | undefined;
  const spawner: AgentSpawner = { async model(provider) { return provider === 'codex' ? 'gpt-6-astra' : 'opus'; }, async create(request) {
    created.push(request);
    await control!.dispatch({ commandId: randomUUID(), expectedRevision: request.expectedRevision, actor: { kind: 'user', id: 'test' }, commands: [
      { type: 'item.create', id: request.nodeId, projectId: request.projectId, position: request.position, resource: { id: request.resourceId, pluginId: 'agent.session', schemaVersion: 1, title: request.title, data: { ...request.data, sessionId: `${request.requestId}-session` } } },
      { type: 'link.save', link: { id: request.connection!.id, sourceId: request.connection!.otherId, targetId: request.nodeId, kind: 'context', label: '' } },
      { type: 'node.update', id: request.nodeId, activity: 'working' }] });
  } };
  const f = await fixture(undefined, spawner); control = f.control;
  try {
    const request = { operation: 'spawn', requestId: randomUUID(), sendId: randomUUID(), reviewSessionId: 'run-1', findingIds: ['F3'], provider: 'claude', note: 'Rotate the token' };
    assert.deepEqual((await f.run({ operation: 'options' })).newAgent, { provider: 'claude', available: false, reason: 'Set a working directory on this review’s project to start an agent from here.' });
    await assert.rejects(f.run(request), /working directory/);
    await f.apply([{ type: 'project.create', id: 'project', title: 'App', summary: '', workingDirectory: '/work/app', position: { x: 0, y: 0 } }, { type: 'node.attach', id: 'review', projectId: 'project' }]);
    assert.equal((await f.run({ operation: 'options' })).newAgent.available, true);
    const receipt = await f.run(request);
    assert.equal(receipt.state, 'queued'); assert.equal(created.length, 1);
    assert.deepEqual([created[0].pluginId, created[0].projectId, created[0].title, created[0].data], ['agent.session', 'project', 'Fix F3 · #42', { provider: 'claude', model: 'opus', cwd: '/work/app' }]);
    const options = await f.run({ operation: 'options' });
    assert.ok(options.agents.some((agent: any) => agent.nodeId === created[0].nodeId && agent.direct), 'the new agent is linked to the review');
    assert.equal((await f.run(request)).sendId, receipt.sendId); assert.equal(created.length, 1, 'a replayed request starts no second agent');
    assert.equal((await f.run({ operation: 'list' })).statuses.F3, 'queued');
    await f.apply([{ type: 'node.update', id: created[0].nodeId, activity: 'idle' }]); await f.findings.reconcile();
    assert.match(f.prompts().at(-1)!.data, /Fix only F3/); assert.match(f.prompts().at(-1)!.data, /Rotate the token/);
    const bare = await fixture();
    try { assert.equal((await bare.run({ operation: 'options' })).newAgent.available, false); } finally { bare.close(); }
  } finally { f.close(); }
});

test('a recipient held at a prompt is told apart from one that is working', async () => {
  const f = await fixture();
  try {
    await f.apply([{ type: 'node.update', id: 'tests', activity: 'idle', attention: 'input', attentionNote: 'Agent needs permission', summary: 'Waiting for your input' }]);
    const options = await f.run({ operation: 'options' });
    assert.deepEqual(options.agents.map((agent: any) => [agent.nodeId, agent.status, agent.prompt ?? false]), [['impl', 'idle', false], ['tests', 'working', true], ['docs', 'working', false]]);
  } finally { f.close(); }
});

test('a review with no findings shows a green check on the map and leaves Needs me; findings take the cue away again', async () => {
  const clean = { schemaVersion: 1, summary: 'No issues.', findings: [], checked: ['Error handling', 'Tests'], tests: { ran: true, notes: 'Green.' } };
  const f = await fixture(JSON.stringify(clean));
  try {
    await f.apply([{ type: 'attention.set', id: 'review', source: 'completion', reason: 'finished', note: 'Review ready', eventId: 'session:run-1' }]);
    assert.equal(attentionItems((await f.control.read()).nodes).length, 1);
    await f.findings.reconcile();
    let node = (await f.control.read()).nodes.find(node => node.id === 'review')!;
    assert.deepEqual(node.indicators, [{ id: 'findings', label: 'No findings', icon: 'check', tone: 'green', stage: 'done' }]);
    assert.equal(node.summary, 'No findings\n2 areas checked');
    assert.equal(attentionItems((await f.control.read()).nodes).length, 0, 'a clean review is not Needs me');
    const revision = (await f.control.read()).revision; await f.findings.reconcile();
    assert.equal((await f.control.read()).revision, revision, 'nothing is rewritten on the next look');
    // The next round finds something: the cue goes, the roll-up and Needs me take over.
    f.setResult({ state: 'complete', markdown: JSON.stringify(sampleReview), truncated: false });
    await f.apply([{ type: 'item.update', id: 'review', data: { provider: 'claude', model: 'opus', sessionId: 'run-2', sourcePrId: 'pr', baseSha: 'b'.repeat(40), headSha: 'c'.repeat(40) } }]);
    await f.findings.reconcile();
    node = (await f.control.read()).nodes.find(node => node.id === 'review')!;
    assert.deepEqual(node.indicators ?? [], []);
    assert.equal(node.attentionSources?.findings, 'review');
  } finally { f.close(); }
});
