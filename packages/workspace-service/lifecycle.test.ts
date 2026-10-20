import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspaceControl } from '../core/control.ts';
import { SqliteStore } from './sqlite-store.ts';
import { WorkspaceLifecycle } from './lifecycle.ts';
import type { LifecycleRuntime, RecoveryEntry } from './lifecycle.ts';
import type { SessionRecord, SessionSnapshot } from '../session-runtime/protocol.ts';

async function fixture(run: (input: { store: SqliteStore; control: WorkspaceControl; sessions: SessionRecord[]; runtime: LifecycleRuntime; resumed: RecoveryEntry[]; open(): WorkspaceLifecycle }) => Promise<void>, terminalOptIn = true) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-recovery-')), store = new SqliteStore(join(directory, 'workspace.sqlite'));
  const control = new WorkspaceControl(store), sessions: SessionRecord[] = [], resumed: RecoveryEntry[] = [];
  const runtime: LifecycleRuntime = {
    list: async () => structuredClone(sessions),
    stop: async id => { assert.equal(store.readRecovery().phase, 'closing', 'persist before stopping'); sessions.find(session => session.id === id)!.state = 'exited'; },
    resume: async entry => {
      resumed.push(structuredClone(entry));
      const original = sessions.find(session => session.id === entry.sessionId)!;
      const session = { ...original, id: entry.requestId, state: 'running' as const, pid: 222 };
      sessions.push(session); return { session, chunks: [], firstSequence: 0, lastSequence: 0, truncated: false };
    }, recoverJobs: async () => {},
  };
  for (const [id, pluginId, activity, attention, state] of [
    ['working', 'agent.session', 'working', 'none', 'running'], ['waiting', 'agent.session', 'idle', 'input', 'running'],
    ['stopped', 'agent.session', 'idle', 'none', 'exited'], ['shell', 'terminal.session', 'idle', 'none', 'running'],
  ] as const) {
    const sessionId = randomUUID();
    await control.apply({ type: 'item.add', id, resourceId: id + '-resource', pluginId, title: id, position: { x: 0, y: 0 }, data: { sessionId, provider: 'claude', nativeSessionId: randomUUID(), workspaceId: 'local', cwd: directory, shell: '/bin/sh', ...(id === 'shell' && terminalOptIn ? { resumeOnStartup: true } : {}) } }, (await control.read()).revision);
    await control.apply({ type: 'node.update', id, activity, attention }, (await control.read()).revision);
    sessions.push({ ...(id === 'shell' ? { lastCommand: { text: 'fixture-command', cwd: directory } } : {}), id: sessionId, nodeId: id, requestId: sessionId, state, cwd: directory, workspaceId: 'local', pid: 111, cols: 80, rows: 24, createdAt: '', updatedAt: '' });
  }
  try { await run({ store, control, sessions, runtime, resumed, open: () => new WorkspaceLifecycle(store, control, runtime) }); }
  finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}
