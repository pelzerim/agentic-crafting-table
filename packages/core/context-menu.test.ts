import test from 'node:test';
import assert from 'node:assert/strict';
import { contextMenuActions, convertLinkActions, enabledMenuGroups, itemEditLabel, addMenuSeparator, canHideMenuEntry, drawnMenuLayout, isCustomMenu, itemMenuCustom, itemMenuEntries, linkMenuActions, MENU_SEPARATOR, menuLayout, menuSlot, mergeMenuOrder, moveMenuRow, muteProjectAction, removeMenuSeparator, resetItemMenu, saveItemMenu, setMenuEntryHidden, plotMenuActions, deleteItemAction, moveToProjectAction, sendToProjectAction, sharedContextMenuActions, todoContextActions, fieldMenuActions } from './context-menu.ts';
import { noteItem } from '../../src/resource-plugins/items/note/definition.ts';
import { pluginSettingsValues } from '../../src/resource-plugins/describe.client.ts';
import { githubPullRequest } from '../../src/resource-plugins/items/github-pull-request/definition.ts';

test('context lists contain only local actions and keep creation off objects', () => {
  assert.deepEqual(contextMenuActions('board').map(a => a.label), ['New item', 'New project', 'Open archive']);
  assert.deepEqual(contextMenuActions('neighborhood').map(a => a.label), ['New item']);
  assert.deepEqual(contextMenuActions('link').map(a => a.label), ['Remove connection']);
  assert.deepEqual(contextMenuActions('project').map(a => a.label), ['Project settings…', 'Mark done', 'Send project to Undermap']);
  assert.deepEqual(contextMenuActions('item').map(a => a.label), ['Open', 'Connect to…', 'Settings', 'Mark done', 'Send to Undermap']);
  assert.deepEqual(contextMenuActions('item', true, 'Edit note…').map(a => a.label), ['Open', 'Connect to…', 'Settings', 'Reopen', 'Send to Undermap']);
  assert.equal(contextMenuActions('project', true)[1].id, 'reopen');
  assert.ok(contextMenuActions('item').every(action => !action.destructive));
  assert.equal(contextMenuActions('item')[2].divider, true, 'the basic verbs form their own group');
});

test('plugin review submenus appear only on items and keep lifecycle actions intact', () => {
  const actions = contextMenuActions('item', false, undefined, githubPullRequest.contextMenu);
  assert.deepEqual(actions.map(action => action.label), ['Open', 'Connect to…', 'Trigger review', 'Review loop', 'Explain architecture', 'Merge…', 'Auto deploy', 'Change state', 'Show/Ship', 'Settings', 'Mark done', 'Send to Undermap']);
  assert.deepEqual(actions[3].choices, { load: 'options', apply: 'set', runtime: 'review.loop', loadingLabel: 'Checking the review loop…' });
  assert.deepEqual(actions[4].children?.map(action => [action.id, action.label]), [['plugin:architecture.explain', 'Claude']]);
  assert.deepEqual(actions[5].choices, { load: 'pr.merge.options', apply: 'pr.merge', loadingLabel: 'Checking merge options…', irreversible: true, pickConfirms: true });
  assert.deepEqual(actions[6].choices, { load: 'options', apply: 'set', runtime: 'github.rollout.autoDeploy', loadingLabel: 'Checking auto deploy…' });
  assert.deepEqual(actions[7].choices, { load: 'pr.state.options', apply: 'pr.state', loadingLabel: 'Checking the pull request…' });
  assert.deepEqual(actions[8].choices, { load: 'pr.showShip.options', apply: 'pr.showShip', loadingLabel: 'Checking the title…' });
  assert.deepEqual(actions[2].children?.map(action => [action.id, action.label]), [['plugin:review.claude', 'Claude'], ['plugin:review.codex', 'Codex'], ['plugin:review.both', 'Claude + Codex'], ['plugin:review.workflow', '/review']]);
  for (const scope of ['board', 'neighborhood', 'project', 'link'] as const) assert.ok(contextMenuActions(scope, false, undefined, githubPullRequest.contextMenu).every(action => !action.children));
});

test('in Undermap, items can return or move on to the archive, never be created', () => {
  assert.deepEqual(contextMenuActions('item', false, undefined, githubPullRequest.contextMenu, undefined, {}).map(a => a.label), ['Bring back to map', 'Item settings…', 'Archive']);
  assert.deepEqual(contextMenuActions('project', false, undefined, [], undefined, {}).map(a => a.label), ['Bring back to map', 'Project settings…', 'Archive project']);
  const blocked = contextMenuActions('item', false, undefined, [], undefined, { blocker: 'Bring its project “Billing” back first' })[0];
  assert.equal(blocked.disabled, true); assert.match(blocked.description!, /Billing/);
  for (const scope of ['board', 'neighborhood'] as const) assert.deepEqual(contextMenuActions(scope, false, undefined, [], undefined, {}).map(a => a.id), ['archive-browser']);
});

test('items with a web page offer "Open on …" on the map and in Undermap, but projects and selections do not', () => {
  const web = { label: 'Open on GitHub' };
  assert.deepEqual(contextMenuActions('item', false, undefined, [], undefined, undefined, web).find(action => action.id === 'open-web'), { id: 'open-web', label: 'Open on GitHub', divider: true });
  assert.ok(contextMenuActions('item', false, undefined, [], undefined, { }, web).some(action => action.id === 'open-web'));
  assert.equal(contextMenuActions('project', false, undefined, [], undefined, undefined, web).some(action => action.id === 'open-web'), false);
  assert.equal(sharedContextMenuActions([contextMenuActions('item', false, undefined, [], undefined, undefined, web), contextMenuActions('item', false, undefined, [], undefined, undefined, web)]).some(action => action.id === 'open-web'), false);
});

test('agent items can hand their title back to automation; groups and projects cannot', () => {
  assert.deepEqual(contextMenuActions('item', false, undefined, [], undefined, undefined, undefined, true).map(a => a.label), ['Open', 'Connect to…', 'Settings', 'Auto-name from activity', 'Mark done', 'Send to Undermap']);
  assert.ok(!contextMenuActions('project', false, undefined, [], undefined, undefined, undefined, true).some(action => action.id === 'auto-title'));
  assert.ok(!contextMenuActions('item', false, undefined, [], undefined, {}, undefined, true).some(action => action.id === 'auto-title'));
  assert.ok(!sharedContextMenuActions([contextMenuActions('item', false, undefined, [], undefined, undefined, undefined, true), contextMenuActions('item', false, undefined, [], undefined, undefined, undefined, true)]).some(action => action.id === 'auto-title'));
});

