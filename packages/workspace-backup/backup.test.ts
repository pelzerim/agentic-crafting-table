import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceControl } from '../core/control.ts';
import { SqliteStore, migrations } from '../workspace-service/sqlite-store.ts';
import { RuntimeJournal } from '../session-runtime/journal.ts';
import { createBackup, prepareRecovery, verifyBackup } from './backup.ts';
import type { BackupManifest } from './backup.ts';

async function fixture(run: (root: string, source: string, backup: string) => unknown) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'act-backup-'))), source = join(root, 'source'), backup = join(root, 'backup');
  mkdirSync(source, { mode: 0o700 });
  try { await run(root, source, backup); } finally { rmSync(root, { recursive: true, force: true }); }
}
const command = { commandId: 'create-project', expectedRevision: 0, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'project.create', id: 'project', title: 'Preserve me', position: { x: 123, y: 456 } }] };
const request = (directory: string, id = 'session') => ({ sessionId: id, requestId: id + '-request', nodeId: 'node', workspaceId: 'workspace', cwd: directory, executable: '/bin/sh', args: [], cols: 80, rows: 24 });
function put(root: string, path: string, content: string, mode = 0o600) { const file = join(root, path); mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, content, { mode }); }
function updateManifest(backup: string, update: (manifest: BackupManifest) => void) {
  const path = join(backup, 'manifest.json'), manifest = JSON.parse(readFileSync(path, 'utf8')); update(manifest); writeFileSync(path, JSON.stringify(manifest));
}
function refreshHash(backup: string, path: string) {
  updateManifest(backup, manifest => { const entry = manifest.entries.find(entry => entry.path === path); if (entry?.type !== 'file') throw new Error('Expected file'); const bytes = readFileSync(join(backup, 'data', path)); entry.bytes = bytes.length; entry.sha256 = createHash('sha256').update(bytes).digest('hex'); });
}

