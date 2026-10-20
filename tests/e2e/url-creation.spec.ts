import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { ResourcePluginHost } from '../../src/resource-plugins/host.ts';
import { createResourcePluginRegistry } from '../../src/resource-plugins/builtins.ts';
import { defineResourcePlugin } from '../../src/resource-plugins/define.ts';
import { ProviderConnections } from '../../packages/provider-runtime/connections.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';

test('From URL discovers extension types, requires ambiguous selection and attaches context atomically at the drop point', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-url-creation-'));
  const registry = createResourcePluginRegistry(); const reads: string[] = [];
  for (const [id, name] of [['fixture.document', 'Document'], ['fixture.alternate', 'Alternate document']]) registry.register(defineResourcePlugin({
    id, name, apiVersion: 1, schemaVersion: 1, icon: 'file', preferredView: 'focus', fields: { url: { label: 'URL', kind: 'url', required: true } },
    creation: { label: 'Attach document', mode: 'url', action: 'resource.attach' },
    matchInput: input => new URL(input).hostname === 'documents.example.test' ? { title: 'Lookup title', data: { url: input } } : undefined,
  }));
  const host = new ResourcePluginHost(registry);
  for (const id of ['fixture.document', 'fixture.alternate']) host.register(id, { async load(resource) {
    reads.push(resource.pluginId);
    return { title: 'Verified document title', activity: 'idle', attention: 'none', connection: 'connected', label: 'Ready', observedAt: '2026-09-26T12:00:00Z' };
  } });
  const service = await startWorkspaceService(directory, registry, undefined, { host: () => host, connections: new ProviderConnections(() => [], []) });
  await service.control.dispatch({ commandId: 'seed', expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [
    { type: 'project.create', id: 'project', title: 'Project', position: { x: 300, y: 300 } },
    { type: 'item.add', id: 'agent', resourceId: 'agent-r', pluginId: 'agent.session', projectId: 'project', title: 'Context receiver', data: { sessionId: 'fixture-only', provider: 'claude' }, position: { x: 650, y: 240 } },
  ] });
  await service.store.writeView('desktop', { camera: { x: 140, y: 100, zoom: .7 } });
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow(); await page.emulateMedia({ reducedMotion: 'reduce' });
    const card = page.getByRole('article', { name: 'Context receiver', exact: true }); await card.hover();
    const box = (await card.boundingBox())!, handle = (await card.getByRole('button', { name: 'Connect Context receiver', exact: true }).boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height + 120, { steps: 10 }); await page.mouse.up();
    const form = page.getByRole('form', { name: 'New item' }); await expect(form).toHaveAttribute('data-project-id', 'project');
    const position = await form.evaluate(el => ({ x: Number(el.getAttribute('data-world-x')), y: Number(el.getAttribute('data-world-y')) }));
    await form.getByRole('button', { name: 'From URL', exact: true }).click();
    await form.getByLabel('Item URL').fill('https://github.com/fixture/billing/pull/42');
    await expect(form.locator('.detected-item')).toHaveText('GitHub pull request');
    await expect(form).toContainText('This provider is not connected yet.');
    await expect(form.getByRole('button', { name: 'Add web link', exact: true })).toHaveCount(0);
    expect(reads).toEqual([]);
    await form.getByLabel('Item URL').fill('https://documents.example.test/plan');
    const types = form.getByLabel('Detected item type'); await expect(types).toBeVisible();
    await expect(form.getByRole('button', { name: 'Attach item', exact: true })).toBeDisabled();
    expect(reads).toEqual([]);
    await types.selectOption('fixture.document');
    await expect(form.getByLabel('Relationship', { exact: true })).toHaveCount(0);
    const before = await service.control.read();
    await form.getByRole('button', { name: 'Attach document', exact: true }).click(); await expect(form).toHaveCount(0);
    const after = await service.control.read(), added = after.nodes.find(node => node.title === 'Verified document title')!;
    expect(added).toMatchObject({ projectId: 'project', position }); expect(after.revision).toBe(before.revision + 1);
    expect(after.resources.find(resource => resource.id === added.resourceId)?.pluginId).toBe('fixture.document');
    expect(after.links).toContainEqual(expect.objectContaining({ sourceId: added.id, targetId: 'agent', kind: 'context' }));
    expect(reads).toEqual(['fixture.document']);
    await page.reload(); await expect(page.getByRole('article', { name: 'Verified document title', exact: true })).toBeVisible();
    expect((await service.control.read()).links).toEqual(after.links);
    // Chromium's drag pipeline (still a local payload fixture, not a native-app
    // acceptance run) opens the same form, then attaches only on confirmation.
    const cdp = await page.context().newCDPSession(page), url = 'https://documents.example.test/dropped';
    const point = { x: 1120, y: 670 }, data = { items: [{ mimeType: 'text/uri-list', data: url }], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop'] as const) await cdp.send('Input.dispatchDragEvent', { type, ...point, data });
    await cdp.detach();
    await expect(form.getByLabel('Item URL')).toHaveValue(url);
    await expect(form).toHaveAttribute('data-project-id', '');
    expect(reads).toEqual(['fixture.document']); expect((await service.control.read()).revision).toBe(after.revision);
    const droppedPosition = await form.evaluate(el => ({ x: Number(el.getAttribute('data-world-x')), y: Number(el.getAttribute('data-world-y')) }));
    await form.getByLabel('Detected item type').selectOption('fixture.document');
    await form.getByRole('button', { name: 'Attach document', exact: true }).click(); await expect(form).toHaveCount(0);
    const droppedState = await service.control.read();
    const droppedResource = droppedState.resources.find(resource => resource.data.url === url)!;
    expect(droppedState.nodes.find(node => node.resourceId === droppedResource.id)).toMatchObject({ title: 'Verified document title', position: droppedPosition });
    expect(droppedState.nodes.find(node => node.resourceId === droppedResource.id)?.projectId).toBeUndefined();
    expect(droppedState.links).toEqual(after.links); expect(reads).toEqual(['fixture.document', 'fixture.document']);
  } finally { await exitWithoutShutdown(app); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
