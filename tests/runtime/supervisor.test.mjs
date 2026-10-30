import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import electron from 'electron';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import { WorkspaceConnection } from '../../packages/workspace-service/connection.ts';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { workspacePaths, readWorkspaceSecret } from '../../packages/workspace-service/paths.ts';
import { createConnection } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeJournal } from '../../packages/session-runtime/journal.ts';

async function until(fn, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error('Timed out waiting for real session state');
}
async function start(directory, environment = {}) {
  const process = spawn(electron, [resolve('dist/session-supervisor.cjs')], { env: { ...globalThis.process.env, ELECTRON_RUN_AS_NODE: '1', ACT_DATA_DIR: directory, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb', ...environment }, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostic = ''; process.stderr.on('data', data => { diagnostic += data; });
  const client = await until(() => connectSupervisor(directory).catch(() => { if (process.exitCode !== null) throw new Error(diagnostic); return undefined; }));
  return { process, client, diagnostics: () => diagnostic };
}
function request(directory, sessionId = 'terminal') {
  return { sessionId, requestId: `launch-${sessionId}`, nodeId: 'test-node', workspaceId: 'test-workspace', executable: process.execPath, args: [resolve('tests/fixtures/scripted-agent.mjs')], cwd: directory, cols: 80, rows: 24 };
}
async function output(client, id, text) { return until(async () => { const value = await client.call('sessions.attach', { sessionId: id }); return value.chunks.map(chunk => chunk.data).join('').includes(text) && value; }); }
async function cleanup(service, directory) {
  service.client.close();
  if (service.process.exitCode === null && service.process.signalCode === null) { const exited = once(service.process, 'exit'); service.process.kill('SIGTERM'); await exited; }
  await rm(directory, { recursive: true, force: true });
}

test('a resumed Codex conversation takes its status from the response and keeps one copy of its guide', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-codex-seeded-')), service = await start(directory, { CODEX_FIXTURE_QUIET_RESUME: '1' });
  const fixture = resolve('tests/fixtures/native-codex.mjs');
  const launch = { ...request(directory, 'codex'), args: [fixture], native: { provider: 'codex', model: 'fixture', instructions: 'Trusted test guide', context: 'Untrusted project data', config: {}, serverArguments: [fixture] } };
  try {
    await service.client.call('sessions.launch', launch);
    const started = await output(service.client, 'codex', 'NATIVE_READY:'), nativeId = started.session.native.nativeSessionId;
    assert.equal(started.session.native.status, 'idle'); assert.ok(started.session.native.readyAt);
    await service.client.call('sessions.stop', { sessionId: 'codex' });
    await until(async () => (await service.client.call('sessions.read', { sessionId: 'codex' })).session.state === 'exited');
    const resumed = { ...launch, sessionId: 'resumed', requestId: 'resumed', predecessorId: 'codex', native: { ...launch.native, nativeSessionId: nativeId, contextDelivered: true } };
    await service.client.call('sessions.launch', resumed);
    const ready = await output(service.client, 'resumed', 'NATIVE_READY:');
    assert.equal(ready.session.native.status, 'idle', 'no notification is needed'); assert.ok(ready.session.native.readyAt);
    assert.equal(JSON.parse(await readFile(join(directory, 'native-codex.json'), 'utf8')).injections, 1);
  } finally { service.process.kill('SIGKILL'); await rm(directory, { recursive: true, force: true }); }
});

test('native supervisor deduplicates launches and preserves ordered PTY streams across clients', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-pty-')); const service = await start(directory);
  try {
    const launch = request(directory), first = await service.client.call('sessions.launch', launch);
    assert.equal(first.session.state, 'running'); await output(service.client, launch.sessionId, 'READY:');
    await service.client.call('sessions.input', { sessionId: launch.sessionId, data: 'colors\r' });
    await output(service.client, launch.sessionId, 'COLORS:xterm-256color:truecolor:unset:unset\x1b[32m GREEN');
    assert.equal((await service.client.call('sessions.launch', launch)).session.pid, first.session.pid);
    await assert.rejects(service.client.call('sessions.launch', { ...launch, args: [] }), /reused/);
    await service.client.call('sessions.input', { sessionId: launch.sessionId, data: 'Grüße 世界 🛠\r' });
    await output(service.client, launch.sessionId, 'RECEIVED:Grüße 世界 🛠');
    await service.client.call('sessions.resize', { sessionId: launch.sessionId, cols: 93, rows: 37 });
    await service.client.call('sessions.input', { sessionId: launch.sessionId, data: 'size\r' });
    await output(service.client, launch.sessionId, 'SIZE:93:37');
    await service.client.call('sessions.input', { sessionId: launch.sessionId, data: '\u0003' });
    await output(service.client, launch.sessionId, 'CONTROL:SIGINT');
    await service.client.call('sessions.manage', { sessionId: launch.sessionId, action: 'archive' });
    assert.equal((await service.client.call('sessions.managed', { view: 'active' })).length, 0);
    assert.equal((await service.client.call('sessions.managed', { view: 'archived' }))[0].pid, first.session.pid);
    assert.deepEqual((await service.client.call('sessions.page', { view: 'archived' })).counts, { current: 0, ended: 0, archived: 1 });
    assert.deepEqual((await service.client.call('sessions.page', {})).sessions, []);
    await assert.rejects(service.client.call('sessions.manage', { sessionId: launch.sessionId, action: 'remove' }), /Stop the session/);
    const before = await service.client.call('sessions.attach', { sessionId: launch.sessionId });
    service.client.close(); service.client = await connectSupervisor(directory);
    const attached = await service.client.call('sessions.attach', { sessionId: launch.sessionId });
    assert.equal(attached.session.pid, first.session.pid); assert.deepEqual(attached.chunks, before.chunks);
    const events = []; service.client.on('notification', event => { if (event.event === 'session' && event.data.kind === 'output') events.push(event.data.chunk); });
    await service.client.call('sessions.input', { sessionId: launch.sessionId, data: 'flood\r' });
    const flooded = await output(service.client, launch.sessionId, 'FLOOD_DONE');
    assert.equal(flooded.truncated, true);
    assert.ok(flooded.chunks.reduce((size, chunk) => size + Buffer.byteLength(chunk.data), 0) <= 256 * 1024);
    assert.ok(events.length > 1);
    assert.ok(events.every((chunk, index) => !index || chunk.sequence === events[index - 1].sequence + 1));
    await service.client.call('sessions.input', { sessionId: launch.sessionId, data: 'exit\r' });
    const ended = await until(async () => { const list = await service.client.call('sessions.list'); return list[0].state === 'exited' && list[0]; });
    assert.equal(ended.exitCode, 0);
    // The live tail is bounded, but the private recording retains all earlier bytes.
    let after = 0, recording = '', pages = 0;
    do {
      const page = await service.client.call('sessions.read', { sessionId: launch.sessionId, after, history: true });
      assert.equal(page.truncated, false); assert.ok(page.chunks.length <= 128);
      recording += page.chunks.map(chunk => chunk.data).join(''); after = page.lastSequence; pages++;
      if (!page.hasMore) break;
    } while (pages < 100);
    assert.ok(pages > 1 && pages < 100); assert.ok(recording.length > 1024 * 1024);
    assert.ok(recording.includes('READY:')); assert.ok(recording.includes('FLOOD_DONE'));
    await service.client.call('sessions.manage', { sessionId: launch.sessionId, action: 'restore' });
    await assert.rejects(service.client.call('sessions.manage', { sessionId: launch.sessionId, action: 'remove' }), /Archive the session/);
    await service.client.call('sessions.manage', { sessionId: launch.sessionId, action: 'archive' });
    await service.client.call('sessions.manage', { sessionId: launch.sessionId, action: 'remove' });
    const exited = once(service.process, 'exit'); service.process.kill('SIGTERM'); await exited; service.client.close();
    Object.assign(service, await start(directory));
    const restored = await service.client.call('sessions.read', { sessionId: launch.sessionId, history: true });
    assert.ok(restored.chunks.map(chunk => chunk.data).join('').includes('READY:'));

    assert.equal((await service.client.call('sessions.managed', { view: 'all' })).length, 0);
    assert.equal((await service.client.call('sessions.list')).length, 1, 'internal reconciliation retains dismissed identity');
    assert.equal((await service.client.call('sessions.launch', launch)).session.state, 'exited');
    await assert.rejects(service.client.call('sessions.input', { sessionId: launch.sessionId, data: 'no' }), /no live process/);
    const cachedPath = join(directory, 'scrollback', createHash('sha256').update(launch.sessionId).digest('hex') + '.json');
    const cached = await readFile(cachedPath);
    await assert.rejects(service.client.call('recordings.delete', { sessionId: launch.sessionId }), /confirmation/);
    const deleted = await service.client.call('recordings.delete', { sessionId: launch.sessionId, confirmation: 'delete-recording' });
    assert.ok(deleted.session.recordingDeletedAt); assert.equal(deleted.cleanupPending, false);
    assert.deepEqual((await service.client.call('sessions.attach', { sessionId: launch.sessionId })).chunks, []);
    assert.equal(existsSync(cachedPath), false);
    await mkdir(cachedPath); await writeFile(join(cachedPath, 'blocked'), 'isolated fixture');
    assert.equal((await service.client.call('recordings.delete', { sessionId: launch.sessionId, confirmation: 'delete-recording' })).cleanupPending, true);
    assert.equal((await service.client.call('recordings.list')).recordings[0].cleanupPending, true);
    assert.deepEqual((await service.client.call('sessions.read', { sessionId: launch.sessionId, history: true })).chunks, []);
    await rm(cachedPath, { recursive: true });
    assert.equal((await service.client.call('recordings.delete', { sessionId: launch.sessionId, confirmation: 'delete-recording' })).cleanupPending, false);
    // Simulate a crash after committing deletion but before removing the cache.
    await writeFile(cachedPath, cached);
    const stopped = once(service.process, 'exit'); service.process.kill('SIGTERM'); await stopped; service.client.close();
    Object.assign(service, await start(directory));
    const empty = await service.client.call('sessions.read', { sessionId: launch.sessionId, history: true });
    assert.deepEqual(empty.chunks, []); assert.equal(empty.hasMore, false); assert.equal(empty.recordingEnd, 0);
    assert.equal(existsSync(cachedPath), false); assert.equal((await service.client.call('sessions.launch', launch)).session.recordingDeletedAt, deleted.session.recordingDeletedAt);
  } finally { await cleanup(service, directory); }
});

test('the supervisor records only deciding keys the person typed, with the output sequence they followed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-pty-decisive-')); const service = await start(directory);
  try {
    const launch = request(directory); await service.client.call('sessions.launch', launch); await output(service.client, launch.sessionId, 'READY:');
    const read = () => service.client.call('sessions.read', { sessionId: launch.sessionId, after: Number.MAX_SAFE_INTEGER });
    const send = (data, extra = {}) => service.client.call('sessions.input', { sessionId: launch.sessionId, data, ...extra });
    await send('colors\r'); await send('\x1b[200~validate this rollout\x1b[201~'); await send('\r'); await send('1'); await send('\x1b');
    await output(service.client, launch.sessionId, 'COLORS:');
    assert.equal((await read()).session.decisiveInputAt, undefined, 'input without the user mark is the table\'s own');
    for (const data of ['typing', '\x1b[A', '\x1b[B', '12', '\x1b[12;40R', '\x1b[200~pasted\rtext\x1b[201~', '\x1b[I']) await send(data, { source: 'user' });
    await send('1', { source: 'user', encoding: 'binary' });
    assert.equal((await read()).session.decisiveInputAt, undefined, 'typing, arrows, pastes and terminal replies decide nothing');
    await assert.rejects(send('\r', { source: 'service' }));
    for (const data of ['\x1b', '3', '\r']) {
      const before = await read(), started = Date.now();
      await send(data, { source: 'user' });
      const after = (await read()).session;
      assert.ok(after.decisiveInputAt >= started && after.decisiveInputAt <= Date.now(), JSON.stringify(data));
      assert.ok(after.decisiveInputAt >= (before.session.decisiveInputAt ?? 0)); assert.ok(after.decisiveInputSequence >= before.lastSequence);
    }
    const decided = (await read()).session;
    await until(async () => (await read()).lastSequence > decided.decisiveInputSequence);
    const attached = await service.client.call('sessions.attach', { sessionId: launch.sessionId });
    assert.equal(attached.session.decisiveInputAt, decided.decisiveInputAt);
    await send('more typing', { source: 'user' });
    assert.deepEqual([(await read()).session.decisiveInputAt, (await read()).session.decisiveInputSequence], [decided.decisiveInputAt, decided.decisiveInputSequence]);
  } finally { await cleanup(service, directory); }
});

