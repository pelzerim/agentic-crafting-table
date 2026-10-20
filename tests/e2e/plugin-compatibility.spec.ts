import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { createResourcePluginRegistry } from '../../src/resource-plugins/builtins.ts';
import { defineResourcePlugin } from '../../src/resource-plugins/define.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import type { ResourcePluginDefinition } from '../../src/resource-plugins/types.ts';

const old = defineResourcePlugin({ id: 'fixture.compatible', apiVersion: 1, schemaVersion: 1, name: 'Research note', icon: 'note', preferredView: 'focus', creation: { label: 'Add research' }, fields: { body: { label: 'Body', kind: 'text', required: true } } });
const updated = defineResourcePlugin({ ...old, validateData: undefined, schemaVersion: 2, fields: { content: { label: 'Content', kind: 'text', required: true } }, migrations: [{ fromVersion: 1, toVersion: 2, migrate: data => ({ content: data.body }) }] });

test('an unfamiliar item upgrades, survives a plugin downgrade/removal, and restores its content with the same map identity', async () => {
  test.setTimeout(45_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-plugin-compat-'));
  let service = await startWorkspaceService(directory, createResourcePluginRegistry([old]), undefined, {});
  await service.control.dispatch({ commandId: 'fixture', expectedRevision: 0, actor: { kind: 'agent', id: 'fixture' }, commands: [{ type: 'item.add', id: 'note', resourceId: 'note-resource', pluginId: old.id, title: 'Persistent note', position: { x: 350, y: 200 }, data: { body: 'Keep this content' } }] });
  let app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  async function reopen(plugins: ResourcePluginDefinition[]) {
    await exitWithoutShutdown(app); await service.close(); service = await startWorkspaceService(directory, createResourcePluginRegistry(plugins), undefined, {});
    app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } }); return app.firstWindow();
  }
  try {
    let page = await app.firstWindow(); const before = await service.control.read();
    await page.getByRole('article', { name: 'Persistent note', exact: true }).click(); await expect(page.locator('.resource-detail')).toContainText('Body: Keep this content');
    page = await reopen([updated]);
    await page.getByRole('article', { name: 'Persistent note', exact: true }).click(); await expect(page.locator('.resource-detail')).toContainText('Content: Keep this content');
    const upgraded = await service.control.read(); expect(upgraded.nodes).toEqual(before.nodes); expect(upgraded.resources[0].schemaVersion).toBe(2); expect(upgraded.resources[0].id).toBe('note-resource');
    for (const [plugins, message] of [[[], 'Plugin is not installed'], [[old], 'Resource was saved by a newer plugin']] as [ResourcePluginDefinition[], string][]) {
      page = await reopen(plugins); await page.getByRole('article', { name: 'Persistent note', exact: true }).click();
      await expect(page.locator('.resource-detail')).toContainText(message); expect(await service.control.read()).toEqual(upgraded);
    }
    page = await reopen([updated]); await page.getByRole('article', { name: 'Persistent note', exact: true }).click(); await expect(page.locator('.resource-detail')).toContainText('Content: Keep this content'); expect(await service.control.read()).toEqual(upgraded);
  } finally { await exitWithoutShutdown(app); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
