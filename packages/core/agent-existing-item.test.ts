import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, WorkspaceControl, itemLinkId } from './control.ts';

const user = { kind: 'user', id: 'test' }, agent = { kind: 'agent', id: 'agent' }, host = { kind: 'provider', id: 'session' };
const ID = '00000000-0000-4000-8000-000000000042', URL = `https://claude.ai/code/artifact/${ID}`;
const session = (id: string, extra: Record<string, unknown> = {}) => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'agent.session', title: id, data: { sessionId: `session-${id}`, provider: 'claude' }, ...extra });
const artifact = (id: string, extra: Record<string, unknown> = {}) => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'claude.artifact', title: id, data: { url: URL, artifactId: ID }, ...extra });
const shown = (state: { nodes: { id: string; resourceId?: string }[] }) => state.nodes.filter(node => node.resourceId === 'host-r').map(node => node.id);
/** Project p holds the calling agent and the artifact card the host put beside it; project q is far away. */
async function seeded(hostCard: Record<string, unknown> = { projectId: 'p', position: { x: 0, y: 200 } }) {
  const control = new WorkspaceControl(new MemoryStore());
  await control.dispatch({ commandId: 'seed', expectedRevision: 0, actor: user, commands: [
    { type: 'project.create', id: 'p', title: 'p', position: { x: 0, y: 0 } }, { type: 'project.create', id: 'q', title: 'q', position: { x: 4000, y: 0 } },
    session('agent', { projectId: 'p', position: { x: 0, y: 0 } }), session('other', { projectId: 'q', position: { x: 4000, y: 0 } }),
  ] });
  const { state } = await control.dispatch({ commandId: 'published', expectedRevision: 1, actor: host, commands: [artifact('host', hostCard)] });
  return { control, state };
}

test('an agent adding an item its project already shows gets that node: no alias, its links land on it', async () => {
  const { control, state } = await seeded();
  const envelope = { commandId: 'mine', expectedRevision: state.revision, actor: agent, commands: [artifact('artifact-mine', { links: [{ otherId: 'agent', kind: 'reference', newItemIs: 'target' }] })] };
  const result = await control.dispatch(envelope);
  assert.deepEqual(shown(result.state), ['host']); assert.equal(result.state.resources.filter(resource => resource.pluginId === 'claude.artifact').length, 1);
  assert.deepEqual(result.state.links, [{ id: itemLinkId('host', { otherId: 'agent', kind: 'reference', newItemIs: 'target' }), sourceId: 'agent', targetId: 'host', kind: 'reference', label: '' }]);
  assert.deepEqual(result.state.nodes.find(node => node.id === 'host')!.position, state.nodes.find(node => node.id === 'host')!.position);
  assert.deepEqual(result.alreadyOnMap, [{ requestedId: 'artifact-mine', nodeId: 'host' }]);
  const replay = await control.dispatch(envelope);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.state, result.state); assert.deepEqual(replay.alreadyOnMap, result.alreadyOnMap);
  const again = await control.dispatch({ ...envelope, commandId: 'again', expectedRevision: result.state.revision });
  assert.deepEqual(shown(again.state), ['host']); assert.equal(again.state.links.length, 1, 'the relationship it already has is kept');
});

test('item.create follows the same rule, and floating counts as one place', async () => {
  const { control, state } = await seeded({ position: { x: -3000, y: -3000 } });
  const floating = (await control.dispatch({ commandId: 'float', expectedRevision: state.revision, actor: user, commands: [session('loose', { position: { x: -3000, y: -3300 } })] })).state;
  const result = await control.dispatch({ commandId: 'mine', expectedRevision: floating.revision, actor: { kind: 'agent', id: 'loose' }, commands: [
    { type: 'item.create', id: 'artifact-mine', resource: { id: 'mine-r', pluginId: 'claude.artifact', schemaVersion: 2, title: 'Mine', data: { url: `${URL}?v=2`, artifactId: ID } } }] });
  assert.deepEqual(shown(result.state), ['host']); assert.deepEqual(result.alreadyOnMap, [{ requestedId: 'artifact-mine', nodeId: 'host' }]);
});

test('later commands of the batch reach the existing node under the id the agent asked for', async () => {
  const { control, state } = await seeded();
  const result = await control.dispatch({ commandId: 'batch', expectedRevision: state.revision, actor: agent, commands: [
    artifact('artifact-mine'),
    { type: 'link.save', link: { id: 'explains', sourceId: 'artifact-mine', targetId: 'agent', kind: 'reference' } },
    session('helper', { links: [{ otherId: 'artifact-mine', kind: 'reference' }] }),
    { type: 'node.update', id: 'artifact-mine', summary: 'Billing flow overview' },
  ] });
  assert.deepEqual(shown(result.state), ['host']);
  assert.deepEqual(result.state.links.map(link => [link.sourceId, link.targetId]), [['host', 'agent'], ['helper', 'host']]);
  assert.equal(result.state.nodes.find(node => node.id === 'host')!.summary, 'Billing flow overview');
  assert.deepEqual(result.alreadyOnMap, [{ requestedId: 'artifact-mine', nodeId: 'host' }]);
});

test('another project, an archived node and a node in Undermap still get a new node', async () => {
  const elsewhere = await seeded();
  const aliased = await elsewhere.control.dispatch({ commandId: 'mine', expectedRevision: elsewhere.state.revision, actor: { kind: 'agent', id: 'other' }, commands: [artifact('artifact-mine')] });
  assert.deepEqual(shown(aliased.state), ['host', 'artifact-mine']); assert.equal(aliased.state.nodes.at(-1)!.projectId, 'q'); assert.equal(aliased.alreadyOnMap, undefined);
  const named = await elsewhere.control.dispatch({ commandId: 'named', expectedRevision: aliased.state.revision, actor: agent, commands: [artifact('artifact-named', { projectId: 'q' })] });
  assert.deepEqual(shown(named.state), ['host', 'artifact-mine'], 'the named project already shows it');
  assert.deepEqual(named.alreadyOnMap, [{ requestedId: 'artifact-named', nodeId: 'artifact-mine' }]);
  for (const away of ['node.archive', 'node.below']) {
    const { control, state } = await seeded();
    const hidden = (await control.dispatch({ commandId: 'away', expectedRevision: state.revision, actor: user, commands: [{ type: away, id: 'host' }] })).state;
    const result = await control.dispatch({ commandId: 'mine', expectedRevision: hidden.revision, actor: agent, commands: [artifact('artifact-mine')] });
    assert.deepEqual(shown(result.state), ['host', 'artifact-mine'], away); assert.equal(result.alreadyOnMap, undefined, away);
  }
});

test('people and providers still create an alias in the same project', async () => {
  for (const actor of [user, host]) {
    const { control, state } = await seeded();
    const result = await control.dispatch({ commandId: 'alias', expectedRevision: state.revision, actor, commands: [artifact('alias', { projectId: 'p', position: { x: 900, y: 0 } })] });
    assert.deepEqual(shown(result.state), ['host', 'alias'], actor.kind); assert.equal(result.alreadyOnMap, undefined);
  }
});