test('a tail read of a large recording starts at a line boundary and pages on without gaps or duplicates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-tail-read-')); const service = await start(directory);
  try {
    const launch = request(directory, 'tail'); await service.client.call('sessions.launch', launch);
    await output(service.client, 'tail', 'READY:');
    await service.client.call('sessions.input', { sessionId: 'tail', data: 'flood\r' });
    await output(service.client, 'tail', 'FLOOD_DONE');
    await service.client.call('sessions.input', { sessionId: 'tail', data: 'after flood\r' });
    await output(service.client, 'tail', 'RECEIVED:after flood');
    const read = async (tail) => {
      let page = await service.client.call('sessions.read', { sessionId: 'tail', history: true, tail }), text = '', after = page.firstSequence - 1, contiguous = true;
      const first = page;
      for (;;) {
        for (const chunk of page.chunks) { contiguous &&= chunk.sequence === after + 1; after = chunk.sequence; text += chunk.data; }
        if (!page.hasMore) break;
        page = await service.client.call('sessions.read', { sessionId: 'tail', after, history: true });
      }
      return { first, text, contiguous, last: after, end: page.recordingEnd };
    };
    const tailed = await read(64 * 1024), full = await read();
    assert.ok(tailed.first.replayFrom > 1); assert.equal(tailed.first.firstSequence, tailed.first.replayFrom);
    assert.equal(full.first.replayFrom, undefined); assert.equal(full.first.firstSequence, 1);
    assert.equal(tailed.contiguous, true); assert.equal(full.contiguous, true);
    assert.equal(tailed.last, full.last); assert.equal(tailed.last, tailed.end);
    assert.match(tailed.text, /^FLOOD_DONE\r\n/); assert.ok(full.text.endsWith(tailed.text));
    assert.ok(Buffer.byteLength(tailed.text) <= 64 * 1024); assert.ok(full.text.length > 1024 * 1024);
    const small = await service.client.call('sessions.read', { sessionId: 'tail', after: full.last - 2, history: true, tail: 64 * 1024 });
    assert.equal(small.replayFrom, undefined, 'a range within the budget is read unchanged'); assert.equal(small.firstSequence, full.last - 1);
  } finally { await cleanup(service, directory); }
});

