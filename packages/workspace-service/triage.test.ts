import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { TRIAGE_POLL_MS, TriageCoordinator } from './triage.ts';
import { SqliteStore } from './sqlite-store.ts';
import { WorkspaceControl } from '../core/control.ts';
import type { WorkspaceCommand } from '../core/control.ts';
import type { ProviderConnection } from '../core/connections.ts';
import { linearTriageAdapter, linearTriageFilter } from '../provider-runtime/linear-triage.ts';
import { LINEAR_TRIAGE_PRIORITIES, LINEAR_TRIAGE_STATE_TYPES } from '../provider-runtime/linear.ts';
import linearTicketPlugin from '../../src/resource-plugins/items/linear-ticket/plugin.ts';
import { linearFixture, linearProviders } from '../../tests/fixtures/linear.ts';
import { startWorkspaceService } from './server.ts';
import { connectWorkspace } from './client.ts';
import { groupWorkspaceTodos } from '../../src/graph/todos.ts';
import { attentionItems } from '../../src/graph/attention.ts';
import { sendTodo } from '../core/todos.ts';

async function fixture(run: (input: {
  store: SqliteStore; control: WorkspaceControl; triage: TriageCoordinator; linear: ReturnType<typeof linearFixture>; connections: ProviderConnection[]; settings: { importAssigned: boolean; triageStateTypes?: string[]; triagePriority?: string };
  advance(ms: number): void; restart(): Promise<void>; apply(commands: WorkspaceCommand[]): Promise<void>; titles(): Promise<string[]>; changes: { count: number };
}) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'craft-triage-')), file = join(directory, 'workspace.sqlite');
  const linear = linearFixture(), connections: ProviderConnection[] = [{ id: 'linear-one', providerId: 'linear', account: linear.account.id, enabled: true, isDefault: true }];
  const settings: { importAssigned: boolean; triageStateTypes?: string[]; triagePriority?: string } = { importAssigned: true }, changes = { count: 0 };
  let store = new SqliteStore(file), control = new WorkspaceControl(store), now = 1_000_000;
  const create = () => new TriageCoordinator(store, control, [linearTriageAdapter(async () => linear.client)], () => connections, () => ({ 'linear.ticket': { ...settings } }), async () => { changes.count++; }, () => true, () => now);
  let triage = create();
  const input = { get store() { return store; }, get control() { return control; }, get triage() { return triage; }, linear, connections, settings, changes,
    advance(ms: number) { now += ms; },
    async restart() { await triage.pause(); store.close(); store = new SqliteStore(file); control = new WorkspaceControl(store); triage = create(); },
    async apply(commands: WorkspaceCommand[]) { await control.dispatch({ commandId: randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'test' }, commands }); },
    async titles() { return (groupWorkspaceTodos(await control.read()).find(group => group.triage)?.items ?? []).map(item => item.title); },
  };
  try { await run(input); } finally { await triage.pause(); store.close(); rmSync(directory, { recursive: true, force: true }); }
}
const assignedCalls = (linear: ReturnType<typeof linearFixture>) => linear.calls.filter(call => call.startsWith('assigned:')).length;

