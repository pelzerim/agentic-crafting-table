import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startWorkspaceService } from './server.ts';
import { connectWorkspace } from './client.ts';
import { linearProviders, linearIssueId } from '../../tests/fixtures/linear.ts';
import type { ResourceChoices, ResourceSnapshot, SkillContext } from '../../src/resource-plugins/types.ts';

test('Linear aliases retain UUID identity, links and lifecycle through imports, rename, context, account errors and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-linear-')), providers = linearProviders();
  let service = await startWorkspaceService(directory, undefined, undefined, providers), client = await connectWorkspace(directory);
  try {
    await service.control.dispatch({ commandId: 'legacy', expectedRevision: 0, actor: { kind: 'agent', id: 'fixture' }, commands: [
      ...['OLD-42', 'BIL-128'].map((issueId, i) => ({ type: 'item.add', id: issueId, resourceId: issueId + '-r', pluginId: 'linear.ticket', title: 'Old issue', position: { x: 400 * i, y: 300 }, data: { issueId } })),
      { type: 'item.add', id: 'agent', resourceId: 'agent-r', pluginId: 'agent.session', title: 'Agent', data: { sessionId: 'fixture', provider: 'claude' }, position: { x: 800, y: 300 } },
      { type: 'link.save', link: { id: 'context', sourceId: 'OLD-42', targetId: 'agent', kind: 'context' } }, { type: 'node.complete', id: 'BIL-128' },
    ] });
    const before = await service.control.read();
    const request = (url: string) => ({ requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), pluginId: 'linear.ticket', expectedRevision: before.revision, title: 'Lookup', position: { x: 0, y: 0 }, data: { url } });
    await assert.rejects(client.call('item.create', request('https://linear.app/other/issue/BIL-128/title')), /different Linear workspace/); assert.deepEqual(await service.control.read(), before);
    const original = request('https://linear.app/old-fixture/issue/OLD-42/outdated');
    const result = await client.call('item.create', original), state = await service.control.read(); assert.equal(state.resources.length, 2); assert.equal(state.nodes.length, 3);
    const resource = state.resources.find(resource => resource.pluginId === 'linear.ticket')!; assert.deepEqual(resource.data, { issueId: linearIssueId }); assert.equal(resource.connectionId, 'linear-fixture'); assert.deepEqual(state.links, before.links);
    for (const old of before.nodes) { const node = state.nodes.find(node => node.id === old.id)!; assert.deepEqual(node.position, old.position); assert.equal(node.completedAt, old.completedAt); }
    providers.data.issue.previousIdentifiers.push('BIL-128'); providers.data.issue.identifier = 'PAY-7'; providers.data.issue.url = 'https://linear.app/fixture/issue/PAY-7/new'; providers.data.issue.state.name = 'Done'; providers.data.issue.state.type = 'completed';
    const read = (refresh = false) => client.call<ResourceSnapshot>('runtime.run', { nodeId: 'OLD-42', action: 'resource.read', arguments: { refresh } });
    const refreshed = await read(true); assert.equal(refreshed.title, 'PAY-7 · Make plan changes predictable'); assert.equal(refreshed.activity, 'complete');
    await client.call('item.create', request(providers.data.issue.url)); assert.equal((await service.control.read()).nodes.length, 3);
    providers.data.issue.description = 'Large description '.repeat(3000); const context = await client.call<SkillContext>('runtime.run', { nodeId: 'OLD-42', action: 'resource.context', arguments: {} }); assert.ok(context.content.length <= 32_000); assert.match(context.content, /Context excerpt/); assert.equal(context.sourceUrl, providers.data.issue.url);
    client.close(); await service.close(); service = await startWorkspaceService(directory, undefined, undefined, providers); client = await connectWorkspace(directory);
    const callCount = providers.calls.length; assert.deepEqual(await client.call('item.create', original), result); assert.equal((await read()).title, refreshed.title); assert.equal(providers.calls.length, callCount);
    providers.data.viewer.id = '99999999-9999-4999-8999-999999999999'; const stale = await read(true); assert.equal(stale.stale, true); assert.match(stale.error!, /another account/); assert.equal(stale.title, refreshed.title);
    await assert.rejects(client.call('runtime.run', { nodeId: 'OLD-42', action: 'resource.context', arguments: {} }), /another account/);
    providers.accounts[0].enabled = false; await assert.rejects(read(), /Connect Linear/);
  } finally { client.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Linear workflow writes sync every alias, preserve local tasks/layout and replay safely after restart', async () => {
  const ticket = randomUUID(), resourceId = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), 'craft-linear-status-')), providers = linearProviders();
  let service = await startWorkspaceService(directory, undefined, undefined, providers), client = await connectWorkspace(directory);
  const run = <T>(actionId: string, input = {}) => client.call<T>('runtime.run', { nodeId: ticket, action: 'resource.action', arguments: { actionId, input } });
  try {
    await client.call('item.create', { requestId: randomUUID(), nodeId: ticket, resourceId, title: 'Ticket', pluginId: 'linear.ticket', expectedRevision: 0, position: { x: 200, y: 300 }, data: { url: 'https://linear.app/fixture/issue/BIL-128/plans' } });
    const original = await service.control.read();
    await service.control.dispatch({ commandId: randomUUID(), expectedRevision: original.revision, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'node.todo', id: ticket, enabled: true }, { type: 'item.create', id: 'alias', position: { x: 600, y: 300 }, resource: { ...original.resources[0], id: 'alias-resource' } }] });
    const choices = await run<ResourceChoices>('linear.status.options'); assert.equal(providers.writes.length, 0);
    const input = { ...choices.context, value: providers.states[3].id, requestId: randomUUID() };
    await assert.rejects(run('linear.status.set', { ...input, sourceResourceId: 'other' }), /another item/);
    const first = await run('linear.status.set', input);
    assert.equal(providers.writes.length, 1);
    const state = await service.control.read(), node = state.nodes[0];
    assert.equal(state.nodes.find(node => node.id === 'alias')?.indicators?.[0].label, 'Done');
    assert.equal(node.indicators?.[0].label, 'Done'); assert.equal(node.indicators?.[0].tone, 'green');
    assert.deepEqual(node.position, original.nodes[0].position); assert.equal(node.inTodoList, true); assert.ok(node.completedAt, 'Linear Done checks the to-do');
    const read = await client.call<ResourceSnapshot>('runtime.run', { nodeId: ticket, action: 'resource.read', arguments: {} });
    assert.equal(read.label, 'Done'); assert.deepEqual(read.detail?.state, providers.data.issue.state);
    await assert.rejects(client.call('runtime.run', { nodeId: ticket, action: 'resource.content', arguments: { actionId: 'linear.status.set', input } }), /Only read-only/);
    client.close(); await service.close(); service = await startWorkspaceService(directory, undefined, undefined, providers); client = await connectWorkspace(directory);
    assert.deepEqual(await run('linear.status.set', input), first); assert.equal(providers.writes.length, 1);
    const fresh = await run<ResourceChoices>('linear.status.options');
    const current = await service.control.read(); await service.control.dispatch({ commandId: randomUUID(), expectedRevision: current.revision, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'node.archive', id: ticket }] });
    await assert.rejects(run('linear.status.set', { ...fresh.context, value: providers.states[0].id, requestId: randomUUID() }), /Restore/);
    assert.equal(providers.writes.length, 1);
  } finally { client.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('uncertain Linear updates are never replayed and refresh reconciles the actual provider state', async () => {
  const ticket = randomUUID(), resourceId = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), 'craft-linear-uncertain-')), providers = linearProviders();
  let service = await startWorkspaceService(directory, undefined, undefined, providers), client = await connectWorkspace(directory);
  try {
    await client.call('item.create', { requestId: randomUUID(), nodeId: ticket, resourceId, title: 'Ticket', pluginId: 'linear.ticket', expectedRevision: 0, position: { x: 200, y: 300 }, data: { url: 'https://linear.app/fixture/issue/BIL-128/plans' } });
    const request = (actionId: string, input = {}) => ({ nodeId: ticket, action: 'resource.action', arguments: { actionId, input } });
    const choices = await client.call<ResourceChoices>('runtime.run', request('linear.status.options'));
    const input = { ...choices.context, value: providers.states[2].id, requestId: randomUUID() };
    const update = providers.transport.updateState!;
    providers.transport.updateState = async (...args) => { await update(...args); throw Object.assign(new Error('Confirmation lost. Refresh before retrying.'), { outcomeUnknown: true }); };
    await assert.rejects(client.call('runtime.run', request('linear.status.set', input)), /Confirmation lost/);
    assert.equal((await service.control.read()).nodes[0].indicators?.[0].label, 'In Progress');
    client.close(); await service.close(); service = await startWorkspaceService(directory, undefined, undefined, providers); client = await connectWorkspace(directory);
    await assert.rejects(client.call('runtime.run', request('linear.status.set', input)), /previous update could not be confirmed/);
    assert.equal(providers.writes.length, 1);
    const read = await client.call<ResourceSnapshot>('runtime.run', { nodeId: ticket, action: 'resource.read', arguments: { refresh: true } });
    assert.equal(read.label, 'In Review'); assert.equal((await service.control.read()).nodes[0].indicators?.[0].label, 'In Review');
  } finally { client.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

import { ResourceCoordinator } from './resources.ts';
import { SqliteStore } from './sqlite-store.ts';
import { WorkspaceControl } from '../core/control.ts';
test('Linear polling updates unopened aliases and serializes older reads with duplicate status writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-linear-poll-')), providers = linearProviders(), store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  let now = Date.now();
  const resources = new ResourceCoordinator(store, control, providers.host(control.registry), providers.connections, async () => {}, () => now);
  const signal = AbortSignal.timeout(3000);
  const apply = async (commands: import('../core/control.ts').WorkspaceCommand[]) => control.dispatch({ commandId: randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'fixture' }, commands });
  try {
    await apply(['ticket', 'alias'].map((id, index) => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'linear.ticket', title: 'Ticket', data: { issueId: linearIssueId }, position: { x: index * 400, y: 100 } })));
    await resources.poll();
    assert.equal((await control.read()).resources.length, 1);
    const choices = await resources.execute('ticket', 'linear.status.options', {}, signal) as unknown as ResourceChoices;
    const input = { ...choices.context, value: providers.states[3].id, requestId: randomUUID() };
    const originalRead = providers.transport.read;
    let release!: () => void, started!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { started = resolve; });
    let blockOnce = true;
    providers.transport.read = async (...args) => {
      const result = await originalRead(...args);
      if (blockOnce && args[0] === 'issue') { blockOnce = false; started(); await pending; }
      return result;
    };
    now += 61_000; const polling = resources.poll(); await ready;
    const update = resources.execute('ticket', 'linear.status.set', input, signal), duplicate = resources.execute('ticket', 'linear.status.set', input, signal);
    const laterRead = resources.read('alias');
    release(); const [, result, repeated, refreshed] = await Promise.all([polling, update, duplicate, laterRead]);
    assert.deepEqual(result, repeated); assert.equal(refreshed.label, 'Done'); assert.equal(providers.writes.length, 1);
    for (const node of (await control.read()).nodes) assert.equal(node.indicators?.[0].label, 'Done');
    providers.data.issue.state = { ...providers.states[2] }; now += 61_000; await resources.poll();
    for (const node of (await control.read()).nodes) assert.equal(node.indicators?.[0].label, 'In Review');
    assert.equal(providers.writes.length, 1, 'background polling never writes');
    await apply(['ticket', 'alias'].map(id => ({ type: 'node.archive', id })));
    const count = providers.calls.length; now += 61_000; await resources.poll(); assert.equal(providers.calls.length, count);
  } finally { await resources.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Linear Done and local Mark done mirror each other once, restore the earlier state and revert when Linear refuses', async () => {
  const ticket = randomUUID(), directory = await mkdtemp(join(tmpdir(), 'craft-linear-done-')), providers = linearProviders();
  providers.states.push({ id: '99999999-9999-4999-8999-999999999991', name: 'Shipped', type: 'completed', position: 4 }, { id: '99999999-9999-4999-8999-999999999992', name: 'Canceled', type: 'canceled', position: 5 });
  const [todo, inProgress, , done, , canceled] = providers.states;
  const service = await startWorkspaceService(directory, undefined, undefined, providers), client = await connectWorkspace(directory);
  const apply = async (type: 'node.complete' | 'node.reopen', id: string = ticket) => client.call('apply', { commandId: randomUUID(), expectedRevision: (await service.control.read()).revision, actor: { kind: 'user', id: 'test' }, commands: [{ type, id }] });
  const completed = async () => (await service.control.read()).nodes.filter(node => node.completedAt).map(node => node.id).sort();
  const observe = async (state: { id: string; name: string; type: string }) => { providers.data.issue.state = { id: state.id, name: state.name, type: state.type }; await client.call('runtime.run', { nodeId: ticket, action: 'resource.read', arguments: { refresh: true } }); };
  try {
    await client.call('item.create', { requestId: randomUUID(), nodeId: ticket, resourceId: randomUUID(), title: 'Ticket', pluginId: 'linear.ticket', expectedRevision: 0, position: { x: 200, y: 300 }, data: { url: 'https://linear.app/fixture/issue/BIL-128/plans' } });
    const original = await service.control.read();
    await service.control.dispatch({ commandId: randomUUID(), expectedRevision: original.revision, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'node.todo', id: ticket, enabled: true }, { type: 'item.create', id: 'alias', position: { x: 600, y: 300 }, resource: { ...original.resources[0], id: 'alias-resource' } }] });
    assert.deepEqual(await completed(), []);
    await apply('node.complete');
    assert.deepEqual(providers.writes.map(write => write.stateId), [done.id], 'the first completed state by position');
    assert.deepEqual(await completed(), ['alias', ticket].sort()); assert.equal((await service.control.read()).nodes.find(node => node.id === 'alias')?.indicators?.[0].label, 'Done');
    await observe(done); assert.equal(providers.writes.length, 1, 'observing the mirrored state never writes again');
    await apply('node.reopen');
    assert.deepEqual(providers.writes.map(write => write.stateId), [done.id, inProgress.id], 'reopen restores the state from before completion');
    assert.deepEqual(await completed(), []);
    await observe(done); assert.deepEqual(await completed(), ['alias', ticket].sort());
    await observe(todo); assert.deepEqual(await completed(), []);
    await observe(canceled); assert.deepEqual(await completed(), ['alias', ticket].sort(), 'canceled counts as done');
    await apply('node.reopen', 'alias'); assert.equal(providers.writes.at(-1)?.stateId, inProgress.id, 'without a recorded state, the first started state');
    assert.deepEqual(await completed(), []); assert.equal(providers.writes.length, 3);
    // A later poll that still sees the same open state leaves local completion alone.
    await service.control.dispatch({ commandId: randomUUID(), expectedRevision: (await service.control.read()).revision, actor: { kind: 'system', id: 'fixture' }, commands: [{ type: 'node.complete', id: 'alias' }] });
    await observe(inProgress); assert.deepEqual(await completed(), ['alias']); assert.equal(providers.writes.length, 3);
    await apply('node.reopen', 'alias'); assert.equal(providers.writes.length, 3, 'Linear already open');
    const update = providers.transport.updateState!;
    providers.transport.updateState = async () => { throw new Error('Linear credentials are expired or lack permission. Reconnect the selected account.'); };
    await assert.rejects(apply('node.complete'), /lack permission/);
    assert.deepEqual(await completed(), [], 'a refused write reverts the local check');
    providers.transport.updateState = async (...args) => { await update(...args); throw Object.assign(new Error('Linear update could not be confirmed. Refresh the issue before trying again.'), { outcomeUnknown: true }); };
    await assert.rejects(apply('node.complete'), /could not be confirmed/);
    assert.deepEqual(await completed(), [], 'an unconfirmed write reverts too');
    await observe(done); assert.deepEqual(await completed(), ['alias', ticket].sort(), 'a refresh reconciles what Linear actually did');
    await service.control.dispatch({ commandId: randomUUID(), expectedRevision: (await service.control.read()).revision, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'item.add', id: 'task', resourceId: 'task-r', pluginId: 'workspace.todo', title: 'Local task', position: { x: 1000, y: 300 }, data: {} }] });
    await apply('node.complete', 'task'); assert.ok((await completed()).includes('task'), 'items without a connector complete locally');
    await service.control.dispatch({ commandId: randomUUID(), expectedRevision: (await service.control.read()).revision, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'item.add', id: 'unbound', resourceId: 'unbound-r', pluginId: 'linear.ticket', title: 'BIL-9', position: { x: 1400, y: 300 }, data: { issueId: 'BIL-9' } }] });
    await apply('node.complete', 'unbound'); assert.ok((await completed()).includes('unbound'), 'a ticket without an account binding completes locally');
    await assert.rejects(client.call('runtime.run', { nodeId: ticket, action: 'resource.action', arguments: { actionId: 'linear.status.complete', input: { done: 'false', requestId: randomUUID(), sourceResourceId: 'x' } } }), /Mark done or Reopen/);
  } finally { client.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a to-do that brought its ticket to the map ticks when Linear says Done, and ticking a kept ticket in the list never writes Linear', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-linear-todo-done-')), providers = linearProviders();
  const [todo, , , done] = providers.states;
  const service = await startWorkspaceService(directory, undefined, undefined, providers), client = await connectWorkspace(directory);
  const apply = async (commands: unknown[]) => client.call('apply', { commandId: randomUUID(), expectedRevision: (await service.control.read()).revision, actor: { kind: 'user', id: 'test' }, commands });
  const observe = async (nodeId: string, state: { id: string; name: string; type: string }) => { providers.data.issue.state = { id: state.id, name: state.name, type: state.type }; await client.call('runtime.run', { nodeId, action: 'resource.read', arguments: { refresh: true } }); };
  const node = async (id: string) => (await service.control.read()).nodes.find(node => node.id === id)!;
  try {
    await apply([{ type: 'project.create', id: 'billing', title: 'Billing', summary: '', position: { x: 0, y: 0 } },
      { type: 'todo.save', todo: { id: 'taken', title: 'Make plan changes predictable', completed: false, nodeIds: [], horizon: 'later', triage: { source: 'linear', key: linearIssueId, label: 'BIL-128', item: { pluginId: 'linear.ticket', connectionId: 'linear-fixture', title: 'BIL-128 · Make plan changes predictable', data: { issueId: linearIssueId } } } } }]);
    await apply([{ type: 'todo.send', id: 'taken', projectId: 'billing', nodeId: 'sent', resourceId: 'sent-r' }]);
    assert.equal((await node('sent')).todoTicketId, 'sent:item');
    await observe('sent:item', done);
    assert.ok((await node('sent:item')).completedAt); assert.ok((await node('sent')).completedAt, 'the to-do follows its ticket to Done');
    await observe('sent:item', todo); assert.equal((await node('sent')).completedAt, undefined, 'and back');
    const writes = providers.writes.length;
    await apply([{ type: 'node.todo', id: 'sent:item', enabled: true }, { type: 'todo.move', id: 'map:sent:item', horizon: 'done' }]);
    assert.ok((await node('sent:item')).todoDoneAt); assert.equal((await node('sent:item')).completedAt, undefined);
    assert.equal(providers.writes.length, writes, 'a tick in the list is not a Linear write');
  } finally { client.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
