import { layoutFootprints, ITEM_GAP } from '../../src/graph/movement.ts';
import { overlaps } from '../../src/graph/spatial.ts';
import { DEFAULT_DASHBOARD_SECTIONS } from '../../src/graph/project-dashboard.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { settingsSchema } from '../core/settings.ts';
import { SqliteStore, migrations } from './sqlite-store.ts';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { todoContext, todoList } from '../../src/graph/todos.ts';
import { CommandIdConflict, emptyState, RevisionConflict, WorkspaceControl, envelopeSchema, reduceCommands } from '../core/control.ts';

const actor = { kind: 'user', id: 'test' };

test('map preset settings and collision placement commit together, survive restart and govern subsequent commands', () => fixture(async directory => {
  const file = join(directory, 'presets.sqlite');
  let store = new SqliteStore(file), control = new WorkspaceControl(store);
  try {
    for (const [id, x] of [['one', 100], ['two', 280]] as const) {
      await control.apply({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'workspace.note', title: id, data: { text: id }, position: { x, y: 100 } }, (await control.read()).revision);
    }
    const before = await control.read(), preferences = store.readSettings();
    const value = { ...preferences.value, itemMapSizes: { 'workspace.note': { defaultSize: 'medium' as const, sizes: { medium: { width: 340, height: 140 } } } } };
    const saved = store.writeSettings({ expectedRevision: preferences.revision, value });
    const state = await control.read();
    assert.equal(state.revision, before.revision + 1);
    assert.deepEqual(state.resources, before.resources);
    assert.notDeepEqual(state.nodes.map(n => n.position), before.nodes.map(n => n.position));
    const boxes = layoutFootprints(state.nodes, state.resources, control.registry, saved.value.itemMapSizes);
    assert.ok(boxes.every(box => box.width === 340 && box.height === 88), 'a note takes the preset width and its height from its text');
    assert.equal(overlaps(boxes[0], boxes[1], ITEM_GAP), false);
    await assert.rejects(control.apply({ type: 'node.move', id: 'one', position: { x: 100, y: 100 } }, before.revision), RevisionConflict);
    assert.throws(() => store.writeSettings({ expectedRevision: saved.revision, value: { ...value, itemMapSizes: { 'workspace.todo': { defaultSize: 'large', sizes: {} } } } }), /does not support/);
    assert.deepEqual(await control.read(), state); assert.deepEqual(store.readSettings(), saved);
    store.close(); store = new SqliteStore(file); control = new WorkspaceControl(store);
    assert.deepEqual(store.readSettings(), saved); assert.deepEqual(await control.read(), state);
    await control.apply({ type: 'item.add', id: 'new', resourceId: 'new-r', pluginId: 'workspace.note', title: 'New', data: { text: 'New' }, position: { ...state.nodes[0].position } }, state.revision);
    const after = await control.read(), finalBoxes = layoutFootprints(after.nodes, after.resources, control.registry, store.readMapLayout().sizes);
    for (let i = 0; i < finalBoxes.length; i++) for (let j = i + 1; j < finalBoxes.length; j++) assert.equal(overlaps(finalBoxes[i], finalBoxes[j], ITEM_GAP), false);
  } finally { store.close(); }
}));

test('map size overrides and resized neighbor positions survive a SQLite restart', () => fixture(async directory => {
  const file = join(directory, 'sizes.sqlite');
  let store = new SqliteStore(file), control = new WorkspaceControl(store);
  try {
    await control.apply({ type: 'item.add', id: 'note', resourceId: 'note-r', pluginId: 'workspace.note', title: 'A note', data: { text: 'Keep me' }, position: { x: 100, y: 100 } }, 0);
    await control.apply({ type: 'item.add', id: 'neighbor', resourceId: 'neighbor-r', pluginId: 'workspace.note', title: 'Nearby', data: { text: 'Stay clear' }, position: { x: 280, y: 100 } }, 1);
    assert.equal((await control.read()).nodes[0].mapSize, undefined);
    const input = { commandId: 'size', expectedRevision: 2, actor, commands: [{ type: 'node.resize', id: 'note', dimensions: { width: 310, height: 160 } }] };
    const { state } = await control.dispatch(input);
    assert.notDeepEqual(state.nodes[1].position, { x: 280, y: 100 });
    store.close(); store = new SqliteStore(file); control = new WorkspaceControl(store);
    assert.deepEqual(await control.read(), state);
    assert.equal((await control.dispatch(input)).replayed, true);
    assert.equal((await store.events(0)).events.length, 3);
  } finally { store.close(); }
}));
const create = (commandId = 'create', expectedRevision = 0, id = 'project') => ({ commandId, expectedRevision, actor, commands: [{ type: 'project.create', id, title: 'Project', position: { x: 10, y: 20 } }] });
async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-sqlite-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('a refused stale command is recorded with the commits that landed after the revision it named', () => fixture(async directory => {
  const file = join(directory, 'conflicts.sqlite');
  let store = new SqliteStore(file); const control = new WorkspaceControl(store);
  try {
    await control.dispatch({ commandId: 'add', expectedRevision: 0, actor, commands: [{ type: 'item.add', id: 'one', resourceId: 'one-r', pluginId: 'workspace.note', title: 'one', data: { text: 'one' }, position: { x: 100, y: 100 } }] });
    const seen = (await control.read()).revision;
    await control.dispatch({ commandId: 'quiet', expectedRevision: seen, actor: { kind: 'system', id: 'agent-quiet' }, commands: [{ type: 'node.update', id: 'one', summary: 'idle' }] });
    await assert.rejects(control.dispatch({ commandId: 'stale', expectedRevision: seen, actor: { kind: 'user', id: 'desktop' }, commands: [{ type: 'node.archive', id: 'one' }] }), RevisionConflict);
    const [conflict, ...rest] = store.revisionConflicts();
    assert.equal(rest.length, 0);
    assert.deepEqual({ ...conflict, at: undefined }, { at: undefined, actor: 'user:desktop', commands: [{ type: 'node.archive', id: 'one' }], expected: seen, current: seen + 1,
      landed: [{ revision: seen + 1, actor: 'system:agent-quiet', commands: [{ type: 'node.update', id: 'one' }] }] });
    store.close(); store = new SqliteStore(file);
    assert.equal(store.revisionConflicts().length, 1, 'conflicts survive a restart');
  } finally { store.close(); }
}));

test('SQLite persists graph, command receipts, views and event cursor across restart', () => fixture(async directory => {
  const file = join(directory, 'workspace.sqlite');
  let store = new SqliteStore(file), control = new WorkspaceControl(store);
  const first = await control.dispatch(create());
  await store.writeView('main', { mode: 'workspace', camera: { x: 40, y: 50, zoom: .7 } });
  assert.equal((await store.snapshot()).cursor, 1);
  store.close();
  store = new SqliteStore(file); control = new WorkspaceControl(store);
  try {
    assert.deepEqual(await control.read(), first.state);
    assert.equal((await control.dispatch(create())).replayed, true);
    assert.equal((await store.events(0)).events.length, 1);
    assert.deepEqual((await store.readView('main')).camera, { x: 40, y: 50, zoom: .7 });
    await assert.rejects(control.dispatch(create('create', 0, 'other')), CommandIdConflict);
    await assert.rejects(control.dispatch(create('stale', 0, 'other')), RevisionConflict);
    assert.equal((await store.events(0)).events.length, 1);
  } finally { store.close(); }
}));

test('provider observations commit atomically with shared graph changes without noisy unchanged revisions', () => fixture(async directory => {
  const file = join(directory, 'workspace.sqlite'); let store = new SqliteStore(file); const control = new WorkspaceControl(store);
  try {
    const input = envelopeSchema.parse(create());
    const graph = { envelope: input, reduce: (state: Awaited<ReturnType<SqliteStore['read']>>) => reduceCommands(state, input.commands, input.expectedRevision, control.registry) };
    store.commitObservation('assignments:test', 0, { unseen: true }, graph);
    assert.equal((await store.read()).nodes.length, 1); assert.deepEqual(store.observation('assignments:test'), { revision: 1, value: { unseen: true } });
    const saved = await store.snapshot(); store.commitObservation('assignments:test', 1, { unseen: true, checkedAt: 100 }); assert.deepEqual(await store.snapshot(), saved);
    assert.throws(() => store.commitObservation('assignments:test', 1, { unseen: false }), /observation changed/);
    const bad = envelopeSchema.parse({ ...create('bad', 1), commands: [{ type: 'node.move', id: 'missing', position: { x: 0, y: 0 } }] });
    assert.throws(() => store.commitObservation('assignments:test', 2, { unseen: false }, { envelope: bad, reduce: state => reduceCommands(state, bad.commands, bad.expectedRevision, control.registry) }), /Node not found/);
    assert.equal(store.observation('assignments:test').revision, 2); assert.deepEqual(await store.snapshot(), saved);
    store.close(); store = new SqliteStore(file); assert.deepEqual(store.observation('assignments:test'), { revision: 2, value: { unseen: true, checkedAt: 100 } });
    assert.deepEqual(await store.snapshot(), saved);
  } finally { store.close(); }
}));