test('cache write failures keep the PTY alive and replay newer durable output after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-cache-failure-')); let service = await start(directory), childPid;
  const id = 'cache-session', cachedPath = join(directory, 'scrollback', createHash('sha256').update(id).digest('hex') + '.json');
  try {
    const launch = request(directory, id);
    childPid = (await service.client.call('sessions.launch', launch)).session.pid;
    await output(service.client, id, 'READY:'); await until(() => existsSync(cachedPath));
    const stale = await readFile(cachedPath, 'utf8');
    await mkdir(cachedPath + '.tmp'); // EISDIR in this private fixture, not a disk-fill test.
    const db = new DatabaseSync(join(directory, 'supervisor.sqlite'), { readOnly: true });
    try {
      for (const marker of ['CACHE_FAILURE_FIRST', 'CACHE_FAILURE_SECOND']) {
        await service.client.call('sessions.input', { sessionId: id, data: marker + '\r' });
        await until(() => db.prepare('SELECT 1 FROM output WHERE session_id=? AND data LIKE ?').get(id, `%RECEIVED:${marker}%`));
        assert.equal((await service.client.call('sessions.attach', { sessionId: id })).session.pid, childPid);
        assert.equal(service.process.exitCode, null);
      }
    } finally { db.close(); }
    assert.equal(service.diagnostics().split('Terminal tail cache unavailable').length - 1, 1, 'one diagnostic per runtime, not per output batch');
    assert.ok(!service.diagnostics().includes(directory), 'diagnostic must not disclose private paths');
    await service.client.call('sessions.stop', { sessionId: id });
    await until(async () => (await service.client.call('sessions.attach', { sessionId: id })).session.state === 'exited');
    assert.equal(await readFile(cachedPath, 'utf8'), stale, 'failure left the old cached tail untouched');
    for (const cache of ['stale', 'missing', 'corrupt']) {
      const exited = once(service.process, 'exit'); service.process.kill('SIGTERM'); await exited; service.client.close();
      if (cache === 'missing') await rm(cachedPath);
      if (cache === 'corrupt') await writeFile(cachedPath, 'not json');
      service = await start(directory);
      const restored = await service.client.call('sessions.attach', { sessionId: id });
      assert.ok(restored.chunks.map(chunk => chunk.data).join('').includes('RECEIVED:CACHE_FAILURE_SECOND'), `${cache} cache cannot hide committed output`);
      assert.equal(restored.truncated, false);
      assert.equal((await service.client.call('sessions.launch', launch)).session.state, 'exited');
      const full = await service.client.call('sessions.read', { sessionId: id, history: true });
      assert.ok(full.chunks.map(chunk => chunk.data).join('').includes('READY:'));
    }
  } finally {
    if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
    await cleanup(service, directory);
  }
});