test('assigned tickets become one quiet Triage to-do each, once, across repeated syncs and restarts', () => fixture(async input => {
  input.linear.assign(3); await input.triage.refresh();
  let state = await input.control.read();
  assert.deepEqual(await input.titles(), ['Assigned ticket 1', 'Assigned ticket 2', 'Assigned ticket 3']);
  assert.deepEqual(state.todos[0].triage, { source: 'linear', key: input.linear.assigned[0].id, label: 'BIL-1', url: 'https://linear.app/fixture/issue/BIL-1/assigned-ticket-1', status: 'Todo',
    item: { pluginId: 'linear.ticket', connectionId: 'linear-one', title: 'BIL-1 · Assigned ticket 1', data: { issueId: input.linear.assigned[0].id } } });
  assert.equal(state.nodes.length, 0, 'nothing appears on the map'); assert.equal(state.resources.length, 0); assert.equal(attentionItems(state.nodes).length, 0);
  assert.deepEqual(state.todos.map(todo => [todo.completed, todo.nodeIds, todo.archivedAt, todo.horizon, todo.touchedAt]), [[false, [], undefined, 'inbox', undefined], [false, [], undefined, 'inbox', undefined], [false, [], undefined, 'inbox', undefined]]);
  assert.equal(input.changes.count, 1);
  const revision = state.revision; await input.triage.refresh(); assert.equal((await input.control.read()).revision, revision); assert.equal(input.changes.count, 1);
  await input.restart(); await input.triage.refresh();
  state = await input.control.read(); assert.equal(state.revision, revision); assert.equal(state.todos.length, 3);
  assert.deepEqual(input.triage.status().map(status => [status.connectionId, status.providerId, status.error, typeof status.checkedAt]), [['linear-one', 'linear', undefined, 'number']]);
}));

test('a ticket that already exists as an item or to-do anywhere is never imported again, even after it is deleted', () => fixture(async input => {
  const [first, second, third, fourth] = input.linear.assign(5);
  await input.apply([
    { type: 'project.create', id: 'billing', title: 'Billing', summary: '', position: { x: 0, y: 0 } },
    { type: 'item.add', id: 'resolved', resourceId: 'resolved-r', pluginId: 'linear.ticket', connectionId: 'linear-one', title: 'BIL-1', data: { issueId: first.id }, projectId: 'billing', position: { x: 0, y: 0 } },
    { type: 'item.add', id: 'by-url', resourceId: 'by-url-r', pluginId: 'linear.ticket', title: 'BIL-2', data: { issueId: 'BIL-2', workspaceKey: 'fixture' }, position: { x: 400, y: 0 } },
    { type: 'item.add', id: 'elsewhere', resourceId: 'elsewhere-r', pluginId: 'linear.ticket', connectionId: 'other-workspace', title: 'BIL-5', data: { issueId: 'BIL-5' }, position: { x: 1200, y: 0 } },
    { type: 'item.add', id: 'archived', resourceId: 'archived-r', pluginId: 'linear.ticket', connectionId: 'linear-one', title: 'BIL-3', data: { issueId: third.id }, position: { x: 800, y: 0 } },
    { type: 'node.complete', id: 'resolved' }, { type: 'node.archive', id: 'archived' },
    { type: 'todo.save', todo: { id: 'earlier', title: 'Handled by hand', completed: true, nodeIds: [], archivedAt: '2026-09-29T10:00:00.000Z', triage: { source: 'linear', key: fourth.id, label: 'BIL-4', item: { pluginId: 'linear.ticket', title: 'BIL-4', data: { issueId: fourth.id } } } } },
  ]);
  await input.triage.refresh(); assert.deepEqual(await input.titles(), ['Assigned ticket 5']); void second;
  await input.apply([{ type: 'node.delete', id: 'archived' }, { type: 'todo.remove', id: 'earlier' }]);
  input.advance(TRIAGE_POLL_MS); await input.triage.refresh(); await input.restart(); await input.triage.refresh();
  assert.deepEqual(await input.titles(), ['Assigned ticket 5']); assert.equal((await input.control.read()).todos.length, 1);
}));

test('a Triage to-do the person archives and deletes stays dismissed while the ticket remains assigned', () => fixture(async input => {
  input.linear.assign(2); await input.triage.refresh();
  const dismissed = (await input.control.read()).todos[0];
  await input.apply([{ type: 'todo.archive', id: dismissed.id }]); await input.triage.refresh();
  assert.deepEqual(await input.titles(), ['Assigned ticket 2']); assert.equal((await input.control.read()).todos.length, 2, 'an archived to-do is left in the archive');
  await input.apply([{ type: 'todo.remove', id: dismissed.id }]); await input.triage.refresh(); await input.restart(); await input.triage.refresh();
  assert.deepEqual((await input.control.read()).todos.map(todo => todo.title), ['Assigned ticket 2']);
}));

