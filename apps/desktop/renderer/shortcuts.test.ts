import { test } from 'node:test';
import { RAIL_SLOTS, railKey } from './rail-slots.ts';
import { STANDUP_ENABLED } from '../../../packages/core/standup.ts';
import assert from 'node:assert/strict';
import { matchWorkspaceShortcut, shortcutGroups, shortcutKey, WORKSPACE_SHORTCUTS } from './shortcuts.ts';
import { viewSchema } from '../../../packages/core/control.ts';

const key = { key: 't', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, defaultPrevented: false };
test('workspace shortcut matching respects modifiers, consumed keys, repeats and composition', () => {
  assert.equal(matchWorkspaceShortcut(key), 'todos.toggle');
  assert.equal(matchWorkspaceShortcut({ ...key, key: 'T' }), 'todos.toggle');
  assert.equal(matchWorkspaceShortcut({ ...key, key: 'M' }), 'map.overview');
  assert.equal(matchWorkspaceShortcut({ ...key, key: 'x' }), undefined);
  for (const flag of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'repeat', 'isComposing', 'defaultPrevented']) assert.equal(matchWorkspaceShortcut({ ...key, [flag]: true }), undefined);
  assert.equal(new Set(WORKSPACE_SHORTCUTS.map(binding => binding.id)).size, WORKSPACE_SHORTCUTS.length);
});

test('the keyboard layer covers hotbar slots, Needs me, Undermap, Settings, zoom and the controls card', () => {
  const press = (value: string, shiftKey = false) => matchWorkspaceShortcut({ ...key, key: value, shiftKey });
  assert.deepEqual(['1', '2', '3', '4', '5', '6', '7'].map(value => press(value)), ['rail.attention', 'rail.todos', 'rail.reminders', 'rail.inbox', 'rail.undermap', STANDUP_ENABLED ? 'rail.actions' : undefined, 'rail.settings'], 'the Actions key stays reserved while the standup report is disabled');
  assert.deepEqual(RAIL_SLOTS.map(slot => [press(railKey(slot)), shortcutKey(`rail.${slot}`)]), RAIL_SLOTS.map(slot => [`rail.${slot}`, railKey(slot)]), 'every rail slot takes the number of its position');
  assert.equal(press('8'), undefined, 'numbers past the rail do nothing');
  assert.equal(press('n'), 'attention.toggle'); assert.equal(press('u'), 'layer.toggle'); assert.equal(press('/'), 'undermap.search'); assert.equal(press(','), 'settings.open');
  assert.equal(press('+', true), 'map.zoomIn', 'layouts that need Shift for + still zoom');
  assert.equal(press('='), 'map.zoomIn'); assert.equal(press('-'), 'map.zoomOut'); assert.equal(press('0'), 'map.zoomReset');
  assert.equal(press('?', true), 'shortcuts.help');
  assert.equal(press('['), 'rollout.jobsRail'); assert.equal(shortcutKey('rollout.jobsRail'), '[');
  assert.equal(press('N', true), undefined, 'Shift still changes letters');
  assert.equal(matchWorkspaceShortcut({ ...key, key: ',', metaKey: true }), undefined, 'Cmd+, stays with the app menu');
  assert.equal(press('m'), 'map.overview'); assert.equal(press('M', true), 'project.mute', 'Shift+M is its own gesture, not the overview');
  assert.equal(shortcutKey('project.mute'), '⇧M');
  const keys = WORKSPACE_SHORTCUTS.flatMap(binding => [binding.key, ...('aliases' in binding ? binding.aliases : [])].map(value => `${'shift' in binding && binding.shift ? 'shift+' : ''}${value}`));
  assert.equal(new Set(keys).size, keys.length, 'one action per gesture');
});

test('key labels and the controls card come from the registry', () => {
  assert.equal(shortcutKey('todos.toggle'), 'T'); assert.equal(shortcutKey('rail.inbox'), '4'); assert.equal(shortcutKey('sheet.close'), 'esc');
  const groups = shortcutGroups();
  assert.deepEqual(groups.map(group => group.group), ['Hotbar', 'Map', 'Views', 'App', 'Sheets']);
  assert.equal(groups.flatMap(group => group.rows).length, WORKSPACE_SHORTCUTS.length);
  assert.deepEqual(groups[0].rows.slice(0, RAIL_SLOTS.length).map(row => [row.label, row.key]), [['Needs me', '1'], ['To-dos', '2'], ['Reminders', '3'], ['GitHub inbox', '4'], ['Undermap', '5'], ...(STANDUP_ENABLED ? [['Actions', '6']] : []), ['Settings', '7']]);
});

test('auto-hide is additive to saved view preferences without rewriting older values', () => {
  const old = { x: 20, y: 100, draft: 'Keep my draft', scrollTop: 40 };
  assert.deepEqual(viewSchema.parse({ todoOverlay: old }).todoOverlay, old);
  assert.deepEqual(viewSchema.parse({ todoOverlay: { ...old, autoHide: false } }).todoOverlay, { ...old, autoHide: false });
  assert.throws(() => viewSchema.parse({ todoOverlay: { ...old, autoHide: 'no' } }));
  assert.deepEqual(viewSchema.parse({ remindersPanel: { width: 400, height: 300 } }).remindersPanel, { width: 400, height: 300 }, 'the reminders sheet remembers its size like the other sheets');
});
