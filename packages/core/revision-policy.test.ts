import test from 'node:test';
import assert from 'node:assert/strict';
import { commandSchema, emptyState } from './control.ts';
import type { WorkspaceCommand, WorkspaceState } from './control.ts';
import { COMMAND_REVISION_RULES, REQUEST_REVISION_RULES, revisionRefusal } from './revision-policy.ts';

const commandTypes = commandSchema.options.map(option => option.shape.type.value).sort();
const agent = { kind: 'agent' as const, id: 'agent' };
const state: WorkspaceState = { ...emptyState(), revision: 4,
  nodes: [
    { id: 'project', title: 'Project', position: { x: 0, y: 0 } },
    { id: 'agent', title: 'Agent', resourceId: 'agent-resource', projectId: 'project', position: { x: 0, y: 0 } },
    { id: 'other', title: 'Other', resourceId: 'other-resource', projectId: 'project', position: { x: 0, y: 0 } },
    { id: 'loose', title: 'Loose', resourceId: 'loose-resource', position: { x: 0, y: 0 } },
  ] as WorkspaceState['nodes'],
  links: [{ id: 'saved-link', sourceId: 'agent', targetId: 'other', kind: 'reference', label: '' }],
  todos: [{ id: 'saved-todo', title: 'Saved', completed: false, nodeIds: [] }] };
const refusal = (command: Record<string, unknown>, actor = agent) => revisionRefusal([commandSchema.parse(command)], { state, actor });

test('every command type is classified, and nothing else is', () => {
  assert.deepEqual(Object.keys(COMMAND_REVISION_RULES).sort(), commandTypes);
  for (const [type, rule] of Object.entries(COMMAND_REVISION_RULES)) {
    assert.ok(rule.why.trim().length > 10, `${type} states its reason`);
    if (typeof rule.free === 'function') assert.ok(rule.otherwise.trim().length > 10, `${type} states when it needs a revision`);
  }
});

test('the classification is the reviewed one', () => {
  const kind = (type: string) => { const free = COMMAND_REVISION_RULES[type as WorkspaceCommand['type']].free; return typeof free === 'function' ? 'conditional' : free ? 'free' : 'required'; };
  const grouped = { free: commandTypes.filter(type => kind(type) === 'free'), conditional: commandTypes.filter(type => kind(type) === 'conditional'), required: commandTypes.filter(type => kind(type) === 'required') };
  assert.deepEqual(grouped.free, ['attention.acknowledge', 'attention.restore', 'item.add', 'item.create', 'node.title.generated', 'node.todo.label', 'project.create', 'todo.context']);
  assert.deepEqual(grouped.conditional, ['attention.set', 'link.save', 'node.attach', 'node.todo', 'node.update', 'todo.save']);
  assert.deepEqual(grouped.required, ['item.bind', 'item.convert', 'item.resolve', 'item.update', 'layout.repair', 'link.remove', 'node.archive', 'node.below', 'node.complete', 'node.delete', 'node.hide',
    'node.move', 'node.reopen', 'node.resize', 'node.restore', 'node.show', 'node.surface', 'nodes.action', 'nodes.move', 'nodes.send', 'project.mute', 'todo.archive', 'todo.dismiss', 'todo.move', 'todo.place', 'todo.remove', 'todo.restore',
    'todo.send', 'todos.reorder', 'view.set']);
});

test('additive commands need no revision', () => {
  assert.equal(refusal({ type: 'item.add', id: 'pr', resourceId: 'pr-resource', pluginId: 'github.pull-request', data: {}, position: { x: 0, y: 0 }, links: [{ otherId: 'agent', kind: 'reference' }] }), undefined);
  assert.equal(refusal({ type: 'project.create', id: 'new-project', title: 'New', position: { x: 0, y: 0 } }), undefined);
  assert.equal(refusal({ type: 'attention.acknowledge', id: 'other', versions: { other: 1 } }), undefined);
});

