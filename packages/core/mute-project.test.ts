import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceControl, MemoryStore, agentCommandRefusal } from './control.ts';
import { createResourcePluginRegistry } from '../../src/resource-plugins/builtins.ts';
import { attentionItems } from '../../src/graph/attention.ts';
import { humanOnlyMessage } from '../../src/resource-plugins/host.ts';

const pr = (id: string, projectId: string | undefined, x: number, number = 1) => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'github.pull-request', title: id, data: { owner: 'acme', repo: 'app', number }, ...(projectId ? { projectId } : {}), position: { x, y: 0 } });
async function setup() {
  const control = new WorkspaceControl(new MemoryStore(), createResourcePluginRegistry());
  let state = await control.apply({ type: 'project.create', id: 'p', title: 'Billing', position: { x: 0, y: 0 } }, 0);
  for (const [id, x, n] of [['a', 0, 1], ['b', 400, 2]] as const) state = await control.apply(pr(id, 'p', x, n), state.revision);
  return { control, get state() { return state; }, async apply(command: unknown) { state = await control.apply(command as any, state.revision); return state; } };
}
const node = (state: { nodes: any[] }, id: string) => state.nodes.find(n => n.id === id);

test('muting stamps the project only: nothing is acknowledged, stopped or moved, and unmuting clears it', async () => {
  const f = await setup();
  await f.apply({ type: 'node.update', id: 'a', attention: 'input', activity: 'working' });
  const before = structuredClone(f.state.nodes.filter(n => n.id !== 'p'));
  let state = await f.apply({ type: 'project.mute', id: 'p', muted: true });
  assert.match(node(state, 'p').mutedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(state.nodes.filter(n => n.id !== 'p'), before, 'members are untouched');
  assert.equal(attentionItems(state.nodes).length, 1, 'the unread signal itself stays');
  const stamped = node(state, 'p').mutedAt;
  state = await f.apply({ type: 'project.mute', id: 'p', muted: true });
  assert.equal(node(state, 'p').mutedAt, stamped, 'muting again keeps the original time');
  state = await f.apply({ type: 'project.mute', id: 'p', muted: false });
  assert.equal(node(state, 'p').mutedAt, undefined);
  assert.deepEqual(state.nodes.filter(n => n.id !== 'p'), before);
});

test('only a project can be muted', async () => {
  const f = await setup();
  await assert.rejects(f.apply({ type: 'project.mute', id: 'a', muted: true }), /not a project/);
  await assert.rejects(f.apply({ type: 'project.mute', id: 'missing', muted: true }), /Node not found/);
});

test('the flag is kept through Undermap and Archive and back', async () => {
  const f = await setup();
  await f.apply({ type: 'project.mute', id: 'p', muted: true });
  let state = await f.apply({ type: 'node.below', id: 'p' });
  assert.ok(node(state, 'p').mutedAt);
  state = await f.apply({ type: 'node.surface', id: 'p' });
  assert.ok(node(state, 'p').mutedAt);
  state = await f.apply({ type: 'node.archive', id: 'p' });
  assert.ok(node(state, 'p').mutedAt);
  state = await f.apply({ type: 'node.restore', id: 'p' });
  assert.ok(node(state, 'p').mutedAt);
});

test('agents may read the flag but never mute or unmute', async () => {
  const f = await setup();
  assert.equal(agentCommandRefusal({ type: 'project.mute', id: 'p', muted: true }), humanOnlyMessage);
  assert.equal(agentCommandRefusal({ type: 'node.complete', id: 'a' }), undefined);
  const dispatch = (kind: 'agent' | 'user', muted: boolean) => f.control.dispatch({ commandId: crypto.randomUUID(), expectedRevision: f.state.revision, actor: { kind, id: 'x' }, commands: [{ type: 'project.mute', id: 'p', muted }] });
  await assert.rejects(dispatch('agent', true), new RegExp(humanOnlyMessage));
  const muted = (await dispatch('user', true)).state;
  assert.ok(node(muted, 'p').mutedAt);
  await assert.rejects(f.control.dispatch({ commandId: crypto.randomUUID(), expectedRevision: muted.revision, actor: { kind: 'agent', id: 'x' }, commands: [{ type: 'project.mute', id: 'p', muted: false }] }), new RegExp(humanOnlyMessage));
  assert.ok(node(await f.control.read(), 'p').mutedAt, 'a refused command changes nothing');
});
