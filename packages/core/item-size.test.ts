import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, stateSchema, commandSchema, MemoryStore, WorkspaceControl } from './control.ts';
import { createResourcePluginRegistry } from '../../src/resource-plugins/builtins.ts';
import { itemFootprint } from '../../src/graph/footprints.ts';
import { ITEM_GAP, layoutFootprints } from '../../src/graph/movement.ts';
import { mapSizeProfile, resolveMapSize, itemMapSizesSchema, validateMapSettings, sizeAsDefault } from './item-map-sizes.ts';
import { overlaps } from '../../src/graph/spatial.ts';
import { registryWithSinglePartner, singlePartner } from '../../tests/fixtures/single-partner.ts';

const registry = createResourcePluginRegistry();
function fixture() {
  return stateSchema.parse({ ...emptyState(), nodes: [
    { id: 'p', title: 'Project', position: { x: 0, y: 0 } },
    { id: 'note', resourceId: 'r', projectId: 'p', title: 'Note', position: { x: 0, y: 0 }, summary: 'Saved summary', activity: 'working', attention: 'input' },
    { id: 'alias', resourceId: 'r', projectId: 'p', title: 'Alias', position: { x: 180, y: 0 } },
  ], resources: [{ id: 'r', pluginId: 'workspace.note', schemaVersion: 1, title: 'Note', data: { text: 'Saved content' } }],
  view: { camera: { x: 10, y: 20, zoom: .8 } } });
}

test('map sizes are additive, validated and independent of plugin defaults and resource availability', () => {
  const state = fixture(), node = state.nodes[1];
  assert.equal(node.mapSize, undefined);
  assert.equal(itemFootprint(node, state.resources, registry).height, 88);
  for (const size of ['small', 'medium', 'large'] as const) {
    const changed = { ...node, mapSize: size };
    const box = itemFootprint(changed, state.resources, registry);
    assert.deepEqual({ width: box.width, height: box.height }, { width: registry.get('workspace.note')!.mapSizes!.sizes[size]!.width, height: registry.get('workspace.note')!.mapSizes!.sizes[size]!.height });
    // An unavailable plugin keeps stored intent and uses its fallback tier.
    const missing = [{ ...state.resources[0], pluginId: 'missing.plugin' }];
    assert.equal(itemFootprint(changed, missing, registry).width, 150);
    assert.equal(changed.mapSize, size);
  }
  assert.equal(commandSchema.safeParse({ type: 'node.resize', id: 'note', size: 'huge' }).success, false);
  assert.equal(stateSchema.safeParse({ ...state, nodes: [{ ...node, mapSize: 240 }] }).success, false);
});

test('resizing atomically makes room, keeps the selected center and never mutates a resource, alias size or camera', async () => {
  const before = fixture(), control = new WorkspaceControl(new MemoryStore(before));
  const input = { commandId: 'grow', expectedRevision: 0, actor: { kind: 'agent', id: 'test' }, commands: [{ type: 'node.resize', id: 'note', size: 'large' }] };
  const { state } = await control.dispatch(input);
  assert.deepEqual(state.nodes[1], { ...before.nodes[1], mapSize: 'large' });
  assert.equal(state.nodes[2].mapSize, undefined);
  assert.notDeepEqual(state.nodes[2].position, before.nodes[2].position);
  assert.deepEqual(state.resources, before.resources); assert.deepEqual(state.view, before.view);
  const boxes = layoutFootprints(state.nodes, state.resources, registry);
  assert.equal(overlaps(boxes[0], boxes[1], ITEM_GAP), false);
  assert.equal((await control.dispatch(input)).replayed, true);
  const shrunk = await control.apply({ type: 'node.resize', id: 'note', size: 'small' }, state.revision);
  assert.deepEqual(shrunk.nodes.map(n => n.position), state.nodes.map(n => n.position));
  await assert.rejects(control.dispatch({ ...input, commandId: 'bad', expectedRevision: shrunk.revision, commands: [...input.commands, { type: 'node.resize', id: 'p', size: 'large' }] }), /Only resource/);
  assert.deepEqual(await control.read(), shrunk);
});