test('legacy cached tails import once and remain partial after the cache changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-legacy-tail-')), id = 'old-session';
  const journal = new RuntimeJournal(join(directory, 'supervisor.sqlite'), 'legacy-fixture');
  journal.reserve(request(directory, id)); journal.update(id, { state: 'exited', recordingComplete: undefined }); journal.close();
  const spool = join(directory, 'scrollback'), cachedPath = join(spool, createHash('sha256').update(id).digest('hex') + '.json');
  await mkdir(spool);
  const chunks = [{ sequence: 50, data: 'OLD_RETAINED_OUTPUT' }, { sequence: 51, data: 'LATEST_LEGACY_OUTPUT' }];
  await writeFile(cachedPath, JSON.stringify({ chunks, sequence: 51, truncated: true }));
  let service = await start(directory);
  try {
    const restored = await service.client.call('sessions.attach', { sessionId: id });
    assert.deepEqual(restored.chunks, chunks); assert.equal(restored.truncated, true); assert.equal(restored.session.recordingComplete, false);
    const exited = once(service.process, 'exit'); service.process.kill('SIGTERM'); await exited; service.client.close();
    await writeFile(cachedPath, JSON.stringify({ chunks: [{ sequence: 52, data: 'CACHE_MUST_NOT_REIMPORT' }], sequence: 52 }));
    service = await start(directory);
    const again = await service.client.call('sessions.read', { sessionId: id, history: true });
    assert.deepEqual(again.chunks, chunks); assert.equal(again.truncated, true); assert.equal(again.recordingEnd, 51);
  } finally { await cleanup(service, directory); }
});

