import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentCoordinator } from './agents.ts';
import { WorkspaceControl, MemoryStore } from '../core/control.ts';
import { SqliteStore } from './sqlite-store.ts';
import { attentionItems, attentionReceipt } from '../../src/graph/attention.ts';
import { TEAMMATE_QUIET_MS } from './agent-background.ts';

test('Claude completed turns become unread once; replay, session closure and restart do not revive a seen turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-agent-finished-'));
  const store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  try {
    const processSessionId = randomUUID(), nativeSessionId = randomUUID();
    await control.apply({ type: 'item.add', id: 'agent', resourceId: 'conversation', pluginId: 'agent.session', title: 'Claude', position: { x: 0, y: 0 }, data: { provider: 'claude', sessionId: processSessionId, nativeSessionId } }, 0);
    const create = () => new AgentCoordinator(directory, {} as any, control, {} as any, { prepare: async () => ({}) } as any, async () => {}, store);
    let coordinator = create();
    const hook = (event: string, observedAt: number) => coordinator.hook({ nodeId: 'agent', processSessionId, nativeSessionId, observedAt, event });
    await hook('SessionStart', 1);
    assert.equal(attentionItems((await control.read()).nodes).length, 0);
    await hook('UserPromptSubmit', 2); await hook('Stop', 3);
    let state = await control.read();
    assert.deepEqual(attentionItems(state.nodes)[0].reasons, ['finished']);
    assert.equal(state.nodes[0].activity, 'idle');
    await control.apply({ type: 'attention.acknowledge', ...attentionReceipt(state.nodes, 'agent') }, state.revision);
    const seen = await control.read();
    coordinator = create(); await hook('Stop', 3);
    assert.equal((await control.read()).revision, seen.revision);
    await hook('SessionEnd', 4);
    assert.equal(attentionItems((await control.read()).nodes).length, 0);
    await hook('UserPromptSubmit', 5); await hook('PermissionRequest', 6);
    assert.deepEqual(attentionItems((await control.read()).nodes)[0].reasons, ['input']);
    await hook('PostToolUse', 7); await hook('Stop', 8);
    state = await control.read();
    assert.deepEqual(attentionItems(state.nodes)[0].reasons, ['finished']);
    assert.notEqual(state.nodes[0].attentionEvents?.completion, seen.nodes[0].attentionEvents?.completion);
    await hook('Stop', 3);
    assert.equal((await control.read()).revision, state.revision, 'stale completion is ignored');
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('each Claude hook that needs me says why in a short note', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-agent-notes-'));
  const store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  try {
    const processSessionId = randomUUID(), nativeSessionId = randomUUID();
    await control.apply({ type: 'item.add', id: 'agent', resourceId: 'conversation', pluginId: 'agent.session', title: 'Claude', position: { x: 0, y: 0 }, data: { provider: 'claude', sessionId: processSessionId, nativeSessionId } }, 0);
    const coordinator = new AgentCoordinator(directory, {} as any, control, {} as any, { prepare: async () => ({}) } as any, async () => {}, store);
    let at = 0;
    const notes = async (event: string, extra: Record<string, string> = {}) => {
      await coordinator.hook({ nodeId: 'agent', processSessionId, nativeSessionId, observedAt: ++at, event, ...extra });
      const node = (await control.read()).nodes[0];
      return [node.attention, node.attentionNote, ...attentionItems([node]).flatMap(item => item.notes)];
    };
    await notes('SessionStart'); await notes('UserPromptSubmit');
    assert.deepEqual(await notes('PermissionRequest'), ['input', 'Agent needs permission', 'Agent needs permission']);
    await notes('PostToolUse');
    assert.deepEqual(await notes('Notification', { notificationType: 'permission_prompt' }), ['input', 'Agent needs permission', 'Agent needs permission']);
    await notes('PostToolUse');
    assert.deepEqual(await notes('PreToolUse', { toolName: 'AskUserQuestion' }), ['input', 'Agent asked a question', 'Agent asked a question']);
    assert.deepEqual(await notes('Notification', { notificationType: 'idle_prompt' }), ['input', 'Agent waiting', 'Agent waiting'], 'a different wait for the same input restates the note');
    assert.deepEqual(await notes('StopFailure'), ['error', 'Agent hit an error', 'Agent hit an error']);
    await notes('UserPromptSubmit');
    assert.deepEqual(await notes('Stop'), ['none', undefined, 'Agent finished']);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('native hooks ignore old processes and observations; attaching live Claude never launches or reinjects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-agent-status-'));
  const observations = new SqliteStore(join(directory, 'observations.sqlite'));
  try {
    const control = new WorkspaceControl(new MemoryStore());
    const processSessionId = randomUUID(), nativeSessionId = randomUUID();
    await control.apply({ type: 'item.add', id: 'agent', resourceId: 'conversation', pluginId: 'agent.session', title: 'Claude', position: { x: 0, y: 0 }, data: { provider: 'claude', sessionId: processSessionId, nativeSessionId } }, 0);
    let launched = 0, delivered = 0, observed = 0;
    const sessions = { runtime: { call: async () => ({ session: { id: processSessionId, state: 'running', pid: 123 } }) }, launchPrepared: async () => { launched++; throw new Error('Must not relaunch'); } };
    const context = { prepare: async () => { delivered++; return { deliveryId: 'context-offer' }; } };
    const coordinator = new AgentCoordinator(directory, {} as any, control, sessions as any, context as any, async () => { observed++; }, observations);
    const event = { nodeId: 'agent', processSessionId, nativeSessionId, observedAt: 100, event: 'UserPromptSubmit' };
    await coordinator.hook(event);
    assert.equal((await control.read()).nodes[0].activity, 'working'); assert.equal(delivered, 1);
    const revision = (await control.read()).revision;
    await coordinator.hook({ ...event, event: 'PreToolUse' });
    await coordinator.hook({ ...event, event: 'PostToolUse' });
    assert.equal((await control.read()).revision, revision, 'tool hooks must not invalidate the revision returned by workspace_read');
    assert.deepEqual(await coordinator.hook({ ...event, observedAt: 99, event: 'Stop' }), { ignored: true });
    assert.deepEqual(await coordinator.hook({ ...event, observedAt: 101, processSessionId: randomUUID(), event: 'Stop' }), { ignored: true });
    assert.equal((await control.read()).revision, revision);
    await control.apply({ type: 'node.move', id: 'agent', position: { x: 20, y: 40 } }, revision);
    await coordinator.hook({ ...event, observedAt: 102, event: 'PermissionRequest' });
    assert.equal((await control.read()).nodes[0].attention, 'input');
    await coordinator.hook({ ...event, observedAt: 103, event: 'PostToolUse' });
    assert.equal((await control.read()).nodes[0].attention, 'none');
    const attached = await coordinator.resume('agent', randomUUID());
    assert.equal(attached.session.pid, 123); assert.equal(launched, 0); assert.equal(delivered, 1); assert.equal(observed, 3);
    await control.apply({ type: 'project.create', id: 'source', title: 'Linked project', summary: '', position: { x: 500, y: 0 } }, (await control.read()).revision);
    const request = { requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), pluginId: 'agent.session', title: 'Resume', expectedRevision: (await control.read()).revision, data: { resumeNodeId: 'agent' }, position: { x: 700, y: 0 }, connection: { id: randomUUID(), otherId: 'source', kind: 'context' as const, sourceIsNew: false } };
    await coordinator.create(request); await coordinator.create(request);
    const connected = await control.read();
    assert.equal(connected.nodes.length, 2); assert.equal(connected.links.length, 1);
    assert.equal(connected.links[0].targetId, 'agent'); // Actual resumed node, not the unused new-node ID.
    assert.equal(launched, 0); assert.equal(delivered, 1);
    sessions.runtime.call = async () => { throw Object.assign(new Error('Disconnected'), { code: 'CONNECTION_LOST' }); };
    await assert.rejects(coordinator.resume('agent', randomUUID()), /Disconnected/);
    assert.equal(launched, 0);
  } finally { observations.close(); await rm(directory, { recursive: true, force: true }); }
});