test('completed and archived items retain size choices without changing visibility or repairing hidden layouts', async () => {
  const control = new WorkspaceControl(new MemoryStore(fixture()));
  let state = await control.apply({ type: 'node.complete', id: 'note' }, 0);
  state = await control.apply({ type: 'node.resize', id: 'note', size: 'large' }, state.revision);
  assert.equal(itemFootprint(state.nodes[1], state.resources, registry).width, 300, 'done keeps its chosen size');
  assert.ok(state.nodes[1].completedAt);
  const placed = state.nodes.map(n => n.position);
  state = await control.apply({ type: 'node.archive', id: 'p' }, state.revision);
  state = await control.apply({ type: 'node.resize', id: 'alias', size: 'large' }, state.revision);
  assert.deepEqual(state.nodes.map(n => n.position), placed);
  state = await control.apply({ type: 'node.restore', id: 'p' }, state.revision);
  state = await control.apply({ type: 'node.reopen', id: 'note' }, state.revision);
  const boxes = layoutFootprints(state.nodes, state.resources, registry);
  assert.equal(boxes[0].width, 300); assert.equal(boxes[1].width, 300);
  assert.equal(overlaps(boxes[0], boxes[1], ITEM_GAP), false);
});


test('every builtin preserves its native default footprint and restricted types reject unsupported commands', async () => {
  for (const plugin of registry.list()) {
    const profile = mapSizeProfile(plugin), preset = profile.sizes[profile.defaultSize]!;
    const tier = plugin.appearance?.size ?? 'small';
    assert.equal(preset.width, plugin.appearance?.width ?? ({ icon: 48, tiny: 144, small: 150, medium: 200, large: 240 }[tier]), plugin.id);
    assert.equal(preset.height, plugin.id === 'linear.ticket' ? 64 : plugin.id === 'workspace.note' ? 88 : { icon: 48, tiny: 32, small: 48, medium: 84, large: 112 }[tier], plugin.id);
  }
  const control = new WorkspaceControl();
  await control.apply({ type: 'item.add', id: 'todo', resourceId: 'todo-r', pluginId: 'workspace.todo', title: 'Task', data: {}, position: { x: 100, y: 100 } }, 0);
  for (const size of ['medium', 'large']) await assert.rejects(control.apply({ type: 'node.resize', id: 'todo', size }, 1), /does not support/);
  const state = await control.read(), target = state.nodes[0];
  target.mapSize = 'large';
  assert.equal(resolveMapSize(target, state.resources[0], registry.get('workspace.todo')).size, 'small');
  assert.deepEqual(itemFootprint(target, state.resources, registry), { id: 'todo', x: 100, y: 100, width: 220, height: 48 });
  assert.equal(target.mapSize, 'large'); // Compatibility is non-destructive.
  assert.deepEqual(Object.keys(mapSizeProfile(registry.get('workspace.todo')).sizes), ['small']);
  assert.deepEqual(Object.keys(mapSizeProfile(singlePartner).sizes), ['small', 'medium', 'large']);
});

test('profile settings distinguish agent variants, respect native tiers and validate readable dimensions', () => {
  assert.deepEqual(itemMapSizesSchema.parse(undefined), {});
  const config = itemMapSizesSchema.parse({ 'agent.session:claude': { defaultSize: 'medium', sizes: { medium: { width: 320, height: 100 } } } });
  validateMapSettings(config, registry.list());
  const resource = { id: 'a', pluginId: 'agent.session', schemaVersion: 1, title: 'Agent', data: { provider: 'claude' } };
  const claude = resolveMapSize({}, resource, registry.get(resource.pluginId), config);
  assert.equal(claude.size, 'medium'); assert.equal(claude.width, 320);
  assert.equal(resolveMapSize({}, { ...resource, data: { provider: 'codex' } }, registry.get(resource.pluginId), config).width, 240);
  assert.equal(resolveMapSize({ mapSize: 'small' }, resource, registry.get(resource.pluginId), config).width, 180);
  assert.throws(() => validateMapSettings({ 'workspace.todo': { defaultSize: 'large', sizes: {} } }, registry.list()), /does not support/);
  assert.throws(() => validateMapSettings({ 'workspace.note': { sizes: { medium: { width: 220, height: 25 } } } }, registry.list()), /needs width/);
  assert.equal(itemMapSizesSchema.safeParse({ x: { sizes: { small: { width: Infinity, height: 48 } } } }).success, false);
});