test('item menus group provider actions, then opening, then map housekeeping; provider actions are marked remote', () => {
  const declared = githubPullRequest.contextMenu!.find(group => group.id === 'merge')!, merge = { ...declared, choices: { ...declared.choices!, irreversible: true } };
  const actions = contextMenuActions('item', false, undefined, [githubPullRequest.contextMenu![0]!, merge], { enabled: false }, undefined, { label: 'Open on GitHub' }, true);
  assert.deepEqual(actions.map(action => [action.label, Boolean(action.divider), Boolean(action.remote)]), [
    ['Open', false, false], ['Connect to…', false, false],
    ['Trigger review', true, true], ['Merge…', false, true],
    ['Open on GitHub', true, false], ['Copy URL', false, false], ['Settings', false, false],
    ['Turn into todo', true, false], ['Auto-name from activity', false, false], ['Mark done', false, false], ['Send to Undermap', false, false],
  ]);
  assert.deepEqual(contextMenuActions('item').map(action => [action.label, Boolean(action.divider)]),
    [['Open', false], ['Connect to…', false], ['Settings', true], ['Mark done', true], ['Send to Undermap', false]]);
});

test('a connection menu turns a link blocking or back, naming the direction', () => {
  assert.deepEqual(linkMenuActions('reference', 'PR #64', 'PR #65').map(a => [a.id, a.label, a.description]),
    [['make-blocking', 'Make blocking', 'PR #64 blocks PR #65'], ['remove-link', 'Remove connection', undefined]]);
  assert.deepEqual(linkMenuActions('blocks', 'PR #64', 'PR #65').map(a => [a.id, a.label, a.description]),
    [['make-normal', 'Make normal', undefined], ['reverse-link', 'Reverse blocking', 'PR #65 blocks PR #64'], ['remove-link', 'Remove connection', undefined]]);
  assert.equal(linkMenuActions('context', 'A', 'B')[0].id, 'make-blocking');
});

test('a project menu switches its plots and brings hidden ones back; a sign has its own short menu', () => {
  const ids = (actions: ReturnType<typeof contextMenuActions>) => actions.map(action => [action.id, action.label, action.checked]);
  assert.deepEqual(ids(contextMenuActions('project', false, undefined, [], undefined, undefined, undefined, false, { shown: true, hidden: 2 })).filter(([id]) => String(id).startsWith('plots')),
    [['plots-toggle', 'Show plots', true], ['plots-unhide', 'Show hidden plots (2)', undefined]]);
  assert.deepEqual(ids(contextMenuActions('project', false, undefined, [], undefined, undefined, undefined, false, { shown: false, hidden: 0 })).filter(([id]) => String(id).startsWith('plots')), [['plots-toggle', 'Show plots', false]]);
  assert.ok(!contextMenuActions('item', false, undefined, [], undefined, undefined, undefined, false, { shown: true, hidden: 1 }).some(action => action.id.startsWith('plots')));
  assert.deepEqual(plotMenuActions().map(action => action.label), ['Select items', 'Rename plot…', 'Name automatically', 'Hide this plot']);
  assert.equal(plotMenuActions(false).find(action => action.id === 'plot-auto')?.disabled, true);
});

test(`a sign's menu holds a row of color swatches and Automatic, between Name automatically and Hide this plot`, () => {
  const automatic = plotMenuActions(true, { color: 'sky' });
  assert.deepEqual(automatic.map(action => [action.id, action.label, action.divider, action.checked]), [
    ['plot-select', 'Select items', undefined, undefined], ['plot-rename', 'Rename plot…', undefined, undefined], ['plot-auto', 'Name automatically', undefined, undefined],
    ['plot-color', 'Color', true, undefined], ['plot-color-auto', 'Automatic · Daisy', undefined, true], ['plot-hide', 'Hide this plot', true, undefined]]);
  assert.deepEqual(automatic[3].row, [
    { value: 'rose', label: 'Buttercup', swatch: '#f2c94c', checked: false }, { value: 'sky', label: 'Daisy', swatch: '#f6f6ee', checked: true },
    { value: 'citron', label: 'Fern', swatch: '#4f8a52', checked: false }, { value: 'orchid', label: 'Bluebell', swatch: '#8fa8e8', checked: false },
    { value: 'clay', label: 'Bark', swatch: '#a07a4a', checked: false }, { value: 'slate', label: 'Sage', swatch: '#c4dcb4', checked: false }], 'the current color is checked; Grassland without a color');
  const chosen = plotMenuActions(true, { color: 'sky', chosenColor: 'clay' });
  assert.deepEqual(chosen[3].row!.filter(choice => choice.checked).map(choice => choice.value), ['clay']);
  assert.deepEqual([chosen[4].label, chosen[4].checked], ['Automatic · Daisy', false]);
});

test(`a sign's menu moves the whole plot to another project or to none, and sends it to Undermap`, () => {
  const actions = plotMenuActions(true, undefined, undefined, [{ id: 'billing', title: 'Billing', current: true }, { id: 'docs', title: 'Docs', current: false }]);
  assert.deepEqual(actions.map(action => action.label), ['Select items', 'Rename plot…', 'Name automatically', 'Move plot to', 'Send plot to Undermap', 'Hide this plot']);
  const move = actions.find(action => action.label === 'Move plot to')!;
  assert.equal(move.divider, true);
  assert.deepEqual(move.children!.map(child => [child.id, child.label, child.checked, child.disabled, child.divider]), [
    ['send:billing', 'Billing', true, true, undefined], ['send:docs', 'Docs', false, undefined, undefined], ['plot-leave', 'No project', undefined, undefined, true]]);
  assert.equal(actions.find(action => action.label === 'Send plot to Undermap')!.id, 'plot-below');
});

test(`a sign's menu names the colors of its project's neighborhood`, () => {
  const desert = plotMenuActions(true, { color: 'sky' }, '#e3c55a');
  assert.deepEqual(desert[3].row!.map(choice => [choice.value, choice.label, choice.swatch]), [
    ['rose', 'Dune', '#f8f0d8'], ['sky', 'Cactus', '#5f9a54'], ['citron', 'Terracotta', '#c8623f'], ['orchid', 'Turquoise', '#4fb6b0'], ['clay', 'Dusk', '#b88ab8'], ['slate', 'Driftwood', '#9a7a4a']]);
  assert.equal(desert[4].label, 'Automatic · Cactus');
  assert.deepEqual(plotMenuActions(true, { color: 'slate', chosenColor: 'rose' }, '#5b7fd6').slice(3, 5).map(action => action.label), ['Color', 'Automatic · Abyss']);
  assert.deepEqual(plotMenuActions(true, { color: 'rose' }, '#3366cc')[3].row!.map(choice => choice.label), ['Sky', 'Blue', 'Teal', 'Violet', 'Green', 'Magenta'], 'a custom color');
});

test('menu groups that depend on a package setting appear only while it is on, using declared defaults', () => {
  const groups = [{ id: 'always', label: 'Always', children: [] }, { id: 'tags', label: 'Tags', children: [], when: { plugin: 'acme', setting: 'enabled' } }];
  const descriptions = [{ settingsSections: [{ owner: 'acme', typeId: 'acme.widget', label: 'Acme', fields: { enabled: { label: 'Enabled', kind: 'boolean' as const, default: false } } }] }];
  assert.deepEqual(enabledMenuGroups(groups, pluginSettingsValues(descriptions, {})).map(group => group.id), ['always']);
  assert.deepEqual(enabledMenuGroups(groups, pluginSettingsValues(descriptions, { acme: { enabled: true } })).map(group => group.id), ['always', 'tags']);
  assert.deepEqual(enabledMenuGroups(groups, {}).map(group => group.id), ['always'], 'an unknown package setting counts as off');
});

