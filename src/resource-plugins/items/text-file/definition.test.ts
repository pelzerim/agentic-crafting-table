import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourcePluginRegistry } from '../../builtins.ts';
import { validateFields } from '../../define.ts';
import { defaultItemTitle } from '../../generated-title.ts';
import { ResourcePluginRegistry } from '../../registry.ts';
import type { JsonObject } from '../../types.ts';

test('a text file item is bundled, holds an absolute or home path and never the content, and shows file text on the map only at the large size', () => {
  const registry = createResourcePluginRegistry(), plugin = registry.get('workspace.text')!;
  assert.equal(plugin.name, 'Text file'); assert.equal(plugin.icon, 'file'); assert.equal(plugin.creation?.label, 'Add text file');
  assert.deepEqual(Object.keys(plugin.fields!), ['path', 'language']); assert.equal(plugin.fields!.path.kind, 'file'); assert.equal(plugin.fields!.path.required, true);
  for (const data of [{ path: '/work/app/README.md' }, { path: '~/notes/todo.txt' }, { path: '/work/app/main.ts', language: 'TypeScript' }, { path: '/work/with space/a.md', language: '' }] as JsonObject[])
    assert.deepEqual(registry.createRecord('workspace.text', 'file-r', { title: 'File', data }).data, data);
  for (const data of [{}, { path: '' }, { path: 'notes/todo.txt' }, { path: '~' }, { path: '/' }, { path: '/work/app/' }, { path: '/work/a\nb.md' }, { path: 42 }, { path: '/work/a.md', language: 7 }] as JsonObject[])
    assert.throws(() => registry.createRecord('workspace.text', 'file-r', { title: 'File', data }), /invalid/, JSON.stringify(data));
  assert.equal(plugin.mapSizes!.defaultSize, 'small');
  assert.deepEqual(Object.entries(plugin.mapSizes!.sizes).map(([size, preset]) => [size, Boolean(preset!.nodeView)]), [['small', false], ['medium', false], ['large', true]]);
  assert.equal(validateFields(plugin.fields!, { path: '/work/app/README.md' }), true); assert.equal(validateFields(plugin.fields!, { path: 'README.md' }), false);
});

test('a pasted file path is offered as a text file named after the file', () => {
  const registry = createResourcePluginRegistry(), match = (input: string) => registry.matchInput(input).filter(candidate => candidate.pluginId === 'workspace.text').map(candidate => [candidate.title, candidate.data]);
  assert.deepEqual(match('/work/app/README.md'), [['README.md', { path: '/work/app/README.md' }]]);
  assert.deepEqual(match('  ~/notes/to do.txt '), [['to do.txt', { path: '~/notes/to do.txt' }]]);
  assert.deepEqual(match('/work/app/Makefile'), [['Makefile', { path: '/work/app/Makefile' }]]);
  for (const input of ['https://example.com/a.md', 'file:///work/a.md', 'just words', 'notes/todo.txt', '/', '/work/app/', '~', '/work/a.md\n/work/b.md', '// a comment', '/* a comment */'])
    assert.deepEqual(match(input), [], input);
  assert.deepEqual(registry.matchUrl('/work/app/README.md'), [], 'a path is not a URL');
});

test('a path is matched as a file by the item type whose file field it fills, and a URL by none', () => {
  const registry = createResourcePluginRegistry();
  assert.deepEqual(registry.matchFile(' ~/notes/to do.txt ').map(match => [match.candidate.pluginId, match.candidate.title, match.path]), [['workspace.text', 'to do.txt', '~/notes/to do.txt']]);
  for (const input of ['https://github.com/acme/app/pull/48', 'https://example.com/a.md', 'just words', '/work/a.md\n/work/b.md']) assert.deepEqual(registry.matchFile(input), [], input);
});

test('a new text file without a name is called after its file', () => {
  const plugin = createResourcePluginRegistry().describe().find(plugin => plugin.id === 'workspace.text')!;
  assert.equal(defaultItemTitle(plugin, { path: '/work/app/README.md' }), 'README.md');
  assert.equal(defaultItemTitle(plugin, { path: '~/notes/todo.txt' }), 'todo.txt');
  assert.equal(defaultItemTitle(plugin, { path: '' }), undefined); assert.equal(defaultItemTitle(plugin, {}), undefined);
});

test('a file field belongs to item forms, not to plugin settings', () => {
  assert.throws(() => new ResourcePluginRegistry().registerSettings('acme', { typeId: 'acme.item', label: 'Acme', fields: { output: { label: 'Output file', kind: 'file' } } }), /Plugin settings use plain/);
});
