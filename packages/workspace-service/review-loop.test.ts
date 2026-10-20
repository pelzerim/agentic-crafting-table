import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from './sqlite-store.ts';
import { WorkspaceControl } from '../core/control.ts';
import type { WorkspaceCommand } from '../core/control.ts';
import type { ResourceCreate } from '../core/resource-creation.ts';
import type { SessionCoordinator } from './sessions.ts';
import type { ReviewResult } from './reviews.ts';
import { ReviewFindingsCoordinator } from './review-findings.ts';
import { ReviewLoops, REVIEW_LOOP_COLLECTION } from './review-loop.ts';
import { PUSH_DEADLINE_MS, REVIEW_LOOP_OPERATION } from '../../src/resource-plugins/items/code-review/review-loop.ts';
import type { ReviewLoopRecord } from '../../src/resource-plugins/items/code-review/review-loop.ts';
import type { Finding, ReviewFindings } from '../../src/pull-requests/review-findings.ts';
import { agentRuntimeRefusal } from '../core/runtime.ts';
import { humanOnlyMessage } from '../../src/resource-plugins/host.ts';
import type { JsonObject } from '../../src/resource-plugins/types.ts';

const T0 = Date.parse('2026-10-08T10:00:00Z'), MIN = 60_000;
const finding = (id: string, title: string, over: Partial<Finding> = {}): Finding => ({ id, kind: 'bug', severity: 'high', title, verification: { level: 'verified' }, locations: [{ path: 'src/cart.ts', startLine: 10 }], ...over });
const findings = (...items: Finding[]): ReviewFindings => ({ schemaVersion: 1, summary: items.length ? 'Issues found.' : 'Looks correct.', findings: items, checked: [], tests: { ran: false, notes: '' } });

/** A pull request in a project with one connected agent. Reviews are a script: each start places a review item the test later finishes;
 * findings, sends, delivery and fix reports go through the real findings coordinator and its tables. */
