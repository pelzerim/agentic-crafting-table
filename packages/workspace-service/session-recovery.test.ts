import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from './sqlite-store.ts';
import { WorkspaceControl } from '../core/control.ts';
import { SessionCoordinator, nativeAttentionNote } from './sessions.ts';
import { prepareWorkspace } from './paths.ts';
import { serveLocal } from './local-rpc.ts';
import { connectSupervisor } from '../session-runtime/client.ts';
import type { LaunchRequest, SessionSnapshot } from '../session-runtime/protocol.ts';
import { attentionItems, attentionReceipt, sessionLost } from '../../src/graph/attention.ts';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Recovery did not settle promptly')), 1000); })]); }
  finally { clearTimeout(timer); }
}

async function fixture(count = 2) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-session-recovery-'));
  const paths = prepareWorkspace(join(directory, 'runtime'));
  let store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  const launches: LaunchRequest[] = Array.from({ length: count }, (_, index) => ({ requestId: `launch-${index}`, sessionId: `session-${index}`, nodeId: `item-${index}`, workspaceId: 'local:fixture', executable: '/bin/sh', args: [], cwd: directory, cols: 100, rows: 30 }));
  for (const launch of launches) {
    await control.dispatch({ commandId: launch.requestId + ':node', expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'fixture' }, commands: [
      { type: 'item.add', id: launch.nodeId, resourceId: `resource-${launch.nodeId}`, pluginId: 'terminal.session', title: launch.nodeId, position: { x: 400 * (await control.read()).nodes.length, y: 0 }, data: { sessionId: launch.sessionId, workspaceId: launch.workspaceId, shell: launch.executable, cwd: directory } },
    ] });
    store.enqueueJob(launch.requestId, { action: 'terminal.create', nodeId: launch.nodeId, arguments: { launch } });
  }
  const calls: string[] = [], accepted = new Map<string, SessionSnapshot>();
  let respond: ((launch: LaunchRequest) => Promise<void>) | undefined;
  // Model the supervisor's durable deduplication using the same request identity.
  // These are protocol fixtures, not actual shell processes.
  const runtime = await serveLocal(paths.socket, paths.secret, async (method, input) => {
    if (method === 'hello') return { protocol: 1, service: 'sessions' };
    if (method === 'diagnostics.configure') return {};
    if (method === 'sessions.list') return [...accepted.values()].map(value => value.session);
    if (method === 'sessions.read') return [...accepted.values()].find(value => value.session.id === (input as { sessionId: string }).sessionId);
    if (method === 'sessions.stop') {
      const snapshot = [...accepted.values()].find(value => value.session.id === (input as { sessionId: string }).sessionId)!;
      snapshot.session.stopRequestedAt = new Date().toISOString(); snapshot.session.state = 'exited'; snapshot.session.exitCode = 0; return snapshot.session;
    }
    if (method !== 'sessions.launch') throw new Error('Unexpected fixture call');
    const launch = input as LaunchRequest; calls.push(launch.requestId);
    if (!accepted.has(launch.requestId)) accepted.set(launch.requestId, { session: { ...launch, native: undefined, id: launch.sessionId, state: 'running', createdAt: '2026-09-26', updatedAt: '2026-09-26' }, chunks: [], firstSequence: 1, lastSequence: 0, truncated: false });
    await respond?.(launch);
    return accepted.get(launch.requestId);
  });
  const coordinators: SessionCoordinator[] = [];
  const coordinator = () => {
    const value = new SessionCoordinator(store, control, { directory: paths.dataDirectory, executable: process.execPath, entrypoint: 'unused', electronRuntime: false }, async () => {});
    coordinators.push(value); return value;
  };
  return { get store() { return store; }, get control() { return control; }, calls, accepted, launches, directory: paths.dataDirectory, coordinator,
    set respond(value: typeof respond) { respond = value; },
    states: () => store.listJobs().map(job => job.state),
    reopen() { store.close(); store = new SqliteStore(join(directory, 'workspace.sqlite')); control = new WorkspaceControl(store); },
    async close() { for (const value of coordinators) await value.close(); await runtime.close(); store.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test('a status an agent set on its item stands until the native status changes', async () => {
  const f = await fixture(1), coordinator = f.coordinator(), update = (session: unknown) => (coordinator as unknown as { updateSession(session: unknown): Promise<boolean> }).updateSession(session);
  try {
    await f.control.apply({ type: 'item.add', id: 'agent', resourceId: 'agent-resource', pluginId: 'agent.session', title: 'Codex', position: { x: 900, y: 0 }, data: { provider: 'codex', sessionId: 'agent-session' } }, (await f.control.read()).revision);
    const session = { id: 'agent-session', nodeId: 'agent', state: 'running', native: { provider: 'codex', nativeSessionId: randomUUID(), status: 'idle', observedAt: '2026-10-30' } };
    await update(session);
    const node = async () => (await f.control.read()).nodes.find(node => node.id === 'agent')!;
    assert.equal((await node()).activity, 'idle');
    await f.control.apply({ type: 'node.update', id: 'agent', attention: 'review', attentionNote: 'Findings ready' }, (await f.control.read()).revision);
    await update(session); await update(session);
    assert.equal((await node()).attention, 'review');
    assert.equal((await node()).attentionNote, 'Findings ready');
    await update({ ...session, native: { ...session.native, status: 'working' } });
    assert.equal((await node()).activity, 'working');
    assert.equal((await node()).attention, 'none');
  } finally { await f.close(); }
});

test('Codex reporting an error is not a disconnect, and a stop during preparation is not a failure', async () => {
  assert.equal(nativeAttentionNote({ status: 'error' }), 'Agent disconnected');
  assert.equal(nativeAttentionNote({ status: 'error' }, false), 'Agent reported an error');
  const f = await fixture(1), coordinator = f.coordinator(), update = (session: unknown) => (coordinator as unknown as { updateSession(session: unknown): Promise<boolean> }).updateSession(session);
  try {
    await update({ id: 'session-0', nodeId: 'item-0', state: 'exited', stopRequestedAt: '2026-10-30' });
    assert.notEqual((await f.control.read()).nodes.find(node => node.id === 'item-0')!.attention, 'error');
  } finally { await f.close(); }
});

test('a session lost to a restart asks nothing of the person, and an item that was already raised for it settles', async () => {
  const f = await fixture(1), coordinator = f.coordinator(), update = (session: unknown) => (coordinator as unknown as { updateSession(session: unknown): Promise<boolean> }).updateSession(session);
  const node = async () => (await f.control.read()).nodes.find(node => node.id === 'item-0')!;
  const lost = { id: 'session-0', nodeId: 'item-0', state: 'lost', error: 'Supervisor stopped; the process can no longer be attached.' };
  try {
    await f.control.dispatch({ commandId: 'raised', expectedRevision: (await f.control.read()).revision, actor: { kind: 'system', id: 'sessions' }, commands: [{ type: 'node.update', id: 'item-0', activity: 'unknown', attention: 'error', attentionNote: 'Terminal stopped unexpectedly', pose: 'fallen' }] });
    await update(lost);
    const item = await node();
    assert.deepEqual([item.activity, item.attention, item.attentionNote, item.pose], ['unknown', 'none', undefined, 'ended']);
    assert.equal(sessionLost(item), true);
    assert.deepEqual(attentionItems((await f.control.read()).nodes), []);
    assert.equal(await update(lost), false, 'the settled item is not written again');
    await update({ ...lost, state: 'failed', error: 'Could not start' });
    assert.deepEqual([(await node()).attention, sessionLost(await node())], ['error', false], 'a real failure still asks');
  } finally { await f.close(); }
});

test('natural exits need viewing, explicit stops do not announce success, and failures keep their error status', async () => {
  const f = await fixture(3), coordinator = f.coordinator();
  try {
    f.respond = async launch => {
      const session = f.accepted.get(launch.requestId)!.session;
      session.state = 'exited'; session.exitCode = launch.nodeId === 'item-2' ? 1 : 0;
      if (launch.nodeId === 'item-1') session.stopRequestedAt = new Date().toISOString();
    };
    await coordinator.recover();
    let state = await f.control.read();
    assert.equal(state.nodes.find(node => node.id === 'item-0')!.attentionSources?.completion, 'finished');
    assert.equal(state.nodes.find(node => node.id === 'item-1')!.attentionSources?.completion, undefined);
    assert.equal(state.nodes.find(node => node.id === 'item-2')!.attention, 'error');
    assert.deepEqual(attentionItems(state.nodes).map(item => [item.node.id, item.notes]), [['item-2', ['Terminal exited with an error']], ['item-0', ['Terminal finished']]]);
    assert.equal(state.nodes.find(node => node.id === 'item-2')!.attentionSources?.completion, undefined);
    state = await f.control.apply({ type: 'attention.acknowledge', ...attentionReceipt(state.nodes, 'item-0') }, state.revision);
    assert.deepEqual(attentionItems(state.nodes).map(item => item.node.id), ['item-2']);
    await coordinator.close(); f.reopen();
    assert.deepEqual(attentionItems((await f.control.read()).nodes).map(item => item.node.id), ['item-2']);
  } finally { await f.close(); }
});

test('new terminals inherit project folders while overrides and frozen retries survive project changes and restart', async () => {
  const f = await fixture(0); let coordinator = f.coordinator();
  try {
    await f.control.apply({ type: 'project.create', id: 'p', title: 'Project', workingDirectory: f.directory, position: { x: 0, y: 0 } }, 0);
    const requestId = randomUUID(), request = { requestId, sessionId: requestId, nodeId: randomUUID(), resourceId: randomUUID(), expectedRevision: 1, title: 'Inherited', projectId: 'p', position: { x: 400, y: 0 } };
    const [first, concurrent] = await Promise.all([coordinator.create(request), coordinator.create(request)]);
    assert.equal(first.session.cwd, await realpath(f.directory)); assert.equal(first.session.id, concurrent.session.id);
    assert.equal((await f.control.read()).resources[0].data.cwd, first.session.cwd);
    await f.control.apply({ type: 'node.update', id: 'p', workingDirectory: '' }, (await f.control.read()).revision);
    await coordinator.close(); f.reopen(); coordinator = f.coordinator();
    assert.equal((await coordinator.create(request)).session.id, first.session.id);
    assert.equal((await coordinator.create(request)).session.cwd, first.session.cwd);
    assert.equal(f.calls.length, 1);
    await assert.rejects(coordinator.create({ ...request, cwd: '/changed-input' }), /reused/);
    const fresh = async (extra = {}) => ({ ...request, requestId: randomUUID(), sessionId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), expectedRevision: (await f.control.read()).revision, ...extra });
    await assert.rejects(coordinator.create(await fresh({ cwd: '/missing-fixture-directory' })), /working directory/);
    assert.equal(f.accepted.size, 1);
    const override = join(f.directory, 'override'); await mkdir(override);
    await f.control.apply({ type: 'node.update', id: 'p', workingDirectory: f.directory }, (await f.control.read()).revision);
    assert.equal((await coordinator.create(await fresh({ cwd: override }))).session.cwd, await realpath(override));
  } finally { await f.close(); }
});

test('close drains interrupted launch recovery, preserves untouched jobs and reconciles accepted identities on restart', async () => {
  const f = await fixture(), entered = deferred(), release = deferred();
  const coordinator = f.coordinator(); let recovering: Promise<void> | undefined;
  try {
    f.respond = async () => { entered.resolve(); await release.promise; };
    recovering = coordinator.recover(); await within(entered.promise);
    await within(coordinator.close());
    // The close contract permits immediately disposing SQLite. No recovery writes
    // may still be pending, and the unsent second request must remain queued.
    assert.deepEqual(f.states(), ['outcome-unknown', 'queued']);
    f.reopen(); await within(recovering);
    assert.deepEqual(f.calls, ['launch-0']);
    const observer = await connectSupervisor(f.directory);
    try { assert.equal((await observer.call<unknown[]>('sessions.list')).length, 1); }
    finally { observer.close(); }
    f.respond = undefined; release.resolve();
    const replacement = f.coordinator(); await replacement.recover();
    assert.deepEqual(f.calls, ['launch-0', 'launch-0', 'launch-1']);
    assert.equal(f.accepted.size, 2); assert.deepEqual(f.states(), ['succeeded', 'succeeded']);
    assert.deepEqual((await f.control.read()).resources.map(resource => resource.data.sessionId), ['session-0', 'session-1']);
    await replacement.recover(); assert.equal(f.calls.length, 3);
  } finally { release.resolve(); await recovering; await f.close(); }
});

test('overlapping recovery callers share the current pass without consuming later queued launches', async () => {
  const f = await fixture(), entered = deferred(), release = deferred(), coordinator = f.coordinator();
  let first: Promise<void> | undefined, second: Promise<void> | undefined;
  try {
    f.respond = async () => { entered.resolve(); await release.promise; };
    first = coordinator.recover(); await within(entered.promise);
    second = coordinator.recover();
    assert.deepEqual(f.states(), ['running', 'queued']);
    release.resolve(); await within(Promise.all([first, second]));
    assert.deepEqual(f.calls, ['launch-0', 'launch-1']);
    assert.deepEqual(f.states(), ['succeeded', 'succeeded']);
  } finally { release.resolve(); await Promise.allSettled([first, second]); await f.close(); }
});

test('an uncertain recovered launch stays eligible for explicit reconciliation without restarting the service', async () => {
  const f = await fixture(1), coordinator = f.coordinator();
  try {
    f.respond = async () => { throw new Error('Fixture reply unavailable after acceptance'); };
    await coordinator.recover();
    assert.deepEqual(f.states(), ['outcome-unknown']);
    assert.match(f.store.listJobs()[0].error!, /reply unavailable/);
    assert.equal(f.accepted.size, 1);
    f.respond = undefined; await coordinator.recover();
    assert.deepEqual(f.calls, ['launch-0', 'launch-0']);
    assert.equal(f.accepted.size, 1); assert.deepEqual(f.states(), ['succeeded']);
  } finally { await f.close(); }
});

test('recovery on a closed coordinator leaves durable jobs untouched', async () => {
  const f = await fixture(1), coordinator = f.coordinator();
  try {
    await coordinator.close(); await coordinator.recover();
    assert.deepEqual(f.states(), ['queued']); assert.deepEqual(f.calls, []);
  } finally { await f.close(); }
});

test('recovery rechecks a later job settled by another operation while awaiting the supervisor', async () => {
  const f = await fixture(), coordinator = f.coordinator(), entered = deferred(), release = deferred();
  let recovering: Promise<void> | undefined;
  try {
    const later = f.store.listJobs()[1];
    f.store.transitionJob(later.id, 'queued', 'running'); f.store.transitionJob(later.id, 'running', 'outcome-unknown');
    f.respond = async () => { entered.resolve(); await release.promise; };
    recovering = coordinator.recover(); await within(entered.promise);
    f.store.transitionJob(later.id, 'outcome-unknown', 'failed', { error: 'Settled by another accepted operation' });
    release.resolve(); await within(recovering);
    assert.deepEqual(f.calls, ['launch-0']); assert.equal(f.accepted.size, 1);
    assert.deepEqual(f.states(), ['succeeded', 'failed']);
  } finally { release.resolve(); await recovering; await f.close(); }
});


test('archive reconciles Claude stops across project, managed list, restart and pending launch recovery', async () => {
  const f = await fixture(0); let coordinator = f.coordinator();
  const apply = async (commands: unknown[]) => f.control.dispatch({ commandId: randomUUID(), expectedRevision: (await f.control.read()).revision, actor: { kind: 'user', id: 'fixture' }, commands });
  try {
    await apply([{ type: 'project.create', id: 'p', title: 'Project', position: { x: 0, y: 0 } }]);
    for (const [id, provider] of [['claude', 'claude'], ['codex', 'codex'], ['managed', 'claude'], ['pending', 'claude']]) {
      await apply([{ type: 'item.add', id, resourceId: id + '-r', pluginId: 'agent.session', title: id, projectId: 'p', position: { x: 400 * (await f.control.read()).nodes.length, y: 0 }, data: { sessionId: id, provider } }]);
      const launch = { requestId: id, sessionId: id, nodeId: id, workspaceId: 'fixture', executable: '/bin/sh', args: [], cwd: f.directory, cols: 80, rows: 24 };
      if (id === 'pending') f.store.enqueueJob(id, { action: 'agent.create', nodeId: id, arguments: { launch } });
      else f.accepted.set(id, { session: { ...launch, id, state: 'running', createdAt: '2026-09-28', updatedAt: '2026-09-28', ...(id === 'managed' ? { archivedAt: '2026-09-28' } : {}) }, chunks: [{ sequence: 1, data: 'saved history' }], firstSequence: 1, lastSequence: 1, truncated: false });
    }
    await coordinator.stopArchived(); assert.equal(f.accepted.get('managed')!.session.state, 'exited'); assert.equal(f.accepted.get('claude')!.session.state, 'running');
    // A persisted stop request is not proof that the process actually exited.
    f.accepted.get('claude')!.session.stopRequestedAt = new Date().toISOString();
    await apply([{ type: 'node.archive', id: 'p' }]);
    await coordinator.close(); f.reopen(); coordinator = f.coordinator(); await coordinator.recover();
    assert.equal(f.accepted.get('claude')!.session.state, 'exited'); assert.ok(f.accepted.get('claude')!.session.stopRequestedAt);
    assert.equal(f.accepted.get('codex')!.session.state, 'running');
    assert.equal(f.accepted.has('pending'), false); assert.deepEqual(f.states(), ['failed']);
    assert.equal(f.accepted.get('claude')!.chunks[0].data, 'saved history');
    await apply([{ type: 'node.restore', id: 'p' }]); await coordinator.stopArchived();
    assert.equal(f.accepted.get('claude')!.session.state, 'exited', 'restore does not launch');
  } finally { await f.close(); }
});

test('new shells use the saved directory without capture or command replay and retain restart deduplication', async () => {
  const f = await fixture(1); let coordinator = f.coordinator();
  try {
    await coordinator.recover(); f.accepted.get('launch-0')!.session.state = 'exited';
    const requestId = randomUUID(), first = await coordinator.restartTerminal('item-0', requestId);
    const launch = f.store.listJobs().find(job => job.requestKey === requestId)!.input.arguments.launch as LaunchRequest;
    assert.equal(launch.shellIntegration, undefined); assert.equal(launch.startupCommand, undefined);
    assert.deepEqual(launch.args, ['-l']);
    await coordinator.close(); f.reopen(); coordinator = f.coordinator();
    assert.equal((await coordinator.restartTerminal('item-0', requestId)).session.id, first.session.id);
    assert.equal(f.accepted.size, 2);
  } finally { await f.close(); }
});

test('terminals without a folder use the project folder, then the global default, then the most recent folder', async () => {
  const f = await fixture(0), coordinator = f.coordinator();
  try {
    const [recent, global, project] = ['recent', 'global', 'project'].map(name => join(f.directory, name));
    for (const folder of [recent, global, project]) await mkdir(folder);
    await f.control.apply({ type: 'project.create', id: 'p', title: 'Project', position: { x: 0, y: 0 } }, 0);
    let x = 0;
    const launch = async (extra = {}) => { const requestId = randomUUID(); x += 400; return (await coordinator.create({ requestId, sessionId: requestId, nodeId: randomUUID(), resourceId: randomUUID(), expectedRevision: (await f.control.read()).revision, title: 'Shell', projectId: 'p', position: { x, y: 600 }, ...extra })).session.cwd; };
    await assert.rejects(launch(), /working directory/);
    await assert.rejects(launch({ projectId: undefined }), /working directory/);
    assert.equal(await launch({ cwd: recent }), await realpath(recent));
    assert.equal(await launch(), await realpath(recent));
    assert.equal(await launch({ projectId: undefined }), await realpath(recent));
    const settings = f.store.readSettings();
    f.store.writeSettings({ expectedRevision: settings.revision, value: { ...settings.value, defaultWorkingDirectory: global } });
    assert.equal(await launch(), await realpath(global));
    await f.control.apply({ type: 'node.update', id: 'p', workingDirectory: project }, (await f.control.read()).revision);
    assert.equal(await launch(), await realpath(project));
    await f.control.apply({ type: 'node.update', id: 'p', workingDirectory: '' }, (await f.control.read()).revision);
    await rm(global, { recursive: true });
    assert.equal(await launch(), await realpath(project), 'the most recent folder is the last launch');
  } finally { await f.close(); }
});

test('successful new launches remember their directory; failed launches do not', async () => {
  const f = await fixture(0), coordinator = f.coordinator();
  try {
    const good = join(f.directory, 'good'), bad = join(f.directory, 'bad'); await mkdir(good); await mkdir(bad);
    const request = (cwd: string) => { const requestId = randomUUID(); return { requestId, sessionId: requestId, nodeId: randomUUID(), resourceId: randomUUID(), title: 'Shell', cwd, position: { x: 0, y: 0 } }; };
    await coordinator.create({ ...request(good), expectedRevision: 0 });
    assert.deepEqual(f.store.recentDirectories(), [await realpath(good)]);
    f.respond = async launch => { const session = f.accepted.get(launch.requestId)!.session; session.state = 'failed'; session.error = 'fixture failure'; };
    await assert.rejects(coordinator.create({ ...request(bad), expectedRevision: (await f.control.read()).revision }), /fixture failure/);
    assert.deepEqual(f.store.recentDirectories(), [await realpath(good)]);
  } finally { await f.close(); }
});

for (const state of ['queued', 'outcome-unknown'] as const) test(`legacy ${state} terminal command replay jobs are retired on upgrade`, async () => {
  const f = await fixture(1), coordinator = f.coordinator();
  try {
    await coordinator.recover();
    const job = f.store.enqueueJob('legacy-replay', { action: 'terminal.resume', nodeId: 'item-0', arguments: { launch: { ...f.launches[0], requestId: 'legacy-replay', startupCommand: { text: 'must-not-run', cwd: f.directory } } } });
    if (state === 'outcome-unknown') { f.store.transitionJob(job.id, 'queued', 'running'); f.store.transitionJob(job.id, 'running', state); }
    await coordinator.recover();
    assert.equal(f.store.getJob(job.id)?.state, 'failed');
    assert.equal(f.calls.includes('legacy-replay'), false);
  } finally { await f.close(); }
});

test('a monitoring pass reads the workspace once, not once per session', async () => {
  const f = await fixture(20), coordinator = f.coordinator();
  try {
    await coordinator.recover();
    const control = f.control, read = control.read.bind(control); let reads = 0;
    control.read = (...args: Parameters<typeof read>) => { reads++; return read(...args); };
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.ok(reads > 0, 'the monitor ran');
    assert.ok(reads <= 4, `${reads} workspace reads in one pass over 20 sessions`);
  } finally { await f.close(); }
});

test('native agent statuses that need me have short copy', () => {
  assert.deepEqual([nativeAttentionNote({ status: 'input', input: 'approval' }), nativeAttentionNote({ status: 'input', input: 'question' }), nativeAttentionNote({ status: 'input' }), nativeAttentionNote({ status: 'error' })],
    ['Agent needs permission', 'Agent asked a question', 'Agent waiting', 'Agent disconnected']);
  for (const status of ['idle', 'working', 'unknown'] as const) assert.equal(nativeAttentionNote({ status }), undefined);
});