test('supervisor death records lost sessions and never silently launches them again', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-pty-crash-')); let service = await start(directory); let childPid;
  try {
    const launch = request(directory, 'lost-session');
    childPid = (await service.client.call('sessions.launch', launch)).session.pid;
    await output(service.client, launch.sessionId, 'READY:');
    const exited = once(service.process, 'exit'); service.process.kill('SIGKILL'); await exited; service.client.close();
    service = await start(directory);
    const replay = await service.client.call('sessions.launch', launch);
    assert.equal(replay.session.state, 'lost'); assert.equal(replay.session.pid, childPid);
    await assert.rejects(service.client.call('sessions.input', { sessionId: launch.sessionId, data: 'test\r' }), /no live process/);
    const bad = await service.client.call('sessions.launch', { ...request(directory, 'missing'), executable: '/nonexistent/crafting-table-test' });
    assert.equal(bad.session.state, 'failed'); assert.match(bad.session.error, /ENOENT/);
  } finally {
    if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
    await cleanup(service, directory);
  }
});

test('real shell survives workspace-service death and a slow subscriber cannot block output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-pty-isolation-')), runtime = join(directory, 'runtime');
  const service = await start(runtime);
  const workspace = new WorkspaceConnection(join(directory, 'workspace'), electron, resolve('dist/workspace-service.cjs'), true);
  let slow;
  try {
    await workspace.connect();
    const launch = { ...request(directory), executable: '/bin/sh', args: [] };
    const started = await service.client.call('sessions.launch', launch);
    const prior = await workspace.call('hello');
    const recovered = once(workspace, 'snapshot', { signal: AbortSignal.timeout(10_000) });
    process.kill(prior.pid, 'SIGKILL'); await recovered;
    assert.notEqual((await workspace.call('hello')).pid, prior.pid);
    assert.equal((await service.client.call('sessions.attach', { sessionId: launch.sessionId })).session.pid, started.session.pid);
    await service.client.call('sessions.input', { sessionId: launch.sessionId, data: "printf 'SHELL_STILL_HERE\\n'\r" });
    await output(service.client, launch.sessionId, 'SHELL_STILL_HERE');
    const flood = request(directory, 'slow-reader'); await service.client.call('sessions.launch', flood);
    await output(service.client, flood.sessionId, 'READY:');
    const paths = workspacePaths(runtime);
    slow = createConnection(paths.socket); await once(slow, 'connect');
    slow.write(JSON.stringify({ id: 'slow', token: readWorkspaceSecret(paths.token), method: 'sessions.attach', args: { sessionId: flood.sessionId } }) + '\n');
    await once(slow, 'data'); slow.pause();
    await service.client.call('sessions.input', { sessionId: flood.sessionId, data: 'flood-large\r' });
    await output(service.client, flood.sessionId, 'FLOOD_DONE');
    const closed = once(slow, 'close', { signal: AbortSignal.timeout(5000) }); slow.resume(); await closed;
    assert.equal((await service.client.call('sessions.attach', { sessionId: flood.sessionId })).session.state, 'running');
  } finally {
    slow?.destroy(); workspace.close();
    const client = await connectWorkspace(join(directory, 'workspace')).catch(() => undefined);
    if (client) { await client.call('admin.shutdown'); client.close(); }
    await cleanup(service, directory);
  }
});


test('Dock PATH is repaired before a native hook invokes node in a real PTY', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-dock-path-'));
  const shell = join(directory, 'login-shell');
  await writeFile(shell, '#!/bin/sh\nexport PATH="'+directory+':/usr/bin:/bin"\nexec /bin/sh -c "$2"\n', { mode: 0o700 });
  await writeFile(join(directory, 'node'), '#!/bin/sh\nprintf "NATIVE_HOOK_NODE_OK\\n"\n', { mode: 0o700 });
  const service = await start(directory, { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: shell });
  try {
    const launch = { ...request(directory, 'hook-path'), executable: '/bin/sh', args: ['-c', 'node'] };
    await service.client.call('sessions.launch', launch);
    const result = await output(service.client, launch.sessionId, 'NATIVE_HOOK_NODE_OK');
    assert.ok(!result.chunks.some(chunk => chunk.data.includes('command not found')));
  } finally { await cleanup(service, directory); }
});