test('map items offer Move to project with every map project, the current one checked and unavailable', () => {
  const targets = [{ id: 'billing', title: 'Billing', current: true }, { id: 'docs', title: 'Docs', current: false }];
  const move = moveToProjectAction(targets);
  assert.deepEqual(move, { id: 'send-project', label: 'Move to project', children: [{ id: 'send:billing', label: 'Billing', checked: true, disabled: true }, { id: 'send:docs', label: 'Docs', checked: false }] });
  assert.deepEqual(moveToProjectAction(targets.map(target => ({ ...target, current: false }))).children?.map(child => [child.checked, child.disabled]), [[false, undefined], [false, undefined]], 'a floating item has none checked');
  assert.deepEqual(moveToProjectAction([]).children, [{ id: 'send:', label: 'No projects yet', disabled: true }]);
  assert.deepEqual(contextMenuActions('item', false, undefined, [], undefined, undefined, undefined, false, undefined, move).map(action => [action.label, Boolean(action.divider)]),
    [['Open', false], ['Connect to…', false], ['Settings', true], ['Move to project', true], ['Mark done', false], ['Send to Undermap', false]]);
  assert.ok(!contextMenuActions('project', false, undefined, [], undefined, undefined, undefined, false, undefined, move).some(action => action.id === 'send-project'));
  assert.ok(!contextMenuActions('item', false, undefined, [], undefined, {}, undefined, false, undefined, move).some(action => action.id === 'send-project'), 'not in Undermap');
});

test('a selection of items offers Move to project once; a selection with a project does not', () => {
  const move = moveToProjectAction([{ id: 'billing', title: 'Billing', current: false }]);
  const item = contextMenuActions('item', false, undefined, [], undefined, undefined, undefined, false, undefined, move), project = contextMenuActions('project', false, undefined, [], undefined, undefined, undefined, false, undefined, move);
  assert.deepEqual(sharedContextMenuActions([item, item]).map(action => action.label), ['Move to project', 'Mark done', 'Send selection to Undermap']);
  assert.deepEqual(sharedContextMenuActions([item, item])[0].children, move.children);
  assert.deepEqual(sharedContextMenuActions([item, project]).map(action => action.label), ['Mark done', 'Send selection to Undermap']);
});

test('the to-do list row keeps Send to project', () => {
  assert.deepEqual(sendToProjectAction([{ id: 'docs', title: 'Docs', current: false }]), { id: 'send-project', label: 'Send to project', children: [{ id: 'send:docs', label: 'Docs', checked: false }] });
});

test('a project offers Mute above Send project to Undermap, and Unmute while muted; never in Undermap or on items', () => {
  const menu = (scope: 'project' | 'item' | 'neighborhood', mute: ReturnType<typeof muteProjectAction>, below?: object) => contextMenuActions(scope, false, undefined, [], undefined, below, undefined, false, undefined, undefined, mute).map(action => action.label);
  assert.deepEqual(menu('project', muteProjectAction(false)), ['Project settings…', 'Mark done', 'Mute project', 'Send project to Undermap']);
  assert.deepEqual(menu('project', muteProjectAction(false, 2)), ['Project settings…', 'Mark done', 'Mute project (Needs me: 2)', 'Send project to Undermap']);
  assert.equal(muteProjectAction(false, 1).label, 'Mute project (Needs me: 1)');
  assert.deepEqual(menu('project', muteProjectAction(true, 2)), ['Project settings…', 'Mark done', 'Unmute project', 'Send project to Undermap']);
  assert.deepEqual([muteProjectAction(false).id, muteProjectAction(true).id], ['mute', 'unmute']);
  assert.deepEqual(menu('neighborhood', muteProjectAction(false)), ['New item', 'Mute project']);
  assert.ok(!menu('item', muteProjectAction(false)).some(label => /mute/i.test(label)));
  assert.ok(!menu('project', muteProjectAction(true), {}).some(label => /mute/i.test(label)), 'Undermap draws no cover');
});

test('a generic link offers Convert to the type that claims its URL, next to opening it; never in Undermap, on projects or selections', () => {
  const convert = convertLinkActions([{ pluginId: 'notion.page', name: 'Notion page' }]);
  assert.deepEqual(convert, [{ id: 'convert:notion.page', label: 'Convert to Notion page' }]);
  const web = { label: 'Open in browser' }, menu = (scope: 'item' | 'project', below?: object) => contextMenuActions(scope, false, undefined, [], undefined, below, web, false, undefined, undefined, undefined, convert);
  assert.deepEqual(menu('item').map(action => [action.label, Boolean(action.divider)]),
    [['Open', false], ['Connect to…', false], ['Open in browser', true], ['Copy URL', false], ['Convert to Notion page', false], ['Settings', false], ['Mark done', true], ['Send to Undermap', false]]);
  assert.ok(!menu('item', {}).some(action => action.id.startsWith('convert:')));
  assert.ok(!menu('project').some(action => action.id.startsWith('convert:')));
  assert.ok(!sharedContextMenuActions([menu('item'), menu('item')]).some(action => action.id.startsWith('convert:')));
  assert.deepEqual(convertLinkActions([]), []);
  assert.deepEqual(convertLinkActions([{ pluginId: 'a.one', name: 'One' }, { pluginId: 'b.two', name: 'Two' }]).map(action => action.label), ['Convert to One', 'Convert to Two'], 'equally specific types stay an explicit choice');
});

test('items with a web page offer Copy URL right after "Open on …", on the map and in Undermap; one item or a whole selection', () => {
  const web = { label: 'Open on GitHub' }, menu = (scope: 'item' | 'project', below?: object, link: typeof web | null = web) => contextMenuActions(scope, false, undefined, [], undefined, below, link ?? undefined);
  assert.deepEqual(menu('item').map(action => [action.id, action.label, Boolean(action.divider)]),
    [['open', 'Open', false], ['connect', 'Connect to…', false], ['open-web', 'Open on GitHub', true], ['copy-url', 'Copy URL', false], ['settings', 'Settings', false], ['complete', 'Mark done', true], ['below', 'Send to Undermap', false]]);
  assert.deepEqual(menu('item', {}).map(action => action.id), ['surface', 'open-web', 'copy-url', 'edit', 'archive']);
  assert.ok(!menu('item', undefined, null).some(action => action.id === 'copy-url'), 'no web page, no Copy URL');
  assert.ok(!menu('project').some(action => action.id === 'copy-url'));
  assert.ok(!menu('item').find(action => action.id === 'copy-url')!.remote, 'copying writes nowhere');
  assert.deepEqual(sharedContextMenuActions([menu('item'), menu('item')]).map(action => [action.id, action.label]), [['copy-url', 'Copy URLs'], ['complete', 'Mark done'], ['below', 'Send selection to Undermap']]);
  assert.ok(!sharedContextMenuActions([menu('item'), menu('item', undefined, null)]).some(action => action.id === 'copy-url'), 'only when every selected item has a web page');
});

