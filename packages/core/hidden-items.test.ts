import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceControl, MemoryStore, agentCommandRefusal } from './control.ts';
import { createResourcePluginRegistry } from '../../src/resource-plugins/builtins.ts';
import { attentionItems } from '../../src/graph/attention.ts';
import { layoutFootprints } from '../../src/graph/movement.ts';
import { hiddenPartner, isDrawn, isHidden } from '../../src/graph/archive.ts';
import { contextMenuActions } from './context-menu.ts';
import { projectActivity } from '../../src/graph/project-neighborhoods.ts';
import { humanOnlyMessage } from '../../src/resource-plugins/host.ts';

const registry = createResourcePluginRegistry();
async function setup() {
  const control = new WorkspaceControl(new MemoryStore(), registry);
  let state = await control.apply({ type: 'project.create', id: 'p', title: 'Platform', position: { x: 0, y: 0 } }, 0);
  state = await control.apply({ type: 'item.add', id: 'rollout', resourceId: 'rollout-r', pluginId: 'github.rollout', title: 'Deploy', projectId: 'p', position: { x: 0, y: 0 }, data: { owner: 'acme', repo: 'app', runId: 1 } } as any, state.revision);
  return { control, get state() { return state; }, async apply(command: unknown) { state = await control.apply(command as any, state.revision); return state; } };
}
const node = (state: { nodes: any[] }, id: string) => state.nodes.find(n => n.id === id);
const agent = (id: string, extra: object = {}) => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'agent.session', title: id, projectId: 'p', near: ['rollout'], data: { provider: 'claude', sessionId: `${id}-s` }, ...extra });

test('an item created hidden is kept with its label but is no obstacle, Needs me source or project activity', async () => {
  const f = await setup();
  let state = await f.apply(agent('validator', { hidden: { label: 'validation agent' } }));
  const hidden = node(state, 'validator');
  assert.match(hidden.hiddenAt, /^\d{4}-\d\d-\d\dT/); assert.equal(hidden.hideLabel, 'validation agent');
  assert.equal(isHidden(hidden), true); assert.equal(isDrawn(hidden, state.nodes), false); assert.equal(isDrawn(node(state, 'rollout'), state.nodes), true);
  assert.deepEqual(layoutFootprints(state.nodes, state.resources, registry).map(box => box.id).sort(), ['rollout']);
  state = await f.apply({ type: 'node.update', id: 'validator', activity: 'working', attention: 'input' });
  assert.deepEqual(attentionItems(state.nodes), []);
  assert.deepEqual(projectActivity('p', state.nodes as any), { working: 0, needsMe: 0, asking: 0, turn: 0, finished: 0 });
  // The next item takes the slot beside the rollout the hidden one would have held.
  state = await f.apply(agent('visible'));
  assert.deepEqual(node(state, 'visible').position, hidden.position);
});

test('Show places a hidden item beside the item named, keeps its links and label; Hide takes it off again', async () => {
  const f = await setup();
  await f.apply(agent('validator', { hidden: { label: 'validation agent' }, links: [{ otherId: 'rollout', kind: 'context', newItemIs: 'target', label: 'Validation' }] }));
  let state = await f.apply(agent('visible'));
  const taken = node(state, 'visible').position;
  state = await f.apply({ type: 'node.show', id: 'validator', near: ['rollout'] });
  const shown = node(state, 'validator');
  assert.equal(shown.hiddenAt, undefined); assert.equal(shown.hideLabel, 'validation agent');
  assert.notDeepEqual(shown.position, taken, 'it does not land on the item that took its place');
  assert.ok(Math.abs(shown.position.x - node(state, 'rollout').position.x) < 700 && Math.abs(shown.position.y - node(state, 'rollout').position.y) < 400, JSON.stringify(shown.position));
  assert.deepEqual(layoutFootprints(state.nodes, state.resources, registry).map(box => box.id).sort(), ['rollout', 'validator', 'visible']);
  assert.equal(state.links.filter(link => link.targetId === 'validator').length, 1);
  state = await f.apply({ type: 'node.show', id: 'validator', near: ['rollout'] });
  assert.deepEqual(node(state, 'validator').position, shown.position, 'showing a shown item changes nothing');
  state = await f.apply({ type: 'node.hide', id: 'validator' });
  const at = node(state, 'validator').hiddenAt;
  assert.match(at, /^\d{4}-/);
  state = await f.apply({ type: 'node.hide', id: 'validator' });
  assert.equal(node(state, 'validator').hiddenAt, at, 'hiding again keeps the time');
  await assert.rejects(f.apply({ type: 'node.hide', id: 'p' }), /Only items/);
});

