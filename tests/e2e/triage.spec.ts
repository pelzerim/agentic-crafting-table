import { test, expect, _electron as electron } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { linearProviders } from '../fixtures/linear.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { resize, scrollbarArgs } from './visual-fixture.ts';

const launch = (directory: string) => electron.launch({ args: ['.', '--force-device-scale-factor=1', '--disable-lcd-text', '--force-color-profile=srgb', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory, TZ: 'UTC' } });
const read = (page: Page) => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
async function open(app: Awaited<ReturnType<typeof launch>>) {
  const page = await app.firstWindow(); await resize(app, page, 1280, 800); await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.route(/^https?:\/\//, route => route.abort());
  const list = page.getByRole('form', { name: 'To-dos', exact: true });
  // A pinned list reopens with the app.
  await expect(page.getByRole('button', { name: /^(Keep to-dos open|Close to-dos)(: \d+ in the inbox)?$/ })).toBeVisible();
  if (await list.getAttribute('data-open') !== 'true') await page.getByRole('button', { name: /^Keep to-dos open/ }).click();
  await expect(list).toHaveAttribute('data-open', 'true');
  return { page, list };
}
/** The From Linear inbox, opened when it is folded to its count. */
async function inboxOf(list: Locator) {
  const inbox = list.getByRole('region', { name: 'From Linear', exact: true }), show = inbox.getByRole('button', { name: /^Show \d+ from Linear$/ });
  await expect(inbox).toBeVisible();
  if (await show.count()) await show.click();
  return inbox;
}
const seed = [
  { type: 'project.create', id: 'billing', title: 'Billing', summary: '', position: { x: 300, y: 300 } },
  { type: 'project.create', id: 'docs', title: 'Docs', summary: '', position: { x: 1500, y: 300 } },
  { type: 'item.add', id: 'existing', resourceId: 'existing-r', pluginId: 'workspace.todo', title: 'Existing billing work', data: {}, projectId: 'billing', position: { x: 520, y: 320 } },
  { type: 'item.add', id: 'guide', resourceId: 'guide-r', pluginId: 'workspace.todo', title: 'Existing docs work', data: {}, projectId: 'docs', position: { x: 1720, y: 320 } },
];

test('assigned Linear tickets wait in the From Linear inbox, survive restart, and are taken, dragged or sent to a project', async () => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-triage-journey-')), providers = linearProviders({ assigned: 3 });
  let service = await startWorkspaceService(directory, undefined, undefined, providers);
  await service.control.dispatch({ commandId: 'seed', expectedRevision: (await service.control.read()).revision, actor: { kind: 'user', id: 'fixture' }, commands: seed });
  let app = await launch(directory);
  try {
    let { page, list } = await open(app);
    await expect(list.locator('.todo-group').first()).toHaveAttribute('aria-label', 'From Linear');
    let inbox = list.getByRole('region', { name: 'From Linear', exact: true });
    // Folded to its count; the rail badge counts the tickets waiting there, not Next.
    await expect(inbox.locator('.todo-group-count')).toHaveText('3'); await expect(inbox.locator('.todo-row')).toHaveCount(0);
    await expect(list.locator('.todo-inbox-count')).toHaveText('3');
    inbox = await inboxOf(list);
    await expect(inbox.locator('.todo-row .todo-row-title')).toHaveText(['Assigned ticket 1', 'Assigned ticket 2', 'Assigned ticket 3']);
    await expect(inbox.getByRole('button', { name: 'Open BIL-2 in the browser', exact: true })).toBeVisible();
    await expect(inbox.locator('.todo-state')).toHaveText(['Todo', 'Todo', 'Todo']);
    await expect(inbox.getByRole('checkbox')).toHaveCount(0);
    // Imports are quiet: nothing on the map, nothing in Needs me.
    let state = await read(page);
    expect(state.nodes.map(node => node.id).sort()).toEqual(['billing', 'docs', 'existing', 'guide']); expect(state.nodes.some(node => node.attentionSources)).toBe(false);
    await page.mouse.move(700, 700);
    await expect(list.locator('.rail-panel-sheet')).toHaveScreenshot('todo-triage.png');
    // Taking a ticket makes it a to-do; the checkbox is then the ordinary completion control.
    await inbox.getByRole('button', { name: 'Take BIL-3 into Next', exact: true }).click();
    let next = list.getByRole('region', { name: 'Next', exact: true });
    await expect(next.locator('.todo-row .todo-row-title')).toHaveText(['Existing billing work', 'Existing docs work', 'Assigned ticket 3']);
    await expect(list.locator('.todo-inbox-count')).toHaveText('2');
    // A ticked row folds into Done once saved, so the tick is a click; the poll below reads it back.
    await next.getByRole('checkbox', { name: 'Complete Assigned ticket 3', exact: true }).click();
    await expect.poll(async () => (await read(page)).todos.find(todo => todo.title === 'Assigned ticket 3')?.completed).toBe(true);
    await list.getByRole('region', { name: 'Done', exact: true }).getByRole('button', { name: 'Show 1 done', exact: true }).click();
    await list.getByRole('region', { name: 'Done', exact: true }).getByRole('checkbox', { name: 'Complete Assigned ticket 3', exact: true }).uncheck();
    await expect.poll(async () => (await read(page)).todos.find(todo => todo.title === 'Assigned ticket 3')?.completed).toBe(false);

    await exitWithoutShutdown(app); await service.close();
    service = await startWorkspaceService(directory, undefined, undefined, providers); app = await launch(directory);
    ({ page, list } = await open(app)); inbox = await inboxOf(list); next = list.getByRole('region', { name: 'Next', exact: true });
    await expect(inbox.locator('.todo-row')).toHaveCount(2); expect((await read(page)).todos).toHaveLength(3);

    // Row menu: Send to project lists the projects in list order.
    await inbox.locator('.todo-row', { hasText: 'Assigned ticket 1' }).click({ button: 'right', position: { x: 120, y: 10 } });
    const menu = page.getByRole('menu', { name: 'Context actions', exact: true });
    await expect(menu.getByRole('menuitem')).toHaveText(['Send to project', 'Add context…']);
    await menu.getByRole('menuitem', { name: 'Send to project', exact: true }).click();
    const projects = page.getByRole('menu', { name: 'Send to project', exact: true });
    await expect(projects.getByRole('menuitemradio')).toHaveText(['Billing', 'Docs']);
    await expect(list).toHaveAttribute('data-open', 'true');
    await projects.getByRole('menuitemradio', { name: 'Billing', exact: true }).click();
    await expect(menu).toHaveCount(0);
    await expect(inbox.locator('.todo-row')).toHaveCount(1); await expect(inbox.locator('.todo-group-count')).toHaveText('1');
    state = await read(page);
    const todo = state.nodes.find(node => node.title === 'Assigned ticket 1')!, ticket = state.nodes.find(node => node.id === `${todo.id}:item`)!;
    await expect(next.locator('.todo-row .todo-row-title')).toHaveText(['Existing billing work', 'Existing docs work', 'Assigned ticket 3', 'Assigned ticket 1']);
    await expect(list.locator(`[data-todo-id="map:${todo.id}"] .todo-project`)).toHaveText('Billing');
    expect([todo.projectId, ticket.projectId]).toEqual(['billing', 'billing']);
    expect(state.resources.find(resource => resource.id === ticket.resourceId)).toMatchObject({ pluginId: 'linear.ticket', connectionId: 'linear-fixture' });
    expect(state.links.map(link => [link.sourceId, link.targetId])).toEqual([[todo.id, ticket.id]]);
    // The ticket card loads from the provider like any attached Linear ticket.
    await list.locator(`[data-todo-id="map:${todo.id}"]`).getByRole('button', { name: /^Show BIL-1 · Assigned ticket 1 on map$/ }).click();
    const card = page.getByRole('article', { name: 'Assigned ticket 1', exact: true });
    await expect(card).toBeVisible(); await expect(page.getByRole('article', { name: 'BIL-1 · Assigned ticket 1', exact: true }).getByText('Todo', { exact: true })).toBeVisible();

    // A second read never imports the sent ticket again.
    const client = await connectWorkspace(directory);
    try { await client.call('connections.refresh', {}); } finally { client.close(); }
    await expect(inbox.locator('.todo-row')).toHaveCount(1); expect((await read(page)).todos).toHaveLength(2);

    // Card menu: Move to project, with the current project checked and unavailable; another project takes the to-do and its ticket.
    // The first right click on the card only closes the kept list; the second opens the card's menu.
    await card.click({ button: 'right' });
    await expect(list).not.toHaveAttribute('data-open', 'true'); await expect(menu).toHaveCount(0);
    await card.click({ button: 'right' });
    await expect(menu.getByRole('menuitem', { name: 'Send to project', exact: true })).toHaveCount(0);
    await menu.getByRole('menuitem', { name: 'Move to project', exact: true }).click();
    const moves = page.getByRole('menu', { name: 'Move to project', exact: true });
    await expect(moves.getByRole('menuitemradio', { name: 'Billing', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(moves.getByRole('menuitemradio', { name: 'Billing', exact: true })).toBeDisabled();
    await moves.getByRole('menuitemradio', { name: 'Docs', exact: true }).click();
    await page.getByRole('button', { name: /^Keep to-dos open/ }).click();
    await expect(list.locator(`[data-todo-id="map:${todo.id}"] .todo-project`)).toHaveText('Docs');
    state = await read(page);
    expect(state.nodes.filter(node => [todo.id, ticket.id].includes(node.id)).map(node => node.projectId)).toEqual(['docs', 'docs']);
    expect(state.links).toHaveLength(1);

    // Dragging the last ticket into Later takes it there.
    inbox = await inboxOf(list);
    const transfer = await page.evaluateHandle(() => new DataTransfer());
    const grip = inbox.getByRole('button', { name: 'Reorder Assigned ticket 2', exact: true }), later = list.getByRole('region', { name: 'Later', exact: true });
    await grip.dispatchEvent('dragstart', { dataTransfer: transfer });
    await later.dispatchEvent('dragover', { dataTransfer: transfer }); await expect(later).toHaveAttribute('data-drop-group', 'true');
    await later.dispatchEvent('drop', { dataTransfer: transfer });
    await expect(later.locator('.todo-row .todo-row-title')).toHaveText(['Assigned ticket 2']);
    await expect(list.getByRole('region', { name: 'From Linear', exact: true })).toHaveCount(0);
    expect((await read(page)).todos.find(todo => todo.title === 'Assigned ticket 2')?.horizon).toBe('later');
  } finally { await exitWithoutShutdown(app); await service.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('duplicate tickets stay out of the inbox and the status checkboxes decide which tickets are imported', async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-triage-statuses-')), providers = linearProviders({ assigned: 5 });
  const stateOf = (type: string, name: string, number: number) => ({ id: `99999999-9999-4999-8999-00000000000${number}`, name, type });
  [stateOf('backlog', 'Backlog', 1), stateOf('backlog', 'Backlog', 1), stateOf('unstarted', 'Todo', 2), stateOf('duplicate', 'Duplicate', 3), stateOf('started', 'In Progress', 4)].forEach((state, index) => { providers.assigned[index].state = state; });
  const service = await startWorkspaceService(directory, undefined, undefined, providers);
  await service.control.dispatch({ commandId: 'seed', expectedRevision: (await service.control.read()).revision, actor: { kind: 'user', id: 'fixture' }, commands: seed });
  const client = await connectWorkspace(directory), saved = await client.call<{ revision: number; value: Record<string, unknown> }>('settings.read', {});
  await client.call('settings.write', { expectedRevision: saved.revision, value: { ...saved.value, connections: providers.accounts } });
  const app = await launch(directory);
  try {
    const { page, list } = await open(app), inbox = await inboxOf(list), titles = inbox.locator('.todo-row .todo-row-title');
    await expect(titles).toHaveText(['Assigned ticket 1', 'Assigned ticket 2', 'Assigned ticket 3', 'Assigned ticket 5']);
    // A ticket the person took is theirs to keep.
    await inbox.getByRole('button', { name: 'Take BIL-2 into Later', exact: true }).click();
    await expect.poll(async () => (await read(page)).todos.find(todo => todo.title === 'Assigned ticket 2')?.horizon).toBe('later');
    const dialog = page.getByRole('dialog', { name: 'Settings' }), tree = dialog.getByRole('tree', { name: 'Settings', exact: true });
    const toggle = dialog.getByRole('switch', { name: 'Show my assigned Linear tickets in the to-do inbox', exact: true });
    const statuses = dialog.getByRole('group', { name: 'Ticket statuses that go to the inbox', exact: true }), status = (name: string) => statuses.getByRole('checkbox', { name, exact: true });
    const priority = dialog.getByRole('combobox', { name: 'Minimum priority', exact: true }), hint = dialog.getByText('No status is selected, so nothing is imported. The to-dos you already have stay.', { exact: true });
    const settings = async (change: () => Promise<void>) => {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await tree.getByRole('treeitem', { name: 'Items', exact: true }).click(); await tree.getByRole('treeitem', { name: 'Linear ticket', exact: true }).click();
      await change();
      await dialog.getByRole('button', { name: 'Save settings', exact: true }).click(); await expect(dialog).toHaveCount(0);
    };
    await settings(async () => {
      // Only open statuses are offered; finished and duplicate tickets cannot be chosen.
      await expect(statuses.getByRole('checkbox')).toHaveCount(4); await expect(statuses.locator('label')).toHaveText(['Triage', 'Backlog', 'Todo', 'In progress']);
      for (const name of ['Triage', 'Backlog', 'Todo', 'In progress']) await expect(status(name)).toBeChecked();
      await expect(priority).toHaveValue('any'); await expect(priority.locator('option')).toHaveText(['Any', 'Urgent, High and Medium', 'Urgent and High']);
      await page.mouse.move(700, 790);
      await expect(dialog.getByRole('group', { name: 'Assigned tickets', exact: true })).toHaveScreenshot('settings-linear-triage.png');
      await toggle.uncheck(); for (const name of ['Triage', 'Backlog', 'Todo', 'In progress']) await expect(status(name)).toBeDisabled(); await expect(priority).toBeDisabled();
      await toggle.check(); await expect(status('Backlog')).toBeEnabled(); await expect(hint).toHaveCount(0);
      for (const name of ['Triage', 'Backlog', 'Todo', 'In progress']) await status(name).uncheck();
      await expect(hint).toBeVisible();
      for (const name of ['Triage', 'Todo', 'In progress']) await status(name).check();
      await expect(hint).toHaveCount(0);
    });
    await expect.poll(async () => (await client.call<{ value: { plugins: Record<string, Record<string, unknown>> } }>('settings.read', {})).value.plugins['linear.ticket']?.triageStateTypes).toEqual(['triage', 'unstarted', 'started']);
    // Saving reads at once: the untouched backlog ticket leaves, the taken one stays in Later.
    await expect(titles).toHaveText(['Assigned ticket 3', 'Assigned ticket 5']);
    expect((await read(page)).todos.map(todo => todo.title)).not.toContain('Assigned ticket 1');
    await expect(list.getByRole('region', { name: 'Later', exact: true }).locator('.todo-row .todo-row-title')).toHaveText(['Assigned ticket 2']);
    await settings(async () => { await expect(status('Backlog')).not.toBeChecked(); await expect(status('Todo')).toBeChecked(); await status('Backlog').check(); });
    await expect(titles).toHaveText(['Assigned ticket 3', 'Assigned ticket 5', 'Assigned ticket 1']);
    // Reopened in Linear, the former duplicate arrives like any other ticket.
    providers.assigned[3].state = stateOf('started', 'In Progress', 4); await client.call('connections.refresh', {});
    await expect(titles).toHaveText(['Assigned ticket 3', 'Assigned ticket 5', 'Assigned ticket 1', 'Assigned ticket 4']);
    expect((await read(page)).nodes.map(node => node.id).sort()).toEqual(['billing', 'docs', 'existing', 'guide']);
  } finally { client.close(); await exitWithoutShutdown(app); await service.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('the Linear setting turns the assigned-ticket import off and on, and says when Linear is not connected', async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-triage-setting-')), providers = linearProviders({ assigned: 0 });
  const service = await startWorkspaceService(directory, undefined, undefined, providers);
  await service.control.dispatch({ commandId: 'seed', expectedRevision: (await service.control.read()).revision, actor: { kind: 'user', id: 'fixture' }, commands: seed });
  const app = await launch(directory), client = await connectWorkspace(directory);
  try {
    const { page, list } = await open(app);
    await expect(list.getByRole('region', { name: 'From Linear', exact: true })).toHaveCount(0);
    const dialog = page.getByRole('dialog', { name: 'Settings' }), tree = dialog.getByRole('tree', { name: 'Settings', exact: true });
    const toggle = dialog.getByRole('switch', { name: 'Show my assigned Linear tickets in the to-do inbox', exact: true });
    const settings = async (change: () => Promise<void>) => {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await tree.getByRole('treeitem', { name: 'Items', exact: true }).click(); await tree.getByRole('treeitem', { name: 'Linear ticket', exact: true }).click();
      await change();
      await expect(dialog).toHaveCount(0);
    };
    await settings(async () => {
      await expect(toggle).toBeChecked();
      // The fixture account is not a saved connection, so the page explains what the import needs.
      await expect(dialog.getByText('Linear is not connected', { exact: true })).toBeVisible();
      await expect(dialog.getByText('Connect Linear in Settings → Connections to import your assigned tickets.', { exact: true })).toBeVisible();
      await toggle.uncheck(); await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
      await expect.poll(async () => (await client.call<{ value: { plugins: Record<string, Record<string, unknown>> } }>('settings.read', {})).value.plugins['linear.ticket']?.importAssigned).toBe(false);
    });
    const reads = () => providers.calls.filter(call => call.startsWith('assigned:')).length, before = reads();
    providers.assign(2); await client.call('connections.refresh', {});
    await page.waitForTimeout(300);
    expect(reads()).toBe(before); expect((await read(page)).todos).toHaveLength(0);
    await expect(list.getByRole('region', { name: 'From Linear', exact: true })).toHaveCount(0);
    // A saved Linear connection removes the hint; turning the import back on reads at once.
    const saved = await client.call<{ revision: number; value: Record<string, unknown> }>('settings.read', {});
    await client.call('settings.write', { expectedRevision: saved.revision, value: { ...saved.value, connections: providers.accounts } });
    await settings(async () => {
      await expect(toggle).not.toBeChecked(); await expect(dialog.getByText('Linear is not connected', { exact: true })).toHaveCount(0);
      await toggle.check(); await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
    });
    await expect((await inboxOf(list)).locator('.todo-row .todo-row-title')).toHaveText(['Assigned ticket 1', 'Assigned ticket 2']);
  } finally { client.close(); await exitWithoutShutdown(app); await service.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