test('settings cannot retarget an existing provider binding to another account', () => fixture(async directory => {
  const store = new SqliteStore(join(directory, 'workspace.sqlite'));
  try {
    const initial = store.readSettings(), value = { ...initial.value, connections: [{ id: 'github', providerId: 'github', account: 'one', enabled: true, isDefault: true }] };
    const saved = store.writeSettings({ expectedRevision: initial.revision, value });
    assert.throws(() => store.writeSettings({ expectedRevision: saved.revision, value: { ...saved.value, connections: [{ ...saved.value.connections[0], account: 'two' }] } }), /bindings are immutable/);
    assert.deepEqual(store.readSettings(), saved);
  } finally { store.close(); }
}));

test('failed batch rolls back graph, receipt and event; independent writers reject stale revisions', () => fixture(async directory => {
  const file = join(directory, 'workspace.sqlite');
  const a = new SqliteStore(file), b = new SqliteStore(file);
  try {
    const ca = new WorkspaceControl(a), cb = new WorkspaceControl(b);
    const bad = { ...create(), commands: [...create().commands, { type: 'node.move', id: 'missing', position: { x: 1, y: 2 } }] };
    await assert.rejects(ca.dispatch(bad), /Node not found/);
    assert.deepEqual(await a.read(), emptyState());
    assert.equal((await a.snapshot()).cursor, 0);
    const results = await Promise.allSettled([ca.dispatch(create()), cb.dispatch(create('other', 0, 'other'))]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.deepEqual(await a.read(), await b.read());
    assert.equal((await a.events(0)).events.length, 1);
  } finally { a.close(); b.close(); }
}));

test('reads decode the workspace once per change, hand out copies and see other connections and rollbacks', () => fixture(async directory => {
  const file = join(directory, 'workspace.sqlite');
  const a = new SqliteStore(file), b = new SqliteStore(file);
  try {
    const ca = new WorkspaceControl(a), cb = new WorkspaceControl(b);
    await ca.dispatch(create());
    const db = (a as unknown as { db: DatabaseSync }).db, prepare = db.prepare.bind(db);
    let decodes = 0;
    db.prepare = (sql: string) => { if (sql.startsWith('SELECT body FROM nodes')) decodes++; return prepare(sql); };
    const first = await a.read(); first.nodes[0].title = 'mutated by a reader';
    const second = await a.read();
    assert.equal(decodes, 1);
    assert.notEqual(second.nodes[0].title, 'mutated by a reader');
    await cb.dispatch(create('other', 1, 'other'));
    assert.equal((await a.read()).revision, 2);
    await assert.rejects(ca.dispatch({ ...create('third', 2, 'third'), commands: [...create('third', 2, 'third').commands, { type: 'node.move', id: 'missing', position: { x: 1, y: 2 } }] }), /Node not found/);
    assert.deepEqual(await a.read(), await b.read());
  } finally { a.close(); b.close(); }
}));

test('a save rewrites only the rows that changed and keeps order, identities and rollbacks', () => fixture(async directory => {
  const file = join(directory, 'workspace.sqlite');
  const store = new SqliteStore(file), control = new WorkspaceControl(store);
  try {
    const add = (index: number) => ({ type: 'item.add', id: `note-${index}`, resourceId: `note-r-${index}`, pluginId: 'workspace.note', title: `Note ${index}`, data: { text: `n${index}` }, position: { x: index * 400, y: 0 } });
    await control.dispatch({ commandId: 'seed', expectedRevision: 0, actor, commands: Array.from({ length: 40 }, (_, index) => add(index)) });
    const db = (store as unknown as { db: DatabaseSync }).db, changes = () => Number(db.prepare('SELECT total_changes() AS n').get()!.n);
    const before = changes();
    await control.dispatch({ commandId: 'rename', expectedRevision: 1, actor, commands: [{ type: 'node.update', id: 'note-7', title: 'Renamed' }] });
    assert.ok(changes() - before < 10, `rows written: ${changes() - before}`);
    await control.dispatch({ commandId: 'archive', expectedRevision: 2, actor, commands: [{ type: 'node.archive', id: 'note-3' }, { type: 'link.save', link: { id: 'link', sourceId: 'note-1', targetId: 'note-2', kind: 'reference' } }] });
    await assert.rejects(control.dispatch({ commandId: 'bad', expectedRevision: 3, actor, commands: [{ type: 'node.update', id: 'note-9', title: 'Lost' }, { type: 'node.move', id: 'missing', position: { x: 0, y: 0 } }] }), /Node not found/);
    const saved = await control.read(), reopened = new SqliteStore(file);
    try { assert.deepEqual(await reopened.read(), saved); } finally { reopened.close(); }
    assert.equal(saved.nodes.find(node => node.id === 'note-7')!.title, 'Renamed');
    assert.equal(saved.nodes.find(node => node.id === 'note-9')!.title, 'Note 9');
    assert.deepEqual(saved.nodes.map(node => node.id), Array.from({ length: 40 }, (_, index) => `note-${index}`));
    assert.equal(saved.links.length, 1);
  } finally { store.close(); }
}));

test('native hook ordering survives restart without changing the graph revision or event cursor', () => fixture(async directory => {
  const file = join(directory, 'workspace.sqlite');
  let store = new SqliteStore(file);
  assert.equal(store.observeAgent('session', 200, 'PreToolUse'), true);
  assert.equal(store.observeAgent('session', 199, 'Stop'), false);
  const before = await store.snapshot();
  store.close(); store = new SqliteStore(file);
  try {
    assert.equal(store.observeAgent('session', 199, 'Stop'), false);
    assert.equal(store.observeAgent('session', 201, 'PostToolUse'), true);
    assert.deepEqual(await store.snapshot(), before);
  } finally { store.close(); }
}));

test('outstanding agent background work survives restart and clears per process session', () => fixture(async directory => {
  const file = join(directory, 'workspace.sqlite');
  let store = new SqliteStore(file);
  store.observeBackground('session', { observedAt: 1, launched: { id: 'a', kind: 'subagent' }, turnEnded: true });
  store.observeBackground('other', { observedAt: 1, launched: { id: 'b', kind: 'monitor' } });
  const before = await store.snapshot();
  store.close(); store = new SqliteStore(file);
  try {
    assert.deepEqual(store.agentBackground('session')?.tasks, [{ id: 'a', kind: 'subagent' }]);
    assert.equal(store.agentBackground('session')?.turnEnded, true);
    assert.deepEqual(store.observeBackground('session', { observedAt: 2, ended: 'a' }).tasks, []);
    store.clearBackground('other');
    assert.equal(store.agentBackground('other'), undefined);
    assert.deepEqual(await store.snapshot(), before, 'background observations do not change the graph');
  } finally { store.close(); }
}));

test('provider identity constraints reject duplicate resources without committing partial items', () => fixture(async directory => {
  const store = new SqliteStore(join(directory, 'workspace.sqlite'), { identity: resource => resource.pluginId === 'agent.session' ? String(resource.data.sessionId) : undefined });
  const control = new WorkspaceControl(store);
  try {
    const add = (id: string) => ({ type: 'item.create', id, position: { x: 0, y: 0 }, resource: { id, pluginId: 'agent.session', schemaVersion: 1, title: id, data: { provider: 'fixture', sessionId: 'native-1' } } });
    await control.dispatch({ ...create(), commands: [add('a')] });
    await assert.rejects(control.dispatch({ ...create('duplicate', 1), commands: [add('b')] }), /UNIQUE constraint/);
    assert.equal((await store.read()).nodes.length, 1);
    assert.equal((await store.snapshot()).cursor, 1);
  } finally { store.close(); }
}));

test('explicit JSON import preserves identities, is repeatable and retains invalid original files', () => fixture(async directory => {
  const source = join(directory, 'original.state.json');
  const original = new WorkspaceControl();
  await original.dispatch(create());
  await writeFile(source, JSON.stringify(await original.read()));
  const store = new SqliteStore(join(directory, 'workspace.sqlite'));
  try {
    assert.equal((await store.importJson(source)).imported, true);
    assert.deepEqual(await store.read(), await original.read());
    assert.equal((await store.importJson(source)).imported, false);
    const broken = join(directory, 'broken.json'); await writeFile(broken, '{broken');
    await assert.rejects(store.importJson(broken));
    assert.equal(await readFile(broken, 'utf8'), '{broken');
    assert.deepEqual(await store.read(), await original.read());
    const other = join(directory, 'other.json'); await writeFile(other, JSON.stringify(emptyState()));
    await assert.rejects(store.importJson(other), /empty workspace/);
  } finally { store.close(); }
}));

test('schema upgrade creates a usable original backup and rejects future versions without resetting them', () => fixture(async directory => {
  const file = join(directory, 'old.sqlite');
  const old = new DatabaseSync(file);
  old.exec(migrations[0]);
  old.exec('PRAGMA user_version = 1');
  old.prepare('INSERT INTO workspace VALUES (1, 7, ?)').run(JSON.stringify(emptyState().view));
  old.close();
  const store = new SqliteStore(file);
  try {
    assert.equal((await store.read()).revision, 7);
    assert.ok(store.backupFile);
    const backup = new DatabaseSync(store.backupFile, { readOnly: true });
    assert.equal(backup.prepare('PRAGMA user_version').get()!.user_version, 1);
    assert.equal(backup.prepare('SELECT revision FROM workspace').get()!.revision, 7);
    backup.close();
  } finally { store.close(); }
  const future = new DatabaseSync(file); future.exec('PRAGMA user_version = 999'); future.close();
  assert.throws(() => new SqliteStore(file), /newer than this app/);
  const unchanged = new DatabaseSync(file, { readOnly: true });
  assert.equal(unchanged.prepare('PRAGMA user_version').get()!.user_version, 999);
  assert.equal(unchanged.prepare('SELECT revision FROM workspace').get()!.revision, 7);
  unchanged.close();
}));

test('cursor compaction requests a snapshot; subsequent events remain monotonic', () => fixture(async directory => {
  const store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  try {
    await control.dispatch(create()); await control.dispatch(create('second', 1, 'second'));
    store.compactEvents(2);
    assert.equal((await store.events(0)).resetRequired, true);
    assert.equal((await store.events(3)).resetRequired, true);
    assert.equal((await store.snapshot()).cursor, 2);
    await control.dispatch(create('third', 2, 'third'));
    assert.deepEqual((await store.events(2)).events.map(event => event.sequence), [3]);
  } finally { store.close(); }
}));

test('failed schema migration rolls back version changes and retains a backup of the source', () => fixture(async directory => {
  const file = join(directory, 'incompatible.sqlite');
  const db = new DatabaseSync(file);
  db.exec(migrations[0]); db.exec('PRAGMA user_version = 1; CREATE TABLE receipts (unexpected TEXT);');
  db.prepare('INSERT INTO workspace VALUES (1, 12, ?)').run(JSON.stringify(emptyState().view)); db.close();
  assert.throws(() => new SqliteStore(file), /already exists/);
  const after = new DatabaseSync(file, { readOnly: true });
  assert.equal(after.prepare('PRAGMA user_version').get()!.user_version, 1);
  assert.equal(after.prepare('SELECT revision FROM workspace').get()!.revision, 12);
  assert.equal(after.prepare("SELECT name FROM sqlite_master WHERE name = 'events'").get(), undefined);
  after.close();
}));

test('separate processes contend on the same revision without lost updates', () => fixture(async directory => {
  const file = join(directory, 'workspace.sqlite');
  const store = new SqliteStore(file); store.close();
  const moduleUrl = new URL('./sqlite-store.ts', import.meta.url).href;
  const coreUrl = new URL('../core/control.ts', import.meta.url).href;
  const code = `import { SqliteStore } from ${JSON.stringify(moduleUrl)}; import { WorkspaceControl } from ${JSON.stringify(coreUrl)}; const store = new SqliteStore(process.argv[1]); try { await new WorkspaceControl(store).dispatch(JSON.parse(process.argv[2])); console.log('committed'); } catch(error) { console.log(error.code); } finally { store.close(); }`;
  const writer = (id: string) => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, file, JSON.stringify(create(id, 0, id))]);
    let output = '', errors = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(output.trim()) : reject(new Error(errors)));
  });
  assert.deepEqual((await Promise.all([writer('a'), writer('b')])).sort(), ['REVISION_CONFLICT', 'committed']);
  const final = new SqliteStore(file);
  try { assert.equal((await final.read()).nodes.length, 1); assert.equal((await final.snapshot()).cursor, 1); }
  finally { final.close(); }
}));