test('tickets that leave the assigned list take their untouched Triage to-do with them; touched or sent to-dos stay', () => fixture(async input => {
  input.linear.assign(5); await input.triage.refresh();
  let state = await input.control.read();
  const [untouched, renamed, done, sent, kept] = state.todos;
  await input.apply([
    { type: 'project.create', id: 'billing', title: 'Billing', summary: '', position: { x: 0, y: 0 } },
    { type: 'todo.save', todo: { id: renamed.id, title: 'BIL-2 in my own words', completed: false, nodeIds: [] } },
    { type: 'todo.save', todo: { id: done.id, title: done.title, completed: true, nodeIds: [] } },
    sendTodo(groupWorkspaceTodos(state)[0].items.find(item => item.id === sent.id)!, 'billing', { nodeId: 'sent', resourceId: 'sent-r' }),
  ]);
  input.linear.assigned.splice(0, 4); await input.triage.refresh();
  state = await input.control.read();
  assert.deepEqual(state.todos.map(todo => [todo.title, todo.completed, todo.archivedAt]), [[kept.title, false, undefined], ['BIL-2 in my own words', false, undefined], ['Assigned ticket 3', true, undefined]]);
  assert.equal(state.todos.some(todo => todo.id === untouched.id), false, 'removed, not archived');
  assert.deepEqual(state.nodes.filter(node => node.resourceId).map(node => [node.id, node.projectId]), [['sent', 'billing'], ['sent:item', 'billing']]);
  // Reassignment starts a new cycle for the removed ticket only.
  input.linear.assigned.unshift({ ...input.linear.assigned[0], id: untouched.triage!.key, identifier: 'BIL-1', title: 'Assigned ticket 1', url: 'https://linear.app/fixture/issue/BIL-1/assigned-ticket-1' });
  await input.triage.refresh();
  assert.deepEqual(await input.titles(), [kept.title, 'Assigned ticket 1'], 'the touched ones were taken out of the inbox');
  assert.equal((await input.control.read()).nodes.filter(node => node.resourceId).length, 2);
}));

test('a truncated assigned list adds tickets but removes none', () => fixture(async input => {
  input.linear.assign(3); await input.triage.refresh();
  input.linear.assign(101); input.linear.assigned.splice(0, 3); await input.triage.refresh();
  const titles = await input.titles(); assert.equal(titles.length, 103); assert.equal(titles[0], 'Assigned ticket 1');
  input.linear.assigned.splice(100); await input.triage.refresh();
  const complete = await input.titles(); assert.equal(complete.length, 100, 'a complete list reconciles again'); assert.equal(complete[0], 'Assigned ticket 4');
}));

const stateOf = (type: string) => ({ id: `99999999-9999-4999-8999-${String(['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled', 'duplicate'].indexOf(type)).padStart(12, '0')}`, name: type, type });
const rows = async (input: { control: WorkspaceControl }) => (await input.control.read()).todos.map(todo => todo.title);

