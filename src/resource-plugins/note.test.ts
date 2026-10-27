import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourcePluginRegistry } from './builtins.ts';
import { registryFromDescriptions } from './describe.client.ts';
import { resolveMapSize, wrappedLines } from '../../packages/core/item-map-sizes.ts';
import type { ResourceRecord } from './types.ts';
import { fieldsSchema } from './define.ts';

const registry = createResourcePluginRegistry(), note = registry.get('workspace.note')!;
const record = (data: ResourceRecord['data'], schemaVersion = note.schemaVersion): ResourceRecord => ({ id: 'r', pluginId: note.id, schemaVersion, title: 'Note', data });

test('a saved v1 note upgrades to the paper schema without touching its text or adding fields', () => {
  assert.equal(note.schemaVersion, 2);
  const legacy = record({ text: '  Design decision\n- [ ] Keep the API  ' }, 1);
  assert.equal(registry.resolve(legacy).available, false);
  const upgraded = registry.migrate(legacy);
  assert.equal(upgraded.schemaVersion, 2);
  assert.deepEqual(upgraded.data, legacy.data);
  assert.equal(registry.resolve(upgraded).available, true);
});

test('paper is an optional choice of ten named colours, never yellow or amber, or a custom #rrggbb', () => {
  assert.equal(registry.resolve(record({ text: 'No paper saved' })).available, true);
  for (const paper of ['mint', 'sky', 'lilac', 'peach', 'slate', 'moss', 'ice', 'rose', 'sand', 'fog', '#3366cc', '#3366CC']) assert.equal(registry.resolve(record({ text: 'Paper', paper })).available, true, paper);
  for (const paper of ['yellow', 'amber', 'butter', '', 3, '#36c', '3366cc', '#3366cg']) assert.equal(registry.resolve(record({ text: 'Paper', paper })).available, false, String(paper));
  assert.deepEqual(note.fields?.paper?.options, ['mint', 'moss', 'ice', 'sky', 'lilac', 'rose', 'peach', 'sand', 'fog', 'slate']);
  assert.equal(note.fields?.paper?.customColor, true);
  assert.equal(note.fields?.paper?.required, undefined);
  assert.equal(note.fields?.text?.required, true);
  const described = registryFromDescriptions(registry.describe()).get(note.id)!;
  assert.equal(described.fields?.paper?.customColor, true, 'the renderer sees that the paper takes custom colours');
  assert.deepEqual((fieldsSchema(note.fields!).properties as Record<string, unknown>).paper, {
    type: 'string', title: 'Paper', anyOf: [{ enum: ['mint', 'moss', 'ice', 'sky', 'lilac', 'rose', 'peach', 'sand', 'fog', 'slate'] }, { pattern: '^#[0-9a-fA-F]{6}$' }] });
});

test('stored size ids map to S160, M220 and L300 tiles whose height follows the text from 3 to 14 lines', () => {
  const described = registryFromDescriptions(registry.describe()).get(note.id)!;
  const short = record({ text: 'One line' });
  assert.deepEqual(['small', 'medium', 'large'].map(size => resolveMapSize({ mapSize: size as 'small' }, short, described).width), [160, 220, 300]);
  const base = resolveMapSize({}, short, described);
  assert.equal(base.size, 'small');
  const three = resolveMapSize({}, record({ text: 'a\nb\nc' }), described).height;
  assert.equal(base.height, three, 'one line still shows the three-line minimum');
  const five = resolveMapSize({}, record({ text: 'a\nb\nc\nd\ne' }), described).height;
  assert.ok(five > three);
  const long = Array.from({ length: 40 }, (_, line) => `Line ${line}`).join('\n');
  const capped = resolveMapSize({}, record({ text: long }), described).height;
  assert.equal(capped, resolveMapSize({}, record({ text: long.split('\n').slice(0, 14).join('\n') }), described).height);
  assert.ok(capped > five);
  const wide = resolveMapSize({ mapDimensions: { width: 310, height: 32 } }, record({ text: 'a\nb\nc\nd\ne' }), described);
  assert.equal(wide.width, 310); assert.equal(wide.size, 'large');
  assert.equal(wide.height, five, 'a stored height never overrides the text height');
  assert.equal(resolveMapSize({ mapSize: 'small' }, record({ text: 'x'.repeat(200) }), described).height > three, true, 'long lines wrap');
  assert.ok(wrappedLines('x'.repeat(200), 160) > wrappedLines('x'.repeat(200), 300));
});