test('native Codex driver persists identity, isolates approval ownership and stops its server and tools', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-codex-driver-')), service = await start(directory);
  const fixture = resolve('tests/fixtures/native-codex.mjs');
  const launch = { ...request(directory, 'codex'), args: [fixture], native: { provider: 'codex', model: 'fixture', instructions: 'Trusted test guide', context: 'Untrusted project data', config: {}, serverArguments: [fixture] } };
  try {
    const first = await service.client.call('sessions.launch', launch);
    const started = await output(service.client, 'codex', 'NATIVE_READY:');
    assert.equal(started.session.native.provider, 'codex');
    assert.ok(started.session.native.readyAt); const nativeId = started.session.native.nativeSessionId;
    assert.equal(started.session.native.completionId, undefined, 'opening a conversation is not a finished turn');
    assert.equal((await service.client.call('sessions.launch', launch)).session.pid, first.session.pid);
    await service.client.call('sessions.input', { sessionId: 'codex', data: 'work\r' });
    await until(async () => (await service.client.call('sessions.read', { sessionId: 'codex' })).session.native.status === 'working');
    const {readFile}=await import('node:fs/promises');
    const toolPid = await until(async () => readFile(join(directory,'native-tool.pid'),'utf8').then(Number).catch(()=>undefined));
    await service.client.call('sessions.input', { sessionId: 'codex', data: 'wait\r' });
    const waiting = await output(service.client, 'codex', 'NATIVE_APPROVAL_WAITING');
    assert.equal(waiting.session.native.status, 'input');
    await service.client.call('sessions.input', { sessionId: 'codex', data: 'done\r' });
    const finished = await until(async () => { const value = await service.client.call('sessions.read', { sessionId: 'codex' }); return value.session.native.completionId && value; });
    assert.equal(finished.session.native.status, 'idle');
    await service.client.call('sessions.input', { sessionId: 'codex', data: 'done\r' });
    await output(service.client, 'codex', 'NATIVE_INPUT:done');
    assert.equal((await service.client.call('sessions.read', { sessionId: 'codex' })).session.native.completionId, finished.session.native.completionId, 'duplicate idle observations keep one durable completion');
    await service.client.call('sessions.manage', { sessionId: 'codex', action: 'archive' });
    await service.client.call('sessions.stop', { sessionId: 'codex' });
    await until(async () => (await service.client.call('sessions.read', { sessionId: 'codex' })).session.state === 'exited');
    await until(() => { try { process.kill(toolPid, 0); return false; } catch { return true; } });
    const resumed = { ...launch, sessionId: 'resumed', requestId: 'resumed', predecessorId: 'codex', native: { ...launch.native, nativeSessionId: nativeId } };
    const next = await service.client.call('sessions.launch', resumed);
    assert.equal(next.session.native.nativeSessionId, nativeId); assert.ok(next.session.archivedAt);
    await output(service.client, 'resumed', 'NATIVE_READY:');
    await service.client.call('sessions.input', { sessionId: 'resumed', data: 'disconnect\r' });
    const lost = await until(async () => { const result=await service.client.call('sessions.read', {sessionId:'resumed'});return result.session.state==='exited'&&result; });
    assert.match(lost.session.error, /disconnected/); assert.equal(lost.session.native.status, 'error');
    assert.equal((await service.client.call('sessions.launch', resumed)).session.pid, next.session.pid, 'replaying a disconnected launch cannot start a second conversation');
    const history = await service.client.call('sessions.read', { sessionId: 'codex', history: true });
    assert.ok(history.chunks.some(chunk=>chunk.data.includes('NATIVE_APPROVAL_WAITING')));
    const crashLaunch = { ...resumed, sessionId: 'crash', requestId: 'crash' };
    const crash = await service.client.call('sessions.launch', crashLaunch);
    await output(service.client, 'crash', 'NATIVE_READY:');
    await service.client.call('sessions.input', { sessionId: 'crash', data: 'work\r' });
    const orphanTool = await until(async () => { const pid=Number(await readFile(join(directory,'native-tool.pid'),'utf8'));return pid!==toolPid&&pid; });
    const serverPid = Number(await readFile(join(directory,'native-server.pid'),'utf8'));
    const crashed = once(service.process, 'exit'); service.process.kill('SIGKILL'); await crashed; service.client.close();
    for (const pid of [orphanTool, serverPid, crash.session.pid]) await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    Object.assign(service, await start(directory));
    const recovered = await service.client.call('sessions.launch', crashLaunch);
    assert.equal(recovered.session.state, 'lost'); assert.equal(recovered.session.native.nativeSessionId, nativeId);
    assert.equal(recovered.session.pid, crash.session.pid, 'supervisor recovery preserves identity and never repeats the model turn');

  } finally { await cleanup(service, directory); }
});

test('idle supervisor startup and recording reads do not run shell profiles; fresh launches resolve PATH once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-lazy-path-'));
  const shell = join(directory, 'fixture-shell'), marker = join(directory, 'profile-ran'), bin = join(directory, 'bin');
  await mkdir(bin);
  await writeFile(shell, '#!/bin/sh\nprintf "called\\n" >> "$CRAFT_PATH_MARKER"\n/bin/sleep 1\nPATH="$CRAFT_PATH_BIN:$PATH" exec /bin/sh -c "$2"\n', { mode: 0o700 });
  await writeFile(join(bin, 'craft-path-fixture'), '#!/bin/sh\nprintf "RESOLVED_PATH_OK\\n"\n', { mode: 0o700 });
  const service = await start(directory, { SHELL: shell, CRAFT_PATH_MARKER: marker, CRAFT_PATH_BIN: bin });
  try {
    assert.equal(existsSync(marker), false, 'exposing supervisor IPC must not source a login shell');
    assert.deepEqual(await service.client.call('sessions.list'), []);
    assert.equal((await service.client.call('recordings.list')).recordings.length, 0);
    assert.equal(existsSync(marker), false, 'idle and recording-only calls must not resolve PATH');
    for (const id of ['first-path', 'second-path']) {
      const launch = { ...request(directory, id), executable: '/bin/sh', args: ['-c', 'craft-path-fixture'] };
      await service.client.call('sessions.launch', launch); await output(service.client, id, 'RESOLVED_PATH_OK');
      await until(async () => (await service.client.call('sessions.read', { sessionId: id })).session.state === 'exited');
      assert.equal((await service.client.call('sessions.launch', launch)).session.state, 'exited');
    }
    assert.equal(await readFile(marker, 'utf8'), 'called\n', 'PATH is resolved once and replay never spawns a shell profile');
  } finally { await cleanup(service, directory); }
});