test('an earlier saved order (ids only) is merged with the defaults: unknown ids ignored, missing ones kept at their default relative position', () => {
  const defaults = ['open', 'connect', 'open-web', 'copy-url', 'edit', 'complete', 'below'];
  assert.deepEqual(mergeMenuOrder(defaults, []), defaults);
  assert.deepEqual(mergeMenuOrder(defaults, ['copy-url', 'open', 'connect', 'open-web', 'edit', 'complete', 'below']), ['copy-url', 'open', 'connect', 'open-web', 'edit', 'complete', 'below']);
  assert.deepEqual(mergeMenuOrder(defaults, ['gone', 'below', 'plugin:removed', 'open']), ['below', 'open', 'connect', 'open-web', 'copy-url', 'edit', 'complete'], 'unknown ids are ignored; the rest follow their default predecessor');
  assert.deepEqual(mergeMenuOrder(defaults, ['open-web', 'open', 'connect', 'edit', 'complete', 'below']), ['open-web', 'copy-url', 'open', 'connect', 'edit', 'complete', 'below'], 'an entry added after the order was saved follows its default predecessor');
  assert.deepEqual(mergeMenuOrder(defaults, ['edit', 'connect']), ['open', 'edit', 'complete', 'below', 'connect', 'open-web', 'copy-url'], 'a missing first entry stays first');
  assert.deepEqual(mergeMenuOrder(defaults, ['edit', 'edit', 'open']), ['edit', 'complete', 'below', 'open', 'connect', 'open-web', 'copy-url'], 'a repeated id counts once');
  assert.deepEqual(mergeMenuOrder(defaults, ['reopen', 'open']), ['complete', 'below', 'open', 'connect', 'open-web', 'copy-url', 'edit'], 'a saved variant id means its slot');
});

test('state-dependent entries share one slot, so both variants take the same position', () => {
  assert.deepEqual(['complete', 'reopen', 'add-todo', 'remove-todo', 'convert:notion.page', 'convert:linear.issue', 'mute', 'unmute', 'open', 'plugin:merge'].map(menuSlot),
    ['complete', 'complete', 'add-todo', 'add-todo', 'convert', 'convert', 'mute', 'mute', 'open', 'plugin:merge']);
  for (const custom of [{ order: ['complete', 'add-todo', 'open'] }, { layout: ['reopen', 'below', 'remove-todo', 'open', 'connect', 'edit'] }]) {
    const menu = (completed: boolean, enabled: boolean) => contextMenuActions('item', completed, undefined, [], { enabled }, undefined, undefined, false, undefined, undefined, undefined, [], custom).map(action => action.id);
    assert.deepEqual(menu(false, false), ['complete', 'below', 'add-todo', 'open', 'connect', 'settings']);
    assert.deepEqual(menu(true, true), ['reopen', 'below', 'remove-todo', 'open', 'connect', 'settings']);
  }
  const convert = convertLinkActions([{ pluginId: 'a.one', name: 'One' }, { pluginId: 'b.two', name: 'Two' }]);
  assert.deepEqual(contextMenuActions('item', false, undefined, [], undefined, undefined, { label: 'Open in browser' }, false, undefined, undefined, undefined, convert, { layout: ['convert', 'open'] }).map(action => action.id),
    ['convert:a.one', 'convert:b.two', 'settings', 'complete', 'below', 'open', 'connect', 'open-web', 'copy-url'], 'entries of one slot stay together in their default order');
});

const PR = [false, undefined, githubPullRequest.contextMenu, { enabled: false }, undefined, { label: 'Open on GitHub' }, true, undefined, moveToProjectAction([])] as const;
const prMenu = (custom?: Parameters<typeof contextMenuActions>[12]) => contextMenuActions('item', ...PR, undefined, [], custom);

test('the default layout holds a separator at each default group boundary and draws the menus unchanged', () => {
  assert.equal(MENU_SEPARATOR, '---');
  assert.equal(menuSlot(MENU_SEPARATOR), MENU_SEPARATOR);
  assert.deepEqual(itemMenuEntries({ name: 'Note' }), [{ id: 'open', label: 'Open' }, { id: 'connect', label: 'Connect to…' }, { id: '---', label: 'Separator', separator: true }, { id: 'edit', label: 'Settings' },
    { id: '---', label: 'Separator', separator: true }, { id: 'send-project', label: 'Move to project' }, { id: 'complete', label: 'Mark done / Reopen' }, { id: 'below', label: 'Send to Undermap' }]);
  const layout = itemMenuEntries({ ...githubPullRequest, todoSupport: {}, activityTitle: {} }).map(entry => entry.id);
  assert.deepEqual(layout, ['open', 'connect', '---', 'plugin:review', 'plugin:reviewLoop', 'plugin:architecture', 'plugin:merge', 'plugin:autoDeploy', 'plugin:state', 'plugin:showShip', '---', 'open-web', 'copy-url', 'edit', '---', 'send-project', 'add-todo', 'auto-title', 'complete', 'below']);
  assert.deepEqual(prMenu().map(action => [action.label, Boolean(action.divider)]), [
    ['Open', false], ['Connect to…', false],
    ['Trigger review', true], ['Review loop', false], ['Explain architecture', false], ['Merge…', false], ['Auto deploy', false], ['Change state', false], ['Show/Ship', false],
    ['Open on GitHub', true], ['Copy URL', false], ['Settings', false],
    ['Move to project', true], ['Turn into todo', false], ['Auto-name from activity', false], ['Mark done', false], ['Send to Undermap', false],
  ]);
  for (const custom of [{}, { layout: [] }, { order: [] }, { layout }, { layout: ['nothing', '---', 'known'] }, { order: ['nothing', 'known'] }, { order: prMenu().map(action => action.id) }])
    assert.deepEqual(prMenu(custom), prMenu(), JSON.stringify(custom).slice(0, 40));
  // The whole type's default layout also draws every state of the menu as before: groups a state lacks leave no line behind.
  const states: ((custom?: { layout: string[] }) => ReturnType<typeof contextMenuActions>)[] = [
    custom => contextMenuActions('item', true, undefined, [], undefined, undefined, undefined, false, undefined, undefined, undefined, [], custom),
    custom => contextMenuActions('item', false, 'Edit note…', githubPullRequest.contextMenu, { enabled: true }, undefined, undefined, false, undefined, undefined, undefined, [], custom),
    custom => contextMenuActions('item', true, undefined, [], undefined, undefined, { label: 'Open on GitHub' }, true, undefined, undefined, undefined, [], custom),
  ];
  for (const state of states) assert.deepEqual(state({ layout }), state());
});