async function settled(lifecycle: WorkspaceLifecycle) {
  for (let i = 0; i < 200 && lifecycle.status().phase === 'recovering'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(lifecycle.status().phase, 'open');
}

test('close checkpoints active work before stopping; startup resumes the same items once and skips manually stopped sessions', () => fixture(async ({ open, sessions, resumed, store }) => {
  const lifecycle = open();
  await lifecycle.close();
  const checkpoint = store.readRecovery();
  assert.equal(checkpoint.phase, 'closed'); assert.equal(checkpoint.entries.length, 2);
  assert.equal(sessions.filter(session => session.state === 'running').length, 0);
  assert.equal(checkpoint.entries.find(entry => entry.nodeId === 'working')?.continueWork, true);
  assert.equal(checkpoint.entries.find(entry => entry.nodeId === 'waiting')?.continueWork, false);
  const restarted = open(); restarted.recover(); restarted.recover(); await settled(restarted);
  assert.deepEqual(resumed.map(entry => entry.nodeId).sort(), ['waiting', 'working']);
  assert.equal(restarted.status().entries.every(entry => entry.state === 'restored'), true);
  restarted.recover(); await settled(restarted); assert.equal(resumed.length, 2);
  // A successfully restored session explicitly stopped later must not auto-restart again.
  sessions.find(session => session.nodeId === 'working' && session.state === 'running')!.state = 'exited';
  await restarted.close();
  assert.equal(store.readRecovery().entries.some(entry => entry.nodeId === 'working'), false);
}));

test('close drains a pending launch and rejects new work after the close gate', () => fixture(async ({ open, sessions }) => {
  const lifecycle = open(); let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const starting = lifecycle.execute(async () => { await gate; sessions.find(session => session.nodeId === 'stopped')!.state = 'running'; });
  const closing = lifecycle.close();
  assert.equal(lifecycle.allowsBackgroundWork, false, 'background work pauses as soon as close begins');
  await assert.rejects(lifecycle.execute(async () => {}), { code: 'WORKSPACE_CLOSING' });
  finish(); await starting; await closing;
  assert.equal(lifecycle.status().entries.length, 3);
  assert.equal(sessions.every(session => session.state === 'exited'), true);
}));

test('closing still drains a manually stopping process without selecting it for startup recovery', () => fixture(async ({ open, sessions, store, resumed }) => {
  const stopped = sessions.find(session => session.nodeId === 'working')!;
  stopped.stopRequestedAt = new Date().toISOString();
  assert.equal(stopped.state, 'running');
  await open().close();
  assert.equal(stopped.state, 'exited', 'close must still stop and await this process');
  assert.equal(store.readRecovery().entries.some(entry => entry.nodeId === 'working'), false);
  const restarted = open(); restarted.recover(); await settled(restarted);
  assert.deepEqual(resumed.map(entry => entry.nodeId).sort(), ['waiting']);
}));

test('interrupted close reconnects a surviving process and failures retry with the same uncertain launch identity', () => fixture(async ({ open, runtime, sessions, store, resumed }) => {
  const lifecycle = open(); await lifecycle.close();
  const saved = store.readRecovery(); saved.phase = 'closing'; store.writeRecovery(saved);
  sessions.find(session => session.nodeId === 'waiting')!.state = 'running';
  const resume = runtime.resume; let first = true;
  runtime.resume = async entry => {
    if (entry.nodeId === 'working' && first) { first = false; throw Object.assign(new Error('Connection lost after launch'), { code: 'LAUNCH_UNCERTAIN' }); }
    return resume(entry);
  };
  const restarted = open(); restarted.recover(); await settled(restarted);
  assert.equal(resumed.some(entry => entry.nodeId === 'waiting'), false, 'reattach surviving process');
  const failure = restarted.status().entries.find(entry => entry.nodeId === 'working')!;
  assert.equal(failure.state, 'failed'); assert.match(failure.error!, /Connection lost/);
  assert.equal(failure.requestId, saved.entries.find(entry => entry.nodeId === 'working')!.requestId);
  restarted.recover(true); await settled(restarted);
  assert.equal(resumed.find(entry => entry.nodeId === 'working')!.requestId, failure.requestId);
}));

test('recovery skips removed items but reports confirmed launch failures without losing its checkpoint', () => fixture(async ({ open, control, runtime, store }) => {
  const lifecycle = open(); await lifecycle.close();
  const original = store.readRecovery();
  await control.apply({ type: 'node.archive', id: 'waiting' }, (await control.read()).revision);
    await control.apply({ type: 'node.delete', id: 'waiting' }, (await control.read()).revision);
  runtime.resume = async entry => ({ session: { state: 'failed', error: 'Native conversation unavailable' }, chunks: [] } as unknown as SessionSnapshot);
  const restarted = open(); restarted.recover(); await settled(restarted);
  assert.equal(restarted.status().entries.filter(entry => entry.state === 'failed').length, 1);
  assert.equal(restarted.status().entries.find(entry => entry.nodeId === 'waiting')!.state, 'skipped');
  assert.equal(restarted.status().entries.find(entry => entry.nodeId === 'waiting')!.error, undefined);
  assert.notEqual(restarted.status().entries[0].requestId, original.entries[0].requestId);
  assert.equal(store.readRecovery().entries.length, 2);
}));

test('a failed durable checkpoint never stops a process', () => fixture(async ({ store, control, runtime, sessions }) => {
  const failingStore = { readRecovery: () => store.readRecovery(), writeRecovery: () => { throw new Error('Disk full'); } };
  const lifecycle = new WorkspaceLifecycle(failingStore, control, runtime);
  await assert.rejects(lifecycle.close(), /Disk full/);
  assert.equal(sessions.filter(session => session.state === 'running').length, 3);
}));

test('a failed recovery-start checkpoint stays retryable without launching sessions or staying stuck recovering', () => fixture(async ({ open, store, control, runtime, resumed }) => {
  await open().close(); const checkpoint = store.readRecovery(); let fail = true;
  const lifecycle = new WorkspaceLifecycle({ readRecovery: () => store.readRecovery(), writeRecovery: state => {
    if (fail) throw new Error('Fixture storage unavailable'); store.writeRecovery(state);
  } }, control, runtime);
  lifecycle.recover();
  assert.equal(lifecycle.status().phase, 'open'); assert.match(lifecycle.status().error!, /checkpoint.*Fixture storage unavailable/);
  assert.equal(lifecycle.pendingCount, 0); assert.deepEqual(store.readRecovery(), checkpoint); assert.equal(resumed.length, 0);
  await assert.rejects(lifecycle.execute(async () => {}), { code: 'WORKSPACE_CLOSING' });
  fail = false; lifecycle.recover(true); await settled(lifecycle);
  assert.equal(lifecycle.status().error, undefined); assert.equal(resumed.length, 2);
  assert.deepEqual(resumed.map(entry => entry.requestId), checkpoint.entries.map(entry => entry.requestId));
  assert.equal(await lifecycle.execute(async () => 'available'), 'available');
}));

test('persistent checkpoint failure during background restore is owned and restart reuses uncertain identities', () => fixture(async ({ open, store, control, runtime, sessions, resumed }) => {
  await open().close(); const checkpoint = store.readRecovery(); let writes = 0;
  const resume = runtime.resume;
  runtime.resume = async entry => {
    // Simulate the supervisor accepting a launch before its workspace checkpoint.
    const existing = sessions.find(session => session.id === entry.requestId);
    return existing ? { session: existing, chunks: [], firstSequence: 0, lastSequence: 0, truncated: false } : resume(entry);
  };
  const lifecycle = new WorkspaceLifecycle({ readRecovery: () => store.readRecovery(), writeRecovery: state => {
    if (++writes > 1) throw new Error('Fixture checkpoint writes failed'); store.writeRecovery(state);
  } }, control, runtime);
  lifecycle.recover(); await settled(lifecycle);
  assert.match(lifecycle.status().error!, /checkpoint.*Fixture checkpoint writes failed/);
  assert.equal(lifecycle.pendingCount, 0); assert.equal(resumed.length, 1);
  assert.equal(store.readRecovery().phase, 'recovering');
  assert.deepEqual(store.readRecovery().entries, checkpoint.entries);
  await assert.rejects(lifecycle.execute(async () => {}), { code: 'WORKSPACE_CLOSING' });
  const restarted = open(); restarted.recover(); await settled(restarted);
  assert.equal(resumed.length, 2); assert.equal(new Set(sessions.filter(session => session.state === 'running').map(session => session.id)).size, 2);
  assert.deepEqual(resumed.map(entry => entry.requestId), checkpoint.entries.map(entry => entry.requestId));
  assert.equal(restarted.status().entries.every(entry => entry.state === 'restored'), true);
}));

test('failure to save the final recovery checkpoint surfaces an error and retries without resuming completed entries', () => fixture(async ({ open, store, control, runtime, resumed }) => {
  await open().close(); let fail = true;
  const lifecycle = new WorkspaceLifecycle({ readRecovery: () => store.readRecovery(), writeRecovery: state => {
    if (state.phase === 'open' && fail) throw new Error('Fixture final checkpoint failed'); store.writeRecovery(state);
  } }, control, runtime);
  lifecycle.recover(); await settled(lifecycle);
  assert.match(lifecycle.status().error!, /checkpoint.*Fixture final checkpoint failed/);
  assert.equal(lifecycle.pendingCount, 0); assert.equal(resumed.length, 2);
  assert.equal(store.readRecovery().phase, 'recovering');
  fail = false; lifecycle.recover(true); await settled(lifecycle);
  assert.equal(lifecycle.status().error, undefined); assert.equal(resumed.length, 2);
  assert.equal(store.readRecovery().phase, 'open');
}));

test('a transient checkpoint failure stays gated even when its final error checkpoint succeeds', () => fixture(async ({ open, store, control, runtime, resumed }) => {
  await open().close(); const checkpoint = store.readRecovery(); let writes = 0;
  const lifecycle = new WorkspaceLifecycle({ readRecovery: () => store.readRecovery(), writeRecovery: state => {
    if (++writes === 2) throw new Error('Fixture interrupted checkpoint'); store.writeRecovery(state);
  } }, control, runtime);
  lifecycle.recover(); await settled(lifecycle);
  assert.equal(resumed.length, 1); assert.equal(writes, 3);
  assert.equal(store.readRecovery().phase, 'open');
  assert.match(store.readRecovery().error!, /checkpoint.*Fixture interrupted checkpoint/);
  assert.deepEqual(lifecycle.status(), store.readRecovery());
  assert.equal(lifecycle.allowsBackgroundWork, false);
  let launches = 0;
  await assert.rejects(lifecycle.execute(async () => { launches++; }), { code: 'WORKSPACE_CLOSING' });
  assert.equal(launches, 0);
  // A new service cannot bypass the persisted failure before its recovery pass.
  const restarted = open();
  await assert.rejects(restarted.execute(async () => { launches++; }), { code: 'WORKSPACE_CLOSING' });
  restarted.recover(true); await settled(restarted);
  assert.equal(restarted.status().error, undefined); assert.equal(resumed.length, 2);
  assert.equal(restarted.allowsBackgroundWork, true);
  assert.deepEqual(resumed.map(entry => entry.requestId), checkpoint.entries.map(entry => entry.requestId));
  await restarted.execute(async () => { launches++; }); assert.equal(launches, 1);
}));

test('an interrupted recovering checkpoint rejects new launches until recovery starts durably', () => fixture(async ({ open, store, resumed }) => {
  await open().close(); const checkpoint = store.readRecovery();
  checkpoint.phase = 'recovering'; store.writeRecovery(checkpoint);
  const lifecycle = open(); let launches = 0;
  await assert.rejects(lifecycle.execute(async () => { launches++; }), { code: 'WORKSPACE_CLOSING' });
  assert.equal(launches, 0); assert.deepEqual(store.readRecovery(), checkpoint);
  lifecycle.recover(); await settled(lifecycle);
  assert.equal(resumed.length, 2); assert.equal(lifecycle.status().error, undefined);
  await lifecycle.execute(async () => { launches++; }); assert.equal(launches, 1);
}));

for (const phase of ['open', 'closed', 'recovering'] as const) test(`legacy terminal opt-ins and ${phase} checkpoints never replay commands`, () => fixture(async ({ open, store, sessions, resumed }) => {
  const session = sessions.find(session => session.nodeId === 'shell')!;
  session.state = 'exited';
  store.writeRecovery({ phase, startupPending: true, entries: [{ sessionId: session.id, nodeId: 'shell', resourceId: 'shell-resource', title: 'Shell', kind: 'terminal', continueWork: false, requestId: randomUUID(), state: 'failed', error: 'Old error', terminalCommand: { text: 'must-not-run', cwd: session.cwd } }] });
  const lifecycle = open(); lifecycle.recover(false, randomUUID()); await settled(lifecycle);
  assert.equal(lifecycle.status().entries[0].state, 'skipped'); assert.equal(lifecycle.status().entries[0].error, undefined);
  lifecycle.recover(true, randomUUID()); await settled(lifecycle);
  assert.equal(resumed.length, 0);
  await lifecycle.close(); assert.equal(lifecycle.status().entries.some(entry => entry.kind === 'terminal'), false);
}));

test('close stops detached processes without selecting them for recovery or losing their session metadata', () => fixture(async ({ open, control, sessions, resumed }) => {
  const orphan = sessions.find(session => session.nodeId === 'working')!;
  await control.apply({ type: 'node.archive', id: 'working' }, (await control.read()).revision);
  await control.apply({ type: 'node.delete', id: 'working' }, (await control.read()).revision);
  const lifecycle = open(); await lifecycle.close();
  assert.equal(orphan.state, 'exited');
  assert.equal(lifecycle.status().entries.some(entry => entry.sessionId === orphan.id), false);
  assert.ok(sessions.includes(orphan), 'recording/session metadata is retained');
  lifecycle.recover(); await settled(lifecycle);
  assert.equal(resumed.some(entry => entry.nodeId === 'working'), false);
}));

test('close stops a running session archived in Sessions without selecting it for recovery', () => fixture(async ({ open, sessions, resumed }) => {
  const archived = sessions.find(session => session.nodeId === 'working')!;
  archived.archivedAt = new Date().toISOString();
  const lifecycle = open(); await lifecycle.close();
  assert.equal(archived.state, 'exited');
  assert.deepEqual(lifecycle.status().entries.map(entry => entry.nodeId), ['waiting']);
  const restarted = open(); restarted.recover(); await settled(restarted);
  assert.deepEqual(resumed.map(entry => entry.nodeId), ['waiting']);
}));

for (const state of ['pending', 'failed'] as const) test(`legacy ${state} detached checkpoint is silently retired without relaunching or retrying attached failures`, () => fixture(async ({ open, store, resumed }) => {
  const detached = { sessionId: 'orphan', nodeId: 'gone', title: 'Detached session', kind: 'unavailable' as const, continueWork: false, requestId: randomUUID(), state, error: 'This session has no restorable map item. Its recording is retained.' };
  const attached = { ...detached, sessionId: 'attached', nodeId: 'working', resourceId: 'working-resource', title: 'Working', state: 'failed' as const, error: 'Real launch failed' };
  store.writeRecovery({ phase: 'open', entries: [detached, attached] });
  const lifecycle = open(); lifecycle.recover(); await settled(lifecycle);
  assert.equal(lifecycle.status().entries[0].state, 'skipped'); assert.equal(lifecycle.status().entries[0].error, undefined);
  assert.deepEqual(lifecycle.status().entries[1], attached); assert.equal(resumed.length, 0);
  const reopened = open(); reopened.recover(); await settled(reopened);
  assert.equal(reopened.status().entries[0].state, 'skipped'); assert.equal(resumed.length, 0);
  await reopened.close(); assert.equal(store.readRecovery().entries.some(entry => entry.sessionId === 'orphan'), false);
}));

test('an agent in Undermap at close is stopped but never selected for automatic resume', () => fixture(async ({ open, control, sessions, resumed }) => {
  const below = sessions.find(session => session.nodeId === 'working')!;
  await control.apply({ type: 'node.below', id: 'working' }, (await control.read()).revision);
  const lifecycle = open(); await lifecycle.close();
  assert.equal(below.state, 'exited');
  assert.equal(lifecycle.status().entries.some(entry => entry.nodeId === 'working'), false);
  lifecycle.recover(false, randomUUID()); await settled(lifecycle);
  assert.equal(resumed.some(entry => entry.nodeId === 'working'), false);
}));

test('startup does not resume an agent whose project is muted; unmuting later does not start it either', () => fixture(async ({ open, control, sessions, resumed, store }) => {
  await control.apply({ type: 'project.create', id: 'quiet', title: 'Quiet', summary: '', position: { x: 0, y: 0 } }, (await control.read()).revision);
  await control.apply({ type: 'node.attach', id: 'working', projectId: 'quiet' }, (await control.read()).revision);
  await control.apply({ type: 'project.mute', id: 'quiet', muted: true }, (await control.read()).revision);
  await open().close();
  assert.deepEqual(store.readRecovery().entries.map(entry => entry.nodeId).sort(), ['waiting', 'working'], 'the checkpoint still records it');
  const restarted = open(); restarted.recover(); await settled(restarted);
  assert.deepEqual(resumed.map(entry => entry.nodeId), ['waiting']);
  assert.equal(restarted.status().entries.find(entry => entry.nodeId === 'working')?.state, 'skipped');
  assert.equal(sessions.some(session => session.nodeId === 'working' && session.state === 'running'), false);
  await control.apply({ type: 'project.mute', id: 'quiet', muted: false }, (await control.read()).revision);
  restarted.recover(); await settled(restarted);
  assert.deepEqual(resumed.map(entry => entry.nodeId), ['waiting']);
}));
