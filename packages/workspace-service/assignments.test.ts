import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { AssignmentCoordinator } from './assignments.ts';
import type { DiscoveredAssignment, AssignmentAdapter } from './assignments.ts';
import { SqliteStore } from './sqlite-store.ts';
import { WorkspaceControl } from '../core/control.ts';
import type { ProviderConnection } from '../core/connections.ts';
import { attentionItems } from '../../src/graph/attention.ts';

const discovered = (number: number, assigned = true): DiscoveredAssignment => ({ data: { owner: 'fixture', repo: 'repo', number }, title: `PR ${number}`, assigned });
async function fixture(run: (input: {
  store: SqliteStore; control: WorkspaceControl; watcher: AssignmentCoordinator; connections: ProviderConnection[]; calls: number;
  set(items: DiscoveredAssignment[]): void; fail(error?: Error): void; delay(callback: (signal: AbortSignal) => Promise<void>): void; advance(ms: number): void; restart(): Promise<void>;
  apply(commands: unknown[]): Promise<void>;
}) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'craft-assignments-')), file = join(directory, 'workspace.sqlite');
  const connections = [{ id: 'github-one', providerId: 'github', account: 'fixture', enabled: true, isDefault: true }];
  let store = new SqliteStore(file), control = new WorkspaceControl(store), items: DiscoveredAssignment[] = [], failure: Error | undefined, delay: ((signal: AbortSignal) => Promise<void>) | undefined, now = 1_000_000, calls = 0;
  const adapter: AssignmentAdapter = { providerId: 'github', pluginId: 'github.pull-request', attentionNote: 'Assigned to you', key: data => `${data.owner}/${data.repo}/${data.number}`, group: data => `${data.owner}/${data.repo}`,
    async discover(_connection, _previous, signal) { calls++; await delay?.(signal); if (failure) throw failure; return structuredClone(items); } };
  const create = () => new AssignmentCoordinator(store, control, [adapter], () => connections, async () => {}, () => true, () => now);
  let watcher = create();
  const input = { get store() { return store; }, get control() { return control; }, get watcher() { return watcher; }, connections, get calls() { return calls; },
    set(value: DiscoveredAssignment[]) { items = value; }, fail(error?: Error) { failure = error; }, delay(callback: (signal: AbortSignal) => Promise<void>) { delay = callback; }, advance(ms: number) { now += ms; },
    async restart() { await watcher.pause(); store.close(); store = new SqliteStore(file); control = new WorkspaceControl(store); watcher = create(); },
    async apply(commands: unknown[]) { await control.dispatch({ commandId: randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'test' }, commands }); },
  };
  try { await run(input); } finally { await watcher.pause(); store.close(); rmSync(directory, { recursive: true, force: true }); }
}
const project = (id: string) => ({ type: 'project.create', id, title: id, position: { x: 0, y: 0 } });
const pr = (id: string, number: number, projectId?: string) => ({ type: 'item.add', id, resourceId: id, pluginId: 'github.pull-request', title: `PR ${number}`, data: discovered(number).data, projectId, position: { x: 300, y: 0 } });