async function fixture(options: { directory?: string; agent?: 'idle' | 'working' | 'none'; workingDirectory?: boolean } = {}) {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), 'craft-review-loop-')), store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  const apply = async (commands: WorkspaceCommand[]) => control.dispatch({ commandId: randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'test' }, commands });
  if (!options.directory) {
    await apply([
      { type: 'project.create', id: 'web', title: 'Web', summary: '', position: { x: 0, y: 0 }, ...(options.workingDirectory === false ? {} : { workingDirectory: '/work/web' }) },
      { type: 'item.add', id: 'pr', resourceId: 'pr-r', pluginId: 'github.pull-request', title: 'Cart totals', projectId: 'web', position: { x: 300, y: 200 }, data: { owner: 'acme', repo: 'app', number: 42 } },
    ]);
    if (options.agent !== 'none') await apply([
      { type: 'item.add', id: 'impl', resourceId: 'impl-r', pluginId: 'agent.session', title: 'Claude · impl', projectId: 'web', position: { x: 300, y: 500 }, data: { provider: 'claude', sessionId: 'impl-session' } },
      { type: 'link.save', link: { id: 'pr-impl', sourceId: 'pr', targetId: 'impl', kind: 'context', label: '' } },
      { type: 'node.update', id: 'impl', activity: options.agent ?? 'idle' }]);
  }
  let now = T0;
  const github = { head: 'a'.repeat(40), state: 'open', merged: false, heads: 0 };
  const resources = { async cached(nodeId: string) { return nodeId === 'pr' ? { detail: { pull: { state: github.state, merged: github.merged, head: { ref: 'feature/cart', sha: github.head }, base: { ref: 'main' } } } } : null; } };
  const results = new Map<string, ReviewResult>(), jobs = new Map<string, { state: string; nodeId?: string; sessionId?: string; error?: string }>();
  const starts: { requestId: string; input: JsonObject }[] = [];
  const reviews = {
    async start(prNodeId: string, provider: string, input: JsonObject) {
      starts.push({ requestId: String(input.requestId), input });
      const requestId = String(input.requestId);
      if (jobs.has(requestId)) return { requestId };
      const n = jobs.size + 1, nodeId = `review-${n}`, sessionId = `run-${n}`, loop = input.loop as { from?: string; round: number } | undefined;
      jobs.set(requestId, { state: 'running' });
      await apply([{ type: 'item.create', id: nodeId, projectId: 'web', position: { x: 300 + n * 280, y: 200 }, resource: { id: `${nodeId}-r`, pluginId: 'code.review', schemaVersion: 1, title: `Claude review · #42${loop?.from ? ` · round ${loop.round}` : ''}`,
        data: { provider, model: String(input.model), sessionId, sourcePrId: prNodeId, baseSha: 'c'.repeat(40), headSha: github.head, launchMode: 'review' } } },
      { type: 'link.save', link: { id: `${nodeId}-link`, sourceId: loop?.from ?? prNodeId, targetId: nodeId, kind: 'reference', label: loop?.from ? `Round ${loop.round}` : 'Review' } },
      { type: 'node.update', id: nodeId, activity: 'working' }]);
      jobs.set(requestId, { state: 'succeeded', nodeId, sessionId });
      return { requestId };
    },
    status(_prNodeId: string, requestId: string) { const job = jobs.get(requestId); return job ? [{ requestId, ...job }] : []; },
    async options() { return [{ provider: 'codex', options: ['gpt-6-astra'], default: 'gpt-6-astra' }, { provider: 'claude', options: ['opus', 'sonnet'], default: 'opus' }]; },
  };
  const prompts: { sessionId: string; data: string }[] = [];
  let deliveryFails = false;
  const sessions = { runtime: { async call(method: string, input: { sessionId: string; data: string }) {
    if (method === 'sessions.input') { if (deliveryFails) throw new Error('The terminal went away.'); if (input.data !== '\r') prompts.push(input); return {}; }
    return { session: { state: 'running', native: { status: 'idle' } }, lastSequence: 1 };
  } } } as unknown as SessionCoordinator;
  const spawned: ResourceCreate[] = [];
  const spawner = { async model() { return 'opus'; }, async create(request: ResourceCreate) {
    spawned.push(request);
    await apply([{ type: 'item.add', id: request.nodeId, resourceId: request.resourceId, pluginId: 'agent.session', title: request.title, projectId: request.projectId, position: request.position!, data: { ...request.data, sessionId: `${request.nodeId}-session` } },
      ...(request.connection ? [{ type: 'link.save' as const, link: { id: request.connection.id, sourceId: request.connection.otherId, targetId: request.nodeId, kind: 'context' as const, label: '' } }] : []),
      { type: 'node.update', id: request.nodeId, activity: 'idle' }]);
  } };
  const result = async (nodeId: string): Promise<ReviewResult> => {
    const state = await control.read(), sessionId = String(state.resources.find(resource => resource.id === state.nodes.find(node => node.id === nodeId)?.resourceId)?.data.sessionId);
    return results.get(sessionId) ?? { state: 'running' };
  };
  const findingsCoordinator = new ReviewFindingsCoordinator(store, control, result, sessions, async () => {}, () => true, spawner);
  const make = () => new ReviewLoops({ storage: store.pluginStorage('code.review'), store, control, resources, reviews, findings: findingsCoordinator, sessions, changed: async () => {}, now: () => now });
  let loops = make();
  const run = (input: object, nodeId = 'pr') => loops.run(nodeId, input) as Promise<Record<string, any>>;
  const arm = (rounds = 3) => run({ operation: 'set', value: `arm:${rounds}`, sourceResourceId: 'pr-r', requestId: randomUUID(), provider: 'claude', model: 'opus' });
  const record = () => store.pluginStorage('code.review').get(REVIEW_LOOP_COLLECTION, 'pr-r')?.value as unknown as ReviewLoopRecord | undefined;
  const pass = async (minutes = 1) => { now += minutes * MIN; await findingsCoordinator.reconcile(); await loops.reconcile(); await findingsCoordinator.reconcile(); };
  const reviewNode = (round: number) => record()!.rounds.find(entry => entry.round === round)!.reviewNodeId!;
  const finish = async (round: number, review: ReviewFindings | 'text' | 'failed') => {
    const nodeId = reviewNode(round), state = await control.read(), sessionId = String(state.resources.find(resource => resource.id === state.nodes.find(node => node.id === nodeId)?.resourceId)?.data.sessionId);
    results.set(sessionId, review === 'failed' ? { state: 'failed', markdown: '' } : { state: 'complete', markdown: review === 'text' ? 'Looks fine to me.' : JSON.stringify(review), truncated: false });
    await apply([{ type: 'node.update', id: nodeId, activity: review === 'failed' ? 'unknown' : 'complete' }]);
  };
  const report = (round: number, ids: string[]) => findingsCoordinator.run(reviewNode(round), { operation: 'report', agentNodeId: record()!.fixerNodeId!, findingIds: ids, commit: 'abcdef1' });
  const push = () => { github.heads++; github.head = String(github.heads + 1).repeat(40).slice(0, 40); };
  const attention = async () => { const node = (await control.read()).nodes.find(entry => entry.id === 'pr'); return [node?.attentionSources?.['review-loop'] ?? null, node?.attentionNotes?.['review-loop'] ?? null]; };
  const line = async () => (await run({ operation: 'status' })).line;
  return { directory, store, control, apply, github, starts, jobs, prompts, spawned, findings: findingsCoordinator, run, arm, record, pass, finish, report, push, attention, line, reviewNode,
    restart: () => { loops = make(); }, setNow: (value: number) => { now = value; }, failDelivery: () => { deliveryFails = true; } };
}

