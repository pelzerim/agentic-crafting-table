import test from 'node:test';
import assert from 'node:assert/strict';
import { seenOnOpen, settingsSchema } from './settings.ts';

test('map dashboards default to far zoom, keep saved choices and reject thresholds outside the zoom range', () => {
  assert.deepEqual(settingsSchema.parse({}).mapDashboards, { enabled: true, belowZoom: .65, placement: 'center', sections: { needsYou: true, working: true, todos: true, plots: true, pipelines: false, tallies: false } }, 'settings saved before dashboards existed');
  assert.deepEqual(settingsSchema.parse({ mapDashboards: { enabled: false } }).mapDashboards, { enabled: false, belowZoom: .65, placement: 'center', sections: { needsYou: true, working: true, todos: true, plots: true, pipelines: false, tallies: false } });
  assert.deepEqual(settingsSchema.parse({ mapDashboards: { enabled: true, belowZoom: .3 } }).mapDashboards, { enabled: true, belowZoom: .3, placement: 'center', sections: { needsYou: true, working: true, todos: true, plots: true, pipelines: false, tallies: false } });
  for (const belowZoom of [.2, .7, Number.NaN]) assert.equal(settingsSchema.safeParse({ mapDashboards: { enabled: true, belowZoom } }).success, false, String(belowZoom));
});

test('dashboard sections show everything but PRs and tickets by default, also for settings saved before sections existed', () => {
  const sections = { needsYou: true, working: true, todos: true, plots: true, pipelines: false, tallies: false };
  assert.deepEqual(settingsSchema.parse({}).mapDashboards.sections, sections);
  assert.deepEqual(settingsSchema.parse({ mapDashboards: { enabled: true, belowZoom: .5, placement: 'top' } }).mapDashboards, { enabled: true, belowZoom: .5, placement: 'top', sections }, 'saved before sections existed');
  assert.deepEqual(settingsSchema.parse({ mapDashboards: { sections: { pipelines: true, needsYou: false } } }).mapDashboards.sections, { ...sections, pipelines: true, needsYou: false }, 'missing keys read their default');
  for (const value of ['yes', 1, null]) assert.equal(settingsSchema.safeParse({ mapDashboards: { sections: { tallies: value } } }).success, false, String(value));
});

test('dashboard placement defaults to centred, keeps a saved top placement and rejects other values', () => {
  assert.equal(settingsSchema.parse({ mapDashboards: { enabled: true, belowZoom: .45 } }).mapDashboards.placement, 'center', 'settings saved before placement existed');
  assert.equal(settingsSchema.parse({ mapDashboards: { placement: 'top' } }).mapDashboards.placement, 'top');
  assert.equal(settingsSchema.parse({ mapDashboards: { placement: 'center' } }).mapDashboards.placement, 'center');
  for (const placement of ['bottom', '', 1, null]) assert.equal(settingsSchema.safeParse({ mapDashboards: { placement } }).success, false, String(placement));
});

test('double-click opening the web page is off by default and only accepts a boolean', () => {
  assert.equal(settingsSchema.parse({}).doubleClickOpensWeb, false);
  assert.equal(settingsSchema.parse({}).undermapLayout, 'mirror');
  assert.equal(settingsSchema.parse({ undermapLayout: 'classic' }).undermapLayout, 'classic');
  assert.equal(settingsSchema.safeParse({ undermapLayout: 'list' }).success, false);
  assert.equal(settingsSchema.parse({ doubleClickOpensWeb: true }).doubleClickOpensWeb, true);
  for (const value of ['yes', 1, null]) assert.equal(settingsSchema.safeParse({ doubleClickOpensWeb: value }).success, false, String(value));
});

test('implied connections are hidden by default, also for settings saved before the choice existed', () => {
  assert.equal(settingsSchema.parse({}).hideImpliedLinks, true);
  assert.equal(settingsSchema.parse({ hideImpliedLinks: false }).hideImpliedLinks, false);
  for (const value of ['no', 0, null]) assert.equal(settingsSchema.safeParse({ hideImpliedLinks: value }).success, false, String(value));
});

test('the working animal is a sheep with kits for helpers by default, also for settings saved before it existed', () => {
  assert.deepEqual(settingsSchema.parse({}).workingMark, { animal: 'sheep', helpers: 'kits' });
  assert.deepEqual(settingsSchema.parse({ workingMark: { animal: 'raccoon' } }).workingMark, { animal: 'raccoon', helpers: 'kits' });
  assert.deepEqual(settingsSchema.parse({ workingMark: { animal: 'raccoon', helpers: 'same' } }).workingMark, { animal: 'raccoon', helpers: 'same' });
  for (const workingMark of [{ animal: 'cat' }, { helpers: 'tiny' }, { animal: null }]) assert.equal(settingsSchema.safeParse({ workingMark }).success, false, JSON.stringify(workingMark));
});

