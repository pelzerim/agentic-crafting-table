import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as workspaceTest } from './visual-fixture.ts';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import type { SettingsSnapshot } from '../../packages/core/settings.ts';

test('settings persist, reject managed flags and release the real display assertion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-settings-'));
  const launch = () => electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await expect(page.getByText('Desktop connected')).toBeVisible();
    expect((await page.evaluate(() => window.craftingTable.appInfo())).name).toBe('Agentic Crafting Table');
    await app.evaluate(({ powerSaveBlocker }) => {
      const start = powerSaveBlocker.start.bind(powerSaveBlocker);
      powerSaveBlocker.start = type => { const id = start(type); (globalThis as any).displayAssertion = id; return id; };
    });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const remote = page.getByLabel('Remote Control', { exact: true }), awake = page.getByLabel('Keep screen awake while the app is open');
    const autoMode = page.getByLabel('Auto mode', { exact: true });
    await expect(autoMode).toBeChecked();
    await expect(remote).toBeChecked(); await expect(awake).not.toBeChecked();
    await expect(page.getByLabel('Neighborhood padding', { exact: true })).toHaveValue('240');
    await page.getByRole('treeitem', { name: 'Map', exact: true }).click();
    await page.getByLabel('Neighborhood padding', { exact: true }).fill('360');
    await expect(page.getByRole('status').filter({ hasText: '1 unsaved change · Map' })).toBeVisible();
    await page.getByRole('treeitem', { name: 'Items', exact: true }).locator(':scope > .settings-tree-row').click(); await page.getByRole('treeitem', { name: 'Claude', exact: true }).click(); await remote.uncheck();
    await autoMode.uncheck();
    await page.getByRole('treeitem', { name: 'General', exact: true }).click(); await awake.check();
    await page.getByRole('treeitem', { name: 'Items', exact: true }).locator(':scope > .settings-tree-row').click(); await page.getByRole('treeitem', { name: 'Claude', exact: true }).click();
    await page.getByLabel('Additional launch arguments').fill('--resume\nother-session');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByRole('alert')).toContainText('managed by the app');
    await page.getByLabel('Additional launch arguments').fill('--effort\nhigh\n--verbose');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
    expect(await app.evaluate(({ powerSaveBlocker }) => powerSaveBlocker.isStarted((globalThis as any).displayAssertion))).toBe(true);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(remote).not.toBeChecked(); await expect(awake).toBeChecked();
    await expect(autoMode).not.toBeChecked();
    await page.getByRole('treeitem', { name: 'General', exact: true }).click(); await awake.uncheck(); await page.getByRole('button', { name: 'Save settings' }).click();
    expect(await app.evaluate(({ powerSaveBlocker }) => powerSaveBlocker.isStarted((globalThis as any).displayAssertion))).toBe(false);
    const before = await page.evaluate(() => window.craftingTable.settingsRead());
    await app.close(); app = await launch(); page = await app.firstWindow();
    await expect(page.getByText('Desktop connected')).toBeVisible();
    expect(await page.evaluate(() => window.craftingTable.settingsRead())).toEqual(before);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByLabel('Additional launch arguments')).toHaveValue('--effort\nhigh\n--verbose');
    await expect(page.getByLabel('Auto mode', { exact: true })).not.toBeChecked();
    await page.getByRole('treeitem', { name: 'Items', exact: true }).locator(':scope > .settings-tree-row').click(); await page.getByRole('treeitem', { name: 'Claude', exact: true }).click();
    await page.getByLabel('Additional launch arguments').fill('--effort\nhigh\n--permission-mode=plan');
    await expect(page.getByText('Custom permission mode: plan.', { exact: false })).toBeVisible();
    await page.getByLabel('Auto mode', { exact: true }).check();
    await expect(page.getByLabel('Additional launch arguments')).toHaveValue('--effort\nhigh');
    await page.getByRole('button', { name: 'Save settings' }).click();
    expect((await page.evaluate(() => window.craftingTable.settingsRead())).value.claude).toEqual({ remoteControl: false, autoMode: true, arguments: ['--effort', 'high'] });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByLabel('Neighborhood padding', { exact: true })).toHaveValue('360');
    await page.screenshot({ path: 'test-results/settings.png' });
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});


