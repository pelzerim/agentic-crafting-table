import test from 'node:test';
import assert from 'node:assert/strict';
import { clampItemViewPosition, clampItemViewSize, expandedItemBounds, itemViewProfile, itemViewProfiles } from './item-views.ts';
import { presentResource } from '../../src/resource-plugins/views.ts';
import { settingsSchema } from './settings.ts';
import { createResourcePluginRegistry } from '../../src/resource-plugins/builtins.ts';
import { registryFromDescriptions } from '../../src/resource-plugins/describe.client.ts';

const registry = registryFromDescriptions(createResourcePluginRegistry().describe());
test('item expansion and provider subgroups survive plugin discovery without map branches', () => {
  const agent = registry.get('agent.session')!;
  assert.deepEqual(itemViewProfiles(agent).map(p => [p.key, p.name]), [['agent.session:claude', 'Claude'], ['agent.session:codex', 'Codex']]);
  assert.equal(itemViewProfile(agent, { id: 'a', pluginId: agent.id, schemaVersion: 1, title: 'Agent', data: { provider: 'codex' } }).key, 'agent.session:codex');
  assert.equal(itemViewProfiles(registry.get('workspace.todo')!)[0].mode, 'inline');
  assert.equal(itemViewProfiles(registry.get('workspace.note')!)[0].mode, 'inline', 'notes are written on the map and have no full view');
  assert.equal(itemViewProfiles({ id: 'custom.new', name: 'New', view: { mode: 'card', width: 480, height: 300 } })[0].width, 480);
});
test('older settings keep launch preferences and default sizes; invalid overrides are rejected', () => {
  const old = settingsSchema.parse({ claude: { remoteControl: false, arguments: ['--verbose'] } });
  assert.deepEqual(old.itemViews, {}); assert.deepEqual(old.claude, { remoteControl: false, autoMode: true, arguments: ['--verbose'] });
  const itemViews = { 'agent.session:codex': { width: 960, height: 640 }, 'missing.plugin': { width: 700, height: 400 } };
  assert.deepEqual(settingsSchema.parse({ ...old, itemViews }).itemViews, itemViews);
  for (const size of [{ width: -1, height: 300 }, { width: 800, height: Infinity }, { width: 10000, height: 500 }, { width: 500.5, height: 400 }]) {
    assert.equal(settingsSchema.safeParse({ itemViews: { note: size } }).success, false);
  }
});
test('expanded projections leave map margins, keep small cards near their anchor and clamp without mutating inputs', () => {
  const note = itemViewProfiles({ id: 'custom.card', name: 'Card', view: { mode: 'card', width: 520, height: 360 } })[0], agent = itemViewProfiles(registry.get('agent.session')!)[0];
  const canvas = { width: 1400, height: 1000 }, anchor = { x: 800, y: 500 };
  assert.deepEqual(expandedItemBounds(note, {}, canvas, anchor), { ...anchor, width: 520, height: 360 });
  const big = expandedItemBounds(agent, {}, canvas, anchor);
  assert.equal(big.width, 1280); assert.equal(big.height, 800); assert.ok(big.x - big.width / 2 >= 64);
  for (const profile of [note, agent]) for (const point of [{ x: -900, y: -800 }, { x: 9999, y: 9999 }]) {
    const bounds = expandedItemBounds(profile, { [profile.key]: { width: 2560, height: 1600 } }, { width: 900, height: 640 }, point);
    assert.ok(bounds.x - bounds.width / 2 >= 64); assert.ok(bounds.x + bounds.width / 2 <= 860);
    assert.ok(bounds.y - bounds.height / 2 >= 72); assert.ok(bounds.y + bounds.height / 2 <= 584);
  }
  assert.deepEqual(anchor, { x: 800, y: 500 });
});

test('floating view positions clamp independently of graph coordinates and fit a resized window', () => {
  const saved = { x: 700, y: 400 }, view = { width: 520, height: 360 };
  assert.deepEqual(clampItemViewPosition(saved, view, { width: 1400, height: 1000 }), saved);
  assert.deepEqual(clampItemViewPosition(saved, view, { width: 900, height: 640 }), { x: 368, y: 268 });
  assert.deepEqual(clampItemViewPosition({ x: -100, y: -100 }, view, { width: 900, height: 640 }), { x: 12, y: 12 });
  assert.deepEqual(saved, { x: 700, y: 400 });
});

test('individual view sizing respects the fixed corner, usable minimums and card policy without changing preferences', () => {
  const desired = { width: 920, height: 600 }, canvas = { width: 1280, height: 800 };
  assert.deepEqual(clampItemViewSize(desired, { mode: 'focus' }, canvas, { x: 500, y: 320 }), { width: 768, height: 468 });
  assert.deepEqual(clampItemViewSize({ width: 1, height: 1 }, { mode: 'focus' }, canvas), { width: 480, height: 280 });
  assert.deepEqual(clampItemViewSize({ width: 1, height: 1 }, { mode: 'card' }, canvas), { width: 320, height: 240 });
  assert.deepEqual(clampItemViewSize(desired, { mode: 'card' }, { width: 900, height: 640 }), { width: 675, height: 480 });
  assert.deepEqual(clampItemViewSize(desired, { mode: 'focus' }, { width: 280, height: 200 }), { width: 256, height: 176 });
  assert.deepEqual(clampItemViewSize(desired, { mode: 'focus' }, canvas), desired);
  assert.deepEqual(desired, { width: 920, height: 600 });
});

test('PR frame identity and desk dimensions survive plugin discovery without replacing the map title', () => {
  const item = presentResource(registry, { id: 'pr', pluginId: 'github.pull-request', schemaVersion: 1, title: 'Plan changes', data: { owner: 'fixture', repo: 'billing', number: 42 } });
  assert.equal(item.frameTitle, 'fixture/billing #42'); assert.equal(item.title, 'Plan changes');
  assert.equal(item.view.width, 1040); assert.equal(item.view.height, 720);
});

test('a plugin minimum width holds against resizing, saved sizes and settings unless the window is narrower', () => {
  const [profile] = itemViewProfiles({ id: 'code.review', name: 'Code review', view: { width: 1040, height: 720, minWidth: 750 } });
  assert.equal(profile.minWidth, 750);
  const canvas = { width: 1400, height: 900 };
  assert.deepEqual(clampItemViewSize({ width: 500, height: 600 }, profile, canvas), { width: 750, height: 600 });
  assert.equal(expandedItemBounds(profile, { 'code.review': { width: 600, height: 700 } }, canvas, { x: 0, y: 0 }).width, 750);
  assert.equal(clampItemViewSize({ width: 500, height: 600 }, profile, { width: 700, height: 900 }).width, 676, 'the window still wins');
});