test('assignment sync reuses agent items, maps one repository project and preserves independent reasons across viewed cycles/restart', () => fixture(async input => {
  await input.apply([project('billing'), pr('existing', 42, 'billing'), { type: 'node.update', id: 'existing', attention: 'input' }]);
  input.set([discovered(42), discovered(43)]); await input.watcher.refresh();
  let state = await input.control.read(); assert.equal(state.resources.length, 2); assert.equal(state.nodes.filter(node => node.projectId === 'billing').length, 2);
  assert.equal(state.nodes.filter(node => node.title === 'PR 42').length, 1); assert.equal(attentionItems(state.nodes).length, 2);
  assert.deepEqual(attentionItems(state.nodes).map(item => item.notes), [['Assigned to you'], ['Assigned to you']]);
  const receipt = (await input.watcher.receipt('existing'))!; assert.ok(receipt);
  assert.deepEqual(await input.watcher.viewed('existing', receipt), { acknowledged: true });
  state = await input.control.read(); assert.equal(state.nodes.find(node => node.id === 'existing')?.attention, 'input');
  assert.equal(state.nodes.find(node => node.id === 'existing')?.attentionSources, undefined);
  const revision = state.revision; await input.watcher.refresh(); assert.equal((await input.control.read()).revision, revision); assert.equal(await input.watcher.receipt('existing'), undefined);
  await input.restart(); await input.watcher.refresh(); assert.equal(await input.watcher.receipt('existing'), undefined); assert.equal((await input.control.read()).revision, revision);
  input.set([discovered(43)]); await input.watcher.refresh(); input.set([discovered(42), discovered(43)]); await input.watcher.refresh();
  const next = (await input.watcher.receipt('existing'))!; assert.notEqual(next.cycle, receipt.cycle);
  assert.equal((await input.watcher.viewed('existing', receipt)).acknowledged, false); assert.equal((await input.watcher.viewed('existing', next)).acknowledged, true);
}));

test('ambiguous mappings stay floating, accounts keep separate identities, and archive/delete are respected', () => fixture(async input => {
  await input.apply([project('one'), project('two'), pr('reference-one', 10, 'one'), pr('reference-two', 11, 'two')]);
  input.set([discovered(42)]); await input.watcher.refresh();
  let state = await input.control.read(), node = state.nodes.find(node => node.title === 'PR 42')!; assert.equal(node.projectId, undefined);
  await input.apply([{ type: 'node.complete', id: node.id }]); assert.equal(attentionItems((await input.control.read()).nodes).length, 1);
  await input.apply([{ type: 'node.archive', id: node.id }]); await input.watcher.refresh(); assert.equal(attentionItems((await input.control.read()).nodes).length, 0); assert.ok((await input.control.read()).nodes.find(item => item.id === node.id)?.archivedAt);
  await input.apply([{ type: 'node.archive', id: node.id }, { type: 'node.delete', id: node.id }]); await input.watcher.refresh(); assert.equal((await input.control.read()).nodes.some(node => node.title === 'PR 42'), false);
  input.set([]); await input.watcher.refresh(); input.set([discovered(42)]); await input.watcher.refresh();
  assert.notEqual((await input.control.read()).nodes.find(node => node.title === 'PR 42')!.id, node.id);
  input.connections.push({ id: 'github-two', providerId: 'github', account: 'other', enabled: true, isDefault: false }); await input.watcher.refresh();
  state = await input.control.read(); assert.equal(state.resources.filter(resource => resource.data.number === 42).length, 2);
}));

test('failed or partial discovery preserves attention and rate-limit backoff survives restart', () => fixture(async input => {
  input.set([discovered(42)]); await input.watcher.refresh(); const before = await input.control.read();
  input.set([]); input.fail(Object.assign(new Error('GitHub rate limit reached'), { retryAt: 4_600_000 }));
  await input.watcher.refresh(); assert.deepEqual(await input.control.read(), before); assert.match(input.watcher.status()[0].error!, /rate limit/);
  const calls = input.calls; await input.restart(); await input.watcher.refresh(); assert.equal(input.calls, calls); assert.deepEqual(await input.control.read(), before);
  input.fail(); input.advance(3600_001); await input.watcher.refresh(); assert.equal(attentionItems((await input.control.read()).nodes).length, 0);
}));

test('disconnect/shutdown during discovery cannot create items or clear attention', () => fixture(async input => {
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  input.delay(signal => new Promise((_resolve, reject) => { started(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); })); input.set([discovered(42)]);
  const syncing = input.watcher.refresh(); await ready; await input.watcher.pause(); await syncing;
  assert.equal((await input.control.read()).nodes.length, 0);
}));

test('a connection disabled during a completed read cannot commit its observations', () => fixture(async input => {
  input.set([discovered(42)]); input.delay(async () => { input.connections[0].enabled = false; });
  await input.watcher.refresh(); assert.equal((await input.control.read()).nodes.length, 0);
}));