test('Stop during PATH discovery prevents a later PTY and survives request replay and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-pending-stop-')), shell = join(directory, 'fixture-shell');
  await writeFile(shell, '#!/bin/sh\nprintf "entered" > "$CRAFT_PATH_MARKER"\nwhile [ ! -f "$CRAFT_PATH_RELEASE" ]; do /bin/sleep 0.02; done\nexec /bin/sh -c "$2"\n', { mode: 0o700 });
  const entered = join(directory, 'entered'), release = join(directory, 'release');
  let service = await start(directory, { SHELL: shell, CRAFT_PATH_MARKER: entered, CRAFT_PATH_RELEASE: release });
  const cancelled = { ...request(directory, 'cancel-before-spawn'), executable: '/bin/sh', args: ['-c', 'printf spawned > "$PWD/must-not-spawn"'] };
  let launch, sibling;
  try {
    launch = service.client.call('sessions.launch', cancelled);
    await until(() => existsSync(entered));
    sibling = service.client.call('sessions.launch', request(directory, 'sibling'));
    const stopping = service.client.call('sessions.stop', { sessionId: cancelled.sessionId });
    await until(async () => (await service.client.call('sessions.read', { sessionId: cancelled.sessionId })).session.stopRequestedAt);
    // Release the shared PATH probe: cancelling one launch must not break another.
    await writeFile(release, 'continue');
    const stopped = await stopping; const result = await launch;
    assert.equal(stopped.state, 'exited'); assert.ok(stopped.stopRequestedAt);
    assert.equal(result.session.state, 'exited'); assert.equal(result.session.pid, undefined);
    assert.equal(existsSync(join(directory, 'must-not-spawn')), false);
    await sibling; await output(service.client, 'sibling', 'READY:');
    assert.equal((await service.client.call('sessions.launch', cancelled)).session.state, 'exited');
    const exited = once(service.process, 'exit'); service.process.kill('SIGTERM'); await exited; service.client.close();
    service = await start(directory);
    const replay = await service.client.call('sessions.launch', cancelled);
    assert.equal(replay.session.state, 'exited'); assert.ok(replay.session.stopRequestedAt);
    assert.equal(existsSync(join(directory, 'must-not-spawn')), false);
  } finally { await writeFile(release, 'continue'); await Promise.allSettled([launch, sibling]); await cleanup(service, directory); }
});

for (const phase of ['startup', 'initialize', 'thread/inject_items']) test(`Stop cancels native Codex setup during ${phase} without starting its terminal`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-native-stop-'));
  const service = await start(directory, { CODEX_FIXTURE_PAUSE_METHOD: phase });
  const fixture = resolve('tests/fixtures/native-codex.mjs');
  const launch = { ...request(directory, 'pending-native'), args: [fixture], native: { provider: 'codex', model: 'fixture', instructions: 'Guide', context: 'Fixture context', config: {}, serverArguments: [fixture], initialPrompt: 'Must never run' } };
  const pending = service.client.call('sessions.launch', launch);
  try {
    await until(() => existsSync(join(directory, 'native-paused')));
    const serverPid = Number(await readFile(join(directory, 'native-server.pid'), 'utf8'));
    const result = await service.client.call('sessions.stop', { sessionId: launch.sessionId });
    assert.equal(result.state, 'exited'); assert.equal(result.pid, undefined); assert.ok(result.stopRequestedAt); assert.equal(result.error, undefined);
    const cancelled = await pending;
    assert.equal(cancelled.session.state, 'exited'); assert.deepEqual(cancelled.chunks, []);
    if (phase === 'thread/inject_items') assert.ok(cancelled.session.native.nativeSessionId, 'confirmed native identity is preserved');
    await until(() => { try { process.kill(serverPid, 0); return false; } catch { return true; } });
    await writeFile(join(directory, 'native-release'), 'continue');
    const replay = await service.client.call('sessions.launch', launch);
    assert.equal(replay.session.state, 'exited'); assert.equal(replay.session.pid, undefined);
    assert.equal(existsSync(join(directory, 'native-codex.json')), false, 'no context injection or terminal/model turn completed after cancellation');
  } finally { await writeFile(join(directory, 'native-release'), 'continue'); await Promise.allSettled([pending]); await cleanup(service, directory); }
});

