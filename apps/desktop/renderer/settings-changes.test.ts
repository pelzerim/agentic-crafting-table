import test from 'node:test';
import assert from 'node:assert/strict';
import { draftChanges } from './settings-changes.ts';
import { settingsSchema } from '../../../packages/core/settings.ts';

test('draft changes count changed leaves and name the page that holds each one', () => {
  const saved = settingsSchema.parse({});
  assert.deepEqual(draftChanges(saved, saved), []);
  const draft = { ...saved, neighborhoodPadding: 320, neighborhoodAppearance: { ...saved.neighborhoodAppearance, pixelSize: 48 },
    summaries: { ...saved.summaries, requestsPerHour: 30 }, itemViews: { 'workspace.note': { width: 560, height: 340 } },
    itemMapSizes: { 'agent.session:claude': { sizes: { small: { width: 340, height: 48 } } } }, claude: { ...saved.claude, arguments: ['--verbose'] } };
  assert.deepEqual(draftChanges(saved, draft).sort(), ['AI features', 'Map', 'Map', 'agent.session:claude', 'agent.session:claude', 'workspace.note'].sort());
});

test('the default working directory belongs to the Items page', () => {
  const saved = settingsSchema.parse({});
  assert.deepEqual(draftChanges(saved, { ...saved, defaultWorkingDirectory: '/Users/example/code' }), ['Items']);
});

test('the double-click web setting belongs to the Map page', () => {
  const saved = settingsSchema.parse({});
  assert.deepEqual(draftChanges(saved, { ...saved, doubleClickOpensWeb: true }), ['Map']);
  assert.deepEqual(draftChanges(saved, { ...saved, hideImpliedLinks: false }), ['Map']);
  assert.deepEqual(draftChanges(saved, { ...saved, snapToGrid: true }), ['Map']);
  assert.deepEqual(draftChanges(saved, { ...saved, groundRightClickRing: true }), ['Map']);
});

test('package settings belong to the item page that shows them, compared with their defaults filled in', () => {
  const saved = settingsSchema.parse({}), pages = { acme: { page: 'acme.widget', defaults: { enabled: false, mode: 'safe' } } };
  assert.deepEqual(draftChanges(saved, { ...saved, plugins: { acme: { enabled: true } } }, pages), ['acme.widget']);
  assert.deepEqual(draftChanges(saved, { ...saved, plugins: { acme: { enabled: false } } }, pages), [], 'choosing the default again is no change');
  assert.deepEqual(draftChanges({ ...saved, plugins: { acme: { mode: 'fast' } } }, { ...saved, plugins: { acme: { mode: 'safe' } } }, pages), ['acme.widget']);
});

test('terminal settings belong to the General page', () => {
  const saved = settingsSchema.parse({});
  assert.deepEqual(draftChanges(saved, { ...saved, terminal: { ...saved.terminal, screenReader: true } }), ['General']);
});
