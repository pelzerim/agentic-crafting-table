import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResourcePluginRegistry } from '../../src/resource-plugins/builtins.ts';
import { defineResourcePlugin } from '../../src/resource-plugins/define.ts';
import { settingsSchema } from './settings.ts';
import { DEFAULT_QUICK_ITEMS, RUN_SKILL, itemChoices, itemChoiceLayers } from './item-picker.ts';

test('Note is in the default ring and carries its one-letter hotkey', () => {
  const choices = itemChoices(createResourcePluginRegistry().describe());
  assert.ok(DEFAULT_QUICK_ITEMS.length < 7, 'All still fits in the ring');
  assert.equal(choices.find(choice => choice.id === 'workspace.note')?.hotkey, 'n');
  assert.equal(itemChoiceLayers(choices, DEFAULT_QUICK_ITEMS).quick.at(-1)?.id, 'workspace.note');
});

test('Run skill occupies a bounded quick slot only in a project with native capability', () => {
  const plugins = createResourcePluginRegistry().describe();
  assert.ok(!itemChoices(plugins, undefined, true).some(choice => choice.id === RUN_SKILL));
  assert.ok(!itemChoices(plugins, 'project', false).some(choice => choice.id === RUN_SKILL));
  const choices = itemChoices(plugins, 'project', true);
  const quickIds = choices.filter(choice => choice.id !== RUN_SKILL).map(choice => choice.id);
  const saved = [...quickIds];
  const layers = itemChoiceLayers(choices, quickIds);
  assert.equal(layers.quick.at(-1)?.id, RUN_SKILL); assert.ok(layers.quick.length <= 7);
  assert.ok(!layers.remaining.some(choice => choice.id === RUN_SKILL));
  assert.deepEqual(new Set([...layers.quick, ...layers.remaining].map(choice => choice.id)), new Set(choices.map(choice => choice.id)));
  assert.deepEqual(quickIds, saved);
  assert.deepEqual(itemChoiceLayers(choices, []).quick.map(choice => choice.id), [RUN_SKILL]);
});

test('quick item choices retain stable IDs and discover an unknown plugin in All without transport changes', () => {
  const registry = createResourcePluginRegistry([defineResourcePlugin({ id: 'fixture.note', name: 'Research note', apiVersion: 1, schemaVersion: 1, icon: 'note', preferredView: 'focus', fields: {}, appearance: { size: 'small', tone: 'violet', shape: 'document' }, creation: { label: 'Add note' } })]);
  const choices = itemChoices(registry.describe());
  const saved = settingsSchema.parse({ quickItemTypes: ['workspace.todo', 'missing.plugin', 'project'] });
  const layers = itemChoiceLayers(choices, saved.quickItemTypes);
  assert.deepEqual(layers.quick.map(choice => choice.id), ['workspace.todo', 'project']);
  assert.ok(layers.remaining.some(choice => choice.id === 'fixture.note'));
  assert.deepEqual(layers.remaining.find(choice => choice.id === 'fixture.note'), { id: 'fixture.note', name: 'Research note', shortLabel: undefined, icon: 'note', brand: undefined, tone: 'violet', size: 'small' });
  assert.ok(!layers.remaining.some(choice => ['workspace.todo', 'project'].includes(choice.id)));
  assert.deepEqual(saved.quickItemTypes, ['workspace.todo', 'missing.plugin', 'project']);
  assert.deepEqual(itemChoiceLayers(choices, choices.map(choice => choice.id)).remaining, []);
  assert.deepEqual(itemChoiceLayers(choices, []).remaining, choices);
  const inside = itemChoices(registry.describe(), 'billing');
  assert.ok(!inside.some(choice => choice.id === 'project'));
  assert.deepEqual(inside, choices.filter(choice => choice.id !== 'project'));
  assert.deepEqual(itemChoiceLayers(inside, saved.quickItemTypes).quick.map(choice => choice.id), ['workspace.todo']);
  assert.deepEqual(saved.quickItemTypes, ['workspace.todo', 'missing.plugin', 'project']);
});

test('older settings retain defaults and invalid shortcut updates are rejected', () => {
  assert.deepEqual(settingsSchema.parse({ keepAwake: true }).quickItemTypes, DEFAULT_QUICK_ITEMS);
  for (const quickItemTypes of [['project', 'project'], [''], Array.from({ length: 8 }, (_, i) => `type-${i}`)]) assert.throws(() => settingsSchema.parse({ quickItemTypes }));
  assert.deepEqual(settingsSchema.parse({ quickItemTypes: [] }).quickItemTypes, []);
});

test('URL choices collapse into From URL and legacy shortcuts keep order without mutating settings', () => {
  const registry = createResourcePluginRegistry([defineResourcePlugin({ id: 'fixture.url', name: 'Custom URL', apiVersion: 1, schemaVersion: 1, icon: 'link', preferredView: 'focus', fields: {}, creation: { label: 'Attach', mode: 'url' } })]);
  const choices = itemChoices(registry.describe());
  assert.equal(choices.filter(choice => choice.id === 'from-url').length, 1);
  assert.ok(!choices.some(choice => ['github.pull-request', 'slack.message', 'notion.page', 'linear.ticket', 'web.link', 'web.bookmark', 'fixture.url'].includes(choice.id)));
  const saved = ['terminal.session', 'slack.message', 'workspace.todo', 'github.pull-request', 'web.bookmark', 'missing.plugin'];
  assert.deepEqual(itemChoiceLayers(choices, saved).quick.map(choice => choice.id), ['terminal.session', 'from-url', 'workspace.todo']);
  assert.deepEqual(saved, ['terminal.session', 'slack.message', 'workspace.todo', 'github.pull-request', 'web.bookmark', 'missing.plugin']);
  assert.equal(itemChoiceLayers(choices, []).remaining.filter(choice => choice.id === 'from-url').length, 1);
});
