import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { ResourcePluginHost } from '../../src/resource-plugins/host.ts';
import { createResourcePluginRegistry } from '../../src/resource-plugins/builtins.ts';
import { defineResourcePlugin } from '../../src/resource-plugins/define.ts';
import { createWebLinkConnector } from '../../src/resource-plugins/items/web-link/connector.ts';
import { ProviderConnections } from '../../packages/provider-runtime/connections.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';

test('URL-only Web links open the exact browser URL without moving the map and retain fallback links across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-web-link-'));
  const reads: string[] = []; let currentTitle = '<b>Current page</b>';
  const registry = createResourcePluginRegistry([defineResourcePlugin({ id: 'fixture.browser', apiVersion: 1, schemaVersion: 1, name: 'Browser extension', icon: 'globe', preferredView: 'focus',
    activation: { kind: 'browser', urlField: 'destination' }, creation: { label: 'Add browser link' }, fields: { destination: { kind: 'url', label: 'Destination' } } })]);
  const providers = { connections: new ProviderConnections(() => [], []), host: () => {
    const host = new ResourcePluginHost(registry); host.register('web.link', createWebLinkConnector(async url => { reads.push(url); if (url.includes('/private')) throw new Error('Login required'); return currentTitle; })); return host;
  } };
  let service = await startWorkspaceService(directory, registry, undefined, providers);
  let app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  const captureBrowser = async () => app.evaluate(({ shell }) => { (globalThis as any).openedUrls = []; shell.openExternal = async (url: string) => { (globalThis as any).openedUrls.push(url); }; });
  const opened = () => app.evaluate(() => (globalThis as any).openedUrls as string[]);
  try {
    let page = await app.firstWindow(); await expect(page.getByText('Desktop connected')).toBeVisible(); await captureBrowser();
    const url = 'https://example.test/docs?view=flow&token=a%2Bb#architecture';
    await page.mouse.dblclick(900, 350);
    await page.getByRole('button', { name: 'From URL', exact: true }).click();
    await expect(page.getByLabel('Title', { exact: true })).toHaveCount(0); await page.getByLabel('Item URL').fill(url);
    await page.getByRole('button', { name: 'Add web link', exact: true }).click();
    const link = page.getByRole('article', { name: '<b>Current page</b>', exact: true }); await expect(link).toBeVisible();
    expect(await link.locator('b').count()).toBe(0); expect(reads).toEqual([url]);
    const before = await service.control.read(), camera = (await service.store.readView('desktop')).camera;
    await link.dblclick(); await expect.poll(opened).toEqual([url]); await expect(page.locator('.map-area')).toHaveAttribute('data-focus', '');
    expect((await service.store.readView('desktop')).camera).toEqual(camera); expect(await service.control.read()).toEqual(before);
    await page.locator(`.react-flow__node[data-id="${before.nodes[0].id}"]`).focus(); await page.keyboard.press('Enter'); await expect.poll(opened).toEqual([url, url]);
    currentTitle = 'Updated page title'; await link.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click(); await page.getByRole('menuitem', { name: 'Item settings…', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh title', exact: true }).click();
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue(currentTitle);
    await page.getByRole('button', { name: 'Close item form', exact: true }).click();
    await expect(page.getByRole('article', { name: currentTitle, exact: true })).toBeVisible();
    await page.evaluate(async () => {
      const { state } = await window.craftingTable.workspaceRead();
      await window.craftingTable.resourceCreate({ requestId: crypto.randomUUID(), nodeId: crypto.randomUUID(), resourceId: crypto.randomUUID(), expectedRevision: state.revision, pluginId: 'web.link', title: 'Web link', position: { x: 350, y: 350 }, data: { url: 'https://example.test/private?q=1#saved' } });
    });
    const fallback = page.getByRole('article', { name: 'example.test', exact: true }); await expect(fallback).toBeVisible();
    await fallback.click(); await expect.poll(async () => (await opened()).at(-1)).toBe('https://example.test/private?q=1#saved');
    // A new plugin gets the same activation through metadata, without a graph branch.
    await service.control.dispatch({ commandId: 'extension', expectedRevision: (await service.control.read()).revision, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'item.add', id: 'extension', resourceId: 'extension-r', pluginId: 'fixture.browser', title: 'Extension link', position: { x: 350, y: 550 }, data: { destination: 'https://example.test/extension?x=2#kept' } }] });
    await exitWithoutShutdown(app); await service.close(); service = await startWorkspaceService(directory, registry, undefined, providers);
    app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } }); page = await app.firstWindow(); await captureBrowser();
    await page.getByRole('article', { name: 'Extension link', exact: true }).click(); await expect.poll(opened).toEqual(['https://example.test/extension?x=2#kept']);
    await page.getByRole('article', { name: 'example.test', exact: true }).click(); await expect.poll(async () => (await opened()).at(-1)).toBe('https://example.test/private?q=1#saved');
    expect(reads).toHaveLength(3); await expect(page.locator('.map-area')).toHaveAttribute('data-focus', '');
    await expect(page.evaluate(() => window.craftingTable.openUrl('file:///etc/passwd'))).rejects.toThrow('Only HTTP');
    await expect(page.evaluate(() => window.craftingTable.openUrl('https://name:secret@example.test/'))).rejects.toThrow('Only HTTP');
    const browserCalls = await opened();
    await service.store.update(state => ({ ...state, resources: state.resources.map(resource => resource.id === 'extension-r' ? { ...resource, schemaVersion: 2 } : resource) }));
    await page.reload(); await page.getByRole('article', { name: 'Extension link', exact: true }).click();
    await expect(page.getByText('Resource was saved by a newer plugin; its data is preserved', { exact: true })).toBeVisible();
    expect(await opened()).toEqual(browserCalls);
  } finally { await exitWithoutShutdown(app); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