test('continuous dimensions persist per alias, select fitting detail and preserve legacy presets', async () => {
  const control = new WorkspaceControl(new MemoryStore(fixture()));
  const before = await control.read();
  const input = { commandId: 'pointer-size', expectedRevision: before.revision, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'node.resize', id: 'note', dimensions: { width: 310, height: 180 }, position: { x: 150, y: 160 } }] };
  const { state } = await control.dispatch(input), note = state.nodes.find(node => node.id === 'note')!;
  assert.deepEqual(note.mapDimensions, { width: 310, height: 180 });
  assert.deepEqual(note.position, { x: 150, y: 160 });
  assert.equal(state.nodes.find(node => node.id === 'alias')!.mapDimensions, undefined);
  assert.equal(resolveMapSize(note, state.resources[0], registry.get('workspace.note')).size, 'large');
  for (const key of ['resources', 'links', 'todos', 'view'] as const) assert.deepEqual(state[key], before[key]);
  const boxes = layoutFootprints(state.nodes, state.resources, registry);
  for (const a of boxes) for (const b of boxes) if (a.id !== b.id) assert.equal(overlaps(a, b, ITEM_GAP), false);
  assert.equal((await control.dispatch(input)).replayed, true);
  await assert.rejects(control.apply({ type: 'node.resize', id: 'note', dimensions: { width: 10, height: 40 } }, state.revision));
  await assert.rejects(control.apply({ type: 'node.resize', id: 'note', size: 'large', dimensions: { width: 300, height: 160 } }, state.revision));
  await assert.rejects(control.apply({ type: 'node.resize', id: 'note', dimensions: { width: 300, height: 160 } }, before.revision));
  assert.deepEqual(await control.read(), state);
  const restored = await control.apply({ type: 'node.resize', id: 'note', size: 'small' }, state.revision);
  assert.equal(restored.nodes.find(node => node.id === 'note')!.mapDimensions, undefined);
  assert.equal(itemFootprint(restored.nodes.find(node => node.id === 'note')!, restored.resources, registry).width, 160);
});

test('pointer dimensions keep to-dos single-tier and let small badges stay compact', async () => {
  const devices = registryWithSinglePartner(), control = new WorkspaceControl(undefined, devices);
  for (const [id, pluginId, data] of [['todo', 'workspace.todo', {}], ['box', singlePartner.id, { deviceId: 'local-device' }]] as const) {
    await control.apply({ type: 'item.add', id, resourceId: `${id}-r`, pluginId, title: id, data, position: { x: id === 'todo' ? 0 : 500, y: 0 } }, (await control.read()).revision);
    const before = await control.read();
    if (id === 'todo') {
      await assert.rejects(control.apply({ type: 'node.resize', id, dimensions: { width: 300, height: 300 } }, before.revision), /Item size/);
      assert.deepEqual(await control.read(), before);
    }
    const dimensions = id === 'todo' ? { width: 340, height: 60 } : { width: 64, height: 64 };
    const state = await control.apply({ type: 'node.resize', id, dimensions }, before.revision);
    const node = state.nodes.find(node => node.id === id)!, record = state.resources.find(resource => resource.id === node.resourceId)!;
    const presentation = resolveMapSize(node, record, devices.get(pluginId));
    assert.equal(presentation.size, 'small'); assert.equal(presentation.summaryLines, 0);
  }
});