test('opening the workspace waits for a brief external schema lock before its first version read', () => fixture(async directory => {
  const file = join(directory, 'opening.sqlite'), initial = new SqliteStore(file);
  await new WorkspaceControl(initial).dispatch(create()); initial.close();
  const legacy = new DatabaseSync(file); legacy.exec('PRAGMA journal_mode = DELETE;'); legacy.close();
  const code = `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN EXCLUSIVE;'); console.log('locked'); process.stdin.once('data', () => setTimeout(() => { db.exec('COMMIT;'); db.close(); process.exit(0); }, 300));`;
  const locker = spawn(process.execPath, ['--input-type=module', '-e', code, file]);
  const exited = once(locker, 'exit');
  try {
    await once(locker.stdout, 'data'); locker.stdin.write('release shortly');
    const reopened = new SqliteStore(file);
    try { assert.equal((await reopened.read()).nodes[0].title, 'Project'); }
    finally { reopened.close(); }
    assert.equal((await exited)[0], 0);
  } finally { if (locker.exitCode === null) { locker.kill(); await exited; } }
}));

test('durable jobs reconcile interrupted side effects instead of automatically retrying', () => fixture(async directory => {
  const file = join(directory, 'workspace.sqlite');
  let store = new SqliteStore(file);
  const input = { action: 'pr.review.workflow', nodeId: 'pr', arguments: {} };
  const queued = store.enqueueJob('trigger-1', input);
  assert.equal(store.enqueueJob('trigger-1', input).id, queued.id);
  assert.throws(() => store.enqueueJob('trigger-1', { ...input, nodeId: 'other' }), CommandIdConflict);
  store.transitionJob(queued.id, 'queued', 'running', { correlation: { commentId: '123' } });
  store.close(); store = new SqliteStore(file);
  try {
    assert.equal(store.recoverInterruptedJobs()[0].state, 'outcome-unknown');
    assert.equal(store.getJob(queued.id)!.correlation.commentId, '123');
    assert.throws(() => store.transitionJob(queued.id, 'outcome-unknown', 'queued'), /Reconcile/);
    const done = store.transitionJob(queued.id, 'outcome-unknown', 'succeeded', { result: { url: 'https://example.com/report' } });
    assert.equal(done.attempts, 1);
    assert.equal(done.state, 'succeeded');
    assert.throws(() => store.transitionJob(queued.id, 'running', 'failed'), /state conflict/);
    assert.equal((await store.read()).revision, 0);
    assert.equal((await store.events(0)).events.length, 4);
  } finally { store.close(); }
}));

test('rollout approval jobs are only the succeeded rollout.approve actions', () => fixture(async directory => {
  const store = new SqliteStore(join(directory, 'workspace.sqlite'));
  try {
    const approve = (key: string, nodeId: string) => store.enqueueJob(key, { action: 'resource.action', nodeId, arguments: { actionId: 'rollout.approve', input: { runId: 1, attempt: 1, environmentIds: '2' } } });
    const done = approve('approve-1', 'rollout'), pending = approve('approve-2', 'rollout');
    store.transitionJob(done.id, 'queued', 'running'); store.transitionJob(done.id, 'running', 'succeeded', { result: { ok: true } });
    const other = store.enqueueJob('merge-1', { action: 'resource.action', nodeId: 'rollout', arguments: { actionId: 'pr.merge' } });
    store.transitionJob(other.id, 'queued', 'running'); store.transitionJob(other.id, 'running', 'succeeded');
    const review = store.enqueueJob('review-1', { action: 'pr.review.workflow', nodeId: 'rollout', arguments: { actionId: 'rollout.approve' } });
    store.transitionJob(review.id, 'queued', 'running'); store.transitionJob(review.id, 'running', 'succeeded');
    assert.deepEqual(store.rolloutApprovalJobs().map(job => job.id), [done.id]);
    assert.equal(pending.state, 'queued');
  } finally { store.close(); }
}));

test('process crash before commit rolls back; crash after commit preserves receipt and event', () => fixture(async directory => {
  const file = join(directory, 'workspace.sqlite');
  let store = new SqliteStore(file); store.close();
  const before = spawnSync(process.execPath, ['--input-type=module', '-e', `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE; UPDATE workspace SET revision = 999 WHERE id = 1'); process.exit(9);`, file]);
  assert.equal(before.status, 9);
  store = new SqliteStore(file);
  assert.equal((await store.read()).revision, 0); store.close();
  const moduleUrl = new URL('./sqlite-store.ts', import.meta.url).href;
  const coreUrl = new URL('../core/control.ts', import.meta.url).href;
  const after = spawnSync(process.execPath, ['--input-type=module', '-e', `import { SqliteStore } from ${JSON.stringify(moduleUrl)}; import { WorkspaceControl } from ${JSON.stringify(coreUrl)}; const store = new SqliteStore(process.argv[1]); await new WorkspaceControl(store).dispatch(JSON.parse(process.argv[2])); process.exit(9);`, file, JSON.stringify(create())]);
  assert.equal(after.status, 9, after.stderr.toString());
  store = new SqliteStore(file);
  try {
    assert.equal((await new WorkspaceControl(store).dispatch(create())).replayed, true);
    assert.equal((await store.snapshot()).cursor, 1);
  } finally { store.close(); }
}));