test('terminal screen reader support is off by default and only accepts a boolean', () => {
  assert.equal(settingsSchema.parse({}).terminal.screenReader, false, 'settings saved before the terminal section existed');
  assert.equal(settingsSchema.parse({ terminal: { screenReader: true } }).terminal.screenReader, true);
  for (const screenReader of ['yes', 1, null]) assert.equal(settingsSchema.safeParse({ terminal: { screenReader } }).success, false, String(screenReader));
});

test('terminal scrollback defaults to 5,000 lines and accepts only the offered choices', () => {
  assert.equal(settingsSchema.parse({}).terminal.scrollback, 5000);
  assert.equal(settingsSchema.parse({ terminal: { screenReader: true } }).terminal.scrollback, 5000, 'settings saved before scrollback existed');
  for (const scrollback of [2000, 5000, 10000, 25000]) assert.equal(settingsSchema.parse({ terminal: { scrollback } }).terminal.scrollback, scrollback);
  for (const scrollback of [0, 3000, 100000, '5000', null]) assert.equal(settingsSchema.safeParse({ terminal: { scrollback } }).success, false, String(scrollback));
});

test('opening marks no item type seen by default; saved type ids survive, including unknown ones', () => {
  assert.deepEqual(settingsSchema.parse({}).notifications.seenOnOpen, []);
  assert.deepEqual(settingsSchema.parse({ notifications: { mode: 'always' } }).notifications.seenOnOpen, []);
  const saved = settingsSchema.parse({ notifications: { seenOnOpen: ['github.pull-request', 'removed.plugin-type'] } }).notifications;
  assert.deepEqual(saved.seenOnOpen, ['github.pull-request', 'removed.plugin-type']);
  assert.equal(saved.dockBadge, true);
  assert.equal(settingsSchema.safeParse({ notifications: { seenOnOpen: [''] } }).success, false);
  assert.equal(settingsSchema.safeParse({ notifications: { seenOnOpen: 'github.pull-request' } }).success, false);
});

test('seenOnOpen acknowledges only a person opening an enabled type in a focused, visible window', () => {
  const settings = { seenOnOpen: ['github.pull-request', 'removed.plugin-type'] };
  const user = { origin: 'user', windowFocused: true, documentVisible: true } as const;
  assert.equal(seenOnOpen('github.pull-request', settings, user), true);
  assert.equal(seenOnOpen('agent.session', settings, user), false);
  assert.equal(seenOnOpen(undefined, settings, user), false);
  assert.equal(seenOnOpen('github.pull-request', { seenOnOpen: [] }, user), false);
  assert.equal(seenOnOpen('github.pull-request', settings, { ...user, origin: 'program' }), false);
  assert.equal(seenOnOpen('github.pull-request', settings, { ...user, windowFocused: false }), false);
  assert.equal(seenOnOpen('github.pull-request', settings, { ...user, documentVisible: false }), false);
  assert.equal(seenOnOpen('github.pull-request', settingsSchema.parse({}).notifications, user), false);
});

test('saved menus default to none, keep ids per item type (also of types not installed) and reject malformed lists', () => {
  assert.deepEqual(settingsSchema.parse({}).menus, { order: {}, layout: {}, hidden: {} }, 'settings saved before menus could be arranged');
  assert.deepEqual(settingsSchema.parse({ menus: {} }).menus, { order: {}, layout: {}, hidden: {} });
  const order = { 'github.pull-request': ['copy-url', 'open', 'plugin:merge'], 'acme.removed': ['open'] };
  assert.deepEqual(settingsSchema.parse({ menus: { order } }).menus, { order, layout: {}, hidden: {} }, 'settings saved while a menu was a list of ids keep that list');
  const layout = { 'github.pull-request': ['copy-url', '---', 'open', '---', '---', 'plugin:merge'], 'acme.removed': ['---'] };
  const hidden = { 'github.pull-request': ['below', 'plugin:merge'], 'acme.removed': ['open'] };
  assert.deepEqual(settingsSchema.parse({ menus: { order, layout } }).menus, { order, layout, hidden: {} }, 'settings saved before entries could be hidden');
  assert.deepEqual(settingsSchema.parse({ menus: { order, layout, hidden } }).menus, { order, layout, hidden });
  for (const key of ['order', 'layout', 'hidden'] as const) for (const value of [{ 'github.pull-request': 'open' }, { 'github.pull-request': [''] }, { 'github.pull-request': [1] }, { '': ['open'] }, { 'github.pull-request': Array(401).fill('open') }, ['open']])
    assert.equal(settingsSchema.safeParse({ menus: { [key]: value } }).success, false, JSON.stringify(value).slice(0, 60));
  for (const key of ['order', 'hidden'] as const) assert.equal(settingsSchema.safeParse({ menus: { [key]: { note: Array(201).fill('open') } } }).success, false);
});

test('snapping to the grid is off by default and only accepts a boolean', () => {
  assert.equal(settingsSchema.parse({}).snapToGrid, false);
  assert.equal(settingsSchema.parse({ snapToGrid: true }).snapToGrid, true);
  for (const value of ['yes', 1, null]) assert.equal(settingsSchema.safeParse({ snapToGrid: value }).success, false, String(value));
});