test('backup/recovery preserves WAL graph, camera, settings, receipts, jobs, checkpoints and recordings without activation', () => fixture(async (root, source, backup) => {
  const store = new SqliteStore(join(source, 'workspace.sqlite')), control = new WorkspaceControl(store);
  const first = await control.dispatch(command);
  await store.writeView('desktop', { mode: 'workspace', camera: { x: 22, y: 33, zoom: .7 } });
  store.writeSettings({ expectedRevision: 0, value: { neighborhoodPadding: 370 } });
  const checkpoint = { phase: 'closed' as const, entries: [{ sessionId: 'session', nodeId: 'node', title: 'Session', kind: 'terminal' as const, continueWork: false, requestId: 'resume-once', state: 'pending' as const }] };
  store.writeRecovery(checkpoint); store.close();
  mkdirSync(join(source, 'runtime'));
  const runtime = new RuntimeJournal(join(source, 'runtime/supervisor.sqlite'), 'fixture');
  runtime.reserve(request(source)); runtime.update('session', { state: 'exited' });
  runtime.append('session', [{ sequence: 1, data: '\u001b[32mretained output\u001b[0m\n' }]);
  runtime.reserve(request(source, 'deleted')); runtime.update('deleted', { state: 'exited' });
  runtime.append('deleted', [{ sequence: 1, data: 'removed recording' }]); runtime.manage('deleted', 'archive'); runtime.deleteRecording('deleted'); runtime.close();
  for (const path of ['agent-launches/request/plan.json', 'agent-launches/request/context.json', 'agent-launches/request/plugin/hooks/hooks.json', 'review-launches/request/plan.json', 'review-resumes/request.json', 'runtime/terminal-launches/request.json', 'runtime/scrollback/stale.json', 'comparisons/request/comparison.json']) put(source, path, JSON.stringify({ originalPath: source, identity: path }));
  put(source, 'comparisons/request/repository/bin/check', '#!/bin/sh\nexit 99\n', 0o700);
  symlinkSync('bin/check', join(source, 'comparisons/request/repository/check'));
  for (const path of ['.service-token', 'runtime/.service-token', 'service.log', 'runtime/service.log', 'Cache/private', 'workspace.sqlite.backup-v8.sqlite', 'summary-workspace/private']) put(source, path, 'excluded');
  const native = join(root, 'native-conversation'); writeFileSync(native, 'native original');
  // Keep a connection open so committed changes remain in WAL during the backup.
  const wal = new DatabaseSync(join(source, 'workspace.sqlite'));
  wal.prepare('INSERT INTO provider_observations VALUES(?,?,?)').run('fixture', 3, '{"fromWal":true}');
  wal.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?)').run('job', 'dedupe-key', '{"action":"fixture","nodeId":"project","arguments":{}}', 'outcome-unknown', 1, '{"remoteIdentity":"same-id"}', null, 'uncertain', '2026-09-26');
  assert.ok(lstatSync(join(source, 'workspace.sqlite-wal')).size > 0);
  const sourceInode = lstatSync(join(source, 'workspace.sqlite')).ino;
  try {
    const manifest = createBackup(source, backup); assert.deepEqual(verifyBackup(backup), manifest);
    const recovery = prepareRecovery(backup, join(root, 'recovery'));
    assert.equal(recovery.sourceDirectory, source); assert.ok(existsSync(join(root, 'recovery/READY.json')));
    assert.equal(lstatSync(join(source, 'workspace.sqlite')).ino, sourceInode);
    const restored = new SqliteStore(join(recovery.profile, 'workspace.sqlite'));
    try {
      assert.deepEqual(await new WorkspaceControl(restored).dispatch(command), { ...first, replayed: true }, 'receipt is replayed, not applied twice');
      assert.equal((await restored.snapshot()).state.nodes[0].title, 'Preserve me');
      assert.equal(restored.readSettings().value.neighborhoodPadding, 370);
      assert.deepEqual(restored.readRecovery(), checkpoint);
    } finally { restored.close(); }
    const recoveredDb = new DatabaseSync(join(recovery.profile, 'workspace.sqlite'), { readOnly: true });
    try {
      assert.equal(recoveredDb.prepare('SELECT body FROM provider_observations').get()!.body, '{"fromWal":true}');
      assert.equal(recoveredDb.prepare('SELECT state FROM jobs').get()!.state, 'outcome-unknown');
      assert.deepEqual(JSON.parse(String(recoveredDb.prepare('SELECT body FROM views').get()!.body)).camera, { x: 22, y: 33, zoom: .7 });
    } finally { recoveredDb.close(); }
    const restoredRuntime = new RuntimeJournal(join(recovery.profile, 'runtime/supervisor.sqlite'), 'restored');
    try {
      assert.equal(restoredRuntime.history('session', 0, 1)[0].data, '\u001b[32mretained output\u001b[0m\n');
      assert.equal(restoredRuntime.reserve(request(source)).fresh, false);
      assert.deepEqual(restoredRuntime.history('deleted', 0, 1), []); assert.ok(restoredRuntime.get('deleted').recordingDeletedAt);
    } finally { restoredRuntime.close(); }
    assert.equal(readlinkSync(join(recovery.profile, 'comparisons/request/repository/check')), 'bin/check');
    assert.equal(readFileSync(native, 'utf8'), 'native original');
    assert.equal(readFileSync(join(recovery.profile, 'agent-launches/request/plan.json'), 'utf8'), readFileSync(join(source, 'agent-launches/request/plan.json'), 'utf8'));
    assert.equal(lstatSync(backup).mode & 0o777, 0o700);
    for (const entry of manifest.entries) if (entry.type !== 'symlink') assert.equal(lstatSync(join(backup, 'data', entry.path)).mode & 0o077, 0);
    assert.ok(manifest.entries.every(entry => !/token|service\.log|private|backup-v|-(wal|shm)$/.test(entry.path)));
    assert.deepEqual(verifyBackup(backup), manifest, 'reading a recovery copy does not alter the backup');
  } finally { wal.close(); }
}));