test('Show brings an archived hidden item back from the archive', async () => {
  const f = await setup();
  await f.apply(agent('validator', { hidden: { label: 'validation agent' } }));
  await f.apply({ type: 'node.archive', id: 'validator' });
  const { state } = await f.control.dispatch({ commandId: 'show', expectedRevision: f.state.revision, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'node.show', id: 'validator', near: ['rollout'] }] as any });
  assert.equal(node(state, 'validator').archivedAt, undefined); assert.equal(node(state, 'validator').hiddenAt, undefined);
});

test('an item offers Show for a hidden item it links to, and Hide for itself when the host may hide it', () => {
  const labels = (visibility: { show?: string; hide?: string }) => contextMenuActions('item', false, undefined, [], undefined, undefined, undefined, false, undefined, undefined, undefined, [], {}, undefined, visibility).map(a => [a.id, a.label]);
  assert.deepEqual(labels({ show: 'validation agent' }).slice(0, 3), [['open', 'Open'], ['connect', 'Connect to…'], ['show-hidden', 'Show validation agent']]);
  assert.deepEqual(labels({ hide: 'validation agent' }).slice(-2), [['hide-item', 'Hide validation agent'], ['below', 'Send to Undermap']]);
  assert.deepEqual(labels({}), contextMenuActions('item').map(a => [a.id, a.label]));
  assert.ok(!contextMenuActions('project', false, undefined, [], undefined, undefined, undefined, false, undefined, undefined, undefined, [], {}, undefined, { hide: 'x' }).some(a => a.id === 'hide-item'));
});

test('Show names the most recently hidden labelled item linked either way, archived or not, but not one whose project is archived', () => {
  const item = (id: string, extra: object = {}) => ({ id, title: id, resourceId: `${id}-r`, position: { x: 0, y: 0 }, ...extra });
  const nodes = [item('rollout'), item('older', { hiddenAt: '2026-10-13T10:00:00.000Z', hideLabel: 'validation agent' }), item('newer', { hiddenAt: '2026-10-13T11:00:00.000Z', hideLabel: 'validation agent', archivedAt: '2026-10-13T12:00:00.000Z' }),
    item('unlabelled', { hiddenAt: '2026-10-13T13:00:00.000Z' }), item('shown', { hideLabel: 'validation agent' }), item('gone', { hiddenAt: '2026-10-13T14:00:00.000Z', hideLabel: 'x', projectId: 'old' }), { id: 'old', title: 'Old', position: { x: 0, y: 0 }, archivedAt: '2026-10-13T00:00:00.000Z' }];
  const link = (sourceId: string, targetId: string) => ({ id: `${sourceId}-${targetId}`, sourceId, targetId, kind: 'context' as const, label: '' });
  const links = [link('rollout', 'older'), link('newer', 'rollout'), link('rollout', 'unlabelled'), link('rollout', 'shown'), link('rollout', 'gone')];
  assert.equal(hiddenPartner(nodes, links, 'rollout')?.id, 'newer');
  assert.equal(hiddenPartner(nodes, links.slice(0, 1), 'rollout')?.id, 'older');
  assert.equal(hiddenPartner(nodes, links.slice(2), 'rollout'), undefined);
});

test('only a person hides, shows or creates a hidden item', () => {
  assert.equal(agentCommandRefusal({ type: 'node.hide', id: 'a' }), humanOnlyMessage);
  assert.equal(agentCommandRefusal({ type: 'node.show', id: 'a' }), humanOnlyMessage);
  assert.equal(agentCommandRefusal(agent('a', { hidden: { label: 'x' } }) as any), humanOnlyMessage);
  assert.equal(agentCommandRefusal(agent('a') as any), undefined);
});
