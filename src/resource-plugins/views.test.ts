import test from 'node:test';
import assert from 'node:assert/strict';
import { patchedData, ResourceViewRegistry, savedSnapshot } from './views.ts';
import { PluginPackageRegistry } from './packages.ts';
import { defineResourcePlugin } from './define.ts';
import type { MountedResourceView, ResourceViewServices } from './types.ts';

test('a mounted view is updated with its item\'s saved map state, without a provider title or content', () => {
  const cues = [{ id: 'rollout-state', label: 'Ongoing', icon: 'clock' as const, tone: 'blue' as const }];
  assert.deepEqual(savedSnapshot({ activity: 'working', attention: 'none', summary: 'Ongoing', indicators: cues }, '2026-10-07T10:00:00.000Z'),
    { activity: 'working', attention: 'none', connection: 'unknown', label: 'Ongoing', observedAt: '2026-10-07T10:00:00.000Z', indicators: cues });
  const paused = savedSnapshot({ activity: 'idle', attention: 'review', summary: '', indicators: [...cues, { id: 'connection', label: 'Updates paused', icon: 'clock' as const, tone: 'amber' as const }] }, '2026-10-07T10:00:00.000Z');
  assert.equal(paused.connection, 'disconnected');
  assert.deepEqual(Object.keys(savedSnapshot({ activity: 'unknown', attention: 'none', summary: '' }, '2026-10-07T10:00:00.000Z')), ['activity', 'attention', 'connection', 'label', 'observedAt']);
});

test('a view saves fields into its item\'s data: a value replaces, null removes, the rest stays', () => {
  const data = { owner: 'acme', repo: 'app', number: 42 };
  assert.deepEqual(patchedData(data, { autoValidate: false }), { owner: 'acme', repo: 'app', number: 42, autoValidate: false });
  assert.deepEqual(patchedData({ ...data, autoValidate: false }, { autoValidate: null }), data);
  assert.deepEqual(patchedData(data, { autoValidate: null }), data);
  assert.deepEqual(data, { owner: 'acme', repo: 'app', number: 42 });
});

test('a mounted view is asked before it closes; one with no say, one that fails and one that is gone agree', async () => {
  const widget = defineResourcePlugin({ id: 'acme.widget', apiVersion: 1, schemaVersion: 1, name: 'Widget', icon: 'box', preferredView: 'inspector', fields: { name: { label: 'Name', kind: 'text', required: true } } });
  const packages = new PluginPackageRegistry();
  packages.register({ manifest: { id: 'acme', name: 'Acme', version: '1.0.0', apiRange: '^1.0.0', entries: { definitions: 'plugin.ts', service: 'service.ts' }, contributes: { itemTypes: ['acme.widget'] } }, module: { definitions: [widget] } });
  const views = new ResourceViewRegistry(packages.types);
  let confirmClose: MountedResourceView['confirmClose'];
  views.register('acme.widget', { mountDetail: () => ({ update() {}, dispose() {}, ...(confirmClose ? { confirmClose } : {}) }) });
  const mount = () => views.mount('detail', {} as HTMLElement, { id: 'r', pluginId: 'acme.widget', schemaVersion: 1, title: 'Widget', data: { name: 'One' } },
    { runAction: async () => null, openResource() {}, attachTerminal: () => ({ dispose() {} }) } as ResourceViewServices, () => ({ update() {}, dispose() {} }));

  assert.equal(mount().confirmClose!(), true, 'a view with no say agrees');
  confirmClose = () => false;
  assert.equal(mount().confirmClose!(), false);
  confirmClose = async () => false;
  assert.equal(await mount().confirmClose!(), false);
  confirmClose = () => { throw new Error('broken'); };
  assert.equal(mount().confirmClose!(), true, 'a view that fails cannot hold its item open');
  confirmClose = async () => { throw new Error('broken'); };
  assert.equal(await mount().confirmClose!(), true);
  let asked = 0;
  confirmClose = () => { asked += 1; return false; };
  const gone = mount(); gone.dispose();
  assert.equal(gone.confirmClose!(), true); assert.equal(asked, 0, 'a disposed view is not asked');
});