test('arming confirms reviewer, fixer and limit, is human-only, and Stop ends it quietly before the next review', async () => {
  const f = await fixture();
  const options = await f.run({ operation: 'options' }) as { prompt: string; context: JsonObject; options: { id: string; label: string; confirm?: { prompt: string; note?: string; action: string } }[] };
  assert.deepEqual(options.context, { sourceResourceId: 'pr-r', provider: 'claude', model: 'opus' });
  assert.deepEqual(options.options.map(option => option.id), ['arm:3', 'arm:1', 'arm:2', 'arm:4', 'arm:5']);
  const three = options.options[0].confirm!;
  assert.equal(three.prompt, 'Start a review loop on #42?');
  assert.equal(three.action, 'Start review loop');
  assert.match(three.note!, /Reviewer: Claude · opus\. Fixer: Claude · impl\. Up to 3 reviews and 3 fix requests\. The fixer pushes to feature\/cart\. Nothing is merged or approved\./);
  assert.deepEqual(await f.run({ operation: 'status' }), { state: 'off' });
  const armed = await f.arm();
  assert.deepEqual([armed.state, armed.line], ['armed', 'Review loop · reviewing (round 1 of 3)']);
  assert.equal(f.starts.length, 0, 'the first review starts on the service pass, not in the request');
  const stopped = await f.run({ operation: 'set', value: 'stop', sourceResourceId: 'pr-r', requestId: randomUUID() });
  assert.deepEqual([stopped.state, stopped.line], ['stopped', 'Review loop · stopped']);
  const before = f.starts.length;
  await f.pass(); await f.pass();
  assert.equal(f.starts.length, before, 'nothing starts after Stop');
  assert.deepEqual(await f.attention(), [null, null], 'Stop raises no Needs me');
  for (const operation of ['status', 'options']) assert.equal(agentRuntimeRefusal({ action: REVIEW_LOOP_OPERATION, arguments: { operation } }), undefined);
  assert.equal(agentRuntimeRefusal({ action: REVIEW_LOOP_OPERATION, arguments: { operation: 'set', value: 'arm:3' } }), humanOnlyMessage);
  await assert.rejects(f.run({ operation: 'set', value: 'arm:3', sourceResourceId: 'other-r', requestId: randomUUID() }), /another item/);
});