test('v4 upgrade preserves existing workspace and camera, then persists a recovery checkpoint across reopening', () => fixture(async directory => {
  const file = join(directory, 'upgrade-v4.sqlite');
  let store = new SqliteStore(file);
  const control = new WorkspaceControl(store);
  await control.apply({ type: 'project.create', id: 'existing-project', title: 'Keep this project', summary: 'Existing work', position: { x: 123, y: 456 } }, 0);
  await store.writeView('desktop', { camera: { x: 37, y: 91, zoom: .73 } });
  const before = await store.read(), view = await store.readView('desktop');
  store.close();
  const old = new DatabaseSync(file); old.exec('DROP TABLE rollout_validations; DROP TABLE rollout_events; DROP TABLE provider_validators; DROP TABLE attention_history; DROP TABLE review_sends; DROP TABLE review_finding_events; DROP TABLE github_inbox; DROP TABLE github_inbox_hidden; DROP TABLE provider_observations; DROP TABLE resource_cache; DROP TABLE activity_summaries; DROP TABLE summary_attempts; DROP TABLE app_settings; DROP TABLE recovery_checkpoint; PRAGMA user_version = 4;'); old.close();
  store = new SqliteStore(file);
  assert.ok(store.backupFile?.includes('backup-v4-'));
  assert.deepEqual(await store.read(), before); assert.deepEqual(await store.readView('desktop'), view);
  assert.deepEqual(store.readRecovery(), { phase: 'open', entries: [] });
  const checkpoint = { phase: 'closed' as const, closedAt: '2026-09-25T12:00:00Z', entries: [] };
  store.writeRecovery(checkpoint); store.close(); store = new SqliteStore(file);
  try { assert.deepEqual(store.readRecovery(), checkpoint); assert.deepEqual(await store.read(), before); }
  finally { store.close(); }
}));

test('v5 settings migration preserves graph/checkpoint and persists independent revisioned preferences', () => fixture(async directory => {
  const file = join(directory, 'settings.sqlite');
  let store = new SqliteStore(file);
  await new WorkspaceControl(store).dispatch(create());
  const state = await store.read(), checkpoint = { phase: 'closed' as const, entries: [] };
  store.writeRecovery(checkpoint); store.close();
  const old = new DatabaseSync(file); old.exec('DROP TABLE rollout_validations; DROP TABLE rollout_events; DROP TABLE provider_validators; DROP TABLE attention_history; DROP TABLE review_sends; DROP TABLE review_finding_events; DROP TABLE github_inbox; DROP TABLE github_inbox_hidden; DROP TABLE provider_observations; DROP TABLE resource_cache; DROP TABLE activity_summaries; DROP TABLE summary_attempts; DROP TABLE app_settings; PRAGMA user_version = 5;'); old.close();
  store = new SqliteStore(file);
  assert.ok(store.backupFile?.includes('backup-v5-'));
  const defaults = store.readSettings();
  assert.deepEqual(defaults.value, settingsSchema.parse({}));
  const saved = store.writeSettings({ expectedRevision: 0, value: { keepAwake: true, claude: { remoteControl: false, arguments: ['--effort', 'high'] } } });
  assert.throws(() => store.writeSettings({ expectedRevision: 0, value: defaults.value }), /changed elsewhere/);
  assert.throws(() => store.writeSettings({ expectedRevision: 1, value: { claude: { arguments: ['--mcp-config=elsewhere'] } } }), /managed/);
  assert.deepEqual(await store.read(), state); assert.deepEqual(store.readRecovery(), checkpoint);
  store.close(); store = new SqliteStore(file);
  try { assert.deepEqual(store.readSettings(), saved); assert.deepEqual(await store.read(), state); }
  finally { store.close(); }
}));


test('older settings default circular padding; validation, conflicts and restarts preserve the workspace', () => fixture(async directory => {
  const file = join(directory, 'padding.sqlite');
  let store = new SqliteStore(file);
  await new WorkspaceControl(store).dispatch(create());
  await store.writeView('desktop', { camera: { x: 72, y: 81, zoom: .85 } });
  const graph = await store.read(), view = await store.readView('desktop');
  store.writeSettings({ expectedRevision: 0, value: { keepAwake: true } }); store.close();
  // A real v6 row from before the added preference; no schema reset/migration.
  const old = new DatabaseSync(file);
  old.prepare('UPDATE app_settings SET body = ?').run(JSON.stringify({ keepAwake: true, claude: { remoteControl: false, arguments: ['--verbose'] } })); old.close();
  store = new SqliteStore(file);
  let saved = store.readSettings();
  assert.equal(saved.revision, 1); assert.equal(saved.value.neighborhoodPadding, 240);
  assert.deepEqual(saved.value.neighborhoodAppearance, { pixelSize: 24, fade: 96, scatter: 0, style: 'biome', texture: 'quiet', brightness: 24 });
  assert.deepEqual(saved.value.itemViews, {});
  assert.deepEqual(saved.value.quickItemTypes, ['project', 'agent.session', 'terminal.session', 'from-url', 'workspace.todo', 'workspace.note']);
  assert.equal(saved.value.claude.remoteControl, false);
  assert.equal(saved.value.claude.autoMode, true, 'older settings adopt auto mode without resetting other fields');
  saved = store.writeSettings({ expectedRevision: saved.revision, value: { ...saved.value, claude: { ...saved.value.claude, autoMode: false } } });
  for (const padding of [-1, NaN, Infinity]) {
    assert.throws(() => store.writeSettings({ expectedRevision: saved.revision, value: { ...saved.value, neighborhoodPadding: padding } }));
    assert.deepEqual(store.readSettings(), saved);
  }
  for (const neighborhoodAppearance of [{ pixelSize: 7 }, { fade: -1 }, { scatter: 101 }, { style: 'fancy' }, { texture: 'loud', brightness: 24 }]) {
    assert.throws(() => store.writeSettings({ expectedRevision: saved.revision, value: { ...saved.value, neighborhoodAppearance } }));
    assert.deepEqual(store.readSettings(), saved);
  }
  saved = store.writeSettings({ expectedRevision: saved.revision, value: { ...saved.value, neighborhoodPadding: 0, neighborhoodAppearance: { pixelSize: 48, fade: 144, scatter: 60, style: 'plain', texture: 'full', brightness: 24 }, itemViews: { "workspace.note": { width: 540, height: 380 } } } });
  assert.throws(() => store.writeSettings({ expectedRevision: 1, value: { ...saved.value, neighborhoodPadding: 400 } }), /changed elsewhere/);
  saved = store.writeSettings({ expectedRevision: saved.revision, value: { ...saved.value, neighborhoodPadding: 400, quickItemTypes: ['workspace.todo', 'missing.plugin', 'project'] } });
  store.close(); store = new SqliteStore(file);
  try {
    assert.deepEqual(store.readSettings(), saved);
    assert.deepEqual(await store.read(), graph); assert.deepEqual(await store.readView('desktop'), view);
    const reset = store.writeSettings({ expectedRevision: saved.revision, value: { ...saved.value, neighborhoodPadding: 240 } });
    assert.equal(reset.value.neighborhoodPadding, 240);
  } finally { store.close(); }
}));

test('provider aliases persist one shared resource across restart and deleting one keeps the other intact', () => fixture(async directory => {
  const file = join(directory, 'provider-aliases.sqlite'); let store = new SqliteStore(file);
  try {
    let control = new WorkspaceControl(store);
    const add = (id: string) => ({ type: 'item.add', id, resourceId: id + '-r', pluginId: 'github.pull-request', title: 'PR title', data: { owner: 'acme', repo: 'example', number: 42 }, connectionId: 'github-main', position: { x: 20, y: 30 } });
    await control.dispatch({ commandId: 'aliases', expectedRevision: 0, actor, commands: [add('one'), add('two')] });
    const before = await control.read(); assert.equal(before.resources.length, 1);
    store.close(); store = new SqliteStore(file); control = new WorkspaceControl(store);
    assert.deepEqual(await control.read(), before);
    await control.apply({ type: 'node.archive', id: 'one' }, before.revision);
    await control.apply({ type: 'node.delete', id: 'one' }, before.revision + 1);
    const after = await control.read(); assert.equal(after.resources.length, 1); assert.equal(after.nodes[0].id, 'two');
    assert.equal(after.nodes[0].resourceId, before.resources[0].id);
  } finally { store.close(); }
}));

