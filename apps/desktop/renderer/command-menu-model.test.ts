import test from 'node:test';
import assert from 'node:assert/strict';
import type { GraphNode } from '../../../src/graph/graph.ts';
import { COMMAND_MENU_COMMANDS, commandMenuSections } from './command-menu-model.ts';
import { matchWorkspaceShortcut, shortcutKey } from './shortcuts.ts';

const key = { key: 'k', ctrlKey: false, metaKey: true, altKey: false, shiftKey: false, repeat: false, isComposing: false, defaultPrevented: false };
const project = (id: string, title: string): GraphNode => ({ id, title, position: { x: 0, y: 0 } });
const item = (id: string, title: string, projectId?: string): GraphNode => ({ id, title, resourceId: `${id}-r`, projectId, position: { x: 0, y: 0 } });
const nodes: GraphNode[] = [project('billing', 'Billing redesign'), item('plan', 'Plan switcher', 'billing'), item('invoice', 'Invoice emails', 'billing'), item('notes', 'Settings notes')];

test('Cmd+K opens the command menu, beside Cmd+F, which still only finds', () => {
  assert.equal(matchWorkspaceShortcut(key), 'command.menu');
  assert.equal(shortcutKey('command.menu'), '⌘K');
  assert.equal(matchWorkspaceShortcut({ ...key, key: 'f' }), 'map.find');
  assert.equal(matchWorkspaceShortcut({ ...key, metaKey: false }), undefined, 'plain K stays free');
});

test('with nothing typed the menu lists recently opened items, then every command', () => {
  const sections = commandMenuSections(nodes, ['invoice', 'plan', 'gone'], '');
  assert.deepEqual(sections.map(section => section.label), ['Recently opened', 'Commands']);
  assert.deepEqual(sections[0].rows.map(row => row.title), ['Invoice emails', 'Plan switcher']);
  assert.equal(sections[1].rows.length, COMMAND_MENU_COMMANDS.length);
});

test('typing finds items, projects and commands by every word, each in its own section', () => {
  const sections = commandMenuSections(nodes, [], 'settings');
  assert.deepEqual(sections.map(section => section.label), ['Items', 'Commands']);
  assert.deepEqual(sections[0].rows.map(row => row.id), ['item:notes']);
  assert.ok(sections[1].rows.some(row => row.title === 'Open Settings' && row.hint === ','), 'a command shows its key');
  const billing = commandMenuSections(nodes, [], 'billing');
  assert.deepEqual(billing.map(section => section.label), ['Items', 'Projects']);
  assert.deepEqual(billing[1].rows, [{ id: 'project:billing', kind: 'project', target: 'billing', title: 'Billing redesign', detail: 'Project' }]);
  assert.deepEqual(commandMenuSections(nodes, [], 'zzzz'), []);
});

test('the menu never lists itself, keys that only work inside a view, or a command twice', () => {
  const ids = COMMAND_MENU_COMMANDS.map(command => command.id);
  assert.ok(!ids.includes('shortcut:command.menu'));
  assert.ok(!ids.some(id => ['shortcut:view.closeSeen', 'shortcut:terminal.find', 'shortcut:sheet.close', 'shortcut:rollout.jobsRail'].includes(id)));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(COMMAND_MENU_COMMANDS.map(command => command.title)).size, ids.length);
  assert.ok(ids.includes('action:new-item') && ids.includes('action:new-project'));
});

test('on the Undermap the menu leaves out New item and New project, which only work on the map', () => {
  const below = commandMenuSections(nodes, [], '', { below: true }).find(section => section.label === 'Commands')!;
  assert.ok(!below.rows.some(row => row.target.startsWith('action:')));
  assert.ok(below.rows.some(row => row.target === 'shortcut:layer.toggle'), 'travel back still shows');
  assert.ok(!commandMenuSections(nodes, [], 'new', { below: true }).some(section => section.rows.some(row => row.target.startsWith('action:'))));
  assert.ok(commandMenuSections(nodes, [], 'new').some(section => section.rows.some(row => row.target === 'action:new-item')));
});

test('rail commands say Toggle, since picking one on a held-open panel closes it', () => {
  for (const id of ['rail.attention', 'rail.reminders', 'rail.inbox', 'rail.actions', 'todos.toggle']) {
    const command = COMMAND_MENU_COMMANDS.find(entry => entry.id === `shortcut:${id}`);
    if (command) assert.match(command.title, /^Toggle /, id);
  }
});