test('refuses live workspace owners, supervisors, and orphaned recorded processes', () => fixture(async (_root, source, backup) => {
  const store = new SqliteStore(join(source, 'workspace.sqlite')); store.claimService('live');
  assert.throws(() => createBackup(source, backup), /Quit the app/); assert.equal(existsSync(backup), false);
  store.releaseService('live'); store.close(); mkdirSync(join(source, 'runtime'));
  const journal = new RuntimeJournal(join(source, 'runtime/supervisor.sqlite'), 'live-runtime');
  assert.throws(() => createBackup(source, backup), /Quit the app/);
  journal.reserve(request(source)); journal.update('session', { state: 'running', pid: process.pid }); journal.close();
  assert.throws(() => createBackup(source, backup), /still alive/); assert.equal(existsSync(backup), false);
}));

test('both SQLite write locks block concurrent ownership claims and release after failure', () => fixture(async (_root, source, backup) => {
  new SqliteStore(join(source, 'workspace.sqlite')).close(); mkdirSync(join(source, 'runtime')); new RuntimeJournal(join(source, 'runtime/supervisor.sqlite'), 'fixture').close();
  assert.throws(() => createBackup(source, backup, phase => {
    if (phase !== 'locked') return;
    for (const file of ['workspace.sqlite', 'runtime/supervisor.sqlite']) {
      const other = new DatabaseSync(join(source, file)); try { assert.throws(() => other.exec('BEGIN IMMEDIATE'), /locked/); } finally { other.close(); }
    }
    throw new Error('simulated interruption');
  }), /simulated interruption/);
  createBackup(source, backup); verifyBackup(backup);
}));

test('rejects unsupported/corrupt source databases and releases earlier locks', () => fixture(async (_root, source, backup) => {
  new SqliteStore(join(source, 'workspace.sqlite')).close(); mkdirSync(join(source, 'runtime'));
  const journal = new RuntimeJournal(join(source, 'runtime/supervisor.sqlite'), 'fixture'); journal.close();
  const future = new DatabaseSync(join(source, 'runtime/supervisor.sqlite')); future.exec('PRAGMA user_version=4'); future.close();
  assert.throws(() => createBackup(source, backup), /Unsupported database version/);
  const old = new DatabaseSync(join(source, 'runtime/supervisor.sqlite')); old.exec('PRAGMA user_version=3'); old.close();
  const graph = new DatabaseSync(join(source, 'workspace.sqlite')); graph.exec('BEGIN IMMEDIATE; ROLLBACK'); graph.close();
  writeFileSync(join(source, 'runtime/supervisor.sqlite'), 'not a database');
  assert.throws(() => createBackup(source, backup), /not a database/); assert.equal(existsSync(backup), false);
}));

test('old graph and runtime snapshots can be restored and migrated without modifying the originals', () => fixture(async (root, source, backup) => {
  const db = new DatabaseSync(join(source, 'workspace.sqlite')); db.exec(migrations.slice(0, 3).join('\n')); db.exec('PRAGMA user_version=3'); db.close();
  mkdirSync(join(source, 'runtime'));
  const runtime = new DatabaseSync(join(source, 'runtime/supervisor.sqlite'));
  runtime.exec('CREATE TABLE owner(id INTEGER PRIMARY KEY, instance TEXT, pid INTEGER); CREATE TABLE sessions(id TEXT PRIMARY KEY, request_id TEXT UNIQUE, request TEXT, body TEXT); PRAGMA user_version=1');
  runtime.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('old', 'request', '{}', '{"id":"old","state":"exited","requestId":"request"}'); runtime.close();
  put(source, 'runtime/scrollback/old.json', '{"chunks":[{"sequence":7,"data":"legacy tail"}]}');
  createBackup(source, backup); const recovered = prepareRecovery(backup, join(root, 'recovery'));
  new SqliteStore(join(recovered.profile, 'workspace.sqlite')).close();
  const upgraded = new RuntimeJournal(join(recovered.profile, 'runtime/supervisor.sqlite'), 'upgraded');
  assert.equal(upgraded.get('old').id, 'old'); upgraded.close();
  assert.ok(readdirSync(recovered.profile).some(name => name.includes('.backup-v3-')));
  assert.ok(existsSync(join(recovered.profile, 'runtime/supervisor.sqlite.before-v2.sqlite')));
  const original = new DatabaseSync(join(source, 'workspace.sqlite'), { readOnly: true }); assert.equal(original.prepare('PRAGMA user_version').get()!.user_version, 3); original.close();
  verifyBackup(backup);
}));