test('prompt injection validates the live Claude binding and never writes input or launches a process', async () => {
  const control = new WorkspaceControl(new MemoryStore()), sessionId = randomUUID();
  const data = { provider: 'claude', sessionId, nativeSessionId: randomUUID(), launchDirectory: '/fixture/launch' };
  await control.apply({ type: 'item.add', id: 'agent', resourceId: 'conversation', pluginId: 'agent.session', title: 'Claude', position: { x: 0, y: 0 }, data }, 0);
  let live = true, requested = 0;
  const sessions = { runtime: { call: async (method: string, input: { after: number }) => {
    assert.equal(method, 'sessions.read');
    assert.equal(input.after, Number.MAX_SAFE_INTEGER, 'status polling must not replay terminal bytes');
    return { session: { state: live ? 'running' : 'exited' } };
  } } };
  const context = { queueGuide: (...args: string[]) => { assert.equal(args[1], sessionId); requested++; return { state: 'queued' }; }, guideStatus: () => ({ state: 'none' }) };
  const coordinator = new AgentCoordinator('/fixture', {} as any, control, sessions as any, context as any, async () => {}, {} as any);
  const request = { operation: 'queue', sessionId, requestId: randomUUID() };
  assert.deepEqual(await coordinator.injectContext('agent', request), { state: 'queued' });
  await assert.rejects(coordinator.injectContext('agent', { ...request, sessionId: randomUUID() }), /changed/);
  await assert.rejects(coordinator.injectContext('agent', { ...request, prompt: 'Untrusted replacement' }), /Unrecognized/);
  live = false;
  await assert.rejects(coordinator.injectContext('agent', request), /Resume/);
  assert.equal((await coordinator.injectContext('agent', { operation: 'status', sessionId })).state, 'unavailable');
  live = true;
  await control.apply({ type: 'item.update', id: 'agent', data: { ...data, provider: 'codex' } }, (await control.read()).revision);
  await assert.rejects(coordinator.injectContext('agent', request), /available for Claude/);
  assert.equal(requested, 1);
});