test('v10 upgrade adds the review findings queue; sends and finding history survive reopening', () => fixture(async directory => {
  const file = join(directory, 'review-findings.sqlite');
  let store = new SqliteStore(file);
  await new WorkspaceControl(store).apply({ type: 'project.create', id: 'kept', title: 'Kept', position: { x: 0, y: 0 } }, 0);
  const before = await store.read(); store.close();
  const old = new DatabaseSync(file); old.exec('DROP TABLE rollout_validations; DROP TABLE rollout_events; DROP TABLE provider_validators; DROP TABLE attention_history; DROP TABLE review_sends; DROP TABLE review_finding_events; PRAGMA user_version = 10;'); old.close();
  store = new SqliteStore(file);
  try {
    assert.ok(store.backupFile?.includes('backup-v10-')); assert.deepEqual(await store.read(), before);
    const send = { id: 'send-1', reviewNodeId: 'review', reviewSessionId: 'run-1', agentNodeId: 'agent', findingIds: ['F1', 'F3'], note: 'Keep it small', prompt: 'Fix F1, F3', linked: true };
    assert.equal(store.createReviewSend(send, 1).created, true);
    assert.equal(store.createReviewSend({ ...send, note: 'other' }, 2).created, false, 'an existing request id is never replaced');
    assert.equal(store.transitionReviewSend('send-1', ['sent'], 'failed', 3), undefined, 'the state is compared before changing');
    assert.equal(store.transitionReviewSend('send-1', ['queued'], 'delivering', 4)?.state, 'delivering');
    store.transitionReviewSend('send-1', ['delivering'], 'sent', 5, { status: 'sent' });
    store.addReviewFindingEvents([{ reviewSessionId: 'run-1', findingId: 'F1', status: 'fixed', agentNodeId: 'agent', actor: 'agent', commit: 'abc1234', note: 'Done', at: 6 }]);
  } finally { store.close(); }
  store = new SqliteStore(file);
  try {
    assert.deepEqual(store.reviewSends({ states: ['sent'] }).map(send => [send.id, send.findingIds, send.note, send.linked]), [['send-1', ['F1', 'F3'], 'Keep it small', true]]);
    assert.deepEqual(store.reviewFindingEvents('run-1').map(event => [event.findingId, event.status, event.actor, event.commit]),
      [['F1', 'queued', 'user', undefined], ['F3', 'queued', 'user', undefined], ['F1', 'sent', 'system', undefined], ['F3', 'sent', 'system', undefined], ['F1', 'fixed', 'agent', 'abc1234']]);
    assert.deepEqual(store.reviewFindingEvents('other'), []);
  } finally { store.close(); }
}));

test('dashboard settings saved before placement existed read as centred; a top placement is kept', () => fixture(async directory => {
  const path = join(directory, 'placement.sqlite');
  let store = new SqliteStore(path);
  const saved = store.readSettings();
  store.writeSettings({ expectedRevision: saved.revision, value: { ...saved.value, mapDashboards: { ...saved.value.mapDashboards, enabled: true, belowZoom: .5, placement: 'top' } } }); store.close();
  const old = new DatabaseSync(path); old.prepare(`UPDATE app_settings SET body = json_remove(body, '$.mapDashboards.placement') WHERE id = 1`).run(); old.close();
  store = new SqliteStore(path);
  try {
    const read = store.readSettings();
    assert.deepEqual(read.value.mapDashboards, { enabled: true, belowZoom: .5, placement: 'center', sections: DEFAULT_DASHBOARD_SECTIONS });
    store.writeSettings({ expectedRevision: read.revision, value: { ...read.value, mapDashboards: { ...read.value.mapDashboards, placement: 'top' } } });
    assert.equal(store.readSettings().value.mapDashboards.placement, 'top');
    assert.throws(() => store.writeSettings({ expectedRevision: store.readSettings().revision, value: { ...read.value, mapDashboards: { ...read.value.mapDashboards, placement: 'bottom' } } }));
  } finally { store.close(); }
}));

test('dashboard settings saved before sections existed hide PRs and tickets; chosen sections are kept', () => fixture(async directory => {
  const path = join(directory, 'sections.sqlite');
  let store = new SqliteStore(path);
  const saved = store.readSettings();
  store.writeSettings({ expectedRevision: saved.revision, value: { ...saved.value, mapDashboards: { ...saved.value.mapDashboards, belowZoom: .5 } } }); store.close();
  const old = new DatabaseSync(path); old.prepare(`UPDATE app_settings SET body = json_remove(body, '$.mapDashboards.sections') WHERE id = 1`).run(); old.close();
  store = new SqliteStore(path);
  try {
    const read = store.readSettings();
    assert.deepEqual(read.value.mapDashboards, { enabled: true, belowZoom: .5, placement: 'center', sections: { needsYou: true, working: true, todos: true, plots: true, pipelines: false, tallies: false } });
    store.writeSettings({ expectedRevision: read.revision, value: { ...read.value, mapDashboards: { ...read.value.mapDashboards, sections: { ...read.value.mapDashboards.sections, pipelines: true } } } });
    assert.equal(store.readSettings().value.mapDashboards.sections.pipelines, true);
  } finally { store.close(); }
}));

test('the saved former dashboard default moves to the new default once; chosen thresholds stay', () => fixture(async directory => {
  const legacy = join(directory, 'legacy.sqlite'), chosen = join(directory, 'chosen.sqlite'), fresh = join(directory, 'fresh.sqlite');
  let store = new SqliteStore(legacy);
  const saved = store.readSettings();
  store.writeSettings({ expectedRevision: saved.revision, value: { ...saved.value, keepAwake: true } }); store.close();
  const old = new DatabaseSync(legacy); old.prepare(`UPDATE app_settings SET body = json_set(body, '$.mapDashboards.belowZoom', 0.45) WHERE id = 1`).run(); old.close();
  store = new SqliteStore(legacy);
  try {
    assert.equal(store.readSettings().value.mapDashboards.belowZoom, .45);
    store.migrateSettingsDefaults();
    const migrated = store.readSettings();
    assert.deepEqual(migrated.value.mapDashboards, { enabled: true, belowZoom: .65, placement: 'center', sections: DEFAULT_DASHBOARD_SECTIONS }); assert.equal(migrated.value.keepAwake, true);
    const again = store.writeSettings({ expectedRevision: migrated.revision, value: { ...migrated.value, mapDashboards: { ...migrated.value.mapDashboards, belowZoom: .45 } } });
    store.migrateSettingsDefaults();
    assert.deepEqual(store.readSettings(), again, 'choosing the former default afterwards is kept');
  } finally { store.close(); }
  store = new SqliteStore(chosen);
  try {
    const initial = store.readSettings();
    const written = store.writeSettings({ expectedRevision: initial.revision, value: { ...initial.value, mapDashboards: { ...initial.value.mapDashboards, enabled: false, belowZoom: .3 } } });
    store.migrateSettingsDefaults();
    assert.deepEqual(store.readSettings(), written);
  } finally { store.close(); }
  store = new SqliteStore(fresh);
  try { store.migrateSettingsDefaults(); assert.deepEqual(store.readSettings(), { revision: 0, value: settingsSchema.parse({}) }); }
  finally { store.close(); }
}));

test('closing no longer warns by default; a saved warning turns off once and a later choice is kept', () => fixture(async directory => {
  assert.equal(settingsSchema.parse({}).warnBeforeClosing, false);
  const file = join(directory, 'warn.sqlite');
  let store = new SqliteStore(file);
  const saved = store.readSettings();
  store.writeSettings({ expectedRevision: saved.revision, value: { ...saved.value, keepAwake: true } }); store.close();
  const old = new DatabaseSync(file); old.prepare(`UPDATE app_settings SET body = json_set(body, '$.warnBeforeClosing', json('true')) WHERE id = 1`).run(); old.close();
  store = new SqliteStore(file);
  try {
    store.migrateSettingsDefaults();
    const migrated = store.readSettings();
    assert.equal(migrated.value.warnBeforeClosing, false); assert.equal(migrated.value.keepAwake, true);
    const again = store.writeSettings({ expectedRevision: migrated.revision, value: { ...migrated.value, warnBeforeClosing: true } });
    store.migrateSettingsDefaults();
    assert.deepEqual(store.readSettings(), again, 'turning the warning back on afterwards is kept');
  } finally { store.close(); }
}));

test('v17 upgrade adds plot names; identity, names, hiding and the per-project switch survive reopening', () => fixture(async directory => {
  const file = join(directory, 'plots.sqlite');
  let store = new SqliteStore(file);
  await new WorkspaceControl(store).apply({ type: 'project.create', id: 'kept', title: 'Kept', position: { x: 0, y: 0 } }, 0);
  const before = await store.read(); store.close();
  const old = new DatabaseSync(file); old.exec('DROP TABLE plots; DROP TABLE plot_projects; PRAGMA user_version = 17;'); old.close();
  store = new SqliteStore(file);
  try {
    assert.ok(store.backupFile?.includes('backup-v17-')); assert.deepEqual(await store.read(), before);
    store.savePlots([{ id: 'plot-1', projectId: 'kept', memberIds: ['a', 'b', 'c'] }, { id: 'plot-2', projectId: 'kept', memberIds: ['d', 'e', 'f'] }], 1000);
    store.renamePlot('plot-1', 'Q4 pricing', false);
    store.hidePlot('plot-2', true);
    store.setPlotsShown('kept', false);
    assert.equal(store.renamePlot('plot-1', 'Billing plan switch', true, 'older-fingerprint'), false, 'a generated name never replaces a user name');
    store.savePlots([{ id: 'plot-1', projectId: 'kept', memberIds: ['a', 'b', 'c', 'g'] }], 2000);
  } finally { store.close(); }
  store = new SqliteStore(file);
  try {
    const records = store.plotRecords();
    assert.deepEqual(records.map(record => [record.id, record.memberIds, record.active, record.name, record.generated, record.hidden, record.changedAt]), [
      ['plot-1', ['a', 'b', 'c', 'g'], true, 'Q4 pricing', false, false, 2000],
      ['plot-2', ['d', 'e', 'f'], false, undefined, false, true, 1000],
    ]);
    assert.deepEqual(store.hiddenPlotProjects(), ['kept']);
    store.setPlotsShown('kept', true); assert.deepEqual(store.hiddenPlotProjects(), []);
    store.renamePlot('plot-1', undefined, false);
    assert.equal(store.plotRecords()[0].name, undefined, 'clearing a name hands it back to automation');
  } finally { store.close(); }
}));

