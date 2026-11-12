import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from './plugin.ts';
import { textFile } from './definition.ts';
import { textFileSettings } from './settings.ts';

test('text files save automatically unless the setting is switched off', () => {
  assert.equal(textFileSettings({}).saveAutomatically, true);
  assert.equal(textFileSettings({ plugins: {} }).saveAutomatically, true);
  assert.equal(textFileSettings({ plugins: { 'workspace.text': {} } }).saveAutomatically, true);
  assert.equal(textFileSettings({ plugins: { 'workspace.text': { saveAutomatically: false } } }).saveAutomatically, false);
  assert.equal(textFileSettings({ plugins: { 'workspace.text': { saveAutomatically: true } } }).saveAutomatically, true);
  assert.equal(textFileSettings({ plugins: { 'other.package': { saveAutomatically: false } } }).saveAutomatically, true, 'another package\'s setting is not read');
});

test('the setting is on the text file settings page, on by default', () => {
  assert.equal(plugin.settings?.typeId, textFile.id);
  const field = plugin.settings?.fields.saveAutomatically;
  assert.equal(field?.kind, 'boolean'); assert.equal(field?.default, true); assert.equal(field?.label, 'Save automatically');
});
