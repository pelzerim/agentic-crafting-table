import test from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from './index.ts';
import * as views from './views.ts';
import { apiSatisfies, ownsIdentifier, parsePluginManifest, PLUGIN_API } from './manifest.ts';
import { PluginPackageRegistry } from '../../src/resource-plugins/packages.ts';
import { defineResourcePlugin } from '../../src/resource-plugins/define.ts';
import { pluginPackageContract } from './testing.ts';

const manifest = (overrides: Record<string, unknown> = {}) => ({
  id: 'acme', name: 'Acme items', version: '1.2.0', apiRange: '^1.0.0', entries: { definitions: 'dist/definitions.mjs' }, ...overrides,
});
const widget = defineResourcePlugin({ id: 'acme.widget', apiVersion: 1, schemaVersion: 1, name: 'Widget', icon: 'box', preferredView: 'inspector', fields: { name: { label: 'Name', kind: 'text', required: true } } });

test('the exported SDK surface is pinned for API 1', () => {
  assert.equal(PLUGIN_API, '1.3.0');
  assert.deepEqual(Object.keys(sdk).sort(), ['PLUGIN_API', 'PLUGIN_DEFINITION_API_VERSION', 'apiSatisfies', 'defineResourcePlugin', 'fieldDefaults', 'fieldsSchema', 'indicatorsSchema', 'ownsIdentifier', 'parsePluginManifest', 'pluginManifestSchema', 'validateFields', 'webLinkUrl']);
  assert.deepEqual(Object.keys(views).sort(), ['PIXEL_GLYPHS', 'choiceInput', 'emptyState', 'formatWhen', 'freshnessCopy', 'freshnessStamp', 'glyphPath', 'loadResourceChoices', 'mountProviderRead', 'mountViewHeader', 'openResourceChoices', 'pixelGlyphElement', 'renderMarkdown', 'sessionChip', 'skeleton', 'staleNotice', 'statusChip', 'timeElement', 'whenDate', 'workflowReviewChip']);
});

test('manifests parse with defaults and reject unsafe or incompatible packages', () => {
  const parsed = parsePluginManifest(manifest({ contributes: { itemTypes: ['acme.widget'] } }));
  assert.deepEqual(parsed.contributes.runtimeOperations, []); assert.deepEqual(parsed.legacyIds, []);
  assert.throws(() => parsePluginManifest(manifest({ apiRange: '^2.0.0' })), /needs plugin API \^2\.0\.0; this app provides 1\.3\.0/);
  assert.throws(() => parsePluginManifest(manifest({ apiRange: '>=1' })), /caret API range/);
  assert.throws(() => parsePluginManifest(manifest({ entries: { definitions: '../outside.mjs' } })), /relative path/);
  assert.throws(() => parsePluginManifest(manifest({ entries: { definitions: '/abs.mjs' } })), /relative path/);
  assert.throws(() => parsePluginManifest(manifest({ id: 'Acme' })), /lowercase dotted/);
  assert.throws(() => parsePluginManifest(manifest({ unknown: true })), /Invalid plugin manifest/);
  assert.throws(() => parsePluginManifest(manifest({ contributes: { itemTypes: ['other.widget'] } })), /outside its namespace: other\.widget/);
  assert.throws(() => parsePluginManifest(manifest({ contributes: { runtimeOperations: ['rollout.validation'] } })), /outside its namespace/);
  assert.doesNotThrow(() => parsePluginManifest(manifest({ contributes: { runtimeOperations: ['rollout.validation'] }, legacyIds: ['rollout.validation'] })));
  assert.throws(() => parsePluginManifest(manifest({ contributes: { itemTypes: ['acme.widget'], actionContributions: { 'acme.widget': ['acme.extra'] } } })), /its own type/);
  assert.throws(() => parsePluginManifest(manifest({ contributes: { runtimeOperations: ['acme.run', 'acme.run'] } })), /more than once/);
});

test('namespaces cover dotted ids, MCP tool names and declared legacy ids only', () => {
  const owner = { id: 'github.review-run', legacyIds: ['pr.review.workflow'] };
  assert.equal(ownsIdentifier(owner, 'github.review-run'), true);
  assert.equal(ownsIdentifier(owner, 'github.review-run.options'), true);
  assert.equal(ownsIdentifier(owner, 'github_review_run_report'), true);
  assert.equal(ownsIdentifier(owner, 'pr.review.workflow'), true);
  assert.equal(ownsIdentifier(owner, 'github.review-runner'), false);
  assert.equal(ownsIdentifier(owner, 'github.pull-request'), false);
});

