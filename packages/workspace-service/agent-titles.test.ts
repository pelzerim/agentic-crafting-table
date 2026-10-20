import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspaceControl } from '../core/control.ts';
import type { WorkspaceCommand } from '../core/control.ts';
import { SqliteStore } from './sqlite-store.ts';
import { AgentTitles, AGENT_TITLE_INTERVAL_MS, AGENT_TITLE_WORKING_MS } from './agent-titles.ts';
import type { ActivitySummaryClient } from '../../src/agents/activity-summary.ts';
import type { SessionSnapshot } from '../session-runtime/protocol.ts';

type Fixture = { directory: string; store: SqliteStore; control: WorkspaceControl; apply(command: WorkspaceCommand, actor?: 'user' | 'system'): Promise<void>; titles(client: ActivitySummaryClient, clock?: () => number): AgentTitles; output: { text: string } };
async function fixture(run: (value: Fixture) => Promise<void>, title = 'Claude session') {
  const directory = await mkdtemp(join(tmpdir(), 'craft-agent-titles-'));
  const store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store), output = { text: 'Investigating the cache refresh loop\npassword=FAKE_SECRET' };
  const created: AgentTitles[] = [];
  let current: AgentTitles | undefined;
  const apply = async (command: WorkspaceCommand, actor: 'user' | 'system' = 'user') => {
    const result = await control.dispatch({ commandId: randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: actor, id: 'fixture' }, commands: [command] });
    current?.observe(result.state);
  };
  const titles = (client: ActivitySummaryClient, clock = () => 1_000_000) => {
    current = new AgentTitles(store, control, async () => snapshot(output.text), async () => {}, () => true, directory, client, clock, 50);
    created.push(current); return current;
  };
  try {
    await apply({ type: 'item.create', id: 'agent', position: { x: 30, y: 40 }, resource: { id: 'agent-r', pluginId: 'agent.session', schemaVersion: 1, title, data: { sessionId: 'session', provider: 'claude', cwd: join(directory, 'notes') } } });
    await apply({ type: 'item.add', id: 'pr', resourceId: 'pr-r', pluginId: 'github.pull-request', title: 'Cache refresh never stops', data: { owner: 'acme', repo: 'notes', number: 7 }, position: { x: 600, y: 40 } });
    await apply({ type: 'link.save', link: { id: 'context', sourceId: 'pr', targetId: 'agent', kind: 'context', label: '' } });
    await run({ directory, store, control, apply, titles, output });
  } finally { for (const titles of created) await titles.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
}
const snapshot = (output: string): SessionSnapshot => ({
  session: { id: 'session', requestId: 'request', nodeId: 'agent', workspaceId: 'workspace', cwd: '/tmp', state: 'running', cols: 80, rows: 24, createdAt: '', updatedAt: '' },
  chunks: [{ sequence: 1, data: output }], firstSequence: 1, lastSequence: 1, truncated: false,
});
const turn = async (apply: Fixture['apply']) => { await apply({ type: 'node.update', id: 'agent', activity: 'working' }, 'system'); await apply({ type: 'node.update', id: 'agent', activity: 'idle' }, 'system'); };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const node = async (control: WorkspaceControl) => (await control.read()).nodes.find(node => node.id === 'agent')!;
function limit(store: SqliteStore, summaries: Record<string, unknown>) {
  const settings = store.readSettings(); store.writeSettings({ expectedRevision: settings.revision, value: { ...settings.value, summaries: { ...settings.value.summaries, ...summaries } } });
}

test('a finished turn names a default-titled agent from its redacted output and linked items, once per fingerprint', () => fixture(async ({ store, control, apply, titles, output }) => {
  const requests: any[] = []; let now = 1_000_000;
  const service = titles({ async complete(request) { requests.push(request); return '"Fix cache refresh loop."'; } }, () => now);
  assert.equal(store.readSettings().value.summaries.agentTitles, true);
  service.start(); await service.tick(); assert.equal(requests.length, 0, 'no turn has been observed yet');
  await turn(apply); await service.tick();
  assert.equal(requests.length, 1);
  const input = JSON.parse(requests[0].messages[0].content);
  assert.equal(requests[0].model, 'haiku'); assert.equal(input.currentTitle, null); assert.equal(input.directory, 'notes'); assert.deepEqual(input.linked, ['Cache refresh never stops']);
  assert.match(input.recentOutput, /cache refresh loop/); assert.doesNotMatch(input.recentOutput, /FAKE_SECRET/);
  const named = await control.read(), agent = named.nodes.find(node => node.id === 'agent')!;
  assert.equal(agent.title, 'Fix cache refresh loop'); assert.equal(agent.generatedTitle, 'Fix cache refresh loop');
  assert.equal(named.resources.find(resource => resource.id === 'agent-r')!.title, 'Fix cache refresh loop');
  // Unchanged evidence is not sent again, even after the item interval.
  now += AGENT_TITLE_INTERVAL_MS; await turn(apply); await service.tick(); assert.equal(requests.length, 1);
  output.text += '\nNow also fixing the search index';
  await turn(apply); await service.tick(); assert.equal(requests.length, 2);
  assert.equal(JSON.parse(requests[1].messages[0].content).currentTitle, 'Fix cache refresh loop');
  output.text += '\nAnd the cache metrics'; now += AGENT_TITLE_INTERVAL_MS - 1;
  await turn(apply); await service.tick(); assert.equal(requests.length, 2, 'attempts are rate limited per item');
  now += 1; await service.tick(); assert.equal(requests.length, 3);
}));