test('corrupt, missing, extra, and newer-version backup content cannot produce a recovery copy', () => fixture(async (root, source, backup) => {
  new SqliteStore(join(source, 'workspace.sqlite')).close(); put(source, 'agent-launches/request/plan.json', '{"id":"same"}'); createBackup(source, backup);
  const original = readFileSync(join(backup, 'data/agent-launches/request/plan.json'));
  writeFileSync(join(backup, 'data/agent-launches/request/plan.json'), 'corrupt');
  assert.throws(() => prepareRecovery(backup, join(root, 'recovery')), /checksum/); assert.equal(existsSync(join(root, 'recovery')), false);
  writeFileSync(join(backup, 'data/agent-launches/request/plan.json'), original);
  rmSync(join(backup, 'data/agent-launches/request/plan.json'));
  assert.throws(() => verifyBackup(backup), /ENOENT/); put(backup, 'data/agent-launches/request/plan.json', original.toString());
  put(backup, 'data/unknown', 'extra'); assert.throws(() => verifyBackup(backup), /unlisted/); rmSync(join(backup, 'data/unknown'));
  chmodSync(join(backup, 'data/agent-launches/request/plan.json'), 0o700); assert.throws(() => verifyBackup(backup), /mode mismatch/); chmodSync(join(backup, 'data/agent-launches/request/plan.json'), 0o600);
  const db = new DatabaseSync(join(backup, 'data/workspace.sqlite')); db.exec('PRAGMA user_version=999'); db.close(); refreshHash(backup, 'workspace.sqlite');
  assert.throws(() => verifyBackup(backup), /Unsupported database version/);
}));

test('rejects traversal, duplicate paths, symlink parents, external links and hard links', () => fixture(async (root, source, backup) => {
  new SqliteStore(join(source, 'workspace.sqlite')).close(); put(source, 'agent-launches/request/plan.json', '{}');
  const secret = join(root, 'secret'); writeFileSync(secret, 'must not copy'); symlinkSync(secret, join(source, 'agent-launches/request/escape'));
  assert.throws(() => createBackup(source, backup), /external symbolic link/); assert.equal(existsSync(backup), false); rmSync(join(source, 'agent-launches/request/escape'));
  linkSync(secret, join(source, 'agent-launches/request/hard')); assert.throws(() => createBackup(source, backup), /hard links/); rmSync(join(source, 'agent-launches/request/hard'));
  symlinkSync(secret, join(source, 'workspace.sqlite-wal'));
  assert.throws(() => createBackup(source, backup), /regular file/); rmSync(join(source, 'workspace.sqlite-wal'));
  createBackup(source, backup); const original = readFileSync(join(backup, 'manifest.json'));
  for (const path of ['../secret', '/secret', 'agent-launches/../secret', 'agent-launches//secret']) {
    updateManifest(backup, manifest => { manifest.entries[0].path = path; }); assert.throws(() => verifyBackup(backup), /Invalid.*path/); writeFileSync(join(backup, 'manifest.json'), original);
  }
  updateManifest(backup, manifest => { manifest.entries.push(manifest.entries[0]); }); assert.throws(() => verifyBackup(backup), /duplicate/); writeFileSync(join(backup, 'manifest.json'), original);
  rmSync(join(backup, 'data/agent-launches'), { recursive: true }); symlinkSync(root, join(backup, 'data/agent-launches'));
  assert.throws(() => prepareRecovery(backup, join(root, 'recovery')), /directory|symbolic link/); assert.equal(readFileSync(secret, 'utf8'), 'must not copy');
}));