test('API ranges follow caret semantics', () => {
  assert.equal(apiSatisfies('^1.0.0', '1.0.0'), true);
  assert.equal(apiSatisfies('^1.0.0', '1.4.2'), true);
  assert.equal(apiSatisfies('^1.2.0', '1.1.9'), false);
  assert.equal(apiSatisfies('^1.0.0', '2.0.0'), false);
  assert.equal(apiSatisfies('^0.3.0', '0.4.0'), false);
});

test('a package registers only what its manifest declares', () => {
  const registry = new PluginPackageRegistry();
  assert.throws(() => registry.register({ manifest: manifest({ contributes: { itemTypes: ['acme.widget'] } }), module: {} }), /declares item types it does not provide: acme\.widget/);
  assert.throws(() => registry.register({ manifest: manifest(), module: { definitions: [widget] } }), /does not declare: acme\.widget/);
  assert.throws(() => registry.register({ manifest: manifest(), module: { runtimeOperations: [{ id: 'acme.sync' }] } }), /runtime operations its manifest does not declare/);
  assert.equal(registry.list().length, 0, 'failed registrations leave nothing behind');
  registry.register({ manifest: manifest({ contributes: { itemTypes: ['acme.widget'], runtimeOperations: ['acme.sync'] } }), module: { definitions: [widget], runtimeOperations: [{ id: 'acme.sync', agentPolicy: 'humanOnly' }] } });
  assert.equal(registry.ownerOf('acme.widget'), 'acme');
  assert.deepEqual(registry.runtimeOperations(), [{ id: 'acme.sync', agentPolicy: 'humanOnly', owner: 'acme' }]);
  assert.throws(() => registry.register({ manifest: manifest(), module: {} }), /already registered: acme/);
  assert.throws(() => registry.register({ manifest: manifest({ id: 'other', contributes: { runtimeOperations: ['acme.sync'] }, legacyIds: ['acme.sync'] }), module: { runtimeOperations: [{ id: 'acme.sync' }] } }), /redeclares identifiers of another plugin: acme\.sync/);
});

test('menus and settings contributed to another type appear in its description only', () => {
  const registry = new PluginPackageRegistry();
  registry.register({ manifest: manifest({ contributes: { itemTypes: ['acme.widget'] } }), module: { definitions: [widget] } });
  const extra = manifest({ id: 'tags', contributes: { actionContributions: { 'acme.widget': ['tags.options', 'tags.apply'] }, settingsPages: ['acme.widget'] } });
  const menus = [{ targetTypeId: 'acme.widget', groups: [{ id: 'tags', label: 'Tags', children: [], choices: { load: 'tags.options', apply: 'tags.apply' }, when: { plugin: 'tags', setting: 'enabled' } }] }];
  const settings = { typeId: 'acme.widget', label: 'Tags', fields: { enabled: { label: 'Enable tags', kind: 'boolean' as const, default: false } } };
  assert.throws(() => registry.register({ manifest: extra, module: { settings, actionMenus: [{ targetTypeId: 'acme.widget', groups: [{ ...menus[0].groups[0], choices: { load: 'tags.options', apply: 'tags.other' } }] }] } }), /undeclared actions: tags\.other/);
  registry.register({ manifest: extra, module: { settings, actionMenus: menus } });
  const [described] = registry.types.describe();
  assert.deepEqual(described.contextMenu?.map(group => group.id), ['tags']);
  assert.deepEqual(described.settingsSections, [{ owner: 'tags', ...settings }]);
  assert.deepEqual(registry.types.pluginSettings({ other: { kept: true } }), { other: { kept: true }, tags: { enabled: false } });
  assert.throws(() => registry.types.validatePluginSettings({ tags: { enabled: 'yes' } }), /Tags settings are invalid/);
  assert.doesNotThrow(() => registry.types.validatePluginSettings({ tags: { enabled: true }, removed: { anything: 1 } }));
});