test('archive-stop policy stops the real process and retains readable history without relaunch on restore', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-archive-stop-')); const service = await start(directory);
  try {
    const launch = { ...request(directory, 'claude-policy'), stopOnArchive: true };
    const first = await service.client.call('sessions.launch', launch); await output(service.client, launch.sessionId, 'READY:');
    await service.client.call('sessions.input', { sessionId: launch.sessionId, data: 'retained archive text\r' });
    await output(service.client, launch.sessionId, 'RECEIVED:retained archive text');
    await service.client.call('sessions.manage', { sessionId: launch.sessionId, action: 'archive' });
    const stopped = await until(async () => { const value = await service.client.call('sessions.read', { sessionId: launch.sessionId }); return value.session.state === 'exited' && value; });
    assert.ok(stopped.session.stopRequestedAt); assert.ok(stopped.session.archivedAt);
    assert.equal(stopped.session.pid, first.session.pid); assert.ok(stopped.chunks.some(chunk => chunk.data.includes('retained archive text')));
    assert.throws(() => process.kill(first.session.pid, 0), /ESRCH/);
    await service.client.call('sessions.manage', { sessionId: launch.sessionId, action: 'restore' });
    assert.equal((await service.client.call('sessions.launch', launch)).session.state, 'exited');
    assert.equal((await service.client.call('sessions.managed', { view: 'active' }))[0].id, launch.sessionId);
  } finally { await cleanup(service, directory); }
});

test('zsh keeps native startup configuration and Up-arrow history; legacy replay fields are inert', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-shell-normal-')), profile = join(directory, 'profile');
  await mkdir(profile);
  const config = "PROMPT='ACT_TEST> '\nHISTSIZE=100\nSAVEHIST=100\nHISTFILE=$ZDOTDIR/history\nbindkey -e\nbindkey '^[[A' up-line-or-history\nfixture_function() { print -r -- native-function >> result; }\n";
  await writeFile(join(profile, '.zshrc'), config);
  const service = await start(directory, { ZDOTDIR: profile });
  try {
    const launch = { ...request(directory, 'normal-shell'), executable: '/bin/zsh', args: ['-l'], shellIntegration: true,
      startupCommand: { text: 'touch replayed', cwd: directory } };
    await service.client.call('sessions.launch', launch); await output(service.client, launch.sessionId, 'ACT_TEST>');
    await service.client.call('sessions.input', { sessionId: launch.sessionId, data: 'fixture_function\r' });
    await until(async () => (await readFile(join(directory, 'result'), 'utf8').catch(() => '')) === 'native-function\n');
    await service.client.call('sessions.input', { sessionId: launch.sessionId, data: '\x1b[A\r' });
    await until(async () => (await readFile(join(directory, 'result'), 'utf8')) === 'native-function\nnative-function\n');
    await service.client.call('sessions.input', { sessionId: launch.sessionId, data: 'print -rn -- "$ZDOTDIR" > profile-used\r' });
    await until(async () => (await readFile(join(directory, 'profile-used'), 'utf8').catch(() => '')) === profile);
    assert.equal(existsSync(join(directory, 'replayed')), false);
    const snapshot = await service.client.call('sessions.read', { sessionId: launch.sessionId });
    assert.equal(snapshot.session.commandTracking, undefined); assert.equal(snapshot.session.lastCommand, undefined);
    assert.equal(await readFile(join(profile, '.zshrc'), 'utf8'), config);
    await service.client.call('sessions.input', { sessionId: launch.sessionId, data: 'exit\r' });
    await until(async () => (await service.client.call('sessions.read', { sessionId: launch.sessionId })).session.state === 'exited');
    assert.match(await readFile(join(profile, 'history'), 'utf8'), /fixture_function/);
  } finally { await cleanup(service, directory); }
});

test('a session nobody views gets the terminal\'s startup answers from the supervisor; a watched one is left to its view', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-pty-headless-')); const service = await start(directory);
  try {
    const text = async id => (await service.client.call('sessions.read', { sessionId: id, after: 0, history: true })).chunks.map(chunk => chunk.data).join('');
    const replies = async id => JSON.parse(/REPLIES:(.*?):END/.exec(await until(async () => { const value = await text(id); return value.includes(':END') && value; }))[1]);
    const unseen = { ...request(directory, 'unseen'), args: [resolve('tests/fixtures/terminal-probe.mjs')] };
    await service.client.call('sessions.launch', unseen);
    const answered = await replies(unseen.sessionId);
    assert.match(answered, /\x1bP>\|Agentic Crafting Table\(\d+\.\d+\.\d+\)\x1b\\/);
    assert.ok(answered.includes('\x1b[?2026;2$y') && answered.includes('\x1b[?1016;0$y') && answered.endsWith('\x1b[?1;2c'), JSON.stringify(answered));
    const watched = { ...request(directory, 'watched'), args: [resolve('tests/fixtures/terminal-probe.mjs'), 'wait'] };
    await service.client.call('sessions.launch', watched);
    await service.client.call('sessions.attach', { sessionId: watched.sessionId });
    await service.client.call('sessions.input', { sessionId: watched.sessionId, data: 'g' });
    assert.equal(await replies(watched.sessionId), '', 'the watching view\'s emulator answers, not the supervisor');
  } finally { await cleanup(service, directory); }
});
