import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore, migrations } from './sqlite-store.ts';
import { WorkspaceControl } from '../core/control.ts';
import type { WorkspaceCommand } from '../core/control.ts';
import { startWorkspaceService } from './server.ts';
import { connectWorkspace } from './client.ts';

async function fixture(run: (store: SqliteStore, control: WorkspaceControl, clock: { now: number }, file: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-attention-history-')), file = join(directory, 'workspace.sqlite');
  const clock = { now: 1_000 }, store = new SqliteStore(file, { now: () => clock.now }), control = new WorkspaceControl(store);
  try {
    const apply = (command: WorkspaceCommand) => control.dispatch({ commandId: crypto.randomUUID(), expectedRevision: 0, actor: { kind: 'user', id: 'test' }, commands: [command] });
    await apply({ type: 'project.create', id: 'billing', title: 'Billing', summary: '', position: { x: 0, y: 0 } });
    await run(store, control, clock, file);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}
async function run(control: WorkspaceControl, ...commands: WorkspaceCommand[]) {
  const { revision } = await control.read();
  return control.dispatch({ commandId: crypto.randomUUID(), expectedRevision: revision, actor: { kind: 'user', id: 'test' }, commands });
}
const note = (id: string, title = id): WorkspaceCommand => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'workspace.note', title, data: { text: title }, projectId: 'billing', position: { x: 100, y: 100 } });
const finish = (id: string, eventId: string): WorkspaceCommand => ({ type: 'attention.set', id, source: 'completion', reason: 'finished', eventId });
async function acknowledge(control: WorkspaceControl, id: string) {
  const node = (await control.read()).nodes.find(node => node.id === id)!;
  return run(control, { type: 'attention.acknowledge', id, versions: { [id]: node.attentionVersion ?? 0 } });
}

test('seeing a Needs me cycle records one snapshot entry with raise and seen times', () => fixture(async (store, control, clock) => {
  await run(control, note('agent', 'Claude · implementation'));
  clock.now = 2_000; await run(control, finish('agent', 'turn-1'));
  assert.deepEqual(store.attentionHistory().entries, [], 'active attention is not history yet');
  clock.now = 3_000; await run(control, { type: 'node.update', id: 'agent', summary: 'unrelated' });
  clock.now = 4_000; await acknowledge(control, 'agent');
  clock.now = 5_000; await acknowledge(control, 'agent'); await run(control, finish('agent', 'turn-1'));
  assert.deepEqual(store.attentionHistory(), { more: false, entries: [{ key: 'agent-r:1', nodeId: 'agent', resourceId: 'agent-r', title: 'Claude · implementation', reasons: ['finished'], project: 'Billing', raisedAt: 2_000, seenAt: 4_000, outcome: 'seen' }] });
  clock.now = 6_000; await run(control, finish('agent', 'turn-2'));
  clock.now = 7_000; await run(control, { type: 'attention.set', id: 'agent', source: 'completion', reason: null });
  assert.deepEqual(store.attentionHistory().entries.map(entry => [entry.key, entry.raisedAt, entry.seenAt, entry.outcome]), [['agent-r:2', 6_000, 7_000, 'cleared']], 'only the latest cycle per item');
}));

test('aliases share one entry and a deleted item keeps its snapshot', () => fixture(async (store, control, clock) => {
  const resource = { id: 'pr-r', pluginId: 'github.pull-request', schemaVersion: 1, title: 'Plan switcher', data: { owner: 'example', repo: 'billing', number: 48 } };
  await run(control, { type: 'item.create', id: 'pr', resource, projectId: 'billing', position: { x: 100, y: 100 } }, { type: 'item.create', id: 'pr-alias', resource, position: { x: 900, y: 900 } });
  clock.now = 2_000; await run(control, { type: 'attention.set', id: 'pr', source: 'review', reason: 'review' }, { type: 'attention.set', id: 'pr', source: 'provider', reason: 'error' });
  clock.now = 3_000; await run(control, { type: 'node.archive', id: 'pr' }, { type: 'node.archive', id: 'pr-alias' }, { type: 'node.delete', id: 'pr' }, { type: 'node.delete', id: 'pr-alias' });
  assert.equal((await control.read()).nodes.length, 1);
  assert.deepEqual(store.attentionHistory().entries, [{ key: 'pr-r:2', nodeId: 'pr', resourceId: 'pr-r', title: 'Plan switcher', reasons: ['error', 'review'], project: 'Billing · Floating item', raisedAt: 2_000, seenAt: 3_000, outcome: 'cleared' }]);
}));

test('history keeps the newest 100 seen cycles and pages newest first', () => fixture(async (store, control, clock) => {
  for (let first = 1; first <= 105; first += 35) await run(control, ...Array.from({ length: 35 }, (_, i) => note(`item${first + i}`)));
  for (let turn = 1; turn <= 105; turn++) {
    clock.now = turn * 10; await run(control, finish(`item${turn}`, 'event'));
    clock.now = turn * 10 + 5; await acknowledge(control, `item${turn}`);
  }
  const first = store.attentionHistory(0, 10);
  assert.equal(first.more, true);
  assert.deepEqual(first.entries.map(entry => entry.key), Array.from({ length: 10 }, (_, i) => `item${105 - i}-r:1`));
  assert.deepEqual(store.attentionHistory(10, 10).entries.map(entry => entry.key)[0], 'item95-r:1');
  const last = store.attentionHistory(90, 10);
  assert.equal(last.more, false); assert.equal(last.entries.at(-1)!.key, 'item6-r:1');
  assert.deepEqual(store.attentionHistory(100, 10), { entries: [], more: false });
  assert.equal(store.attentionHistory(0, 100).entries.length, 100);
}));