test('an item menu follows the saved layout: entries and separators where the user put them', () => {
  const ids = prMenu().map(action => action.id);
  const moved = prMenu({ layout: ['copy-url', 'open', 'connect', '---', ...ids.filter(id => !['copy-url', 'open', 'connect'].includes(id))] });
  assert.deepEqual(moved.map(action => [action.label, Boolean(action.divider)]), [
    ['Copy URL', false], ['Open', false], ['Connect to…', false],
    ['Trigger review', true], ['Review loop', false], ['Explain architecture', false], ['Merge…', false], ['Auto deploy', false], ['Change state', false], ['Show/Ship', false], ['Open on GitHub', false], ['Settings', false],
    ['Move to project', false], ['Turn into todo', false], ['Auto-name from activity', false], ['Mark done', false], ['Send to Undermap', false],
  ], 'only the saved separator is drawn');
  assert.deepEqual(moved.find(action => action.id === 'plugin:review')?.children, prMenu().find(action => action.id === 'plugin:review')?.children, 'a submenu keeps its inner order');
  assert.deepEqual(prMenu({ layout: ids }).filter(action => action.divider), [], 'a layout without separators draws none');
  const note = (layout: string[]) => contextMenuActions('item', false, undefined, [], undefined, undefined, undefined, false, undefined, undefined, undefined, [], { layout }).map(action => [action.id, Boolean(action.divider)]);
  assert.deepEqual(note(['open', '---', 'below', '---', 'connect', 'edit', 'complete']), [['open', false], ['below', true], ['connect', true], ['settings', false], ['complete', false]]);
});

test('a menu never draws a leading, trailing or doubled separator, also where entries are missing', () => {
  assert.deepEqual(drawnMenuLayout(['---', '---', 'open', '---', '---', '---', 'edit', 'below', '---']), ['open', '---', 'edit', 'below']);
  assert.deepEqual(drawnMenuLayout(['---', '---']), []);
  assert.deepEqual(drawnMenuLayout([]), []);
  const note = (layout: string[]) => contextMenuActions('item', false, undefined, [], undefined, undefined, undefined, false, undefined, undefined, undefined, [], { layout }).map(action => [action.id, Boolean(action.divider)]);
  assert.deepEqual(note(['---', 'open', '---', '---', 'connect', 'edit', 'complete', 'below', '---']), [['open', false], ['connect', true], ['settings', false], ['complete', false], ['below', false]]);
  assert.deepEqual(note(['open', '---', 'open-web', 'copy-url', '---', 'plugin:gone', '---', 'connect', 'edit', 'complete', '---', 'auto-title', 'below']),
    [['open', false], ['connect', true], ['settings', false], ['complete', false], ['below', true]], 'separators around entries this item does not have fold into one');
});

test('an entry the saved layout does not name follows its default predecessor and brings no separator', () => {
  const defaults = ['open', 'connect', '---', 'plugin:new', '---', 'open-web', 'copy-url', 'edit', '---', 'complete', 'below'];
  assert.deepEqual(menuLayout(defaults), defaults);
  assert.deepEqual(menuLayout(defaults, { layout: ['below', '---', 'open-web', 'edit', '---', 'open', 'connect', 'complete'] }),
    ['below', '---', 'open-web', 'copy-url', 'edit', '---', 'open', 'connect', 'plugin:new', 'complete'], 'Copy URL after Open on …, the new provider group after Connect, in its block');
  assert.deepEqual(menuLayout(defaults, { layout: ['---', 'edit', 'connect'] }), ['open', '---', 'edit', 'complete', 'below', 'connect', 'plugin:new', 'open-web', 'copy-url'], 'a missing first entry stays first');
  assert.deepEqual(menuLayout(defaults, { layout: ['edit', 'gone', 'edit', 'reopen', '---', 'plugin:removed'] }), ['open', 'connect', 'plugin:new', 'open-web', 'copy-url', 'edit', 'complete', 'below', '---'], 'unknown ids are ignored, a repeated id counts once, a variant means its slot');
  assert.equal(menuLayout(defaults, { layout: ['edit', 'gone', 'edit', '---', '---'] }).filter(id => id === '---').length, 2, 'saved separators are kept as placed');
  assert.equal(menuLayout(defaults, { layout: ['open'], order: ['below'] })[0], 'open', 'a layout wins over an earlier order');
});

test('an earlier saved order converts to a layout with the separators it used to draw, so the menu is unchanged', () => {
  const ids = prMenu().map(action => action.id), order = ['copy-url', ...ids.filter(id => id !== 'copy-url')];
  assert.deepEqual(prMenu({ order }).map(action => [action.label, Boolean(action.divider)]), [
    ['Copy URL', false],
    ['Open', true], ['Connect to…', false],
    ['Trigger review', true], ['Review loop', false], ['Explain architecture', false], ['Merge…', false], ['Auto deploy', false], ['Change state', false], ['Show/Ship', false],
    ['Open on GitHub', true], ['Settings', false],
    ['Move to project', true], ['Turn into todo', false], ['Auto-name from activity', false], ['Mark done', false], ['Send to Undermap', false],
  ]);
  const mixed = contextMenuActions('item', false, undefined, [], undefined, undefined, undefined, false, undefined, undefined, undefined, [], { order: ['open', 'below', 'connect'] });
  assert.deepEqual(mixed.map(action => [action.id, Boolean(action.divider)]), [['open', false], ['below', true], ['connect', true], ['settings', true], ['complete', true]]);
  const type = { ...githubPullRequest, todoSupport: {}, activityTitle: {} }, converted = itemMenuEntries(type, { order }).map(entry => entry.id);
  assert.deepEqual(converted, ['copy-url', '---', 'open', 'connect', '---', 'plugin:review', 'plugin:reviewLoop', 'plugin:architecture', 'plugin:merge', 'plugin:autoDeploy', 'plugin:state', 'plugin:showShip', '---', 'open-web', 'edit', '---', 'send-project', 'add-todo', 'auto-title', 'complete', 'below']);
  assert.deepEqual(prMenu({ layout: converted }), prMenu({ order }), 'saved in the new shape, it draws the same menu');
  assert.deepEqual(itemMenuEntries({ name: 'Note' }, { order: ['below', 'open'] }).map(entry => entry.id), ['below', '---', 'open', 'connect', '---', 'edit', '---', 'send-project', 'complete']);
});

test('a saved menu never changes projects, boards, connections or Undermap menus', () => {
  const custom = { order: ['below', 'complete', 'edit', 'archive', 'surface'], layout: ['below', '---', 'complete', '---', 'edit', 'archive', 'surface'] };
  const menu = (scope: Parameters<typeof contextMenuActions>[0], below?: object, saved?: typeof custom) => contextMenuActions(scope, false, undefined, [], undefined, below, undefined, false, undefined, undefined, undefined, [], saved);
  for (const scope of ['project', 'board', 'neighborhood', 'link'] as const) assert.deepEqual(menu(scope, undefined, custom), menu(scope));
  assert.deepEqual(menu('item', {}, custom), menu('item', {}));
  assert.deepEqual(menu('project').map(action => [action.id, Boolean(action.divider)]), [['edit', false], ['complete', true], ['below', false]]);
});