test('KEEP, equivalent titles, the item interval and the shared allowance all avoid churn', () => fixture(async ({ store, control, apply, titles, output }) => {
  let now = 1_000_000, answer = 'Fix cache refresh loop', calls = 0;
  const service = titles({ async complete(request) { calls++; if (calls > 1) assert.equal(JSON.parse(request.messages[0].content).currentTitle, 'Fix cache refresh loop'); return answer; } }, () => now);
  service.start(); await turn(apply); await service.tick(); assert.equal(calls, 1);
  const revision = (await control.read()).revision;
  answer = 'KEEP'; output.text += '\nmore work'; now += AGENT_TITLE_INTERVAL_MS;
  await turn(apply); await service.tick(); assert.equal(calls, 2); assert.equal((await node(control)).title, 'Fix cache refresh loop');
  answer = 'fix cache-refresh loop'; output.text += '\neven more work'; now += AGENT_TITLE_INTERVAL_MS;
  await turn(apply); const before = (await control.read()).revision; await service.tick(); assert.equal(calls, 3);
  assert.equal((await control.read()).revision, before, 'an equivalent title is not written'); assert.ok(before > revision);
  answer = 'Search index triage'; output.text += '\nswitched to the search index'; now += AGENT_TITLE_INTERVAL_MS - 1;
  await turn(apply); await service.tick(); assert.equal(calls, 3);
  now += 1; await service.tick(); assert.equal(calls, 4); assert.equal((await node(control)).title, 'Search index triage');
  limit(store, { requestsPerHour: 1 }); output.text += '\nand a new task'; now += AGENT_TITLE_INTERVAL_MS;
  await turn(apply); await service.tick(); assert.equal(calls, 4, 'hourly allowance is shared and exhausted');
  limit(store, { requestsPerHour: 12, agentTitles: false }); await service.tick(); assert.equal(calls, 4, 'setting off');
  limit(store, { agentTitles: true }); await service.tick(); assert.equal(calls, 5);
}));

test('a user rename stops automation and Auto-name from activity hands it back immediately', () => fixture(async ({ store, control, apply, titles, output }) => {
  let now = 1_000_000, calls = 0;
  const service = titles({ async complete() { calls++; return calls === 1 ? 'Fix cache refresh loop' : 'Search index cleanup'; } }, () => now);
  service.start(); await turn(apply); await service.tick(); assert.equal(calls, 1);
  await apply({ type: 'node.update', id: 'agent', title: 'My cache work' });
  output.text += '\nsearch index'; now += AGENT_TITLE_INTERVAL_MS;
  await turn(apply); await service.tick(); assert.equal(calls, 1); assert.equal((await node(control)).title, 'My cache work');
  now += 1000; await service.request('agent'); await service.tick();
  assert.equal(calls, 2); const agent = await node(control);
  assert.equal(agent.title, 'Search index cleanup'); assert.equal(agent.generatedTitle, 'Search index cleanup');
  // Handing back bypasses the per-item interval and unchanged fingerprint once.
  await service.request('agent'); await service.tick(); assert.equal(calls, 3);
  limit(store, { agentTitles: false });
  await assert.rejects(service.request('agent'), /Auto-title agents/);
}));