test('a pre-history database gains the attention history table on upgrade', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-attention-upgrade-')), file = join(directory, 'workspace.sqlite');
  try {
    let store = new SqliteStore(file); await new WorkspaceControl(store).apply({ type: 'project.create', id: 'kept', title: 'Kept', position: { x: 0, y: 0 } }, 0);
    const before = await store.read(); store.close();
    const old = new DatabaseSync(file); old.exec('DROP TABLE rollout_validations; DROP TABLE rollout_events; DROP TABLE provider_validators; DROP TABLE attention_history; PRAGMA user_version = 11;'); old.close();
    store = new SqliteStore(file);
    try { assert.ok(store.backupFile?.includes('backup-v11-')); assert.deepEqual(await store.read(), before); assert.deepEqual(store.attentionHistory(), { entries: [], more: false }); }
    finally { store.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('history keeps each cycle\'s trigger notes; rows from before notes existed keep none', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-attention-notes-')), file = join(directory, 'workspace.sqlite');
  try {
    let store = new SqliteStore(file); store.close();
    const old = new DatabaseSync(file);
    const notesVersion = migrations.indexOf('ALTER TABLE attention_history ADD COLUMN notes TEXT;');
    old.exec(`ALTER TABLE attention_history DROP COLUMN notes; PRAGMA user_version = ${notesVersion};`);
    old.prepare('INSERT INTO attention_history(cycle_key, node_id, resource_id, title, reasons, project, raised_at, seen_at, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('old-r:1', 'old', 'old-r', 'Old item', '["input"]', 'Billing', 1, 2, 'seen');
    old.close();
    const clock = { now: 1_000 };
    store = new SqliteStore(file, { now: () => clock.now });
    try {
      assert.ok(store.backupFile?.includes(`backup-v${notesVersion}-`));
      assert.deepEqual(store.attentionHistory().entries, [{ key: 'old-r:1', nodeId: 'old', resourceId: 'old-r', title: 'Old item', reasons: ['input'], project: 'Billing', raisedAt: 1, seenAt: 2, outcome: 'seen' }]);
      const control = new WorkspaceControl(store);
      await run(control, { type: 'project.create', id: 'billing', title: 'Billing', summary: '', position: { x: 0, y: 0 } }, note('agent', 'Claude'));
      clock.now = 2_000; await run(control, { type: 'attention.set', id: 'agent', source: 'completion', reason: 'finished', note: 'Agent finished', eventId: 'turn-1' }, { type: 'node.update', id: 'agent', attention: 'input', attentionNote: 'Agent waiting' });
      clock.now = 3_000; await acknowledge(control, 'agent');
      assert.deepEqual(store.attentionHistory().entries[0], { key: 'agent-r:2', nodeId: 'agent', resourceId: 'agent-r', title: 'Claude', reasons: ['input', 'finished'], notes: ['Agent waiting', 'Agent finished'], project: 'Billing', raisedAt: 2_000, seenAt: 3_000, outcome: 'seen' });
    } finally { store.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the service pages attention history and validates its arguments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-attention-service-'));
  const service = await startWorkspaceService(directory), client = await connectWorkspace(directory);
  try {
    const control = service.control;
    await run(control, { type: 'project.create', id: 'billing', title: 'Billing', summary: '', position: { x: 0, y: 0 } }, ...Array.from({ length: 12 }, (_, i) => note(`item${i + 1}`)));
    for (let turn = 1; turn <= 12; turn++) { await run(control, finish(`item${turn}`, 'event')); await acknowledge(control, `item${turn}`); }
    const page = await client.call<{ entries: { key: string }[]; more: boolean }>('attention.history', {});
    assert.equal(page.entries.length, 10); assert.equal(page.more, true); assert.equal(page.entries[0].key, 'item12-r:1');
    assert.deepEqual((await client.call<{ entries: { key: string }[]; more: boolean }>('attention.history', { offset: 10, limit: 10 })).entries.map(entry => entry.key), ['item2-r:1', 'item1-r:1']);
    await assert.rejects(client.call('attention.history', { offset: -1 }));
    await assert.rejects(client.call('attention.history', { limit: 101 }));
  } finally { client.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('earlier shows one entry per item and nothing for an item that needs you again', () => fixture(async (store, control, clock) => {
  await run(control, note('agent', 'Claude · implementation'), note('pr', 'Plan switcher'));
  clock.now = 2_000; await run(control, finish('agent', 'turn-1'), finish('pr', 'review-1'));
  clock.now = 3_000; await acknowledge(control, 'agent'); await acknowledge(control, 'pr');
  assert.deepEqual(store.attentionHistory().entries.map(entry => entry.nodeId).sort(), ['agent', 'pr']);
  clock.now = 4_000; await run(control, finish('agent', 'turn-2'));
  assert.deepEqual(store.attentionHistory().entries.map(entry => entry.nodeId), ['pr'], 'an active item is not repeated under Earlier');
  clock.now = 5_000; await acknowledge(control, 'agent');
  assert.deepEqual(store.attentionHistory().entries.map(entry => [entry.nodeId, entry.key]), [['agent', 'agent-r:2'], ['pr', 'pr-r:1']], 'only the latest cycle of each item');
}));