test('every item type lists its possible menu entries, one per slot, with its separators, for Settings', () => {
  const labels = (rows: ReturnType<typeof itemMenuEntries>) => rows.filter(row => !row.separator).map(row => row.label);
  assert.deepEqual(labels(itemMenuEntries(githubPullRequest)),
    ['Open', 'Connect to…', 'Trigger review', 'Review loop', 'Explain architecture', 'Merge…', 'Auto deploy', 'Change state', 'Show/Ship', 'Open on GitHub', 'Copy URL', 'Settings', 'Move to project', 'Mark done / Reopen', 'Send to Undermap']);
  const everything = itemMenuEntries({ name: 'Web link', generatedTitle: true, webLink: { label: 'Open in browser' }, todoSupport: {}, activityTitle: {}, creation: { urlFallback: true }, contextMenu: [{ id: 'tags', label: 'Tags', children: [], when: { plugin: 'acme', setting: 'on' } }] });
  assert.deepEqual(everything.map(entry => [entry.id, entry.label]), [['open', 'Open'], ['connect', 'Connect to…'], ['---', 'Separator'], ['plugin:tags', 'Tags'], ['---', 'Separator'], ['open-web', 'Open in browser'], ['copy-url', 'Copy URL'], ['convert', 'Convert to a specific type'], ['edit', 'Settings'],
    ['---', 'Separator'], ['send-project', 'Move to project'], ['add-todo', 'Turn into todo / Remove from to-dos'], ['auto-title', 'Auto-name from activity'], ['complete', 'Mark done / Reopen'], ['below', 'Send to Undermap']]);
  const slots = everything.filter(entry => !entry.separator);
  assert.equal(new Set(slots.map(entry => entry.id)).size, slots.length);
  assert.deepEqual(itemMenuEntries({ name: 'Note' }, { layout: ['below', '---', '---', 'open'] }).map(entry => entry.id), ['below', '---', '---', 'open', 'connect', 'edit', 'send-project', 'complete'], 'the saved rows as placed, doubled separators included');
  assert.equal(itemEditLabel({ name: 'Note', generatedTitle: true }), 'Edit note…');
  assert.equal(itemEditLabel(undefined), 'Item settings…');
});

test('rows move by place, separators included; a separator can be added or removed, an entry never', () => {
  const layout = ['open', 'connect', '---', 'edit', '---', 'below'];
  assert.deepEqual(moveMenuRow(layout, 2, 0), ['---', 'open', 'connect', 'edit', '---', 'below']);
  assert.deepEqual(moveMenuRow(layout, 2, 3), ['open', 'connect', 'edit', '---', '---', 'below'], 'next to another separator');
  assert.deepEqual(moveMenuRow(layout, 5, 0), ['below', 'open', 'connect', '---', 'edit', '---']);
  assert.deepEqual(moveMenuRow(layout, 0, 99), ['connect', '---', 'edit', '---', 'below', 'open'], 'a target past the end is the end');
  assert.deepEqual(moveMenuRow(layout, 3, -4), ['edit', 'open', 'connect', '---', '---', 'below']);
  for (const from of [-1, 6, 1.5, Number.NaN]) assert.deepEqual(moveMenuRow(layout, from, 0), layout, `no row at ${from}`);
  assert.deepEqual(layout, ['open', 'connect', '---', 'edit', '---', 'below'], 'the given layout is not changed');
  assert.deepEqual(addMenuSeparator(layout), [...layout, '---']);
  assert.deepEqual(addMenuSeparator(layout, 0), ['open', '---', 'connect', '---', 'edit', '---', 'below']);
  assert.deepEqual(addMenuSeparator(layout, 99), [...layout, '---']);
  assert.deepEqual(addMenuSeparator([]), ['---']);
  assert.deepEqual(removeMenuSeparator(layout, 2), ['open', 'connect', 'edit', '---', 'below']);
  assert.deepEqual(removeMenuSeparator(layout, 4), ['open', 'connect', '---', 'edit', 'below']);
  assert.deepEqual(removeMenuSeparator(layout, 0), layout, 'an entry is not removed');
  assert.deepEqual(removeMenuSeparator(layout, 9), layout);
});

test('saving a type’s rows stores a layout, drops its earlier order and stores nothing for the default menu', () => {
  const defaults = ['open', 'connect', '---', 'edit', '---', 'complete', 'below'];
  const menus = { order: { note: ['below', 'open'], 'acme.other': ['edit'] }, layout: { 'acme.kept': ['edit', '---', 'open'] }, hidden: {} };
  assert.deepEqual(itemMenuCustom(menus, 'note'), { layout: undefined, order: ['below', 'open'], hidden: undefined });
  assert.deepEqual(itemMenuCustom(undefined, 'note'), { layout: undefined, order: undefined, hidden: undefined });
  assert.equal(isCustomMenu(defaults, itemMenuCustom(menus, 'note')), true);
  assert.equal(isCustomMenu(defaults), false);
  assert.equal(isCustomMenu(defaults, { layout: defaults }), false);
  assert.equal(isCustomMenu(defaults, { order: ['open', 'connect', 'edit', 'complete', 'below'] }), false, 'the default order saved earlier is the default menu');
  assert.equal(isCustomMenu(defaults, { layout: defaults.filter(id => id !== '---') }), true, 'removing every separator is a change');
  assert.equal(isCustomMenu(defaults, { layout: [...defaults, '---'] }), true);
  const moved = moveMenuRow(menuLayout(defaults, itemMenuCustom(menus, 'note')), 1, 0);
  assert.deepEqual(moved, ['---', 'below', 'open', 'connect', '---', 'edit', '---', 'complete']);
  assert.deepEqual(saveItemMenu(menus, 'note', defaults, moved), { order: { 'acme.other': ['edit'] }, layout: { 'acme.kept': ['edit', '---', 'open'], note: moved }, hidden: {} });
  assert.deepEqual(saveItemMenu(menus, 'note', defaults, defaults), { order: { 'acme.other': ['edit'] }, layout: { 'acme.kept': ['edit', '---', 'open'] }, hidden: {} });
  assert.deepEqual(resetItemMenu(menus, 'acme.kept'), { order: menus.order, layout: {}, hidden: {} });
  assert.deepEqual(menus, { order: { note: ['below', 'open'], 'acme.other': ['edit'] }, layout: { 'acme.kept': ['edit', '---', 'open'] }, hidden: {} }, 'the given settings are not changed');
});

test('a hidden slot leaves the single item menu with all its variants and its submenu; its place is kept', () => {
  const ids = (actions: ReturnType<typeof contextMenuActions>) => actions.map(action => action.id);
  const note = (completed: boolean, custom: Parameters<typeof contextMenuActions>[12]) => ids(contextMenuActions('item', completed, undefined, [], { enabled: completed }, undefined, undefined, false, undefined, moveToProjectAction([]), undefined, [], custom));
  for (const hidden of [['complete'], ['reopen'], ['complete', 'reopen', 'complete']]) {
    assert.deepEqual(note(false, { hidden }), ['open', 'connect', 'settings', 'send-project', 'add-todo', 'below']);
    assert.deepEqual(note(true, { hidden }), ['open', 'connect', 'settings', 'send-project', 'remove-todo', 'below'], 'Reopen goes with Mark done');
  }
  assert.deepEqual(note(true, { hidden: ['remove-todo', 'send-project'] }), ['open', 'connect', 'settings', 'reopen', 'below'], 'a submenu parent takes its submenu along');
  assert.ok(!prMenu({ hidden: ['plugin:review'] }).some(action => action.id === 'plugin:review' || action.children?.some(child => child.id === 'plugin:review.claude')));
  assert.deepEqual(note(false, { hidden: ['gone', 'plugin:removed', '---'] }), note(false, {}), 'ids the menu does not have hide nothing');
  assert.deepEqual(note(false, { layout: ['below', 'complete', '---', 'open'], hidden: ['complete'] }), ['below', 'open', 'connect', 'settings', 'send-project', 'add-todo']);
  const rows = itemMenuEntries({ name: 'Note' }, { layout: ['below', 'complete', '---', 'open'], hidden: ['reopen', 'open'] });
  assert.deepEqual(rows.map(row => [row.id, Boolean(row.hidden)]), [['below', false], ['complete', true], ['---', false], ['open', true], ['connect', false], ['edit', false], ['send-project', false]], 'Settings keeps hidden rows where they are');
  assert.deepEqual(itemMenuEntries({ name: 'Note' }, { hidden: ['edit'] }).map(row => row.id), itemMenuEntries({ name: 'Note' }).map(row => row.id));
});