test('the Linear settings declare the statuses and priorities the client allows, default to all open statuses and parse saved values strictly', () => {
  const fields = linearTicketPlugin.settings!.fields;
  assert.deepEqual(Object.keys(fields), ['importAssigned', 'triageStateTypes', 'triagePriority']);
  assert.deepEqual([fields.triageStateTypes.kind, fields.triageStateTypes.options, fields.triageStateTypes.default, fields.triageStateTypes.enabledBy], ['multiselect', [...LINEAR_TRIAGE_STATE_TYPES], [...LINEAR_TRIAGE_STATE_TYPES], 'importAssigned']);
  assert.deepEqual(fields.triageStateTypes.optionLabels, { triage: 'Triage', backlog: 'Backlog', unstarted: 'Todo', started: 'In progress' });
  assert.ok(fields.triageStateTypes.emptyHint);
  assert.deepEqual([fields.triagePriority.kind, [...fields.triagePriority.options!].sort(), fields.triagePriority.default, fields.triagePriority.enabledBy], ['select', Object.keys(LINEAR_TRIAGE_PRIORITIES).sort(), 'any', 'importAssigned']);
  assert.deepEqual(linearTriageFilter({}), { stateTypes: ['triage', 'backlog', 'unstarted', 'started'], priority: 'any' });
  assert.deepEqual(linearTriageFilter({ importAssigned: true }), linearTriageFilter({}), 'settings saved before the filter existed get the default');
  assert.deepEqual(linearTriageFilter({ triageStateTypes: ['started', 'backlog'], triagePriority: 'high' }), { stateTypes: ['backlog', 'started'], priority: 'high' });
  assert.deepEqual(linearTriageFilter({ triageStateTypes: [] }).stateTypes, []);
  assert.deepEqual(linearTriageFilter({ triageStateTypes: ['duplicate', 'completed', 'canceled', 'started', 7, 'started'], triagePriority: 'low' } as never), { stateTypes: ['started'], priority: 'any' }, 'unknown values never widen the selection');
  assert.deepEqual(linearTriageFilter({ triageStateTypes: 'started', triagePriority: 'constructor' }), linearTriageFilter({}));
  const adapter = linearTriageAdapter(async () => { throw new Error('not read'); });
  assert.equal(adapter.scope!({ triageStateTypes: [] }), undefined, 'nothing selected imports nothing');
  assert.notEqual(adapter.scope!({}), adapter.scope!({ triageStateTypes: ['started'] })); assert.notEqual(adapter.scope!({}), adapter.scope!({ triagePriority: 'high' }));
  assert.equal(adapter.scope!({ triageStateTypes: ['started', 'backlog'] }), adapter.scope!({ triageStateTypes: ['backlog', 'started'], importAssigned: true }));
});

test('a ticket marked duplicate takes its untouched Triage to-do with it and returns when it is reopened', () => fixture(async input => {
  input.linear.assign(3); input.linear.assigned[1].state = stateOf('duplicate');
  await input.triage.refresh();
  assert.deepEqual(await input.titles(), ['Assigned ticket 1', 'Assigned ticket 3'], 'a duplicate is never imported');
  // To-dos an earlier version imported for duplicates leave on the next read.
  input.linear.assigned[2].state = stateOf('duplicate'); input.advance(TRIAGE_POLL_MS); await input.triage.refresh();
  assert.deepEqual(await rows(input), ['Assigned ticket 1']);
  input.linear.assigned[1].state = stateOf('started'); input.linear.assigned[2].state = stateOf('backlog'); await input.triage.refresh();
  assert.deepEqual(await input.titles(), ['Assigned ticket 1', 'Assigned ticket 2', 'Assigned ticket 3']);
}));