test('a Claude item left working after an interrupt shows idle once its terminal is quiet', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-agent-quiet-'));
  const store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  try {
    const processSessionId = randomUUID(), nativeSessionId = randomUUID(), output = { sequence: 5 };
    const sessions = { runtime: { async call() { return { session: { state: 'running' }, chunks: [], firstSequence: 0, lastSequence: output.sequence, truncated: false }; } } };
    await control.apply({ type: 'item.add', id: 'agent', resourceId: 'conversation', pluginId: 'agent.session', title: 'Claude', position: { x: 0, y: 0 }, data: { provider: 'claude', sessionId: processSessionId, nativeSessionId } }, 0);
    const coordinator = new AgentCoordinator(directory, {} as any, control, sessions as any, { prepare: async () => ({}) } as any, async () => {}, store);
    await coordinator.hook({ nodeId: 'agent', processSessionId, nativeSessionId, observedAt: 1, event: 'UserPromptSubmit' });
    await coordinator.hook({ nodeId: 'agent', processSessionId, nativeSessionId, observedAt: 2, event: 'PostToolUse' });
    let now = 1_000;
    await coordinator.settleQuiet(() => now);
    assert.equal((await control.read()).nodes[0].activity, 'working');
    now += 20_000; output.sequence++;
    await coordinator.settleQuiet(() => now);
    assert.equal((await control.read()).nodes[0].activity, 'working', 'fresh output keeps it working');
    now += 20_000;
    await coordinator.settleQuiet(() => now);
    const node = (await control.read()).nodes[0];
    assert.equal(node.activity, 'idle'); assert.equal(node.summary, 'Ready for your next prompt');
    assert.deepEqual(attentionItems((await control.read()).nodes), [], 'an interrupted turn raises no Needs me');
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Stop keeps the last line Claude said on the node, secrets redacted, and the next prompt clears it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-agent-last-line-')), store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  try {
    const processSessionId = randomUUID(), nativeSessionId = randomUUID();
    const sessions = { runtime: { async call() { return { session: { state: 'running' }, chunks: [], firstSequence: 0, lastSequence: 1, truncated: false }; } } };
    await control.apply({ type: 'item.add', id: 'agent', resourceId: 'conversation', pluginId: 'agent.session', title: 'Claude', position: { x: 0, y: 0 }, data: { provider: 'claude', sessionId: processSessionId, nativeSessionId } }, 0);
    const coordinator = new AgentCoordinator(directory, {} as any, control, sessions as any, { prepare: async () => ({}) } as any, async () => {}, store);
    const node = async () => (await control.read()).nodes[0];
    await coordinator.hook({ nodeId: 'agent', processSessionId, nativeSessionId, observedAt: 1, event: 'UserPromptSubmit' });
    await coordinator.hook({ nodeId: 'agent', processSessionId, nativeSessionId, observedAt: 2, event: 'Stop', lastMessage: 'Done.\n\nPushed with token=abc123def456 to `main`.\n' });
    assert.deepEqual([(await node()).summary, (await node()).lastLine], ['Ready for your next prompt', 'Pushed with [redacted credential]']);
    await coordinator.hook({ nodeId: 'agent', processSessionId, nativeSessionId, observedAt: 3, event: 'UserPromptSubmit' });
    assert.equal((await node()).lastLine, undefined, 'a new turn drops the old line');
    await coordinator.hook({ nodeId: 'agent', processSessionId, nativeSessionId, observedAt: 4, event: 'Stop' });
    assert.equal((await node()).lastLine, undefined, 'a Stop without text leaves none');
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a Claude turn that leaves background work stays working until that work is done', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-agent-background-'));
  const store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  try {
    const processSessionId = randomUUID(), nativeSessionId = randomUUID();
    await control.apply({ type: 'item.add', id: 'agent', resourceId: 'conversation', pluginId: 'agent.session', title: 'Claude', position: { x: 0, y: 0 }, data: { provider: 'claude', sessionId: processSessionId, nativeSessionId } }, 0);
    const create = () => new AgentCoordinator(directory, {} as any, control, {} as any, { prepare: async () => ({}) } as any, async () => {}, store);
    let coordinator = create();
    const hook = (event: string, observedAt: number, extra: Record<string, unknown> = {}) => coordinator.hook({ nodeId: 'agent', processSessionId, nativeSessionId, observedAt, event, ...extra });
    const node = async () => (await control.read()).nodes[0];
    const running = (id: string, type: string) => ({ id, type, status: 'running' });
    await hook('UserPromptSubmit', 1);
    await hook('PostToolUse', 2, { toolName: 'Agent', launched: { id: 'a', kind: 'subagent' } });
    await hook('Stop', 3, { backgroundTasks: [running('a', 'subagent'), running('m', 'monitor')] });
    assert.deepEqual([(await node()).activity, (await node()).summary], ['working', 'Waiting on 1 subagent'], 'a watcher runs beside the prompt and is not waited on');
    assert.deepEqual(attentionItems((await control.read()).nodes), [], 'no finished attention while work is outstanding');
    await hook('Notification', 4, { notificationType: 'idle_prompt' });
    assert.equal((await node()).attention, 'none', 'an idle prompt while waiting on its own work is not Needs me');
    await hook('SubagentStop', 5, { agentId: 'a', backgroundTasks: [running('a', 'subagent'), running('m', 'monitor')] });
    assert.deepEqual([(await node()).activity, (await node()).summary], ['working', 'Claude is working'], 'the subagent result wakes the main thread');
    coordinator = create();
    await hook('PreToolUse', 6); await hook('Stop', 7, { backgroundTasks: [running('m', 'monitor')] });
    assert.deepEqual([(await node()).activity, (await node()).summary], ['idle', 'Ready for your next prompt'], 'a turn that leaves only a watcher behind is finished');
    await hook('PreToolUse', 8); await hook('Stop', 9, { backgroundTasks: [] });
    const done = await node();
    assert.deepEqual([done.activity, done.summary], ['idle', 'Ready for your next prompt']);
    assert.deepEqual(attentionItems((await control.read()).nodes)[0].reasons, ['finished']);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('older Claude hooks without a background snapshot still track background subagents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-agent-background-old-'));
  const store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  try {
    const processSessionId = randomUUID(), nativeSessionId = randomUUID();
    await control.apply({ type: 'item.add', id: 'agent', resourceId: 'conversation', pluginId: 'agent.session', title: 'Claude', position: { x: 0, y: 0 }, data: { provider: 'claude', sessionId: processSessionId, nativeSessionId } }, 0);
    const coordinator = new AgentCoordinator(directory, {} as any, control, {} as any, { prepare: async () => ({}) } as any, async () => {}, store);
    const hook = (event: string, observedAt: number, extra: Record<string, unknown> = {}) => coordinator.hook({ nodeId: 'agent', processSessionId, nativeSessionId, observedAt, event, ...extra });
    const node = async () => (await control.read()).nodes[0];
    await hook('UserPromptSubmit', 1);
    await hook('PostToolUse', 2, { toolName: 'Agent', launched: { id: 'a', kind: 'subagent' } });
    await hook('PostToolUse', 3, { toolName: 'Agent', launched: { id: 'b', kind: 'subagent' } });
    await hook('Stop', 4);
    assert.equal((await node()).summary, 'Waiting on 2 subagents');
    await hook('SubagentStop', 5, { agentId: 'a' }); await hook('SubagentStop', 5, { agentId: 'a' });
    assert.equal((await node()).summary, 'Waiting on 1 subagent');
    await hook('SubagentStop', 6, { agentId: 'b' });
    assert.deepEqual([(await node()).activity, (await node()).summary], ['working', 'Claude is working'], 'Claude still has to read the results');
    await hook('PreToolUse', 7); await hook('Stop', 8);
    assert.deepEqual([(await node()).activity, (await node()).summary], ['idle', 'Ready for your next prompt']);
    await hook('UserPromptSubmit', 9); await hook('PostToolUse', 10, { toolName: 'Agent', launched: { id: 'c', kind: 'subagent' } });
    await hook('SessionEnd', 11);
    assert.equal(store.agentBackground(processSessionId), undefined, 'a closed conversation has no outstanding work');
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('quiet settling leaves an item waiting on background work until that work is stale', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-agent-background-quiet-'));
  const store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  try {
    const processSessionId = randomUUID(), nativeSessionId = randomUUID();
    const sessions = { runtime: { async call() { return { session: { state: 'running' }, chunks: [], firstSequence: 0, lastSequence: 1, truncated: false }; } } };
    await control.apply({ type: 'item.add', id: 'agent', resourceId: 'conversation', pluginId: 'agent.session', title: 'Claude', position: { x: 0, y: 0 }, data: { provider: 'claude', sessionId: processSessionId, nativeSessionId } }, 0);
    const coordinator = new AgentCoordinator(directory, {} as any, control, sessions as any, { prepare: async () => ({}) } as any, async () => {}, store);
    await coordinator.hook({ nodeId: 'agent', processSessionId, nativeSessionId, observedAt: 1_000, event: 'UserPromptSubmit' });
    await coordinator.hook({ nodeId: 'agent', processSessionId, nativeSessionId, observedAt: 2_000, event: 'Stop', backgroundTasks: [{ id: 's', type: 'workflow', status: 'running' }] });
    let now = 3_000;
    await coordinator.settleQuiet(() => now);
    now += 60_000;
    await coordinator.settleQuiet(() => now);
    assert.deepEqual([(await control.read()).nodes[0].activity, (await control.read()).nodes[0].summary], ['working', 'Waiting on 1 workflow']);
    now += 2 * 60 * 60 * 1000;
    await coordinator.settleQuiet(() => now);
    await coordinator.settleQuiet(() => now + 30_000);
    assert.equal((await control.read()).nodes[0].activity, 'idle', 'work without any hook for two hours stops counting');
    assert.equal(store.agentBackground(processSessionId), undefined);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

async function promptFixture(name: string) {
  const directory = await mkdtemp(join(tmpdir(), `craft-agent-${name}-`));
  const store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  const processSessionId = randomUUID(), nativeSessionId = randomUUID();
  await control.apply({ type: 'item.add', id: 'agent', resourceId: 'conversation', pluginId: 'agent.session', title: 'Claude', position: { x: 0, y: 0 }, data: { provider: 'claude', sessionId: processSessionId, nativeSessionId } }, 0);
  const session = { sequence: 1, decisiveInputAt: undefined as number | undefined, decisiveInputSequence: undefined as number | undefined };
  const sessions = { runtime: { async call() { return { session: { state: 'running', ...(session.decisiveInputAt === undefined ? {} : { decisiveInputAt: session.decisiveInputAt, decisiveInputSequence: session.decisiveInputSequence }) }, chunks: [], firstSequence: 0, lastSequence: session.sequence, truncated: false }; } } };
  const coordinator = new AgentCoordinator(directory, {} as any, control, sessions as any, { prepare: async () => ({}) } as any, async () => {}, store);
  const hook = (event: string, observedAt: number, extra: Record<string, unknown> = {}) => coordinator.hook({ nodeId: 'agent', processSessionId, nativeSessionId, observedAt, event, ...extra });
  const node = async () => { const { activity, attention, attentionNote, summary } = (await control.read()).nodes[0]; return { activity, attention, attentionNote, summary }; };
  const asking = { activity: 'idle', attention: 'input', attentionNote: 'Agent needs permission', summary: 'Waiting for your input' };
  const ready = { activity: 'idle', attention: 'none', attentionNote: undefined, summary: 'Ready for your next prompt' };
  return { store, control, coordinator, session, processSessionId, hook, node, asking, ready, close: async () => { store.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('a permission prompt raised after the turn ended is cleared by the subagent work that follows the answer', async () => {
  for (const [event, extra] of [['SubagentToolUse', { agentId: 'fork' }], ['SubagentStop', { agentId: 'fork', backgroundTasks: [] }]] as const) {
    const f = await promptFixture('prompt-answered');
    try {
      await f.hook('UserPromptSubmit', 10); await f.hook('Stop', 20, { backgroundTasks: [] });
      await f.hook('SubagentStop', 21, { agentId: 'suggestions', backgroundTasks: [] });
      assert.deepEqual(await f.node(), f.ready);
      await f.hook('Notification', 30, { notificationType: 'permission_prompt' });
      assert.deepEqual(await f.node(), f.asking);
      await f.hook(event, 29, extra);
      assert.deepEqual(await f.node(), f.asking, `${event} from before the prompt is no answer`);
      await f.hook(event, 40, extra);
      assert.deepEqual(await f.node(), f.ready, event);
      assert.deepEqual(f.store.agentObservation(f.processSessionId), { event, observedAt: 40 });
      assert.deepEqual(attentionItems((await f.control.read()).nodes).flatMap(item => item.notes), ['Agent finished'], 'only the finished turn still needs me');
    } finally { await f.close(); }
  }
});

test('subagent work does not clear a permission prompt while the main turn is active', async () => {
  const f = await promptFixture('prompt-active');
  try {
    await f.hook('UserPromptSubmit', 10); await f.hook('PermissionRequest', 20);
    await f.hook('SubagentToolUse', 30, { agentId: 'a' }); await f.hook('SubagentStop', 31, { agentId: 'a' });
    assert.deepEqual(await f.node(), f.asking);
    assert.equal(f.store.agentObservation(f.processSessionId)?.event, 'PermissionRequest', 'the prompt stays the latest observation');
    await f.hook('PostToolUse', 40);
    assert.deepEqual([(await f.node()).activity, (await f.node()).attention], ['working', 'none'], 'the main thread decides');
  } finally { await f.close(); }
});

test('subagent work never changes an item that is not waiting on a permission prompt', async () => {
  const f = await promptFixture('prompt-other');
  try {
    await f.hook('UserPromptSubmit', 10); await f.hook('Stop', 20, { backgroundTasks: [] });
    const settled = (await f.control.read()).revision;
    await f.hook('SubagentToolUse', 30, { agentId: 'a' });
    assert.equal((await f.control.read()).revision, settled); assert.equal(f.store.agentObservation(f.processSessionId)?.event, 'Stop');
    assert.equal(f.store.agentBackground(f.processSessionId)?.turnEnded, true, 'a subagent tool is not a main-thread tool');
    await f.hook('Notification', 40, { notificationType: 'idle_prompt' });
    await f.hook('SubagentToolUse', 50, { agentId: 'a' });
    assert.deepEqual([(await f.node()).attention, (await f.node()).attentionNote], ['input', 'Agent waiting']);
    await f.hook('UserPromptSubmit', 60); await f.hook('PreToolUse', 70, { toolName: 'AskUserQuestion' });
    await f.hook('Stop', 80, { backgroundTasks: [] }); await f.hook('PreToolUse', 90, { toolName: 'AskUserQuestion' });
    await f.hook('SubagentToolUse', 100, { agentId: 'a' });
    assert.equal((await f.node()).attentionNote, 'Agent asked a question');
  } finally { await f.close(); }
});

test('an answered permission prompt returns to the outstanding background work, unless another subagent may hold the dialog', async () => {
  const f = await promptFixture('prompt-background');
  try {
    const running = (id: string, type: string) => ({ id, type, status: 'running' });
    await f.hook('UserPromptSubmit', 10);
    await f.hook('Stop', 20, { backgroundTasks: [running('a', 'subagent'), running('b', 'subagent'), running('m', 'workflow')] });
    await f.hook('Notification', 30, { notificationType: 'permission_prompt' });
    await f.hook('SubagentToolUse', 40, { agentId: 'a' });
    assert.deepEqual(await f.node(), f.asking, 'the other subagent may be the one asking');
    await f.hook('SubagentStop', 50, { agentId: 'b', backgroundTasks: [running('a', 'subagent'), running('m', 'workflow')] });
    assert.deepEqual(await f.node(), f.asking, 'the remaining subagent may be the one asking');
    await f.hook('SubagentToolUse', 60, { agentId: 'a' });
    assert.deepEqual(await f.node(), { activity: 'working', attention: 'none', attentionNote: undefined, summary: 'Waiting on 1 subagent · 1 workflow' });
  } finally { await f.close(); }
});

test('quiet settling repairs an answered permission prompt, and only with the person\'s decisive input', async () => {
  const f = await promptFixture('prompt-quiet');
  try {
    await f.hook('UserPromptSubmit', 10); await f.hook('Stop', 20, { backgroundTasks: [] });
    await f.hook('Notification', 5_000, { notificationType: 'permission_prompt' });
    let now = 6_000;
    await f.coordinator.settleQuiet(() => now); now += 60_000; f.session.sequence++;
    await f.coordinator.settleQuiet(() => now); now += 60_000;
    await f.coordinator.settleQuiet(() => now);
    assert.deepEqual(await f.node(), f.asking, 'quiet or fresh output alone never answers a dialog');
    f.session.decisiveInputAt = 4_000; f.session.decisiveInputSequence = 1;
    await f.coordinator.settleQuiet(() => now); now += 60_000;
    await f.coordinator.settleQuiet(() => now);
    assert.deepEqual(await f.node(), f.asking, 'input from before the prompt answered something else');
    f.session.decisiveInputAt = 5_500; f.session.decisiveInputSequence = f.session.sequence; f.session.sequence++;
    await f.coordinator.settleQuiet(() => now);
    assert.deepEqual(await f.node(), f.asking, 'the answer just repainted the terminal');
    now += 20_000;
    await f.coordinator.settleQuiet(() => now);
    assert.deepEqual(await f.node(), f.ready);
    assert.deepEqual(attentionItems((await f.control.read()).nodes).flatMap(item => item.notes), ['Agent finished']);
  } finally { await f.close(); }
});

test('quiet settling returns an answered prompt to outstanding background work and leaves questions and idle prompts alone', async () => {
  const f = await promptFixture('prompt-quiet-background');
  try {
    await f.hook('UserPromptSubmit', 10); await f.hook('Stop', 20, { backgroundTasks: [{ id: 's', type: 'workflow', status: 'running' }] });
    await f.hook('PermissionRequest', 5_000);
    f.session.decisiveInputAt = 5_500; f.session.decisiveInputSequence = f.session.sequence; f.session.sequence++;
    let now = 6_000;
    await f.coordinator.settleQuiet(() => now); now += 20_000;
    await f.coordinator.settleQuiet(() => now);
    assert.deepEqual(await f.node(), { activity: 'working', attention: 'none', attentionNote: undefined, summary: 'Waiting on 1 workflow' });
    await f.hook('UserPromptSubmit', 30_000); await f.hook('PreToolUse', 31_000, { toolName: 'AskUserQuestion' });
    f.session.decisiveInputAt = 32_000; f.session.decisiveInputSequence = f.session.sequence; f.session.sequence++;
    now = 40_000; await f.coordinator.settleQuiet(() => now); now += 60_000; await f.coordinator.settleQuiet(() => now);
    assert.equal((await f.node()).attentionNote, 'Agent asked a question');
    await f.hook('Stop', 110_000, { backgroundTasks: [] }); await f.hook('Notification', 120_000, { notificationType: 'idle_prompt' });
    now = 130_000; await f.coordinator.settleQuiet(() => now); now += 60_000; await f.coordinator.settleQuiet(() => now);
    assert.equal((await f.node()).attentionNote, 'Agent waiting');
  } finally { await f.close(); }
});

const Q = TEAMMATE_QUIET_MS, scout = 'ascout-0123456789abcdef', builder = 'abuilder-fedcba9876543210';
const teammates = (...ids: string[]) => ids.map(id => ({ id, type: 'teammate', status: 'running' }));
const waitingOn = (summary: string) => ({ activity: 'working', attention: 'none', attentionNote: undefined, summary });
const finished = async (f: Awaited<ReturnType<typeof promptFixture>>) => attentionItems((await f.control.read()).nodes).flatMap(item => item.notes);

test('a teammate that went idle does not keep its lead working once the turn has ended', async () => {
  const f = await promptFixture('teammate-idle');
  try {
    await f.hook('UserPromptSubmit', 1_000);
    await f.hook('TeammateIdle', 1_500, { teammate: 'scout', agentId: scout });
    assert.equal((await f.node()).activity, 'working', 'the main turn is still the one working');
    await f.hook('Stop', 2_000, { backgroundTasks: teammates('t1') });
    assert.deepEqual(await f.node(), f.ready, 'the teammate is listed as running but sits idle');
    assert.deepEqual(await finished(f), ['Agent finished']);
    await f.hook('Notification', 3_000, { notificationType: 'idle_prompt' });
    assert.equal((await f.node()).attentionNote, 'Agent waiting', 'an idle prompt is no longer swallowed');
  } finally { await f.close(); }
});

test('the lead waits on busy teammates only and is ready when the last one goes idle', async () => {
  const f = await promptFixture('teammate-busy');
  try {
    await f.hook('UserPromptSubmit', 1_000); await f.hook('Stop', 2_000, { backgroundTasks: teammates('t1', 't2') });
    assert.deepEqual(await f.node(), waitingOn('Waiting on 2 teammates'));
    await f.hook('SubagentToolStart', 2_500, { agentId: scout });
    assert.deepEqual(await f.node(), waitingOn('Waiting on 2 teammates'), 'a working teammate keeps the item working');
    const revision = (await f.control.read()).revision;
    await f.hook('SubagentToolUse', 2_600, { agentId: scout }); await f.hook('SubagentToolStart', 2_700, { agentId: scout });
    assert.equal((await f.control.read()).revision, revision, 'teammate tool hooks are observations, not graph edits');
    await f.hook('TeammateIdle', 3_000, { teammate: 'builder', agentId: builder });
    assert.deepEqual(await f.node(), waitingOn('Waiting on 1 teammate'), 'one idle and one busy counts one');
    await f.hook('Notification', 3_500, { notificationType: 'idle_prompt' });
    assert.equal((await f.node()).attention, 'none');
    assert.deepEqual(await finished(f), []);
    await f.hook('TeammateIdle', 4_000, { teammate: 'scout', agentId: scout });
    assert.deepEqual(await f.node(), f.ready);
    assert.deepEqual(await finished(f), ['Agent finished']);
  } finally { await f.close(); }
});

test('an idle teammate beside a running subagent still waits on the subagent', async () => {
  const f = await promptFixture('teammate-subagent');
  try {
    const running = [...teammates('t1'), { id: 'a1', type: 'subagent', status: 'running' }];
    await f.hook('UserPromptSubmit', 1_000); await f.hook('Stop', 2_000, { backgroundTasks: running });
    assert.deepEqual(await f.node(), waitingOn('Waiting on 1 subagent · 1 teammate'));
    await f.hook('TeammateIdle', 3_000, { teammate: 'scout', agentId: scout });
    assert.deepEqual(await f.node(), waitingOn('Waiting on 1 subagent'));
    await f.hook('SubagentStop', 4_000, { agentId: 'a1', backgroundTasks: running });
    await f.coordinator.settleQuiet(() => 5_000);
    assert.deepEqual(await f.node(), waitingOn('Claude is working'), 'the main thread still has to read the result');
    await f.hook('PreToolUse', 6_000); await f.hook('Stop', 7_000, { backgroundTasks: teammates('t1') });
    assert.deepEqual(await f.node(), f.ready);
    assert.deepEqual(await finished(f), ['Agent finished']);
  } finally { await f.close(); }
});

test('messaging one teammate wakes only that one, even when the team list carries no names', async () => {
  const f = await promptFixture('teammate-recipient');
  try {
    await f.hook('UserPromptSubmit', 1_000); await f.hook('Stop', 2_000, { backgroundTasks: teammates('t1', 't2') });
    await f.hook('TeammateIdle', 3_000, { teammate: 'scout', agentId: scout }); await f.hook('TeammateIdle', 3_000, { teammate: 'builder', agentId: builder });
    await f.hook('UserPromptSubmit', 4_000); await f.hook('PostToolUse', 4_500, { toolName: 'SendMessage', recipient: 'scout' }); await f.hook('Stop', 5_000, { backgroundTasks: teammates('t1', 't2') });
    assert.deepEqual(await f.node(), waitingOn('Waiting on 1 teammate'), 'the idle teammate nobody messaged stays idle');
  } finally { await f.close(); }
});

test('a teammate that is woken again puts its lead back to working', async () => {
  const f = await promptFixture('teammate-woken');
  try {
    await f.hook('UserPromptSubmit', 1_000); await f.hook('Stop', 2_000, { backgroundTasks: teammates('t1') });
    await f.hook('TeammateIdle', 3_000, { teammate: 'scout', agentId: scout });
    await f.hook('Notification', 3_500, { notificationType: 'idle_prompt' });
    assert.equal((await f.node()).attentionNote, 'Agent waiting');
    await f.hook('SubagentToolStart', 4_000, { agentId: scout });
    assert.deepEqual(await f.node(), waitingOn('Waiting on 1 teammate'), 'its tool is a sign of life');
    await f.hook('SubagentToolUse', 4_500, { agentId: scout }); await f.hook('TeammateIdle', 5_000, { teammate: 'scout', agentId: scout });
    assert.deepEqual(await f.node(), f.ready);
    await f.hook('UserPromptSubmit', 6_000); await f.hook('PostToolUse', 6_500, { toolName: 'SendMessage' }); await f.hook('Stop', 7_000, { backgroundTasks: teammates('t1') });
    assert.deepEqual(await f.node(), waitingOn('Waiting on 1 teammate'), 'a teammate the lead just messaged has work to do');
    await f.hook('TeammateIdle', 7_500, { teammate: 'scout', agentId: scout });
    await f.hook('Notification', 8_000, { notificationType: 'permission_prompt' }); await f.hook('SubagentToolStart', 8_500, { agentId: scout });
    assert.deepEqual(await f.node(), f.asking, 'a teammate starting a tool does not answer a permission prompt');
  } finally { await f.close(); }
});

test('without TeammateIdle a quiet teammate stops counting after the quiet window, never during a tool', async () => {
  const f = await promptFixture('teammate-quiet');
  try {
    await f.hook('UserPromptSubmit', 1_000); await f.hook('Stop', 2_000, { backgroundTasks: teammates('t1') });
    await f.hook('SubagentToolStart', 3_000, { agentId: scout });
    await f.coordinator.settleQuiet(() => 3_000 + 10 * Q);
    assert.deepEqual(await f.node(), waitingOn('Waiting on 1 teammate'), 'one long tool call is not idle');
    await f.hook('SubagentToolUse', 3_000 + 10 * Q, { agentId: scout });
    await f.coordinator.settleQuiet(() => 3_000 + 11 * Q - 1);
    assert.deepEqual(await f.node(), waitingOn('Waiting on 1 teammate'));
    await f.coordinator.settleQuiet(() => 3_000 + 11 * Q);
    assert.deepEqual(await f.node(), f.ready);
    assert.deepEqual(await finished(f), ['Agent finished']);
    const settled = (await f.control.read()).revision;
    await f.coordinator.settleQuiet(() => 3_000 + 12 * Q);
    assert.equal((await f.control.read()).revision, settled);
  } finally { await f.close(); }
});

test('a row stored before teammates were tracked settles its item', async () => {
  const f = await promptFixture('teammate-old-row');
  try {
    await f.hook('UserPromptSubmit', 500);
    (f.store as any).db.prepare('INSERT INTO agent_background(session_id, body) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET body = excluded.body').run(f.processSessionId,
      JSON.stringify({ tasks: [{ id: 't1a2b3c4d', kind: 'teammate' }, { id: 't5e6f7g8h', kind: 'teammate' }], ended: ['a0123456789abcdef0'], snapshotAt: 1_000, turnEnded: true, observedAt: 1_000 }));
    await f.control.apply({ type: 'node.update', id: 'agent', activity: 'working', attention: 'none', summary: 'Waiting on 2 teammates' }, (await f.control.read()).revision);
    await f.coordinator.settleQuiet(() => 1_000 + Q - 1);
    assert.deepEqual(await f.node(), waitingOn('Waiting on 2 teammates'));
    await f.coordinator.settleQuiet(() => 1_000 + Q);
    assert.deepEqual(await f.node(), f.ready);
  } finally { await f.close(); }
});

test('a TeammateIdle that matches no task counts against the teammates and never touches other work', async () => {
  const f = await promptFixture('teammate-unmatched');
  try {
    await f.hook('UserPromptSubmit', 1_000); await f.hook('Stop', 2_000, { backgroundTasks: [{ id: 't1', type: 'teammate', status: 'running', name: 'scout' }, { id: 's', type: 'workflow', status: 'running' }] });
    assert.deepEqual(await f.node(), waitingOn('Waiting on 1 teammate · 1 workflow'));
    assert.deepEqual(await f.hook('TeammateIdle', 2_500, { teammate: 'scout', processSessionId: randomUUID() }), { ignored: true });
    await f.hook('TeammateIdle', 3_000);
    assert.deepEqual(await f.node(), waitingOn('Waiting on 1 workflow'), 'an unnamed mark takes one teammate off the count');
    await f.hook('TeammateIdle', 3_500, { teammate: 'nobody' }); await f.coordinator.settleQuiet(() => 4_000);
    assert.deepEqual(await f.node(), waitingOn('Waiting on 1 workflow'), 'the workflow is still outstanding');
  } finally { await f.close(); }
  const g = await promptFixture('teammate-none');
  try {
    await g.hook('UserPromptSubmit', 1_000); await g.hook('Stop', 2_000, { backgroundTasks: [{ id: 's', type: 'workflow', status: 'running' }] });
    const revision = (await g.control.read()).revision;
    await g.hook('TeammateIdle', 3_000, { teammate: 'scout' }); await g.hook('SubagentToolStart', 3_500, { agentId: scout });
    assert.equal((await g.control.read()).revision, revision); assert.deepEqual(await g.node(), waitingOn('Waiting on 1 workflow'));
    assert.deepEqual(g.store.agentBackground(g.processSessionId)?.team?.signals.map(signal => signal.state), ['idle'], 'tool hooks are not recorded without a teammate');
  } finally { await g.close(); }
});

const helpers = async (f: Awaited<ReturnType<typeof promptFixture>>) => (await f.control.read()).nodes[0].helpers;

test('a working session carries its busy foreground subagents as helpers, written only when the number changes', async () => {
  const f = await promptFixture('helpers-foreground');
  try {
    await f.hook('UserPromptSubmit', 1_000);
    assert.equal(await helpers(f), undefined);
    await f.hook('SubagentToolStart', 2_000, { agentId: 'fg-1' });
    assert.equal(await helpers(f), 1);
    const counted = (await f.control.read()).revision;
    for (let at = 2_100; at < 3_000; at += 100) await f.hook(at % 200 ? 'SubagentToolUse' : 'SubagentToolStart', at, { agentId: 'fg-1' });
    await f.hook('PreToolUse', 3_000, { toolName: 'Read' }); await f.hook('PostToolUse', 3_050, { toolName: 'Read' });
    assert.equal((await f.control.read()).revision, counted, 'tool hooks that leave the number alone edit nothing');
    await f.hook('SubagentToolStart', 3_100, { agentId: 'fg-2' });
    assert.equal(await helpers(f), 2);
    await f.hook('SubagentStop', 3_200, { agentId: 'fg-1' });
    assert.equal(await helpers(f), 1);
    await f.hook('SubagentStop', 3_300, { agentId: 'fg-2' });
    assert.equal(await helpers(f), undefined, 'no helpers is an absent field');
    assert.equal((await f.node()).activity, 'working');
  } finally { await f.close(); }
});

test('helpers follow background subagents and busy teammates after the turn, and never stay on an item that is not working', async () => {
  const f = await promptFixture('helpers-background');
  try {
    await f.hook('UserPromptSubmit', 1_000); await f.hook('SubagentToolStart', 1_500, { agentId: 'fg' });
    await f.hook('Stop', 2_000, { backgroundTasks: [{ id: 'bg-1', type: 'subagent', status: 'running' }, { id: 'bg-2', type: 'subagent', status: 'running' }, { id: 'sh', type: 'workflow', status: 'running' }] });
    assert.deepEqual([(await f.node()).summary, await helpers(f)], ['Waiting on 2 subagents · 1 workflow', 2]);
    await f.hook('SubagentStop', 3_000, { agentId: 'bg-1', backgroundTasks: [{ id: 'bg-2', type: 'subagent', status: 'running' }, { id: 'sh', type: 'workflow', status: 'running' }] });
    assert.equal(await helpers(f), 1);
    await f.hook('SubagentStop', 4_000, { agentId: 'bg-2', backgroundTasks: [{ id: 'sh', type: 'workflow', status: 'running' }] });
    assert.deepEqual([(await f.node()).activity, await helpers(f)], ['working', undefined]);
    // Asking, stopping and ending all leave no count behind.
    await f.hook('UserPromptSubmit', 5_000); await f.hook('SubagentToolStart', 5_100, { agentId: 'fg-3' });
    assert.equal(await helpers(f), 1);
    await f.hook('PermissionRequest', 5_200);
    assert.deepEqual([(await f.node()).activity, await helpers(f)], ['idle', undefined]);
    await f.hook('PostToolUse', 5_300, { toolName: 'Bash' });
    assert.deepEqual([(await f.node()).activity, await helpers(f)], ['working', 1]);
    await f.hook('Stop', 6_000, { backgroundTasks: [] });
    assert.deepEqual([(await f.node()).activity, await helpers(f)], ['idle', undefined]);
    await f.hook('UserPromptSubmit', 7_000); await f.hook('SubagentToolStart', 7_100, { agentId: 'fg-4' });
    await f.hook('SessionEnd', 8_000);
    assert.deepEqual([(await f.node()).activity, await helpers(f)], ['idle', undefined]);
  } finally { await f.close(); }
});

test('an idle teammate is not a helper, and a quiet window that runs out lowers the count within the settle interval', async () => {
  const f = await promptFixture('helpers-teammates');
  try {
    await f.hook('UserPromptSubmit', 1_000); await f.hook('Stop', 2_000, { backgroundTasks: teammates('t1', 't2') });
    assert.equal(await helpers(f), 2);
    await f.hook('TeammateIdle', 3_000, { teammate: 't1' });
    assert.equal(await helpers(f), 1);
    await f.hook('SubagentToolStart', 4_000, { agentId: builder }); await f.hook('SubagentToolUse', 5_000, { agentId: builder });
    await f.coordinator.settleQuiet(() => 5_000 + Q - 1);
    assert.equal(await helpers(f), 1);
    const before = (await f.control.read()).revision;
    await f.coordinator.settleQuiet(() => 5_000 + Q - 1);
    assert.equal((await f.control.read()).revision, before, 'settling an unchanged count edits nothing');
    await f.coordinator.settleQuiet(() => 5_000 + Q);
    assert.deepEqual([(await f.node()).activity, await helpers(f)], ['idle', undefined]);
  } finally { await f.close(); }
});

test('a foreground subagent that falls silent stops counting after the quiet window', async () => {
  const f = await promptFixture('helpers-quiet');
  try {
    f.session.sequence = 1;
    await f.hook('UserPromptSubmit', 1_000); await f.hook('SubagentToolStart', 2_000, { agentId: 'fg' }); await f.hook('SubagentToolUse', 3_000, { agentId: 'fg' });
    assert.equal(await helpers(f), 1);
    await f.hook('PreToolUse', 3_000 + Q, { toolName: 'Read' });
    assert.equal(await helpers(f), undefined, 'the next hook of the session notices');
  } finally { await f.close(); }
});

test('a session that only waits on its helpers says so with them, in one revision, and not while its turn is active or it wakes', async () => {
  const f = await promptFixture('helpers-waiting');
  const flock = async () => { const node = (await f.control.read()).nodes[0]; return [node.helpers, node.waiting]; };
  const two = [{ id: 'bg-1', type: 'subagent', status: 'running' }, { id: 'bg-2', type: 'subagent', status: 'running' }];
  try {
    await f.hook('UserPromptSubmit', 1_000); await f.hook('SubagentToolStart', 1_500, { agentId: 'fg' });
    assert.deepEqual(await flock(), [1, undefined], 'working alongside a foreground subagent');
    await f.hook('SubagentStop', 1_800, { agentId: 'fg' });
    const before = (await f.control.read()).revision;
    await f.hook('Stop', 2_000, { backgroundTasks: two });
    assert.deepEqual(await flock(), [2, true]);
    assert.equal((await f.control.read()).revision, before + 1, 'the status, the count and the flag in one revision');
    const waiting = (await f.control.read()).revision;
    await f.hook('SubagentToolStart', 2_100, { agentId: 'bg-1' }); await f.hook('SubagentToolUse', 2_200, { agentId: 'bg-1' });
    assert.equal((await f.control.read()).revision, waiting, 'helpers at work change nothing');
    await f.hook('SubagentStop', 3_000, { agentId: 'bg-1', backgroundTasks: [two[1]] });
    assert.deepEqual(await flock(), [1, undefined], 'it wakes to read the result');
    await f.hook('PreToolUse', 3_100, { toolName: 'Read' }); await f.hook('Stop', 3_500, { backgroundTasks: [two[1]] });
    assert.deepEqual(await flock(), [1, true]);
    await f.hook('UserPromptSubmit', 4_000);
    assert.deepEqual(await flock(), [1, undefined], 'a new prompt: its own turn is active again');
    await f.hook('Stop', 5_000, { backgroundTasks: [two[1]] });
    assert.deepEqual(await flock(), [1, true]);
    await f.hook('SubagentStop', 6_000, { agentId: 'bg-2', backgroundTasks: [] });
    assert.deepEqual([(await f.node()).activity, ...await flock()], ['working', undefined, undefined]);
  } finally { await f.close(); }
});

test('the waiting flag ends with the last busy teammate on the settle interval', async () => {
  const f = await promptFixture('helpers-waiting-team');
  try {
    await f.hook('UserPromptSubmit', 1_000); await f.hook('Stop', 2_000, { backgroundTasks: teammates('t1') });
    await f.hook('SubagentToolStart', 3_000, { agentId: scout }); await f.hook('SubagentToolUse', 4_000, { agentId: scout });
    assert.deepEqual([(await f.control.read()).nodes[0].helpers, (await f.control.read()).nodes[0].waiting], [1, true]);
    await f.coordinator.settleQuiet(() => 4_000 + Q);
    const node = (await f.control.read()).nodes[0];
    assert.deepEqual([node.activity, node.helpers, node.waiting], ['idle', undefined, undefined]);
  } finally { await f.close(); }
});

const pose = async (f: Awaited<ReturnType<typeof promptFixture>>) => (await f.control.read()).nodes[0].pose;

test('a prompt, a question and an error each give the item its pose in the revision that raises them, and lose it when answered', async () => {
  const f = await promptFixture('pose-attention');
  try {
    await f.hook('UserPromptSubmit', 1_000);
    const before = (await f.control.read()).revision;
    await f.hook('PermissionRequest', 2_000);
    assert.deepEqual([await pose(f), (await f.control.read()).revision], ['gate', before + 1]);
    await f.hook('PostToolUse', 3_000, { toolName: 'Edit' });
    assert.deepEqual([await pose(f), (await f.node()).activity, (await f.control.read()).revision], [undefined, 'working', before + 2]);
    await f.hook('PreToolUse', 4_000, { toolName: 'AskUserQuestion' });
    assert.equal(await pose(f), 'asking');
    await f.hook('PostToolUse', 5_000, { toolName: 'AskUserQuestion' }); await f.hook('Stop', 6_000, { backgroundTasks: [] });
    assert.equal(await pose(f), undefined);
    await f.hook('Notification', 7_000, { notificationType: 'idle_prompt' });
    assert.equal(await pose(f), 'asking', 'the idle prompt that raises Needs me');
    await f.hook('UserPromptSubmit', 8_000); await f.hook('StopFailure', 9_000);
    assert.equal(await pose(f), 'fallen');
    await f.hook('UserPromptSubmit', 10_000);
    assert.equal(await pose(f), undefined);
  } finally { await f.close(); }
});

test('a shell command shows only after it has run a while, stays long enough to see, and tool hooks cost no revision', async () => {
  const f = await promptFixture('pose-command');
  // The terminal keeps printing, so the quiet-turn repair stays out of it.
  const settle = (at: number) => { f.session.sequence++; return f.coordinator.settleQuiet(() => at); };
  try {
    await f.hook('UserPromptSubmit', 1_000);
    const quiet = (await f.control.read()).revision;
    // A burst of quick tools, shell commands among them: nothing is written.
    for (let at = 2_000; at < 12_000; at += 500) { const toolName = at % 1_000 ? 'Bash' : 'Read'; await f.hook('PreToolUse', at, { toolName }); await f.hook('PostToolUse', at + 400, { toolName }); }
    await settle(12_400);
    assert.deepEqual([(await f.control.read()).revision, await pose(f)], [quiet, undefined]);
    // A command that keeps running shows at the next check after a second and a half.
    await f.hook('PreToolUse', 20_000, { toolName: 'Bash' });
    await settle(21_000);
    assert.equal(await pose(f), undefined);
    await settle(21_500);
    assert.deepEqual([await pose(f), (await f.control.read()).revision], ['command', quiet], 'a pose is scene: it keeps the revision');
    await settle(60_000);
    assert.equal((await f.control.read()).revision, quiet);
    await f.hook('PostToolUse', 61_000, { toolName: 'Bash' });
    assert.equal(await pose(f), undefined, 'a long command goes when it ends');
    // One that ended after two seconds is still shown at its end, and leaves on the settle pass.
    await f.hook('PreToolUse', 70_000, { toolName: 'Bash' }); await f.hook('PostToolUse', 72_000, { toolName: 'Bash' });
    assert.equal(await pose(f), 'command');
    await settle(74_000);
    assert.equal(await pose(f), 'command');
    await settle(74_500);
    assert.equal(await pose(f), undefined);
    // A permission prompt outranks a running command, and a subagent's shell is not the item's.
    await f.hook('PreToolUse', 80_000, { toolName: 'Bash' }); await f.hook('PermissionRequest', 82_000);
    assert.equal(await pose(f), 'gate');
    await f.hook('PostToolUse', 83_000, { toolName: 'Bash' }); await settle(90_000);
    await f.hook('SubagentToolStart', 91_000, { agentId: 'fg', toolName: 'Bash' }); await settle(95_000);
    assert.equal(await pose(f), undefined);
  } finally { await f.close(); }
});

test('a helper that finishes leaves with a moment; shells and watchers stay beside an idle item; the end of the session shows and clears', async () => {
  const f = await promptFixture('pose-beside');
  const node = async () => (await f.control.read()).nodes[0];
  try {
    await f.hook('UserPromptSubmit', 1_000);
    await f.hook('Stop', 2_000, { backgroundTasks: [{ id: 'bg', type: 'subagent', status: 'running' }, { id: 'sh', type: 'shell', status: 'running' }, { id: 'm', type: 'monitor', status: 'running' }] });
    assert.deepEqual([(await node()).helpers, (await node()).beside, (await node()).moment], [1, 2, { kind: 'enter', at: 2_000 }]);
    await f.hook('SubagentStop', 10_000, { agentId: 'bg', backgroundTasks: [{ id: 'sh', type: 'shell', status: 'running' }, { id: 'm', type: 'monitor', status: 'running' }] });
    assert.deepEqual([(await node()).helpers, (await node()).moment], [undefined, { kind: 'leave', at: 10_000 }]);
    await f.hook('PreToolUse', 11_000, { toolName: 'Read' }); await f.hook('Stop', 12_000, { backgroundTasks: [{ id: 'm', type: 'monitor', status: 'running' }] });
    assert.deepEqual([(await node()).activity, (await node()).beside, (await node()).pose], ['idle', 1, undefined], 'idle, with a watcher beside it');
    const idle = (await f.control.read()).revision;
    await f.coordinator.settleQuiet(() => 20_000);
    assert.equal((await f.control.read()).revision, idle);
    await f.hook('SessionEnd', 30_000);
    assert.deepEqual([(await node()).pose, (await node()).beside], ['ended', undefined]);
    const ended = (await f.control.read()).revision;
    await f.coordinator.settleQuiet(() => 40_000);
    assert.deepEqual([(await f.control.read()).revision, (await node()).pose], [ended, 'ended'], 'it stays ended until the session lives again');
    await f.hook('SessionStart', 50_000);
    assert.equal((await node()).pose, undefined);
  } finally { await f.close(); }
});

test('compaction, tasks, another model and a worktree reach the node as plain state; a failed or denied tool is one moment per gap', async () => {
  const f = await promptFixture('scene-new-signals');
  const node = async () => (await f.control.read()).nodes[0];
  try {
    await f.hook('SessionStart', 500, { model: 'claude-opus-5-5' });
    await f.hook('UserPromptSubmit', 1_000, { worktree: true });
    assert.deepEqual([(await node()).pen, (await node()).bell], [true, undefined]);
    const steady = (await f.control.read()).revision;
    await f.hook('PreCompact', 2_000);
    assert.deepEqual([(await node()).pose, (await node()).activity, (await f.control.read()).revision], ['shearing', 'working', steady]);
    await f.hook('PostCompact', 3_000);
    assert.equal((await node()).pose, undefined);
    await f.hook('PostModelSwitch', 4_000, { model: 'claude-haiku-5', previousModel: 'claude-opus-5-5' });
    assert.equal((await node()).bell, true);
    await f.hook('PostModelSwitch', 4_500, { model: 'claude-opus-5-5', previousModel: 'claude-haiku-5' });
    assert.equal((await node()).bell, undefined, 'back on its own model');
    for (const id of ['1', '2', '3']) await f.hook('TaskCreated', 5_000, { taskId: id });
    await f.hook('TaskCompleted', 6_000, { taskId: '1' });
    assert.deepEqual((await node()).tasks, { done: 1, total: 3 });
    // A burst of failing tools: one stumble, and the item keeps working.
    const before = (await f.control.read()).revision;
    for (let at = 10_000; at < 12_000; at += 200) { await f.hook('PreToolUse', at, { toolName: 'Edit', worktree: true }); await f.hook('PostToolUseFailure', at + 100, { toolName: 'Edit' }); }
    assert.deepEqual([(await node()).moment, (await node()).activity, (await f.control.read()).revision], [{ kind: 'stumble', at: 10_100 }, 'working', before]);
    await f.hook('PostToolUseFailure', 20_000, { toolName: 'Bash', interrupt: true });
    assert.deepEqual((await node()).moment, { kind: 'stumble', at: 10_100 }, 'an interrupt is not a stumble');
    await f.hook('PermissionDenied', 21_000, { toolName: 'Bash' });
    assert.deepEqual((await node()).moment, { kind: 'bump', at: 21_000 });
    // A subagent starting is a helper at once, and walks in.
    await f.hook('SubagentStart', 30_000, { agentId: 'fg' });
    assert.deepEqual([(await node()).helpers, (await node()).moment], [1, { kind: 'enter', at: 30_000 }]);
    await f.hook('SubagentStop', 40_000, { agentId: 'fg' });
    assert.deepEqual([(await node()).helpers, (await node()).moment], [undefined, { kind: 'leave', at: 40_000 }]);
    // Leaving the worktree unpens it; the end of the session takes the rest.
    await f.hook('PreToolUse', 50_000, { toolName: 'Read' });
    assert.equal((await node()).pen, undefined);
    await f.hook('Stop', 60_000, { backgroundTasks: [] });
    assert.deepEqual([(await node()).activity, (await node()).tasks], ['idle', { done: 1, total: 3 }], 'the list outlives the turn');
    await f.hook('PostToolUseFailure', 61_000, { toolName: 'Edit' });
    assert.deepEqual((await node()).moment, { kind: 'leave', at: 40_000 }, 'an item that is not working does not stumble');
    await f.hook('SessionEnd', 70_000);
    assert.deepEqual([(await node()).pose, (await node()).tasks, (await node()).bell, (await node()).pen], ['ended', undefined, undefined, undefined]);
  } finally { await f.close(); }
});