test('three rounds: only critical, high and security findings go to one fixer, rounds chain from the previous review, and the loop ends clean', async () => {
  const f = await fixture();
  await f.arm(); await f.pass();
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].input.loop, undefined, 'round 1 is an ordinary review of the pull request');
  assert.equal(await f.line(), 'Review loop · reviewing (round 1 of 3)');
  await f.finish(1, findings(finding('F1', 'Totals drift'), finding('F2', 'Slow sort', { severity: 'medium' }), finding('F3', 'Typo', { severity: 'low' })));
  await f.pass();
  assert.equal(f.prompts.length, 1);
  assert.match(f.prompts[0].data, /Fix only F1\./); assert.match(f.prompts[0].data, /Review loop round 1 of 3/); assert.match(f.prompts[0].data, /push the fix to feature\/cart/);
  assert.equal(f.record()!.fixerNodeId, 'impl');
  assert.equal(await f.line(), 'Review loop · round 1 of 3 · Claude · impl is fixing 1');
  await f.report(1, ['F1']); await f.pass();
  assert.equal(await f.line(), 'Review loop · waiting for Claude · impl to push');
  f.push(); await f.pass();
  assert.equal(f.starts.length, 2);
  const loop = f.starts[1].input.loop as { round: number; from: string; context: string };
  assert.deepEqual([loop.round, loop.from], [2, f.reviewNode(1)]);
  assert.match(loop.context, /Totals drift \(fixed in round 1\)/);
  assert.equal(await f.line(), 'Review loop · reviewing (round 2 of 3)');
  await f.finish(2, findings(finding('F1', 'Refunds skip the ledger', { severity: 'critical' }), finding('F2', 'Slow sort', { severity: 'medium' })));
  await f.pass();
  assert.equal(f.prompts.length, 2); assert.match(f.prompts[1].data, /Fix only F1\./); assert.match(f.prompts[1].data, /Review loop round 2 of 3/);
  assert.equal(f.record()!.fixerNodeId, 'impl', 'the same fixer every round');
  await f.report(2, ['F1']); f.push(); await f.pass();
  await f.finish(3, findings(finding('F1', 'Slow sort', { severity: 'medium' }), finding('F2', 'Typo', { severity: 'low' })));
  await f.pass();
  const done = await f.run({ operation: 'status' });
  assert.deepEqual([done.state, done.line], ['clean', 'Review loop · clean after 3 rounds · 1 medium, 1 low left for you']);
  assert.deepEqual(done.rounds.map((entry: { round: number; reviewNodeId: string }) => [entry.round, entry.reviewNodeId]), [[1, 'review-1'], [2, 'review-2'], [3, 'review-3']]);
  assert.deepEqual(await f.attention(), ['finished', 'Review loop clean']);
  assert.deepEqual([new Set(f.starts.map(start => start.requestId)).size, f.prompts.length], [3, 2]);
  const state = await f.control.read();
  assert.ok(state.links.some(link => link.sourceId === 'review-1' && link.targetId === 'review-2' && link.label === 'Round 2'));
  assert.ok(state.links.some(link => link.sourceId === 'review-2' && link.targetId === 'review-3'));
});

test('a first review without anything critical, high or security is clean at round 1', async () => {
  const f = await fixture();
  await f.arm(); await f.pass();
  await f.finish(1, findings(finding('F1', 'Slow sort', { severity: 'medium' }), finding('F2', 'Harden input', { kind: 'hardening', severity: undefined })));
  await f.pass();
  assert.equal(await f.line(), 'Review loop · clean after 1 round · 1 medium, 1 hardening left for you');
  assert.equal(f.prompts.length, 0);
  await f.pass(); assert.equal(f.starts.length, 1);
});