test('an agent titled at creation, a plain terminal and off-map agents are never renamed', async () => {
  await fixture(async ({ control, apply, titles }) => {
    let calls = 0; const service = titles({ async complete() { calls++; return 'Fix cache refresh loop'; } });
    service.start(); await turn(apply); await service.tick(); assert.equal(calls, 0); assert.equal((await node(control)).title, 'Release follow-up work');
  }, 'Release follow-up work');
  await fixture(async ({ control, apply, titles }) => {
    let calls = 0; const service = titles({ async complete() { calls++; return 'Fix cache refresh loop'; } });
    await apply({ type: 'item.create', id: 'shell', position: { x: 30, y: 400 }, resource: { id: 'shell-r', pluginId: 'terminal.session', schemaVersion: 1, title: 'Terminal', data: { sessionId: 'shell-session', workspaceId: 'w', cwd: '/tmp', shell: '/bin/sh' } } });
    await apply({ type: 'node.update', id: 'shell', activity: 'working' }, 'system'); await apply({ type: 'node.update', id: 'shell', activity: 'idle' }, 'system');
    await apply({ type: 'node.below', id: 'agent' });
    service.start(); await turn(apply); await service.tick(); assert.equal(calls, 0);
    await assert.rejects(service.request('agent'), /back to the map/); await assert.rejects(service.request('shell'), /agent items/);
    await apply({ type: 'node.surface', id: 'agent' }); await apply({ type: 'node.archive', id: 'agent' });
    await turn(apply); await service.tick(); assert.equal(calls, 0);
    assert.equal((await control.read()).nodes.find(node => node.id === 'shell')!.title, 'Terminal');
  });
});

test('a rename, archive or setting change during generation discards the generated title', () => fixture(async ({ store, control, apply, titles, output }) => {
  let now = 1_000_000, signal!: AbortSignal, calls = 0, pending = deferred<string>();
  const service = titles({ complete(_request, aborted) { calls++; signal = aborted; return pending.promise; } }, () => now);
  service.start(); await turn(apply);
  let tick = service.tick(); await new Promise(done => setImmediate(done)); assert.equal(calls, 1);
  await apply({ type: 'node.update', id: 'agent', title: 'Named while waiting' });
  assert.equal(signal.aborted, true); pending.resolve('Fix cache refresh loop'); await tick;
  assert.equal((await node(control)).title, 'Named while waiting');
  // Even an unobserved rename is refused by the graph's source-title guard.
  await apply({ type: 'node.update', id: 'agent', title: 'Claude session' });
  await assert.rejects(control.dispatch({ commandId: 'stale', expectedRevision: (await control.read()).revision, actor: { kind: 'system', id: 'agent-title' }, commands: [{ type: 'node.title.generated', id: 'agent', title: 'Stale title', sourceTitle: 'Named while waiting' }] }), /changed before/);
  pending = deferred(); output.text += '\nnew'; now += AGENT_TITLE_INTERVAL_MS; await turn(apply);
  tick = service.tick(); await new Promise(done => setImmediate(done)); assert.equal(calls, 2);
  await apply({ type: 'node.archive', id: 'agent' }); assert.equal(signal.aborted, true); pending.resolve('Late archive title'); await tick;
  assert.equal((await node(control)).title, 'Claude session');
  await apply({ type: 'node.restore', id: 'agent' });
  pending = deferred(); output.text += '\nnewer'; now += AGENT_TITLE_INTERVAL_MS; await turn(apply);
  tick = service.tick(); await new Promise(done => setImmediate(done)); assert.equal(calls, 3);
  limit(store, { agentTitles: false }); service.settingsChanged(); assert.equal(signal.aborted, true); pending.resolve('Late settings title'); await tick;
  assert.equal((await node(control)).title, 'Claude session');
}));

test('a long turn is named while working, after a minute rather than at its end', () => fixture(async ({ control, apply, titles }) => {
  let now = 1_000_000, calls = 0;
  const service = titles({ async complete(request) { calls++; assert.equal(JSON.parse(request.messages[0].content).status, 'working'); return 'Fix cache refresh loop'; } }, () => now);
  service.start(); await apply({ type: 'node.update', id: 'agent', activity: 'working' }, 'system');
  now += AGENT_TITLE_WORKING_MS - 1; await service.tick(); assert.equal(calls, 0);
  now += 1; await service.tick(); assert.equal(calls, 1); assert.equal((await node(control)).title, 'Fix cache refresh loop');
}));

test('a generated title that is itself a leaked KEEP explanation is replaced, not offered for keeping', () => fixture(async ({ control, apply, titles }) => {
  await apply({ type: 'node.title.generated', id: 'agent', title: 'The currentTitle still fits', sourceTitle: 'Claude session' }, 'system');
  let sent: unknown;
  const service = titles({ async complete(request) { sent = JSON.parse(request.messages[0].content).currentTitle; return 'Fix cache refresh loop'; } });
  service.start(); await turn(apply); await service.tick();
  assert.equal(sent, null);
  assert.equal((await node(control)).title, 'Fix cache refresh loop');
}));