test('a settings section may refuse values its fields accept; the check stays out of the description', () => {
  const registry = new PluginPackageRegistry();
  const fields = { rules: { label: 'Rules', kind: 'text' as const, multiline: true, default: '' } };
  const validate = (values: Record<string, unknown>) => { if (String(values.rules).trim()) JSON.parse(String(values.rules)); };
  registry.register({ manifest: manifest({ contributes: { itemTypes: ['acme.widget'], settingsPages: ['acme.widget'] } }), module: { definitions: [widget], settings: { typeId: 'acme.widget', label: 'Rules', fields, validate } } });
  assert.deepEqual(registry.types.describe()[0].settingsSections, [{ owner: 'acme', typeId: 'acme.widget', label: 'Rules', fields }]);
  assert.doesNotThrow(() => registry.types.validatePluginSettings({ acme: { rules: '' } }));
  assert.doesNotThrow(() => registry.types.validatePluginSettings({ acme: { rules: '[]' } }));
  assert.throws(() => registry.types.validatePluginSettings({ acme: { rules: '[' } }), /Rules settings are invalid: .*JSON/);
  registry.types.withdraw('acme', ['acme.widget'], 'gone');
  assert.doesNotThrow(() => registry.types.validatePluginSettings({ acme: { rules: '[' } }));
});

test('settings presets name declared settings of a registered package', () => {
  const registry = new PluginPackageRegistry();
  const settings = { typeId: 'acme.widget', label: 'Widget', fields: { mode: { label: 'Mode', kind: 'text' as const, default: 'plain' } } };
  registry.register({ manifest: manifest({ contributes: { itemTypes: ['acme.widget'], settingsPages: ['acme.widget'] } }), module: { definitions: [widget], settings } });
  const preset = { id: 'house.widget-mode', packageId: 'acme', values: { mode: 'fancy' } }, house = (values: Record<string, unknown> = {}) => manifest({ id: 'house', contributes: { settingsPresets: ['house.widget-mode'] }, ...values });
  assert.throws(() => registry.register({ manifest: manifest({ id: 'house' }), module: { settingsPresets: [preset] } }), /settings presets its manifest does not declare: house\.widget-mode/);
  assert.throws(() => parsePluginManifest(manifest({ id: 'house', contributes: { settingsPresets: ['acme.mode'] } })), /outside its namespace: acme\.mode/);
  registry.register({ manifest: manifest({ id: 'plain' }), module: {} });
  assert.throws(() => registry.register({ manifest: house(), module: { settingsPresets: [{ ...preset, packageId: 'plain' }] } }), /plain has no settings/);
  assert.throws(() => registry.register({ manifest: house(), module: { settingsPresets: [{ ...preset, values: { colour: 'red' } }] } }), /unknown settings of acme: colour/);
  assert.throws(() => registry.register({ manifest: house(), module: { settingsPresets: [{ ...preset, values: { mode: 5 } }] } }), /Widget settings are invalid/);
  registry.register({ manifest: house(), module: { settingsPresets: [preset] } });
  assert.deepEqual(registry.settingsPresets(), [{ ...preset, owner: 'house' }]);
  assert.equal(registry.checkSettingsPreset({ ...preset, owner: 'house' }), true);
});

test('a settings preset for a package that is not registered yet waits for it and is checked once it is', () => {
  const registry = new PluginPackageRegistry(), preset = { id: 'house.widget-mode', packageId: 'acme', values: { mode: 5 } };
  registry.register({ manifest: manifest({ id: 'house', contributes: { settingsPresets: ['house.widget-mode'] } }), module: { settingsPresets: [preset] } });
  assert.equal(registry.checkSettingsPreset({ ...preset, owner: 'house' }), false, 'nothing to apply until the target is there');
  const settings = { typeId: 'acme.widget', label: 'Widget', fields: { mode: { label: 'Mode', kind: 'text' as const, default: 'plain' } } };
  registry.register({ manifest: manifest({ contributes: { itemTypes: ['acme.widget'], settingsPages: ['acme.widget'] } }), module: { definitions: [widget], settings } });
  assert.throws(() => registry.checkSettingsPreset({ ...preset, owner: 'house' }), /Widget settings are invalid/, 'a preset the target refuses is reported, not applied');
});

pluginPackageContract({ manifest: manifest({ contributes: { itemTypes: ['acme.widget'] } }), module: { definitions: [widget] } }, { fixtures: { 'acme.widget': { valid: { name: 'One' }, invalid: [{ name: '' }] } } });