test('taller Linear default preserves previously saved compact dimensions and settings', () => {
  const plugin = registry.get('linear.ticket')!, resource = { id: 'ticket', pluginId: plugin.id, schemaVersion: 1, title: 'Ticket', data: {} };
  assert.equal(resolveMapSize({}, resource, plugin).height, 64);
  const manual = resolveMapSize({ mapDimensions: { width: 140, height: 48 } }, resource, plugin);
  assert.equal(manual.width, 140); assert.equal(manual.height, 48);
  const settings = { 'linear.ticket': { sizes: { small: { width: 240, height: 48 } } } };
  validateMapSettings(settings, [plugin]);
  assert.equal(resolveMapSize({}, resource, plugin, settings).height, 48);
});

function agents(extra: Record<string, object> = {}) {
  const agent = (id: string, provider: string, size: object = {}) => ({ node: { id, resourceId: `${id}-r`, title: id, position: { x: 0, y: 0 }, ...size }, resource: { id: `${id}-r`, pluginId: 'agent.session', schemaVersion: 1, title: id, data: { provider } } });
  const all = [agent('picked', 'claude', extra.picked), agent('plain', 'claude'), agent('medium', 'claude', { mapSize: 'medium' }), agent('large', 'claude', { mapSize: 'large' }), agent('resized', 'claude', { mapDimensions: { width: 300, height: 150 } }), agent('codex', 'codex')];
  const state = stateSchema.parse({ ...emptyState(), nodes: all.map(entry => entry.node), resources: all.map(entry => entry.resource) });
  const sizes = (nodes: typeof state.nodes, settings: Parameters<typeof resolveMapSize>[3]) => Object.fromEntries(nodes.map(node => { const size = resolveMapSize(node, state.resources.find(resource => resource.id === node.resourceId)!, registry.get('agent.session'), settings); return [node.id, `${size.width}x${size.height}`]; }));
  return { state, sizes };
}
const pinned = <T extends { id: string }>(nodes: T[], pins: NonNullable<ReturnType<typeof sizeAsDefault>>['pins']) => nodes.map(node => {
  const pin = pins.find(pin => pin.id === node.id);
  return pin ? pin.dimensions ? { ...node, mapDimensions: pin.dimensions } : { ...node, mapSize: pin.size } : node;
});

test('Use size as default has nothing to change for an item at its type default without dimensions', () => {
  const { state } = agents();
  assert.deepEqual(sizeAsDefault(state.nodes[0], state.nodes, state.resources, registry), { disabled: 'Already the default size for Claude', itemMapSizes: {}, pins: [] });
  const saved = { 'agent.session:claude': { defaultSize: 'small' as const, sizes: {} } };
  assert.equal(sizeAsDefault({ ...state.nodes[0], mapSize: 'small' }, state.nodes, state.resources, registry, saved)?.disabled, 'Already the default size for Claude');
  assert.equal(sizeAsDefault(state.nodes[0], state.nodes, state.resources, registry, saved)?.disabled, 'Already the default size for Claude', 'an item without a tier follows the default');
  assert.equal(sizeAsDefault({ ...state.nodes[0], mapSize: 'large' }, state.nodes, state.resources, registry, saved)?.disabled, undefined);
  assert.equal(sizeAsDefault({ ...state.nodes[0], mapDimensions: { width: 240, height: 112 } }, state.nodes, state.resources, registry)?.disabled, undefined, 'custom dimensions always count');
  assert.equal(sizeAsDefault({ id: 'project' }, state.nodes, state.resources, registry), undefined);
});