test('plot naming shares the summary allowance and is limited per plot', () => fixture(async directory => {
  const store = new SqliteStore(join(directory, 'plot-names.sqlite'));
  try {
    const policy = { ...settingsSchema.parse({}).summaries, requestsPerHour: 2 };
    store.savePlots([{ id: 'p1', projectId: 'x', memberIds: ['a', 'b', 'c'] }, { id: 'p2', projectId: 'x', memberIds: ['d', 'e', 'f'] }], 0);
    assert.equal(store.reservePlotName('p1', 'f1', policy, 1000, 600_000), true);
    assert.equal(store.reservePlotName('p1', 'f2', policy, 2000, 600_000), false, 'once per ten minutes per plot');
    assert.equal(store.reservePlotName('p1', 'f1', policy, 700_000, 600_000), false, 'unchanged evidence is not sent again');
    assert.equal(store.reservePlotName('p2', 'f3', policy, 3000, 600_000), true);
    assert.equal(store.reservePlotName('p1', 'f4', policy, 700_000, 0), false, 'the shared hourly allowance is used up');
    assert.equal(store.renamePlot('p1', 'Billing plan switch', true, 'f2'), false, 'a stale answer is dropped');
    assert.equal(store.renamePlot('p1', 'Billing plan switch', true, 'f1'), true);
    assert.deepEqual(store.plotRecords().map(record => [record.id, record.name, record.generated]), [['p1', 'Billing plan switch', true], ['p2', undefined, false]]);
  } finally { store.close(); }
}));

test('receipts keep the command, not a copy of the workspace; a replay is reported as applied, with the current state', () => fixture(async directory => {
  const file = join(directory, 'receipts.sqlite');
  let store = new SqliteStore(file), control = new WorkspaceControl(store);
  try {
    const first = { commandId: 'attach:stable', expectedRevision: 0, actor, commands: [{ type: 'item.add', id: 'note', resourceId: 'note-r', pluginId: 'workspace.note', title: 'A note', data: { text: 'x'.repeat(4000) }, position: { x: 0, y: 0 } }] };
    await control.dispatch(first);
    for (let revision = 1; revision <= 20; revision++) await control.dispatch({ commandId: `move-${revision}`, expectedRevision: revision, actor, commands: [{ type: 'node.move', id: 'note', position: { x: revision, y: 0 } }] });
    const raw = new DatabaseSync(file, { readOnly: true });
    const kept = Number(raw.prepare("SELECT count(*) AS n FROM receipts WHERE result <> ''").get()!.n), all = Number(raw.prepare('SELECT count(*) AS n FROM receipts').get()!.n);
    raw.close();
    assert.equal(all, 21, 'every command id is remembered');
    assert.equal(kept, 0, 'no receipt keeps a workspace copy');
    const current = await control.read(), replay = await control.dispatch(first);
    assert.equal(replay.replayed, true); assert.deepEqual(replay.state, current, 'an old command is not applied again');
    assert.equal((await control.read()).nodes.length, 1);
    await assert.rejects(control.dispatch({ ...first, commands: [{ ...first.commands[0], title: 'Other' }] }), CommandIdConflict);
    const recent = await control.dispatch({ commandId: 'move-20', expectedRevision: 20, actor, commands: [{ type: 'node.move', id: 'note', position: { x: 20, y: 0 } }] });
    assert.equal(recent.replayed, true); assert.deepEqual(recent.state, current);
  } finally { store.close(); }
}));

test('opening a workspace drops old command copies left by earlier versions and gives the space back', () => fixture(async directory => {
  const file = join(directory, 'bloated.sqlite');
  let store = new SqliteStore(file); store.close();
  const raw = new DatabaseSync(file), insert = raw.prepare('INSERT INTO receipts(command_id, input, result) VALUES (?, ?, ?)'), blob = JSON.stringify({ padding: 'x'.repeat(90_000) });
  raw.exec('BEGIN'); for (let index = 0; index < 600; index++) insert.run(`old-${index}`, `{"commandId":"old-${index}"}`, blob); raw.exec('COMMIT'); raw.close();
  const before = statSync(file).size;
  store = new SqliteStore(file);
  try {
    const check = new DatabaseSync(file, { readOnly: true });
    assert.equal(Number(check.prepare("SELECT count(*) AS n FROM receipts WHERE result <> ''").get()!.n), 0);
    assert.equal(Number(check.prepare('SELECT count(*) AS n FROM receipts').get()!.n), 600);
    check.close();
    assert.ok(statSync(file).size < before / 2, `file shrank from ${before} to ${statSync(file).size}`);
  } finally { store.close(); }
}));

test('a successful upgrade keeps only its own backup; a failed one removes nothing', () => fixture(async directory => {
  const file = join(directory, 'old.sqlite'), stale = [`${file}.backup-v1-old.sqlite`, `${file}.backup-resources-old.sqlite`], unrelated = join(directory, 'old.sqlite.before-repair.sqlite');
  const seed = (version: number) => { const old = new DatabaseSync(file); old.exec(migrations[0]); old.exec(`PRAGMA user_version = ${version}`); old.prepare('INSERT INTO workspace VALUES (1, 7, ?)').run(JSON.stringify(emptyState().view)); old.close(); };
  seed(1);
  for (const path of [...stale, `${stale[0]}-wal`, unrelated]) await writeFile(path, 'x');
  const backups = () => readdirSync(directory).filter(name => name.includes('.backup-')).sort();
  const store = new SqliteStore(file);
  try {
    assert.deepEqual(backups(), [store.backupFile!.slice(directory.length + 1)], 'only the backup of this upgrade is left');
    assert.ok(existsSync(unrelated), 'other files beside the workspace are not touched');
    const resources = store.backupResources();
    assert.deepEqual(backups(), [resources.slice(directory.length + 1)], 'a newer backup replaces it');
  } finally { store.close(); }
  const failing = join(directory, 'failing.sqlite'), kept = `${failing}.backup-v1-earlier.sqlite`;
  const broken = new DatabaseSync(failing); broken.exec('CREATE TABLE workspace (id INTEGER PRIMARY KEY); PRAGMA user_version = 1'); broken.close();
  await writeFile(kept, 'x');
  assert.throws(() => new SqliteStore(failing));
  assert.ok(existsSync(kept), 'a failed upgrade keeps every earlier backup');
}));