test('separators next to hidden entries fold: never a doubled, leading or trailing line', () => {
  const lines = (custom: Parameters<typeof contextMenuActions>[12]) => prMenu(custom).map(action => [action.label, Boolean(action.divider)]);
  assert.deepEqual(lines({ hidden: ['plugin:review', 'plugin:reviewLoop', 'plugin:architecture', 'plugin:merge', 'plugin:autoDeploy', 'plugin:state', 'plugin:showShip'] }), [
    ['Open', false], ['Connect to…', false],
    ['Open on GitHub', true], ['Copy URL', false], ['Settings', false],
    ['Move to project', true], ['Turn into todo', false], ['Auto-name from activity', false], ['Mark done', false], ['Send to Undermap', false],
  ], 'a wholly hidden group leaves one line');
  assert.deepEqual(lines({ hidden: ['open', 'connect', 'send-project', 'add-todo', 'auto-title', 'complete', 'below'] }), [
    ['Trigger review', false], ['Review loop', false], ['Explain architecture', false], ['Merge…', false], ['Auto deploy', false], ['Change state', false], ['Show/Ship', false],
    ['Open on GitHub', true], ['Copy URL', false], ['Settings', false],
  ], 'no line above the first or below the last entry');
  assert.deepEqual(drawnMenuLayout(['open', '---', 'edit', '---', 'copy-url', '---', 'below'], ['edit', 'copy-url']), ['open', '---', 'below']);
  assert.deepEqual(drawnMenuLayout(['open', '---', 'reopen'], ['complete']), ['open']);
  assert.deepEqual(drawnMenuLayout(['open', '---', 'edit'], ['---']), ['open', '---', 'edit'], 'a separator is removed, not hidden');
});

test('hiding applies to one item on the map only, and a menu is never left empty', () => {
  const hidden = ['edit', 'complete', 'below', 'archive', 'surface', 'open-web', 'copy-url'];
  const menu = (scope: Parameters<typeof contextMenuActions>[0], below?: object, custom?: Parameters<typeof contextMenuActions>[12]) => contextMenuActions(scope, false, undefined, [], undefined, below, { label: 'Open on GitHub' }, false, undefined, undefined, undefined, [], custom);
  for (const scope of ['project', 'board', 'neighborhood', 'link'] as const) assert.deepEqual(menu(scope, undefined, { hidden }), menu(scope));
  assert.deepEqual(menu('item', {}, { hidden }), menu('item', {}), 'Undermap keeps Item settings, Copy URL and the rest');
  assert.deepEqual(menu('item', undefined, { hidden }).map(action => action.id), ['open', 'connect']);
  const shown = menu('item');
  assert.deepEqual(sharedContextMenuActions([shown, shown]).map(action => action.id), ['copy-url', 'complete', 'below'], 'a selection menu is built from menus that hide nothing');
  assert.deepEqual(menu('item', undefined, { hidden: shown.map(action => action.id) }), shown, 'hiding every entry this item has hides none');
  assert.deepEqual(drawnMenuLayout(['open', '---', 'edit'], ['open', 'edit']), ['open', '---', 'edit']);
});

test('the last visible entry of a type cannot be hidden; hiding and showing work by slot', () => {
  const layout = ['open', 'connect', '---', 'complete'];
  assert.equal(canHideMenuEntry(layout, [], 'open'), true);
  assert.equal(canHideMenuEntry(layout, ['open', 'connect'], 'complete'), false);
  assert.equal(canHideMenuEntry(layout, ['open', 'connect'], 'reopen'), false);
  assert.equal(canHideMenuEntry(layout, ['open', 'gone', 'unknown'], 'connect'), true, 'hidden ids the menu does not have do not count');
  assert.equal(canHideMenuEntry(layout, ['open'], '---'), false);
  assert.equal(canHideMenuEntry(layout, ['open'], 'unknown'), false);
  assert.deepEqual(setMenuEntryHidden(layout, [], 'reopen', true), ['complete']);
  assert.deepEqual(setMenuEntryHidden(layout, ['complete'], 'complete', true), ['complete']);
  assert.deepEqual(setMenuEntryHidden(layout, ['open', 'connect'], 'complete', true), ['open', 'connect'], 'refused');
  assert.deepEqual(setMenuEntryHidden(layout, ['open', 'gone', 'reopen'], 'complete', false), ['open', 'gone'], 'shown again; other ids are kept');
  assert.deepEqual(setMenuEntryHidden(layout, ['open'], 'connect', false), ['open']);
});

test('hidden slots are saved per type, make the menu custom, and Reset shows everything again', () => {
  const defaults = ['open', 'connect', '---', 'edit', '---', 'complete', 'below'];
  const menus = { order: { note: ['below', 'open'] }, layout: {}, hidden: { 'acme.other': ['edit'] } };
  assert.equal(isCustomMenu(defaults, { hidden: ['edit'] }), true);
  assert.equal(isCustomMenu(defaults, { hidden: ['reopen'] }), true);
  assert.equal(isCustomMenu(defaults, { hidden: ['gone'] }), false, 'hiding something the menu does not have changes nothing');
  assert.deepEqual(saveItemMenu(menus, 'bookmark', defaults, defaults, ['reopen', 'edit', 'complete']), { order: menus.order, layout: {}, hidden: { 'acme.other': ['edit'], bookmark: ['complete', 'edit'] } }, 'default rows with hidden entries save only the hidden list');
  const converted = menuLayout(defaults, itemMenuCustom(menus, 'note'));
  assert.deepEqual(saveItemMenu(menus, 'note', defaults, converted, ['edit']), { order: {}, layout: { note: converted }, hidden: { 'acme.other': ['edit'], note: ['edit'] } }, 'an earlier order becomes a layout when an entry is hidden');
  const saved = saveItemMenu(menus, 'note', defaults, converted, ['edit']);
  assert.deepEqual(itemMenuCustom(saved, 'note'), { layout: converted, order: undefined, hidden: ['edit'] });
  assert.deepEqual(saveItemMenu(saved, 'note', defaults, converted, []), { order: {}, layout: { note: converted }, hidden: { 'acme.other': ['edit'] } });
  assert.deepEqual(resetItemMenu(saved, 'note'), { order: {}, layout: {}, hidden: { 'acme.other': ['edit'] } });
});

