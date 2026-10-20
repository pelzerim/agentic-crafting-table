import { test, expect, _electron as electron } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { SqliteStore } from '../../packages/workspace-service/sqlite-store.ts';
import { WorkspaceControl } from '../../packages/core/control.ts';
import { linearProviders } from '../fixtures/linear.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { resize, scrollbarArgs } from './visual-fixture.ts';

const DAY = 86_400_000;
const launch = (directory: string) => electron.launch({ args: ['.', '--force-device-scale-factor=1', '--disable-lcd-text', '--force-color-profile=srgb', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory, TZ: 'UTC' } });
const read = (page: Page) => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
async function open(app: Awaited<ReturnType<typeof launch>>) {
  const page = await app.firstWindow(); await resize(app, page, 1280, 800); await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.route(/^https?:\/\//, route => route.abort());
  const list = page.getByRole('form', { name: 'To-dos', exact: true });
  await expect(page.getByRole('button', { name: /^(Keep to-dos open|Close to-dos)(: \d+ in the inbox)?$/ })).toBeVisible();
  if (await list.getAttribute('data-open') !== 'true') await page.getByRole('button', { name: /^Keep to-dos open/ }).click();
  await expect(list).toHaveAttribute('data-open', 'true');
  return { page, list };
}
const user = { kind: 'user' as const, id: 'fixture' };

test('Done rows go to Archive after the days chosen in Settings, counted on the service clock, and come back from Archive', async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-todo-archive-'));
  let now = Date.now();
  const service = await startWorkspaceService(directory, undefined, undefined, { todoClock: () => now });
  await service.control.dispatch({ commandId: 'seed', expectedRevision: 0, actor: user, commands: [
    { type: 'todo.save', todo: { id: 'shipped', title: 'Ship the retry fix', completed: false, nodeIds: [] } },
    { type: 'todo.save', todo: { id: 'open', title: 'Still open', completed: false, nodeIds: [] } },
    { type: 'todo.move', id: 'shipped', horizon: 'done' },
  ] });
  const app = await launch(directory);
  try {
    const { page, list } = await open(app), done = list.getByRole('region', { name: 'Done', exact: true });
    await expect(done.locator('.todo-group-count')).toHaveText('1');
    // Two days on, the default of three keeps it; one day sends it to Archive as soon as it is saved.
    now += 2 * DAY;
    const dialog = page.getByRole('dialog', { name: 'Settings' }), tree = dialog.getByRole('tree', { name: 'Settings', exact: true });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await tree.getByRole('treeitem', { name: 'Items', exact: true }).click(); await tree.getByRole('treeitem', { name: 'To-do', exact: true }).click();
    const days = dialog.getByRole('combobox', { name: 'Move done to-dos to Archive after', exact: true });
    await expect(days).toHaveValue('3'); await expect(days.locator('option')).toHaveText(['1 day', '3 days', '7 days', 'Never']);
    await page.waitForTimeout(200); expect((await read(page)).todos.find(todo => todo.id === 'shipped')?.archivedAt).toBeUndefined();
    await days.selectOption('1'); await dialog.getByRole('button', { name: 'Save settings', exact: true }).click(); await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await read(page)).todos.find(todo => todo.id === 'shipped')?.archivedAt).toBeTruthy();
    await expect(done.locator('.todo-group-count')).toHaveText('0');
    expect((await read(page)).todos.find(todo => todo.id === 'open')?.archivedAt).toBeUndefined();
    await page.evaluate(async () => { const { state } = await window.craftingTable.workspaceRead(); await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'todo.restore', id: 'shipped' }] }); });
    await expect(list.getByRole('region', { name: 'Done', exact: true }).locator('.todo-group-count')).toHaveText('1');
  } finally { await exitWithoutShutdown(app); await service.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('a Linear ticket kept in the list shows its identifier and Linear state, and ticks itself when Linear says Done', async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-todo-linear-')), providers = linearProviders();
  const service = await startWorkspaceService(directory, undefined, undefined, providers);
  await service.control.dispatch({ commandId: 'seed', expectedRevision: 0, actor: user, commands: [
    { type: 'item.add', id: 'ticket', resourceId: 'ticket-r', pluginId: 'linear.ticket', title: 'BIL-128 · Make plan changes predictable', position: { x: 600, y: 340 }, data: { issueId: providers.data.issue.id } },
    { type: 'node.todo', id: 'ticket', enabled: true },
  ] });
  const app = await launch(directory);
  try {
    const { page, list } = await open(app), refresh = () => page.evaluate(() => window.craftingTable.runtimeRun({ nodeId: 'ticket', action: 'resource.read', arguments: { refresh: true } }));
    await refresh();
    const row = list.locator('[data-todo-id="map:ticket"]');
    await expect(row.locator('.todo-row-title')).toHaveText('Make plan changes predictable');
    await expect(row.locator('.todo-chip')).toHaveText(['BIL-128', 'In Progress']);
    // Ticking here is the list's own; Linear is not written.
    // The row folds away into Done as it is ticked, so this is a click rather than a check that waits for the box.
    await row.getByRole('checkbox', { name: 'Complete Make plan changes predictable', exact: true }).click();
    await expect.poll(async () => (await read(page)).nodes.find(node => node.id === 'ticket')?.todoDoneAt).toBeTruthy();
    expect(providers.writes).toEqual([]); expect((await read(page)).nodes.find(node => node.id === 'ticket')?.completedAt).toBeUndefined();
    await page.getByRole('status').filter({ hasText: 'Make plan changes predictable' }).getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(list.getByRole('region', { name: 'Next', exact: true }).locator('[data-todo-id="map:ticket"]')).toBeVisible();
    // Linear moves it to Done: the row ticks itself and folds into Done.
    providers.data.issue.state = { id: providers.states[3].id, name: 'Done', type: 'completed' };
    await refresh();
    await expect(list.getByRole('region', { name: 'Next', exact: true }).locator('[data-todo-id="map:ticket"]')).toHaveCount(0);
    await list.getByRole('region', { name: 'Done', exact: true }).getByRole('button', { name: 'Show 1 done', exact: true }).click();
    await expect(row.locator('.todo-chip')).toHaveText(['BIL-128', 'Done']);
    await expect(row.getByRole('checkbox')).toBeChecked(); await expect(row.getByRole('checkbox')).toBeDisabled();
    expect(providers.writes).toEqual([]);
  } finally { await exitWithoutShutdown(app); await service.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('a workspace saved before horizons opens with its to-dos in Next in their order, untouched imports in the inbox and nothing lost', async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-todo-migration-')), file = join(directory, 'workspace.sqlite');
  const ticket = (key: string) => ({ source: 'linear', key, label: key.toUpperCase(), status: 'Todo', item: { pluginId: 'linear.ticket', title: key, data: { issueId: key } } });
  const store = new SqliteStore(file), control = new WorkspaceControl(store);
  await control.dispatch({ commandId: 'seed', expectedRevision: 0, actor: user, commands: [
    { type: 'project.create', id: 'a', title: 'Alpha', summary: '', position: { x: 0, y: 0 } }, { type: 'project.create', id: 'b', title: 'Beta', summary: '', position: { x: 2000, y: 0 } },
    { type: 'item.add', id: 'a1', resourceId: 'a1-r', pluginId: 'workspace.todo', title: 'Alpha task', data: {}, projectId: 'a', position: { x: 0, y: 200 } },
    { type: 'item.add', id: 'b1', resourceId: 'b1-r', pluginId: 'workspace.todo', title: 'Beta task', data: {}, projectId: 'b', position: { x: 2000, y: 200 } },
    { type: 'todo.save', todo: { id: 'free', title: 'Loose task', completed: false, nodeIds: [] } },
    { type: 'todo.save', todo: { id: 'old-done', title: 'Finished long ago', completed: true, nodeIds: [] } },
    { type: 'todo.save', todo: { id: 't1', title: 'BIL-1 As imported', completed: false, nodeIds: [], triage: ticket('bil-1') } },
    { type: 'todo.save', todo: { id: 't2', title: 'BIL-2 In my words', completed: false, nodeIds: [], triage: ticket('bil-2') } },
  ] });
  store.commitObservation('triage:fixture', 0, { account: 'x', entries: [{ key: 'bil-1', todoId: 't1', title: 'BIL-1 As imported' }, { key: 'bil-2', todoId: 't2', title: 'BIL-2 As imported' }] });
  store.close();
  // The version 24 shape: no horizons or touch times, and ranks per project group with Beta's group first.
  const old = new DatabaseSync(file);
  old.exec(`UPDATE todos SET body = json_remove(body, '$.horizon', '$.touchedAt', '$.todoOrder');
    UPDATE nodes SET body = json_remove(body, '$.todoHorizon', '$.todoTouchedAt', '$.todoOrder');
    UPDATE nodes SET body = json_set(body, '$.todoOrder', 0) WHERE id IN ('a1', 'b1', 'b'); UPDATE nodes SET body = json_set(body, '$.todoOrder', 1) WHERE id = 'a';
    PRAGMA user_version = 24;`);
  old.close();
  const app = await launch(directory);
  try {
    const { page, list } = await open(app);
    await expect(list.getByRole('region', { name: 'Next', exact: true }).locator('.todo-row .todo-row-title')).toHaveText(['BIL-2 In my words', 'Beta task', 'Alpha task', 'Loose task']);
    await expect(list.getByRole('region', { name: 'From Linear', exact: true }).locator('.todo-group-count')).toHaveText('1');
    await expect(list.getByRole('region', { name: 'Done', exact: true }).locator('.todo-group-count')).toHaveText('1');
    const state = await read(page);
    expect(state.todos.map(todo => [todo.id, todo.horizon, Boolean(todo.touchedAt)])).toEqual([['free', 'next', true], ['old-done', 'next', true], ['t1', 'inbox', true], ['t2', 'next', true]]);
    expect(state.nodes.length).toBe(4);
  } finally {
    await exitWithoutShutdown(app);
    // The app started its own service for this workspace; stop it before removing the directory.
    const client = await connectWorkspace(directory).catch(() => undefined);
    if (client) { try { const stopped = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await stopped; } finally { client.close(); } }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