test('v23 upgrade: to-dos and nodes saved before context read as none, and context survives reopening', () => fixture(async directory => {
  const file = join(directory, 'context.sqlite');
  let store = new SqliteStore(file), control = new WorkspaceControl(store);
  const apply = async (commands: unknown[], by = actor) => (await control.dispatch({ commandId: crypto.randomUUID(), expectedRevision: (await store.read()).revision, actor: by, commands })).state;
  await apply([
    { type: 'item.add', id: 'task', resourceId: 'task-r', pluginId: 'workspace.todo', title: 'Map task', data: {}, position: { x: 0, y: 0 } },
    { type: 'todo.save', todo: { id: 'check', title: 'Checklist task', completed: true, nodeIds: ['task'] } },
  ]);
  const before = await store.read(); store.close();
  const old = new DatabaseSync(file);
  assert.equal(old.prepare('PRAGMA user_version').get()!.user_version, migrations.length); assert.ok(migrations.length >= 23);
  assert.doesNotMatch(String(old.prepare('SELECT body FROM todos').get()!.body) + String(old.prepare("SELECT body FROM nodes WHERE id = 'task'").get()!.body), /"(context|todoContext)/);
  old.exec('PRAGMA user_version = 22;'); old.close();
  store = new SqliteStore(file); control = new WorkspaceControl(store);
  try {
    const filed = (state: typeof before) => ({ ...state, nodes: state.nodes.map(({ todoOrder: _order, todoTouchedAt: _touched, ...node }) => node) });
    assert.ok(store.backupFile?.includes('backup-v22-')); assert.deepEqual(filed(await store.read()), filed(before), 'the v25 step only files the to-dos');
    assert.equal(todoContext(before, 'check'), undefined); assert.equal(todoContext(before, 'map:task'), undefined);
    await apply([{ type: 'todo.context', id: 'check', context: 'Kept across restarts.', mode: 'replace' }, { type: 'todo.context', id: 'map:task', context: 'On the node.', mode: 'replace' }], { kind: 'agent', id: 'writer' });
  } finally { store.close(); }
  store = new SqliteStore(file);
  try {
    const state = await store.read();
    assert.equal(todoContext(state, 'check')!.text, 'Kept across restarts.'); assert.deepEqual(todoContext(state, 'check')!.by, { kind: 'agent', id: 'writer' });
    assert.equal(todoContext(state, 'map:task')!.text, 'On the node.'); assert.ok(todoContext(state, 'map:task')!.at);
    assert.equal(state.todos[0].completed, true); assert.deepEqual(state.todos[0].nodeIds, ['task']);
  } finally { store.close(); }
  const earlier = new DatabaseSync(file); earlier.exec(`PRAGMA user_version = ${migrations.length + 1};`); earlier.close();
  assert.throws(() => new SqliteStore(file), /newer than this app/);
}));

test('v24 upgrade: standup digests and reports get their own tables; a digest is kept per kind, subject and day', () => fixture(async directory => {
  const file = join(directory, 'standup.sqlite');
  let store = new SqliteStore(file); store.close();
  const old = new DatabaseSync(file); assert.ok(migrations.length >= 24);
  old.exec('DROP TABLE standup_digests; DROP TABLE standup_reports; PRAGMA user_version = 23;'); old.close();
  store = new SqliteStore(file);
  try {
    assert.ok(store.backupFile?.includes('backup-v23-'));
    assert.deepEqual(store.standupDigests(['2026-10-12']), []);
    const evidence = [{ id: 'agent:r1:2026-10-12', kind: 'agent' as const, label: 'Claude · fixes', nodeId: 'n1' }];
    store.saveStandupDigest({ kind: 'agent', subject: 'r1', day: '2026-10-12', text: 'Asked: fix it.', evidence, model: 'haiku', fingerprint: 'f1' }, 10);
    store.failStandupDigest('agent', 'r1', '2026-10-12', 'f2', 20);
    store.saveStandupDigest({ kind: 'pr', subject: 'acme/x/pull/1', day: '2026-10-11', text: 'Merged.', evidence: [], model: 'haiku', fingerprint: 'p1' }, 30);
    assert.deepEqual(store.standupDigest('agent', 'r1', '2026-10-12'), { kind: 'agent', subject: 'r1', day: '2026-10-12', text: 'Asked: fix it.', evidence, model: 'haiku', fingerprint: 'f1', createdAt: 10, failedFingerprint: 'f2', attemptedAt: 20 });
    assert.deepEqual(store.standupDigests(['2026-10-12', '2026-10-11']).map(row => row.subject), ['acme/x/pull/1', 'r1']);
    store.saveStandupReport('k1', { stories: [] }, 'sonnet', 40);
    assert.deepEqual(store.standupReport('k1'), { body: { stories: [] }, model: 'sonnet', createdAt: 40 });
    store.pruneStandup('2026-10-12', 41);
    assert.deepEqual(store.standupDigests(['2026-10-12', '2026-10-11']).map(row => row.subject), ['r1']); assert.ok(store.standupReport('k1'));
    store.pruneStandup('2026-10-12', 40 + 15 * 86_400_000); assert.equal(store.standupReport('k1'), undefined);
  } finally { store.close(); }
  const newer = new DatabaseSync(file); newer.exec(`PRAGMA user_version = ${migrations.length + 1};`); newer.close();
  assert.throws(() => new SqliteStore(file), /newer than this app/);
}));

test('v25 upgrade: open to-dos go to Next in their list order, untouched imports wait in the inbox and done rows start their wait now', () => fixture(async directory => {
  const file = join(directory, 'horizons.sqlite'), at = Date.parse('2026-10-12T08:00:00.000Z');
  let store = new SqliteStore(file), control = new WorkspaceControl(store);
  const apply = async (commands: unknown[]) => control.dispatch({ commandId: crypto.randomUUID(), expectedRevision: (await store.read()).revision, actor, commands });
  const ticket = (key: string) => ({ source: 'linear', key, label: key.toUpperCase(), item: { pluginId: 'linear.ticket', title: key, data: { issueId: key } } });
  await apply([
    { type: 'project.create', id: 'a', title: 'A', summary: '', position: { x: 0, y: 0 } }, { type: 'project.create', id: 'b', title: 'B', summary: '', position: { x: 2000, y: 0 } },
    { type: 'item.add', id: 'a1', resourceId: 'a1-r', pluginId: 'workspace.todo', title: 'A one', data: {}, projectId: 'a', position: { x: 0, y: 200 } },
    { type: 'item.add', id: 'b1', resourceId: 'b1-r', pluginId: 'workspace.todo', title: 'B one', data: {}, projectId: 'b', position: { x: 2000, y: 200 } },
    { type: 'item.add', id: 'b2', resourceId: 'b2-r', pluginId: 'workspace.todo', title: 'B done', data: {}, projectId: 'b', position: { x: 2000, y: 400 } }, { type: 'node.complete', id: 'b2' },
    { type: 'todo.save', todo: { id: 'free', title: 'Free', completed: false, nodeIds: [] } },
    { type: 'todo.save', todo: { id: 't1', title: 'BIL-1 As imported', completed: false, nodeIds: [], triage: ticket('t1') } },
    { type: 'todo.save', todo: { id: 't2', title: 'BIL-2 My words', completed: false, nodeIds: [], triage: ticket('t2') } },
    { type: 'todo.save', todo: { id: 't3', title: 'BIL-3 As imported', completed: true, nodeIds: [], triage: ticket('t3') } },
    { type: 'todo.save', todo: { id: 'gone', title: 'Archived', completed: false, nodeIds: [] } }, { type: 'todo.archive', id: 'gone' },
  ]);
  store.commitObservation('triage:ledger', 0, { account: 'x', entries: [{ key: 't1', todoId: 't1', title: 'BIL-1 As imported' }, { key: 't2', todoId: 't2', title: 'BIL-2 As imported' }, { key: 't3', todoId: 't3', title: 'BIL-3 As imported' }] });
  const before = await store.read(); store.close();
  // The shape a version 24 workspace had: no horizons or touch times, and ranks per project group.
  const old = new DatabaseSync(file);
  old.exec(`UPDATE todos SET body = json_remove(body, '$.horizon', '$.touchedAt', '$.todoOrder');
    UPDATE nodes SET body = json_remove(body, '$.todoHorizon', '$.todoTouchedAt', '$.todoOrder');
    UPDATE nodes SET body = json_set(body, '$.todoOrder', 0) WHERE id IN ('a1', 'b1', 'a', 'b'); UPDATE nodes SET body = json_set(body, '$.todoOrder', 1) WHERE id = 'b2';
    UPDATE nodes SET body = json_set(body, '$.todoOrder', 1) WHERE id = 'a';
    UPDATE todos SET body = json_set(body, '$.todoOrder', 0) WHERE id IN ('free', 't2'); UPDATE todos SET body = json_set(body, '$.todoOrder', 1) WHERE id = 't1';
    PRAGMA user_version = 24;`); old.close();
  store = new SqliteStore(file, { now: () => at });
  try {
    assert.ok(store.backupFile?.includes('backup-v24-'));
    const state = await store.read(), list = todoList(state), byId = (id: string) => state.todos.find(todo => todo.id === id)!;
    assert.deepEqual([list.inbox, list.next, list.later].map(rows => rows.map(row => row.id)), [['t1'], ['t2', 'map:b1', 'map:a1', 'free'], []]);
    assert.deepEqual(list.done.map(row => row.id).sort(), ['map:b2', 't3']);
    assert.equal(byId('t3').touchedAt, new Date(at).toISOString(), 'done rows go to Archive counted from the upgrade');
    assert.equal(state.nodes.find(node => node.id === 'b2')!.todoTouchedAt, new Date(at).toISOString());
    assert.equal(state.nodes.find(node => node.id === 'b2')!.completedAt, before.nodes.find(node => node.id === 'b2')!.completedAt, 'the completion time is kept');
    assert.equal(byId('gone').archivedAt, before.todos.find(todo => todo.id === 'gone')!.archivedAt);
    assert.deepEqual([state.todos.length, state.nodes.length, state.revision], [before.todos.length, before.nodes.length, before.revision], 'nothing is deleted');
    assert.equal(byId('t2').title, 'BIL-2 My words');
  } finally { store.close(); }
}));

test('v26 upgrade: saved rollout validation links show only on hover; every other link stays drawn', () => fixture(async directory => {
  const file = join(directory, 'validation-links.sqlite');
  let store = new SqliteStore(file), control = new WorkspaceControl(store);
  const agent = (id: string, x: number) => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'agent.session', title: id, data: { provider: 'claude', sessionId: `${id}-session` }, position: { x, y: 600 } });
  const link = (id: string, sourceId: string, targetId: string, kind: string, label: string) => ({ type: 'link.save', link: { id, sourceId, targetId, kind, label } });
  await control.dispatch({ commandId: crypto.randomUUID(), expectedRevision: 0, actor, commands: [
    { type: 'item.add', id: 'rollout', resourceId: 'rollout-r', pluginId: 'github.rollout', title: 'Deploy', data: { owner: 'acme', repo: 'app', runId: 101 }, position: { x: 0, y: 0 } },
    { type: 'item.add', id: 'pr', resourceId: 'pr-r', pluginId: 'github.pull-request', title: 'PR', data: { owner: 'acme', repo: 'app', number: 7 }, position: { x: 600, y: 0 } },
    agent('started', 0), agent('connected', 600), agent('other', 1200),
    link('started-validation', 'rollout', 'started', 'context', 'Validation'), link('connected-validation', 'rollout', 'connected', 'context', 'Validation'),
    link('pull', 'pr', 'started', 'context', ''), link('plain', 'rollout', 'other', 'context', ''), link('named', 'pr', 'other', 'context', 'Validation'),
  ] });
  const before = await store.read(); store.close();
  const old = new DatabaseSync(file); old.exec('PRAGMA user_version = 25;'); old.close();
  store = new SqliteStore(file);
  try {
    assert.ok(store.backupFile?.includes('backup-v25-')); assert.ok(migrations.length >= 26);
    const state = await store.read(), reveal = Object.fromEntries(state.links.map(entry => [entry.id, entry.reveal]));
    assert.deepEqual(reveal, { 'started-validation': 'hover', 'connected-validation': 'hover', pull: undefined, plain: undefined, named: undefined });
    assert.deepEqual(state.links.map(({ reveal: _, ...rest }) => rest), before.links, 'nothing else changes');
    assert.equal(state.revision, before.revision);
  } finally { store.close(); }
}));