test('unticking a status removes its untouched to-dos at once, keeps touched ones and dismissals, and re-ticking imports the removed ones again', () => fixture(async input => {
  input.linear.assign(6).forEach((issue, index) => { issue.state = stateOf(['backlog', 'backlog', 'backlog', 'unstarted', 'started', 'triage'][index]); });
  input.triage.start(); await input.triage.tick();
  const [untouched, renamed, dismissed] = (await input.control.read()).todos;
  await input.apply([{ type: 'todo.save', todo: { id: renamed.id, title: 'BIL-2 in my own words', completed: false, nodeIds: [] } }, { type: 'todo.archive', id: dismissed.id }, { type: 'todo.remove', id: dismissed.id }]);
  await input.triage.tick(); assert.equal(assignedCalls(input.linear), 1, 'nothing changed, so the next read waits for the poll');
  input.settings.triageStateTypes = ['triage', 'unstarted', 'started']; input.triage.settingsChanged(); await input.triage.tick();
  assert.equal(assignedCalls(input.linear), 2, 'a changed selection reads at once');
  assert.deepEqual(input.linear.filters.at(-1), { states: ['triage', 'unstarted', 'started'], priorities: [0, 1, 2, 3, 4] });
  assert.deepEqual(await rows(input), ['Assigned ticket 4', 'Assigned ticket 5', 'Assigned ticket 6', 'BIL-2 in my own words']);
  assert.equal((await input.control.read()).todos.some(todo => todo.id === untouched.id), false, 'removed, not archived');
  await input.triage.tick(); assert.equal(assignedCalls(input.linear), 2);
  input.settings.triageStateTypes = ['triage', 'backlog', 'unstarted', 'started']; input.triage.settingsChanged(); await input.triage.tick();
  assert.equal(assignedCalls(input.linear), 3);
  assert.deepEqual(await rows(input), ['Assigned ticket 4', 'Assigned ticket 5', 'Assigned ticket 6', 'BIL-2 in my own words', 'Assigned ticket 1'], 'the removed ticket is back; the renamed one is not doubled and the deleted one stays dismissed');
  // The same holds across a restart between the two changes.
  input.settings.triageStateTypes = ['started']; input.triage.settingsChanged(); await input.triage.tick();
  assert.deepEqual(await rows(input), ['Assigned ticket 5', 'BIL-2 in my own words']);
  await input.restart(); input.advance(TRIAGE_POLL_MS); await input.triage.refresh(); delete input.settings.triageStateTypes; await input.triage.refresh();
  assert.deepEqual((await rows(input)).sort(), ['Assigned ticket 1', 'Assigned ticket 4', 'Assigned ticket 5', 'Assigned ticket 6', 'BIL-2 in my own words']);
  // A dismissal is forgotten only when the ticket itself leaves (unassigned, finished) and comes back.
  const gone = input.linear.assigned.splice(2, 1); input.advance(TRIAGE_POLL_MS); await input.triage.refresh();
  input.linear.assigned.push(...gone); input.advance(TRIAGE_POLL_MS); await input.triage.refresh();
  assert.equal((await rows(input)).includes('Assigned ticket 3'), true);
}));

test('the minimum priority narrows the import the same way', () => fixture(async input => {
  input.linear.assign(5).forEach((issue, index) => { issue.priority = index; });
  await input.triage.refresh(); assert.equal((await rows(input)).length, 5);
  input.settings.triagePriority = 'high'; await input.triage.refresh();
  assert.deepEqual(await rows(input), ['Assigned ticket 2', 'Assigned ticket 3']);
  input.settings.triagePriority = 'medium'; await input.triage.refresh();
  assert.deepEqual(await rows(input), ['Assigned ticket 2', 'Assigned ticket 3', 'Assigned ticket 4']);
}));

test('an empty status selection stops reading like the switch and leaves every to-do alone', () => fixture(async input => {
  input.linear.assign(2); input.triage.start(); await input.triage.tick();
  input.settings.triageStateTypes = []; input.triage.settingsChanged(); input.linear.assigned.splice(0); input.advance(TRIAGE_POLL_MS); await input.triage.tick(); await input.triage.refresh();
  assert.equal(assignedCalls(input.linear), 1); assert.deepEqual(input.triage.status(), []); assert.deepEqual(await rows(input), ['Assigned ticket 1', 'Assigned ticket 2']);
}));

test('a selection that changes while its list is cut off at the cap still removes nothing', () => fixture(async input => {
  input.linear.assign(3).forEach(issue => { issue.state = stateOf('backlog'); }); await input.triage.refresh();
  input.linear.assign(101); input.settings.triageStateTypes = ['unstarted']; await input.triage.refresh();
  assert.equal((await rows(input)).length, 103, 'the cap, not the filter, decides that nothing is removed');
  input.linear.assigned.splice(100); await input.triage.refresh();
  const titles = await rows(input); assert.equal(titles.length, 97); assert.equal(titles.includes('Assigned ticket 1'), false);
}));