test('out of rounds halts with Needs me and sends nothing more', async () => {
  const f = await fixture();
  await f.arm(1); await f.pass();
  await f.finish(1, findings(finding('F1', 'Totals drift'), finding('F2', 'Leaks the token', { kind: 'security', severity: undefined })));
  await f.pass();
  assert.equal(await f.line(), 'Review loop · halted: out of rounds · 1 high, 1 security still open');
  assert.deepEqual(await f.attention(), ['error', 'Review loop halted']);
  assert.equal(f.prompts.length, 0);
});

test('an ignored finding is counted out, a security finding in, medium and low are never sent', async () => {
  const f = await fixture();
  await f.arm(); await f.pass();
  await f.finish(1, findings(finding('F1', 'Totals drift'), finding('F2', 'Leaks the token', { kind: 'security', severity: undefined }), finding('F3', 'Slow sort', { severity: 'medium' }), finding('F4', 'Typo', { severity: 'low' })));
  await f.findings.run(f.reviewNode(1), { operation: 'mark', reviewSessionId: 'run-1', findingIds: ['F1'], status: 'fixed' });
  await f.pass();
  assert.equal(f.prompts.length, 1);
  assert.match(f.prompts[0].data, /Fix only F2\./);
  assert.doesNotMatch(f.prompts[0].data.split('<review>')[0], /Totals drift|Slow sort|Typo/);
  await f.report(1, ['F2']); f.push(); await f.pass();
  assert.match(String((f.starts[1].input.loop as { context: string }).context), /ignore[\s\S]*Totals drift/);
  await f.finish(2, findings(finding('F1', 'Totals drift.')));
  await f.pass();
  assert.equal(await f.line(), 'Review loop · clean after 2 rounds', 'a finding ignored earlier stays ignored when it is raised again');
});

test('a finding fixed earlier that comes back is marked seen and sent once; its next return halts', async () => {
  const f = await fixture();
  await f.arm(4); await f.pass();
  await f.finish(1, findings(finding('F1', 'Totals drift')));
  await f.pass(); await f.report(1, ['F1']); f.push(); await f.pass();
  await f.finish(2, findings(finding('F1', 'Totals  drift')));
  await f.pass();
  assert.equal(f.prompts.length, 2, 'the first return is sent again');
  const view = await f.run({ operation: 'status' }, f.reviewNode(2));
  assert.deepEqual([view.round, view.seen, view.pullNumber, view.rounds.length], [2, { F1: 1 }, 42, 2]);
  await f.report(2, ['F1']); f.push(); await f.pass();
  await f.finish(3, findings(finding('F1', 'totals drift')));
  await f.pass();
  assert.equal(await f.line(), 'Review loop · halted: Totals drift came back after being fixed');
  assert.equal(f.prompts.length, 2);
  assert.deepEqual(await f.attention(), ['error', 'Review loop halted']);
});

test('without a ready connected agent a new agent of the reviewer starts in the project folder and fixes every round', async () => {
  const f = await fixture({ agent: 'working' });
  await f.arm(); await f.pass();
  await f.finish(1, findings(finding('F1', 'Totals drift')));
  await f.pass();
  assert.equal(f.spawned.length, 1);
  assert.deepEqual([f.spawned[0].data.provider, f.spawned[0].data.cwd, f.spawned[0].projectId], ['claude', '/work/web', 'web']);
  const fixer = f.record()!.fixerNodeId!;
  assert.equal(fixer, f.spawned[0].nodeId);
  assert.equal(f.prompts.length, 1); assert.equal(f.prompts[0].sessionId, `${fixer}-session`);
  await f.report(1, ['F1']); f.push(); await f.pass();
  await f.finish(2, findings(finding('F1', 'Refunds skip the ledger')));
  await f.pass();
  assert.equal(f.spawned.length, 1, 'no second agent');
  assert.equal(f.prompts.length, 2); assert.equal(f.prompts[1].sessionId, `${fixer}-session`);
  assert.ok((await f.control.read()).links.some(link => link.sourceId === f.reviewNode(2) && link.targetId === fixer), 'the fixer is connected to each round it fixes');
});