test('Use size as default makes the item tier the type default and leaves every existing item at its size', () => {
  const { state, sizes } = agents({ picked: { mapSize: 'small' } }), before = sizes(state.nodes, {});
  const saved = { 'workspace.note': { defaultSize: 'large' as const, sizes: {} }, 'agent.session:claude': { sizes: { medium: { width: 230, height: 90 } } } };
  const result = sizeAsDefault(state.nodes[0], state.nodes, state.resources, registry, saved)!;
  assert.deepEqual(result.itemMapSizes, { ...saved, 'agent.session:claude': { defaultSize: 'small', sizes: { medium: { width: 230, height: 90 } } } });
  assert.deepEqual(result.pins, [{ id: 'plain', size: 'large' }], 'only the item that followed the old default is pinned to it');
  validateMapSettings(result.itemMapSizes, registry.list());
  assert.deepEqual(sizes(pinned(state.nodes, result.pins), result.itemMapSizes), sizes(state.nodes, saved));
  assert.equal(before.plain, '240x112');
  const fresh = resolveMapSize({}, state.resources[0], registry.get('agent.session'), result.itemMapSizes);
  assert.deepEqual([fresh.size, fresh.width, fresh.height], ['small', 180, 48], 'the next Claude item arrives small');
  assert.equal(resolveMapSize({}, state.resources.at(-1)!, registry.get('agent.session'), result.itemMapSizes).size, 'large', 'Codex is another type');
  assert.deepEqual(saved['agent.session:claude'], { sizes: { medium: { width: 230, height: 90 } } }, 'the given settings are not changed');
});

test('Use size as default saves a hand-resized item as its tier dimensions', () => {
  const { state, sizes } = agents({ picked: { mapDimensions: { width: 365, height: 177 } } });
  const result = sizeAsDefault(state.nodes[0], state.nodes, state.resources, registry)!;
  assert.deepEqual(result.itemMapSizes, { 'agent.session:claude': { defaultSize: 'large', sizes: { large: { width: 365, height: 177 } } } });
  assert.deepEqual(result.pins, [{ id: 'plain', dimensions: { width: 240, height: 112 } }, { id: 'large', dimensions: { width: 240, height: 112 } }]);
  validateMapSettings(result.itemMapSizes, registry.list());
  assert.deepEqual(sizes(pinned(state.nodes, result.pins), result.itemMapSizes), sizes(state.nodes, {}));
  const fresh = resolveMapSize({}, state.resources[0], registry.get('agent.session'), result.itemMapSizes);
  assert.deepEqual([fresh.size, fresh.width, fresh.height], ['large', 365, 177]);
  assert.equal(sizeAsDefault(state.nodes[0], state.nodes, state.resources, registry, result.itemMapSizes)?.disabled, undefined);

  const narrow = agents({ picked: { mapDimensions: { width: 200, height: 200 } } });
  const small = sizeAsDefault(narrow.state.nodes[0], narrow.state.nodes, narrow.state.resources, registry)!;
  assert.deepEqual(small.itemMapSizes, { 'agent.session:claude': { defaultSize: 'small', sizes: { small: { width: 200, height: 72 } } } }, 'the widest tier that fits, within what Settings accepts for it');
  validateMapSettings(small.itemMapSizes, registry.list());
  assert.deepEqual(small.pins, [{ id: 'plain', size: 'large' }]);
  assert.deepEqual(narrow.sizes(pinned(narrow.state.nodes, small.pins), small.itemMapSizes), narrow.sizes(narrow.state.nodes, {}));
});

test('Use size as default keeps the text height of notes that are pinned to their width', () => {
  const note = (id: string, size: object = {}) => ({ id, resourceId: `${id}-r`, title: id, position: { x: 0, y: 0 }, ...size });
  const state = stateSchema.parse({ ...emptyState(), nodes: [note('picked', { mapDimensions: { width: 200, height: 88 } }), note('plain')],
    resources: ['picked', 'plain'].map(id => ({ id: `${id}-r`, pluginId: 'workspace.note', schemaVersion: 1, title: id, data: { text: 'One line\nTwo\nThree\nFour\nFive\nSix' } })) });
  const result = sizeAsDefault(state.nodes[0], state.nodes, state.resources, registry)!, plugin = registry.get('workspace.note');
  assert.deepEqual(result.itemMapSizes, { 'workspace.note': { defaultSize: 'small', sizes: { small: { width: 200, height: 88 } } } });
  assert.deepEqual(result.pins, [{ id: 'plain', dimensions: { width: 160, height: 88 } }]);
  const before = resolveMapSize(state.nodes[1], state.resources[1], plugin), after = resolveMapSize(pinned(state.nodes, result.pins)[1], state.resources[1], plugin, result.itemMapSizes);
  assert.deepEqual([after.width, after.height], [before.width, before.height]);
});