test('a settings change during a read starts the read again with the new selection', () => fixture(async input => {
  input.linear.assign(2); input.linear.assigned[0].state = stateOf('backlog');
  const read = input.linear.transport.read; let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let first = true;
  input.linear.transport.read = async (...args) => { if (first) { first = false; await held; args[2].throwIfAborted(); } return read(...args); };
  input.triage.start(); const running = input.triage.tick(); await new Promise(resolve => setImmediate(resolve));
  input.settings.triageStateTypes = ['unstarted']; input.triage.settingsChanged(); const next = input.triage.tick(); release(); await running; await next;
  assert.deepEqual(await rows(input), ['Assigned ticket 2']); assert.deepEqual(input.linear.filters.at(-1)?.states, ['unstarted']);
}));

test('a retitled ticket updates its untouched to-do and keeps an edited title, while the ticket itself stays current', () => fixture(async input => {
  input.linear.assign(2); await input.triage.refresh();
  const edited = (await input.control.read()).todos[1];
  await input.apply([{ type: 'todo.save', todo: { id: edited.id, title: 'My wording', completed: false, nodeIds: [] } }]);
  input.linear.assigned[0].title = 'Retitled in Linear'; input.linear.assigned[1].title = 'Also retitled';
  await input.triage.refresh();
  const state = await input.control.read();
  assert.deepEqual(state.todos.map(todo => [todo.title, todo.triage?.item.title]).sort(), [['My wording', 'BIL-2 · Also retitled'], ['Retitled in Linear', 'BIL-1 · Retitled in Linear']]);
  const revision = state.revision; await input.triage.refresh(); assert.equal((await input.control.read()).revision, revision);
}));

test('the setting, a disabled connection and provider backoff stop reads without touching existing to-dos', () => fixture(async input => {
  input.linear.assign(1); input.settings.importAssigned = false;
  await input.triage.refresh(); input.triage.start(); await input.triage.tick();
  assert.equal(assignedCalls(input.linear), 0); assert.deepEqual(await input.titles(), []); assert.deepEqual(input.triage.status(), []);
  input.settings.importAssigned = true; input.triage.settingsChanged(); await input.triage.tick();
  assert.equal(assignedCalls(input.linear), 1); assert.deepEqual(await input.titles(), ['Assigned ticket 1']);
  await input.triage.tick(); assert.equal(assignedCalls(input.linear), 1, 'waits for the next poll');
  input.advance(TRIAGE_POLL_MS); await input.triage.tick(); assert.equal(assignedCalls(input.linear), 2);
  input.settings.importAssigned = false; input.linear.assigned.splice(0); input.advance(TRIAGE_POLL_MS); await input.triage.tick(); await input.triage.refresh();
  assert.equal(assignedCalls(input.linear), 2); assert.deepEqual(await input.titles(), ['Assigned ticket 1'], 'turning the import off leaves to-dos alone');
  input.settings.importAssigned = true; input.connections[0].enabled = false; input.connections[0].isDefault = false; input.triage.settingsChanged(); await input.triage.tick(); await input.triage.refresh();
  assert.equal(assignedCalls(input.linear), 2); assert.deepEqual(input.triage.status().map(status => status.enabled), [false]);
  input.connections[0].enabled = true; input.linear.assign(1);
  const read = input.linear.transport.read; let limited = true;
  input.linear.transport.read = async (...args) => { if (limited && args[0] === 'assigned') { input.linear.calls.push('assigned:limited'); throw Object.assign(new Error('Linear rate limit reached. Retry after the cooldown.'), { retryAt: 1_000_000 + 10 * TRIAGE_POLL_MS }); } return read(...args); };
  await input.triage.refresh();
  assert.equal(assignedCalls(input.linear), 3); assert.match(input.triage.status()[0].error ?? '', /rate limit/); assert.deepEqual(await input.titles(), ['Assigned ticket 1']);
  limited = false; input.advance(TRIAGE_POLL_MS); await input.triage.refresh(); await input.triage.tick();
  assert.equal(assignedCalls(input.linear), 3, 'the provider cooldown is honoured, also for a manual refresh');
  input.advance(10 * TRIAGE_POLL_MS); await input.triage.tick();
  assert.equal(assignedCalls(input.linear), 4); assert.equal(input.triage.status()[0].error, undefined); assert.deepEqual(await input.titles(), ['Assigned ticket 1']);
}));

