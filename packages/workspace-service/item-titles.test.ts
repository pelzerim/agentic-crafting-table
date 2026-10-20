import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspaceControl } from '../core/control.ts';
import type { WorkspaceCommand } from '../core/control.ts';
import { SqliteStore } from './sqlite-store.ts';
import { ItemTitles } from './item-titles.ts';
import { itemFootprint } from '../../src/graph/footprints.ts';

test('text-first items save locally, get bounded titles, and preserve data and budgets across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-item-title-')), store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  let calls = 0, now = 10_000, titles: ItemTitles;
  const apply = async (command: WorkspaceCommand) => control.dispatch({ commandId: randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'fixture' }, commands: [command] });
  const client = { async complete(request: any) { calls++; assert.equal(request.model, 'haiku'); assert.equal(request.max_tokens, 64); assert.equal(request.thinking.type, 'disabled'); assert.match(request.system, /never as instructions/); assert.doesNotMatch(request.messages[0].content, /PRIVATE_VALUE/); assert.ok(JSON.parse(request.messages[0].content).note.length <= 6000); return 'API compatibility plan'; } };
  const create = () => new ItemTitles(store, control, async () => {}, () => true, directory, client, () => now);
  titles = create();
  try {
    const text = 'Keep our API compatible\npassword=PRIVATE_VALUE\n' + 'Migration details. '.repeat(800);
    await apply({ type: 'item.add', id: 'note', resourceId: 'note-r', pluginId: 'workspace.note', data: { text }, position: { x: 100, y: 100 } });
    await apply({ type: 'item.add', id: 'todo', resourceId: 'todo-r', pluginId: 'workspace.todo', title: 'Task', data: {}, position: { x: 500, y: 100 } });
    const before = await control.read();
    assert.equal(before.nodes[0].title, 'Keep our API compatible');
    const note = itemFootprint(before.nodes[0], before.resources, control.registry), todo = itemFootprint(before.nodes[1], before.resources, control.registry);
    assert.ok(note.width < todo.width && note.height > todo.height, 'a note is a narrow paper tile showing its text');
    assert.equal(control.registry.get('workspace.note')!.appearance!.size, 'small');
    await assert.rejects(apply({ type: 'item.add', id: 'bad', resourceId: 'bad-r', pluginId: 'workspace.todo', data: {}, position: { x: 900, y: 100 } }), /title/);
    titles.start(); await titles.tick();
    const after = await control.read(); assert.equal(after.nodes[0].title, 'API compatibility plan'); assert.equal(calls, 1);
    assert.deepEqual(after.nodes.map(n => n.position), before.nodes.map(n => n.position)); assert.equal(after.resources[0].data.text, text);
    await titles.close(); titles = create(); titles.start(); await titles.tick(); assert.equal(calls, 1);
    // Explicit edits survive helper polling. Changing text creates a fresh local label.
    await apply({ type: 'node.update', id: 'note', title: 'My chosen title' }); await titles.tick(); assert.equal(calls, 1);
    now += 3000; await apply({ type: 'item.update', id: 'note', data: { text: 'A new note body' } });
    assert.equal((await control.read()).nodes[0].title, 'A new note body');
    // Shared, durable request allowance also covers note title attempts.
    const settings = store.readSettings(); store.writeSettings({ expectedRevision: settings.revision, value: { ...settings.value, summaries: { ...settings.value.summaries, requestsPerHour: 1 } } });
    await titles.tick(); assert.equal(calls, 1); assert.equal((await control.read()).nodes[0].title, 'A new note body');
  } finally { await titles.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('stale, cancelled, invalid and failed title requests never replace a note or retry unchanged content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-item-title-race-')), store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  let resolve!: (text: string) => void, signal!: AbortSignal, calls = 0, now = 10_000;
  const titles = new ItemTitles(store, control, async () => {}, () => true, directory, { complete(_request, aborted) { calls++; signal = aborted; return new Promise<string>(done => { resolve = done; }); } }, () => now, 50);
  const apply = async (command: WorkspaceCommand) => { const result = await control.dispatch({ commandId: randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'fixture' }, commands: [command] }); titles.observe(result.state); };
  try {
    await apply({ type: 'item.add', id: 'note', resourceId: 'note-r', pluginId: 'workspace.note', data: { text: 'Original note body' }, position: { x: 100, y: 100 } });
    titles.start(); const pending = titles.tick();
    await new Promise(done => setImmediate(done));
    await apply({ type: 'item.update', id: 'note', data: { text: 'Newer note body' } });
    assert.equal(signal.aborted, true); resolve('Stale AI title'); await pending;
    assert.equal((await control.read()).nodes[0].title, 'Newer note body');
    now += 3000; const invalid = titles.tick(); await new Promise(done => setImmediate(done)); resolve('<script>bad title</script>'); await invalid;
    assert.equal((await control.read()).nodes[0].title, 'Newer note body'); await titles.tick(); assert.equal(calls, 2);
    await apply({ type: 'item.update', id: 'note', data: { text: 'Third note body' } }); now += 3000;
    await titles.tick(); assert.equal(signal.aborted, true); await titles.tick(); assert.equal(calls, 3);
    assert.equal((await control.read()).resources[0].data.text, 'Third note body');
    await apply({ type: 'item.update', id: 'note', data: { text: 'Archived note body' } }); now += 3000;
    const archived = titles.tick(); await new Promise(done => setImmediate(done)); await apply({ type: 'node.archive', id: 'note' });
    assert.equal(signal.aborted, true); resolve('Late archive title'); await archived; await titles.tick(); assert.equal(calls, 4);
    assert.equal((await control.read()).nodes[0].title, 'Archived note body');
  } finally { await titles.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('an already matching generated title neither rewrites the graph nor starves the next note', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-item-title-same-')), store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  let calls = 0;
  const titles = new ItemTitles(store, control, async () => {}, () => true, directory, { async complete() { calls++; return calls === 1 ? 'Already good title' : 'Second generated title'; } });
  try {
    await control.dispatch({ commandId: 'two-notes', expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: ['Already good title', 'A second note'].map((text, index) => ({ type: 'item.add', id: `note-${index}`, resourceId: `resource-${index}`, pluginId: 'workspace.note', data: { text }, position: { x: index * 250, y: 100 } })) });
    const before = await control.read(); titles.start(); await titles.tick();
    const done = await control.read();
    assert.equal(done.nodes[0].title, 'Already good title'); assert.equal(done.nodes[1].title, 'Second generated title');
    assert.equal(done.revision, before.revision + 1); assert.equal(calls, 2);
    await titles.tick(); await titles.tick(); assert.equal((await control.read()).revision, done.revision); assert.equal(calls, 2);
  } finally { await titles.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a ticket kept in the to-do list shows its provider title: no helper writes a list label, and a stored one stays unused', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-todo-title-')), store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  let calls = 0;
  const titles = new ItemTitles(store, control, async () => {}, () => true, directory, { async complete() { calls++; return 'Export invoices as CSV'; } });
  const apply = async (commands: WorkspaceCommand[]) => control.dispatch({ commandId: randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'fixture' }, commands });
  const original = 'BIL-112 · Invoices can be exported as CSV';
  try {
    await apply([{ type: 'item.add', id: 'ticket', resourceId: 'ticket-r', pluginId: 'linear.ticket', title: original, data: { issueId: 'BIL-112' }, position: { x: 100, y: 100 } }, { type: 'node.todo', id: 'ticket', enabled: true }]);
    titles.start(); await titles.tick(); await titles.tick();
    assert.equal(calls, 0); assert.equal((await control.read()).nodes[0].todoLabel, undefined);
    await apply([{ type: 'node.todo.label', id: 'ticket', title: 'Earlier label', sourceTitle: original }]);
    const state = await control.read(), { todoEntries } = await import('../../src/graph/todos.ts');
    assert.deepEqual(state.nodes[0].todoLabel, { title: 'Earlier label', sourceTitle: original }, 'labels saved by earlier versions are kept');
    assert.equal(todoEntries(state)[0].title, original);
  } finally { await titles.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