test('a command that overwrites or removes work names itself and asks for the revision', () => {
  assert.equal(refusal({ type: 'node.move', id: 'other', position: { x: 1, y: 1 } }),
    'node.move needs expectedRevision: it overwrites positions the user may be changing. Pass the revision from workspace_read.');
  assert.match(refusal({ type: 'item.update', id: 'other', data: {} })!, /^item\.update needs expectedRevision: it replaces the item's data/);
  assert.match(refusal({ type: 'node.archive', id: 'other' })!, /^node\.archive needs expectedRevision/);
  assert.match(refusal({ type: 'link.remove', id: 'saved-link' })!, /^link\.remove needs expectedRevision/);
});

test('a link or to-do is revision-free only while it is new', () => {
  assert.equal(refusal({ type: 'link.save', link: { id: 'new-link', sourceId: 'agent', targetId: 'loose', kind: 'reference' } }), undefined);
  assert.match(refusal({ type: 'link.save', link: { id: 'saved-link', sourceId: 'agent', targetId: 'loose', kind: 'context' } })!, /^link\.save needs expectedRevision: it replaces a link that already exists/);
  assert.equal(refusal({ type: 'todo.save', todo: { id: 'new-todo', title: 'New' } }), undefined);
  assert.match(refusal({ type: 'todo.save', todo: { id: 'saved-todo', title: 'Renamed' } })!, /^todo\.save needs expectedRevision: it replaces a to-do that already exists/);
});

test('writing a to-do\'s context is revision-free for an agent, on a checklist or a map to-do, replacing or appending', () => {
  assert.equal(refusal({ type: 'todo.context', id: 'saved-todo', context: 'Next: rerun the backfill', mode: 'append' }), undefined);
  assert.equal(refusal({ type: 'todo.context', id: 'map:other', context: 'Summary', mode: 'replace' }), undefined);
  assert.equal(refusal({ type: 'todo.save', todo: { id: 'new-todo', title: 'New', context: 'Why this exists' } }), undefined);
  assert.match(refusal({ type: 'todo.save', todo: { id: 'saved-todo', title: 'Saved', context: 'Why this exists' } })!, /^todo\.save needs expectedRevision/);
  assert.match(COMMAND_REVISION_RULES['todo.context'].why, /never moves, completes or removes/);
});

test('adding to the list or to a first project is revision-free; taking away is not', () => {
  assert.equal(refusal({ type: 'node.todo', id: 'other', enabled: true }), undefined);
  assert.match(refusal({ type: 'node.todo', id: 'other', enabled: false })!, /^node\.todo needs expectedRevision/);
  assert.equal(refusal({ type: 'node.attach', id: 'loose', projectId: 'project' }), undefined);
  assert.match(refusal({ type: 'node.attach', id: 'other', projectId: 'project' })!, /^node\.attach needs expectedRevision/);
  assert.match(refusal({ type: 'node.attach', id: 'loose', projectId: null })!, /^node\.attach needs expectedRevision/);
});

test('an agent reports its own status without a revision, and nothing else about a node', () => {
  assert.equal(refusal({ type: 'node.update', id: 'agent', summary: 'Tests pass', activity: 'working', attention: 'input', attentionNote: 'Agent waiting' }), undefined);
  assert.equal(refusal({ type: 'attention.set', id: 'agent', source: 'agent', reason: 'input', note: 'Agent waiting' }), undefined);
  assert.match(refusal({ type: 'node.update', id: 'other', summary: 'Tests pass' })!, /^node\.update needs expectedRevision: it changes a node other than your own session/);
  assert.match(refusal({ type: 'node.update', id: 'agent', title: 'Renamed' })!, /^node\.update needs expectedRevision/);
  assert.match(refusal({ type: 'attention.set', id: 'other', source: 'agent', reason: 'input' })!, /^attention\.set needs expectedRevision/);
  assert.match(refusal({ type: 'node.update', id: 'agent', summary: 'Tests pass' }, { kind: 'agent', id: 'mcp-client' })!, /^node\.update needs expectedRevision/);
});

test('a batch is revision-free only when every member is', () => {
  const add = commandSchema.parse({ type: 'project.create', id: 'new-project', title: 'New', position: { x: 0, y: 0 } });
  const link = commandSchema.parse({ type: 'link.save', link: { id: 'new-link', sourceId: 'agent', targetId: 'loose', kind: 'reference' } });
  const move = commandSchema.parse({ type: 'node.move', id: 'other', position: { x: 1, y: 1 } });
  assert.equal(revisionRefusal([add, link], { state, actor: agent }), undefined);
  assert.match(revisionRefusal([add, move, link], { state, actor: agent })!, /^node\.move needs expectedRevision/);
});

test('requests outside the command union that take a revision are classified too', () => {
  assert.deepEqual(Object.entries(REQUEST_REVISION_RULES).map(([request, rule]) => [request, rule.free]),
    [['workspace_apply', 'per command'], ['workspace_create_item', true], ['workspace_run_skill', true], ['workspace_run skill.run', true], ['workspace_settings', false]]);
});