test('the service imports on start and on a manual refresh, and the Linear setting defaults on and turns it off', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'craft-triage-service-')), providers = linearProviders({ assigned: 2 });
  const todos = async (service: Awaited<ReturnType<typeof startWorkspaceService>>, count: number) => {
    for (let attempt = 0; attempt < 100 && (await service.control.read()).todos.length !== count; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    return (await service.control.read()).todos.map(todo => todo.title);
  };
  let service = await startWorkspaceService(directory, undefined, undefined, providers), client = await connectWorkspace(directory);
  try {
    assert.equal(service.control.registry.pluginSettings(service.store.readSettings().value.plugins)['linear.ticket'].importAssigned, true);
    assert.deepEqual(await todos(service, 2), ['Assigned ticket 1', 'Assigned ticket 2']);
    providers.assign(1); await client.call('connections.refresh', {});
    assert.deepEqual(await todos(service, 3), ['Assigned ticket 1', 'Assigned ticket 2', 'Assigned ticket 3']);
    const settings = service.store.readSettings();
    await client.call('settings.write', { expectedRevision: settings.revision, value: { ...settings.value, plugins: { ...settings.value.plugins, 'linear.ticket': { importAssigned: false } } } });
    const calls = assignedCalls(providers); providers.assign(1); await client.call('connections.refresh', {});
    client.close(); await service.close(); service = await startWorkspaceService(directory, undefined, undefined, providers); client = await connectWorkspace(directory);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(assignedCalls(providers), calls); assert.equal((await service.control.read()).todos.length, 3);
    assert.equal((await service.control.read()).nodes.length, 0);
  } finally { client.close(); await service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('saving a status selection in the service reads at once, and statuses outside the offered list are refused', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'craft-triage-filter-service-')), providers = linearProviders({ assigned: 3 });
  providers.assigned[0].state = stateOf('backlog'); providers.assigned[2].state = stateOf('duplicate');
  const titles = async (service: Awaited<ReturnType<typeof startWorkspaceService>>, count: number) => {
    for (let attempt = 0; attempt < 100 && (await service.control.read()).todos.length !== count; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    return (await service.control.read()).todos.map(todo => todo.title);
  };
  const service = await startWorkspaceService(directory, undefined, undefined, providers), client = await connectWorkspace(directory);
  const save = async (values: Record<string, unknown>) => { const settings = service.store.readSettings(); return client.call('settings.write', { expectedRevision: settings.revision, value: { ...settings.value, plugins: { ...settings.value.plugins, 'linear.ticket': values } } }); };
  try {
    const defaults = service.control.registry.pluginSettings(service.store.readSettings().value.plugins)['linear.ticket'];
    assert.deepEqual([defaults.triageStateTypes, defaults.triagePriority], [['triage', 'backlog', 'unstarted', 'started'], 'any']);
    assert.deepEqual(await titles(service, 2), ['Assigned ticket 1', 'Assigned ticket 2']);
    await save({ importAssigned: true, triageStateTypes: ['unstarted', 'started'] });
    assert.deepEqual(await titles(service, 1), ['Assigned ticket 2']);
    for (const triageStateTypes of [['duplicate'], ['completed'], ['canceled'], ['started', 'started'], 'started']) await assert.rejects(save({ importAssigned: true, triageStateTypes }), /settings are invalid/);
    await assert.rejects(save({ importAssigned: true, triagePriority: 'low' }), /settings are invalid/);
    await save({ importAssigned: true });
    assert.deepEqual(await titles(service, 2), ['Assigned ticket 2', 'Assigned ticket 1']);
  } finally { client.close(); await service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('the first tick after start reads at once, whatever the saved schedule says', () => fixture(async input => {
  input.linear.assign(1); await input.triage.refresh(); await input.restart();
  input.linear.assign(1); input.triage.start(); await input.triage.tick();
  assert.deepEqual(await input.titles(), ['Assigned ticket 1', 'Assigned ticket 2']);
}));

test('Not for me hides an inbox ticket until its title, state or assignment changes', () => fixture(async input => {
  input.linear.assign(4); await input.triage.refresh();
  const [retitled, moved, unassigned, quiet] = (await input.control.read()).todos;
  await input.apply([retitled, moved, unassigned, quiet].map(todo => ({ type: 'todo.dismiss', id: todo.id, dismissed: true })));
  input.advance(TRIAGE_POLL_MS); await input.triage.refresh();
  assert.deepEqual(await input.titles(), [], 'nothing changed, so all stay hidden');
  input.linear.assigned[0].title = 'Retitled ticket'; input.linear.assigned[1].state = { ...stateOf('started'), name: 'In Progress' };
  const gone = input.linear.assigned.splice(2, 1); input.advance(TRIAGE_POLL_MS); await input.triage.refresh();
  assert.deepEqual(await input.titles(), ['Retitled ticket', 'Assigned ticket 2']);
  assert.equal((await input.control.read()).todos.some(todo => todo.id === unassigned.id), false, 'a hidden ticket that leaves goes with it');
  input.linear.assigned.push(...gone); input.advance(TRIAGE_POLL_MS); await input.triage.refresh();
  assert.deepEqual(await input.titles(), ['Retitled ticket', 'Assigned ticket 2', 'Assigned ticket 3'], 'reassigned, it is back');
  assert.deepEqual((await input.control.read()).todos.find(todo => todo.id === quiet.id)?.dismissed?.title, 'Assigned ticket 4');
  input.settings.triageStateTypes = ['started']; input.triage.settingsChanged(); await input.triage.refresh();
  input.settings.triageStateTypes = ['triage', 'backlog', 'unstarted', 'started']; input.triage.settingsChanged(); await input.triage.refresh();
  assert.ok((await input.control.read()).todos.find(todo => todo.id === quiet.id)?.dismissed, 'a settings change is not a change of the ticket');
}));

test('a taken ticket is a to-do: it leaves the inbox, keeps its state current and is not removed when the ticket leaves', () => fixture(async input => {
  input.linear.assign(2); await input.triage.refresh();
  const [taken] = (await input.control.read()).todos;
  await input.apply([{ type: 'todo.move', id: taken.id, horizon: 'later' }]);
  assert.deepEqual(await input.titles(), ['Assigned ticket 2']);
  const touchedAt = (await input.control.read()).todos.find(todo => todo.id === taken.id)!.touchedAt;
  input.linear.assigned[0].state = { ...stateOf('started'), name: 'In Progress' }; input.linear.assigned[0].title = 'Renamed in Linear';
  input.advance(TRIAGE_POLL_MS); await input.triage.refresh();
  let record = (await input.control.read()).todos.find(todo => todo.id === taken.id)!;
  assert.deepEqual([record.title, record.triage?.status, record.horizon, record.touchedAt], ['Renamed in Linear', 'In Progress', 'later', touchedAt], 'a provider refresh is not a touch');
  input.linear.assigned.splice(0, 1); input.advance(TRIAGE_POLL_MS); await input.triage.refresh();
  record = (await input.control.read()).todos.find(todo => todo.id === taken.id)!;
  assert.equal(record.horizon, 'later');
}));