workspaceTest('padding updates all rounded outlines through shared settings without moving the map', async ({ visual: { app, page } }) => {
  await page.evaluate(async () => {
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: 'second-neighborhood', actor: { kind: 'user', id: 'test' }, expectedRevision: state.revision, commands: [
      { type: 'project.create', id: 'docs', title: 'Documentation', summary: '', position: { x: -400, y: 700 } },
    ] });
  });
  const outlines = page.locator('[data-project-outline]');
  await expect(outlines).toHaveCount(2);
  const paths = () => outlines.evaluateAll(elements => elements.map(el => el.getAttribute('d')));
  const original = await paths();
  const before = await page.evaluate(async () => ({ state: (await window.craftingTable.workspaceRead()).state, view: await window.craftingTable.viewRead() }));
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  const padding = page.getByLabel('Neighborhood padding', { exact: true });
  const save = page.getByRole('button', { name: 'Save settings' });
  await settings.click(); await page.getByRole('treeitem', { name: 'Map', exact: true }).click(); await padding.fill('0'); await save.click();
  await expect.poll(paths).not.toEqual(original);
  const tight = await paths();
  tight.forEach((path, i) => expect(path).not.toBe(original[i]));
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
  await settings.click(); await page.getByRole('treeitem', { name: 'Map', exact: true }).click(); await expect(padding).toHaveValue('0');
  await padding.fill('-1'); await save.click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  expect(await padding.evaluate((el: HTMLInputElement) => el.validity.rangeUnderflow)).toBe(true);
  expect(await paths()).toEqual(tight);
  await padding.fill('160'); // Keep a draft while another client changes settings.
  const client = await connectWorkspace(await app.evaluate(({ app }) => app.getPath('userData')));
  try {
    const current = await client.call<SettingsSnapshot>('settings.read');
    await client.call('settings.write', { expectedRevision: current.revision, value: { ...current.value, neighborhoodPadding: 420 } });
    await expect.poll(paths).not.toEqual(tight);
    const spacious = await paths();
    spacious.forEach((path, i) => expect(path).not.toBe(tight[i]));
    await save.click(); await expect(page.getByRole('alert')).toContainText('changed elsewhere');
    expect(await paths()).toEqual(spacious);
    await page.getByRole('button', { name: 'Close settings' }).click();
    await expect(page.getByRole('group', { name: 'Discard changes' })).toContainText('Discard 1 change?');
    await page.getByRole('button', { name: 'Keep editing', exact: true }).click(); await expect(padding).toHaveValue('160');
    await page.getByRole('button', { name: 'Close settings' }).click(); await page.getByRole('group', { name: 'Discard changes' }).getByRole('button', { name: 'Discard', exact: true }).click();
    await settings.click(); await page.getByRole('treeitem', { name: 'Map', exact: true }).click(); await expect(padding).toHaveValue('420');
    await page.getByRole('button', { name: 'Reset to 240 px' }).click(); await save.click();
    await expect.poll(paths).toEqual(original);
    expect(await page.evaluate(async () => ({ state: (await window.craftingTable.workspaceRead()).state, view: await window.craftingTable.viewRead() }))).toEqual(before);
    await page.getByRole('article', { name: 'Plan switcher' }).click();
    await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'pr');
    const currentFocus = await client.call<SettingsSnapshot>('settings.read');
    await client.call('settings.write', { expectedRevision: currentFocus.revision, value: { ...currentFocus.value, neighborhoodPadding: 120 } });
    await expect.poll(paths).not.toEqual(original);
    await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'pr');
    await expect(page.getByRole('navigation', { name: 'Map location' })).toContainText('Plan switcher');
  } finally { client.close(); }
});