test('map items keep their settings entry and Use size as default in one Settings submenu', () => {
  const settings = (actions: ReturnType<typeof contextMenuActions>) => actions.find(action => action.id === 'settings')!;
  const plain = contextMenuActions('item');
  assert.deepEqual(plain.map(action => action.label), ['Open', 'Connect to…', 'Settings', 'Mark done', 'Send to Undermap']);
  assert.deepEqual(settings(plain).children, [{ id: 'edit', label: 'Item settings…' }, { id: 'size-default', label: 'Use size as default' }]);
  assert.equal(settings(contextMenuActions('item', false, 'Edit note…')).children![0]!.label, 'Edit note…');
  const args = [[], undefined, undefined, undefined, false, undefined, undefined, undefined, []] as const;
  assert.deepEqual(settings(contextMenuActions('item', false, undefined, ...args, {}, { disabled: 'Already the default size for this type' })).children![1],
    { id: 'size-default', label: 'Use size as default', disabled: true, description: 'Already the default size for this type' });
  assert.equal(contextMenuActions('project').some(action => action.id === 'settings'), false);
  assert.deepEqual(contextMenuActions('item', false, undefined, [], undefined, {}).map(action => action.id), ['surface', 'edit', 'archive'], 'below the map the entry stays plain');
  assert.equal(menuSlot('settings'), 'edit', 'a menu saved before the submenu existed places and hides it');
  const custom = (value: Parameters<typeof contextMenuActions>[12]) => contextMenuActions('item', false, undefined, ...args, value).map(action => action.id);
  assert.deepEqual(custom({ layout: ['edit', '---', 'open'] }), ['settings', 'complete', 'below', 'open', 'connect']);
  assert.deepEqual(custom({ order: ['below', 'edit'] }), ['open', 'connect', 'below', 'settings', 'complete']);
  assert.deepEqual(custom({ hidden: ['edit'] }), ['open', 'connect', 'complete', 'below'], 'hiding the entry hides both');
  assert.deepEqual(itemMenuEntries({ name: 'Note', generatedTitle: true }).find(row => row.id === 'edit'), { id: 'edit', label: 'Settings' });
  assert.equal(sharedContextMenuActions([plain, plain]).some(action => action.id === 'settings'), false);
});

test('a to-do row offers Add context when it has none, and Show or Hide with Clear when it has', () => {
  const labels = (hasContext: boolean, shown: boolean) => todoContextActions(hasContext, shown).map(action => [action.id, action.label]);
  assert.deepEqual(labels(false, false), [['context-add', 'Add context…']]);
  assert.deepEqual(labels(true, false), [['context-show', 'Show context'], ['context-clear', 'Clear context']]);
  assert.deepEqual(labels(true, true), [['context-hide', 'Hide context'], ['context-clear', 'Clear context']]);
});

test('a plugin group that names selection children is offered to a selection of items that all have it, with those children only', () => {
  const review = { id: 'review', label: 'Trigger review', selection: { label: 'Review selection', children: ['review.claude', 'review.codex'] }, children: [
    { id: 'review.claude', label: 'Claude' }, { id: 'review.codex', label: 'Codex' }, { id: 'review.workflow', label: '/review' }] };
  const merge = { id: 'merge', label: 'Merge…', children: [{ id: 'merge.squash', label: 'Squash' }] };
  const pull = contextMenuActions('item', false, undefined, [review, merge]), ticket = contextMenuActions('item', false, undefined, [merge]);
  const shared = sharedContextMenuActions([pull, pull]);
  assert.deepEqual(shared.map(action => [action.id, action.label]), [['plugin:review', 'Review selection'], ['complete', 'Mark done'], ['below', 'Send selection to Undermap']]);
  assert.deepEqual(shared[0].children?.map(child => [child.id, child.label]), [['plugin:review.claude', 'Claude'], ['plugin:review.codex', 'Codex']]);
  assert.equal(shared[0].remote, true);
  assert.deepEqual(sharedContextMenuActions([pull, ticket]).map(action => action.id), ['complete', 'below'], 'an item without the group keeps the selection menu to shared actions');
});

test('a plugin entry that runs other entries carries their menu ids; the PR offers Claude + Codex alone and for a selection', () => {
  const review = contextMenuActions('item', false, undefined, [{ id: 'review', label: 'Trigger review', children: [{ id: 'review.claude', label: 'Claude' }, { id: 'review.both', label: 'Claude + Codex', runs: ['review.claude', 'review.codex'] }] }]).find(action => action.id === 'plugin:review')!;
  assert.deepEqual(review.children?.map(child => [child.id, child.runs]), [['plugin:review.claude', undefined], ['plugin:review.both', ['plugin:review.claude', 'plugin:review.codex']]]);
  const pull = githubPullRequest.contextMenu!.find(group => group.id === 'review')!;
  assert.deepEqual(pull.children.map(child => child.label), ['Claude', 'Codex', 'Claude + Codex', '/review']);
  assert.deepEqual(pull.children.find(child => child.id === 'review.both')!.runs, ['review.claude', 'review.codex']);
  assert.deepEqual(pull.selection!.children, ['review.claude', 'review.codex', 'review.both']);
});

test('Delete… asks inside its submenu: Cancel first, then the destructive Delete permanently with what stays', () => {
  const action = deleteItemAction();
  assert.deepEqual([action.id, action.label, action.destructive, action.divider], ['delete', 'Delete…', true, true]);
  assert.deepEqual(action.children!.map(child => [child.id, child.label, child.destructive]), [['delete-cancel', 'Cancel', undefined], ['delete-confirm', 'Delete permanently', true]]);
  assert.equal(action.children![1].description, 'Provider data and sessions are kept. This can’t be undone.');
});

test('a note offers Show as and its colour in its menu, the shown value checked, ahead of Settings', () => {
  const fields = fieldMenuActions(noteItem.fields, { text: 'S2' }, { display: 'badge' });
  assert.deepEqual(fields.map(action => [action.id, action.label]), [['field:paper', 'Colour'], ['field:display', 'Show as']]);
  assert.deepEqual(fields[0]!.row!.map(choice => [choice.value, choice.swatch, choice.checked]), [['mint', 'var(--act-paper-mint)', true], ['sky', 'var(--act-paper-sky)', false],
    ['lilac', 'var(--act-paper-lilac)', false], ['peach', 'var(--act-paper-peach)', false], ['slate', 'var(--act-paper-slate)', false]]);
  assert.deepEqual(fields[1]!.children!.map(child => [child.id, child.label, child.checked]), [['field:display:note', 'Note', false], ['field:display:badge', 'Badge', true]]);
  assert.equal(fieldMenuActions(noteItem.fields, { text: 'S2', paper: 'peach' })[0]!.row!.find(choice => choice.checked)!.value, 'peach');
  assert.deepEqual(fieldMenuActions(githubPullRequest.fields, {}), []);
  const menu = contextMenuActions('item', false, undefined, [], undefined, undefined, undefined, false, undefined, undefined, undefined, [], {}, undefined, {}, fields);
  assert.deepEqual(menu.map(action => action.id), ['open', 'connect', 'field:paper', 'field:display', 'settings', 'complete', 'below']);
  assert.ok(itemMenuEntries(noteItem).some(row => row.id === 'field:display' && row.label === 'Show as'), 'Settings can reorder and hide them');
});