test('never overwrites existing output or the source, including aliases and nested destinations', () => fixture(async (root, source, backup) => {
  new SqliteStore(join(source, 'workspace.sqlite')).close();
  assert.throws(() => createBackup(source, join(source, 'nested')), /non-nested/);
  mkdirSync(backup); assert.throws(() => createBackup(source, backup), /already exists/); rmSync(backup, { recursive: true });
  symlinkSync(source, join(root, 'alias')); assert.throws(() => createBackup(source, join(root, 'alias/nested')), /non-nested/);
  createBackup(source, backup);
  assert.throws(() => prepareRecovery(backup, source), /non-nested/);
  assert.throws(() => prepareRecovery(backup, join(backup, 'recovery')), /non-nested/);
  mkdirSync(join(root, 'existing')); assert.throws(() => prepareRecovery(backup, join(root, 'existing')), /already exists/);
}));

test('SIGKILL before publication leaves an invalid partial backup and releases database locks', () => fixture(async (root, source, backup) => {
  new SqliteStore(join(source, 'workspace.sqlite')).close();
  const module = new URL('./backup.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { createBackup } from ${JSON.stringify(module)}; createBackup(process.argv[1], process.argv[2], phase => { if (phase === 'copied') { process.stdout.write('copied\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); } });`, source, backup], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('Backup child exited early'); }), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Backup child timed out')), 10_000); timer.unref(); })]);
    child.kill('SIGKILL'); await once(child, 'exit');
    assert.ok(existsSync(join(backup, 'data/workspace.sqlite'))); assert.equal(existsSync(join(backup, 'manifest.json')), false);
    assert.throws(() => verifyBackup(backup), /ENOENT/);
    assert.throws(() => prepareRecovery(backup, join(root, 'recovery')), /ENOENT/);
    const retry = join(root, 'retry'); createBackup(source, retry); verifyBackup(retry);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
}));

test('root CLI creates, verifies and prepares only a separate recovery copy', () => fixture(async (root, source, backup) => {
  new SqliteStore(join(source, 'workspace.sqlite')).close();
  const cli = resolve('scripts/workspace-backup.mjs');
  for (const args of [['create', source, backup], ['verify', backup], ['prepare-recovery', backup, join(root, 'recovery')]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(spawnSync(process.execPath, [cli, 'create', source, backup]).status, 1);
  assert.equal(spawnSync(process.execPath, [cli, 'verify', backup, 'extra']).status, 1);
  assert.ok(existsSync(join(root, 'recovery/READY.json'))); assert.ok(existsSync(join(source, 'workspace.sqlite')));
}));

test('a recovered graph serves authenticated clients with a fresh IPC token and no runtime', () => fixture(async (root, source, backup) => {
  const { startWorkspaceService } = await import('../workspace-service/server.ts');
  const { connectWorkspace } = await import('../workspace-service/client.ts');
  const store = new SqliteStore(join(source, 'workspace.sqlite')); await new WorkspaceControl(store).dispatch(command); store.close();
  put(source, '.service-token', 'a'.repeat(64)); createBackup(source, backup);
  const recovery = prepareRecovery(backup, join(root, 'recovery'));
  assert.equal(existsSync(join(recovery.profile, '.service-token')), false);
  // No runtime or provider adapters: this fixture cannot launch models or call accounts.
  const service = await startWorkspaceService(recovery.profile, undefined, undefined, { assignments: [], reviews: {}, workflows: {} });
  const client = await connectWorkspace(recovery.profile);
  try {
    assert.notEqual(readFileSync(join(recovery.profile, '.service-token'), 'utf8'), 'a'.repeat(64));
    const snapshot = await client.call<{ state: { nodes: { title: string }[]; revision: number } }>('read');
    assert.equal(snapshot.state.nodes[0].title, 'Preserve me'); assert.equal(snapshot.state.revision, 1);
    const result = await client.call<{ replayed: boolean }>('apply', command); assert.equal(result.replayed, true);
    assert.equal(readFileSync(join(source, '.service-token'), 'utf8'), 'a'.repeat(64));
    assert.equal(existsSync(join(recovery.profile, 'runtime')), false);
  } finally { client.close(); await service.close(); }
  verifyBackup(backup);
}));