test('v27 upgrade: the GitHub inbox gains a seen table and keeps its hidden pull requests', () => fixture(async directory => {
  const file = join(directory, 'inbox-seen.sqlite');
  let store = new SqliteStore(file);
  store.hideInboxPull('acme/app/pull/1', 1); store.close();
  const old = new DatabaseSync(file); old.exec('DROP TABLE github_inbox_seen; PRAGMA user_version = 26;'); old.close();
  store = new SqliteStore(file);
  try {
    assert.ok(store.backupFile?.includes('backup-v26-'));
    assert.deepEqual([...store.hiddenInboxPulls()], ['acme/app/pull/1']);
    assert.equal(store.seenInboxPulls().size, 0);
    store.seeInboxPull('acme/app/pull/2', { updatedAt: '2026-09-29T10:00:00Z', reasons: ['review'] }, 2);
    assert.deepEqual(store.seenInboxPulls().get('acme/app/pull/2'), { updatedAt: '2026-09-29T10:00:00Z', reasons: ['review'] });
  } finally { store.close(); }
}));

test('v28 upgrade: plots gain an assigned and a chosen color and keep their identity, names and hiding', () => fixture(async directory => {
  const file = join(directory, 'plot-colors.sqlite');
  let store = new SqliteStore(file);
  store.savePlots([{ id: 'plot-1', projectId: 'kept', memberIds: ['a', 'b', 'c'] }], 1000); store.renamePlot('plot-1', 'Q4 pricing', false); store.hidePlot('plot-1', true); store.close();
  const old = new DatabaseSync(file); old.exec('ALTER TABLE plots DROP COLUMN color; ALTER TABLE plots DROP COLUMN chosen_color; PRAGMA user_version = 27;'); old.close();
  store = new SqliteStore(file);
  try {
    assert.ok(store.backupFile?.includes('backup-v27-'));
    assert.deepEqual(store.plotRecords().map(record => [record.id, record.name, record.hidden, record.color, record.chosenColor]), [['plot-1', 'Q4 pricing', true, undefined, undefined]]);
    store.colorPlots(new Map([['plot-1', 'sky']])); store.choosePlotColor('plot-1', 'rose');
    store.savePlots([{ id: 'plot-1', projectId: 'kept', memberIds: ['a', 'b', 'c', 'd'] }], 2000);
  } finally { store.close(); }
  store = new SqliteStore(file);
  try {
    assert.deepEqual(store.plotRecords().map(record => [record.id, record.color, record.chosenColor]), [['plot-1', 'sky', 'rose']]);
    store.choosePlotColor('plot-1', undefined);
    assert.deepEqual(store.plotRecords().map(record => [record.color, record.chosenColor]), [['sky', undefined]]);
  } finally { store.close(); }
}));

test('project summaries upgrade: a new table keeps the latest text per project across a restart', () => fixture(async directory => {
  const file = join(directory, 'project-summaries.sqlite'), step = migrations.findIndex(migration => migration.includes('project_summaries'));
  assert.ok(step > 0);
  let store = new SqliteStore(file); store.close();
  const old = new DatabaseSync(file); old.exec(`DROP TABLE project_summaries; PRAGMA user_version = ${step};`); old.close();
  store = new SqliteStore(file);
  const policy = settingsSchema.parse({}).summaries;
  try {
    assert.ok(store.backupFile?.includes(`backup-v${step}-`));
    assert.deepEqual(store.projectSummaries(), []);
    assert.equal(store.reserveProjectSummary('billing', 'f1', policy, 1000, 600_000), true);
    assert.equal(store.finishProjectSummary('billing', 'f1', 'Refund PR waits on your review.', 'haiku'), true);
  } finally { store.close(); }
  store = new SqliteStore(file);
  try { assert.deepEqual(store.projectSummaries(), [{ projectId: 'billing', fingerprint: 'f1', attemptedAt: 1000, text: 'Refund PR waits on your review.', model: 'haiku' }]); } finally { store.close(); }
}));

test('project summaries share the allowance, leave headroom to other helpers and are limited per project', () => fixture(async directory => {
  const store = new SqliteStore(join(directory, 'project-summary-limits.sqlite'));
  try {
    const policy = { ...settingsSchema.parse({}).summaries, requestsPerHour: 6 };
    assert.equal(store.reserveProjectSummary('a', 'f1', policy, 1000, 600_000, 4), true);
    assert.equal(store.reserveProjectSummary('a', 'f2', policy, 2000, 600_000, 4), false, 'once per ten minutes per project');
    assert.equal(store.reserveProjectSummary('a', 'f1', policy, 700_000, 600_000, 4), false, 'unchanged input is not sent again');
    assert.equal(store.reserveProjectSummary('b', 'f3', policy, 3000, 600_000, 4), true);
    assert.equal(store.reserveProjectSummary('c', 'f4', policy, 4000, 600_000, 4), false, 'four requests an hour stay with the other helpers');
    assert.equal(store.reserveAiRequest(policy, 5000), true, 'which another helper can still use');
    assert.equal(store.finishProjectSummary('a', 'f2', 'Stale.', 'haiku'), false, 'an answer for older input is dropped');
    assert.equal(store.finishProjectSummary('a', 'f1', 'Billing waits on you.', 'haiku'), true);
    assert.equal(store.reserveProjectSummary('a', 'f5', policy, 3_700_000, 600_000, 4), true, 'a new attempt keeps the earlier text until it is answered');
    assert.deepEqual(store.projectSummaries().map(row => [row.projectId, row.fingerprint, row.text]), [['a', 'f5', 'Billing waits on you.'], ['b', 'f3', undefined]]);
    store.forgetProjectSummaries(['b']);
    assert.deepEqual(store.projectSummaries().map(row => row.projectId), ['a'], 'rows of projects that are gone are dropped');
  } finally { store.close(); }
}));

test('AI requests of every kind share the rolling hourly and daily allowance, durably',() => fixture(async directory => {
  const file = join(directory, 'allowance.sqlite'), policy = { ...settingsSchema.parse({}).summaries, requestsPerHour: 2, requestsPerDay: 3 };
  let store = new SqliteStore(file);
  try {
    assert.equal(store.reserveAiRequest(policy, 1_000), true); assert.equal(store.reserveAiRequest(policy, 2_000), true); assert.equal(store.reserveAiRequest(policy, 3_000), false);
  } finally { store.close(); }
  store = new SqliteStore(file);
  try {
    assert.equal(store.reserveAiRequest(policy, 3_700_000), true);
    assert.equal(store.reserveAiRequest(policy, 3_800_000), false);
  } finally { store.close(); }
}));

test('a rollout validation or event change is announced once it is committed', () => fixture(async directory => {
  const store = new SqliteStore(join(directory, 'rollout-changes.sqlite')), announced: string[] = [];
  const stop = store.onRolloutChange(id => {
    announced.push(id);
    assert.ok(store.rolloutValidations({ rolloutResourceId: id }).length > 0, 'the change is readable when it is announced');
    store.snapshot();
  });
  try {
    const scope = { runId: 1, attempt: 1, headSha: 'a'.repeat(40) };
    const validation = store.createRolloutValidation({ id: 'v1', rolloutResourceId: 'rollout-r', agentNodeId: 'agent', agent: { title: 'Agent' }, requestId: 'request-1', scope, requestedAt: 1 });
    assert.deepEqual(announced, ['rollout-r']);
    store.createRolloutValidation({ id: 'v1-again', rolloutResourceId: 'rollout-r', agentNodeId: 'agent', agent: { title: 'Agent' }, requestId: 'request-1', scope, requestedAt: 2 });
    store.updateRolloutValidation(validation.id, validation.sequence, { idleSince: 5 }, 5);
    assert.deepEqual(announced, ['rollout-r'], 'a replayed request and an idle mark change nothing shown');
    store.updateRolloutValidation(validation.id, validation.sequence, { state: 'running', sequence: 1, reports: 1 }, 6);
    store.addRolloutEvents('rollout-r', [{ runId: 1, attempt: 1, kind: 'attempt-started', jobId: 0, environment: '', body: {}, observedAt: 6 }]);
    assert.deepEqual(announced, ['rollout-r', 'rollout-r', 'rollout-r']);
    stop();
    store.updateRolloutValidation(validation.id, 1, { state: 'final', verdict: 'passed', sequence: 2 }, 8);
    assert.equal(announced.length, 3);
  } finally { store.close(); }
}));