test('without any agent or project folder the loop halts instead of guessing', async () => {
  const f = await fixture({ agent: 'none', workingDirectory: false });
  await f.arm(); await f.pass();
  await f.finish(1, findings(finding('F1', 'Totals drift')));
  await f.pass();
  assert.match(await f.line(), /^Review loop · halted: no agent can fix the findings: Set a working directory/);
});

test('a restart resumes without starting a review or sending findings twice; a send never journaled is sent once', async () => {
  const f = await fixture();
  await f.arm(); await f.pass();
  f.restart(); await f.pass(); await f.pass();
  assert.equal(f.starts.length, 1);
  await f.finish(1, findings(finding('F1', 'Totals drift')));
  await f.pass();
  assert.equal(f.prompts.length, 1);
  f.restart(); await f.pass(); await f.pass();
  assert.equal(f.prompts.length, 1);
  const recorded = f.record()!, sendId = recorded.rounds[0].send!.id;
  assert.equal(f.store.reviewSend(sendId)?.state, 'sent');

  const g = await fixture();
  await g.arm(); await g.pass();
  await g.finish(1, findings(finding('F1', 'Totals drift')));
  const saved = g.record()!, sendAt = T0 + 2 * MIN;
  g.store.pluginStorage('code.review').put(REVIEW_LOOP_COLLECTION, 'pr-r', { ...saved, step: 'fixing', fixerNodeId: 'impl', fixerTitle: 'Claude · impl',
    rounds: saved.rounds.map(entry => ({ ...entry, reviewNodeId: 'review-1', reviewSessionId: 'run-1', headSha: 'a'.repeat(40), send: { id: randomUUID(), findingIds: ['F1'], at: sendAt } })) } as never);
  g.restart(); await g.pass(); await g.pass();
  assert.equal(g.prompts.length, 1);
  assert.equal(g.store.reviewSend(g.record()!.rounds[0].send!.id)?.state, 'sent');
});

test('a delivery whose outcome is unknown halts and is never sent again', async () => {
  const f = await fixture();
  await f.arm(); await f.pass();
  await f.finish(1, findings(finding('F1', 'Totals drift')));
  f.failDelivery(); await f.pass(); await f.pass();
  assert.match(await f.line(), /^Review loop · halted: the fix request to Claude · impl could not be confirmed/);
  assert.equal(f.store.reviewSend(f.record()!.rounds[0].send!.id)?.state, 'uncertain');
  assert.deepEqual(await f.attention(), ['error', 'Review loop halted']);
});

test('no report or no push within 45 minutes halts; a fixer that leaves the map halts', async () => {
  const f = await fixture();
  await f.arm(); await f.pass();
  await f.finish(1, findings(finding('F1', 'Totals drift')));
  await f.pass();
  await f.report(1, ['F1']);
  await f.pass(PUSH_DEADLINE_MS / MIN);
  assert.equal(await f.line(), 'Review loop · halted: Claude · impl reported fixes but pushed no new commit within 45 minutes');

  const g = await fixture();
  await g.arm(); await g.pass();
  await g.finish(1, findings(finding('F1', 'Totals drift')));
  await g.pass();
  await g.apply([{ type: 'node.archive', id: 'impl' }]);
  await g.pass();
  assert.equal(await g.line(), 'Review loop · halted: Claude · impl is no longer on the map');
});

test('a review that fails or returns text, or a pull request that closes, halts', async () => {
  const f = await fixture();
  await f.arm(); await f.pass();
  await f.finish(1, 'text'); await f.pass();
  assert.match(await f.line(), /^Review loop · halted: the round 1 review returned text, not findings/);

  const g = await fixture();
  await g.arm(); await g.pass();
  g.github.state = 'closed'; await g.pass();
  assert.equal(await g.line(), 'Review loop · halted: the pull request was closed');
  await assert.rejects(g.arm(), /closed/);
});
