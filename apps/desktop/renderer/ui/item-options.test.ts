import test from 'node:test';
import assert from 'node:assert/strict';
import { itemOptions, matchOptions } from './item-options.ts';

const nodes = [
  { id: 'loose', title: 'Scratch note', resourceId: 'r-loose', position: { x: 0, y: 0 } },
  { id: 'agent', title: 'Claude · implementation', resourceId: 'r-agent', projectId: 'billing', position: { x: 0, y: 0 } },
  { id: 'billing', title: 'Billing redesign', position: { x: 0, y: 0 } },
  { id: 'pr', title: 'Plan switcher', resourceId: 'r-pr', projectId: 'billing', position: { x: 0, y: 0 } },
  { id: 'atlas', title: 'Atlas', position: { x: 0, y: 0 } },
];

test('item choices are grouped by project, the project first, floating items last', () => {
  assert.deepEqual(itemOptions(nodes, () => true).map(option => [option.group, option.label, option.meta ?? '']), [
    ['Atlas', 'Atlas', 'whole project'],
    ['Billing redesign', 'Billing redesign', 'whole project'],
    ['Billing redesign', 'Claude · implementation', ''],
    ['Billing redesign', 'Plan switcher', ''],
    ['No project', 'Scratch note', ''],
  ]);
  assert.deepEqual(itemOptions(nodes, node => node.id !== 'billing' && node.id !== 'atlas').map(option => option.value), ['agent', 'pr', 'loose']);
});

test('typing filters by item title or project name, case-insensitively', () => {
  const options = itemOptions(nodes, () => true);
  assert.deepEqual(matchOptions(options, 'BIL').map(option => option.value), ['billing', 'agent', 'pr']);
  assert.deepEqual(matchOptions(options, 'plan sw').map(option => option.value), ['pr']);
  assert.deepEqual(matchOptions(options, '  ').length, options.length);
  assert.deepEqual(matchOptions(options, 'nothing like this'), []);
});
