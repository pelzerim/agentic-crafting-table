import { openProjectPicker } from './project-picker.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { createResourcePluginRegistry } from '../../src/resource-plugins/builtins.ts';
import { defineResourcePlugin } from '../../src/resource-plugins/define.ts';

test('a failed initial workspace read recovers without reloading and later reconnect preserves the current camera', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-bootstrap-retry-'));
  const registry = createResourcePluginRegistry();
  let service = await startWorkspaceService(directory, registry);
  await service.control.dispatch({ commandId: 'fixture', expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [
    { type: 'project.create', id: 'project', title: 'Recovered project', position: { x: 400, y: 300 } },
  ] });
  await service.store.writeView('desktop', { camera: { x: 60, y: 40, zoom: .8 } });
  const before = await service.control.read(), describe = registry.describe.bind(registry);
  let unavailable = true;
  registry.describe = () => { if (unavailable) throw new Error('Fixture catalog temporarily unavailable'); return describe(); };
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow();
    const screen = page.getByRole('alert').filter({ has: page.getByRole('heading', { name: 'Couldn’t open your table' }) });
    await expect(screen).toBeVisible();
    await expect(screen.locator('pre')).toHaveText('Fixture catalog temporarily unavailable');
    unavailable = false;
    await expect(page.getByRole('article', { name: 'Recovered project', exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', '0.8');
    expect(await service.control.read()).toEqual(before);
    await page.mouse.move(900, 500); await page.mouse.wheel(0, 120);
    await expect.poll(() => page.locator('.map-area').getAttribute('data-zoom')).not.toBe('0.8');
    const zoom = await page.locator('.map-area').getAttribute('data-zoom');
    await expect.poll(async () => String((await service.store.readView('desktop')).camera?.zoom)).toBe(zoom);
    await page.getByRole('article', { name: 'Recovered project', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Project settings…', exact: true }).click();
    await page.getByLabel('Title', { exact: true }).fill('Keep this draft');
    await service.close();
    service = await startWorkspaceService(directory);
    // A later reconnect must not replay the saved startup view over the current map.
    await service.store.writeView('desktop', { camera: { x: 0, y: 0, zoom: 1.2 } });
    await expect.poll(() => page.evaluate(async () => (await window.craftingTable.viewRead()).camera?.zoom)).toBe(1.2);
    await expect(page.getByText('Desktop connected', { exact: true })).toBeVisible();
    await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', zoom!);
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Keep this draft');
    expect(await service.control.read()).toEqual(before);
  } finally { unavailable = false; await exitWithoutShutdown(app); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('real projects and an unknown plugin persist, synchronize, and retain camera after reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-live-map-'));
  const registry = createResourcePluginRegistry([defineResourcePlugin({
    id: 'fixture.note', apiVersion: 1, schemaVersion: 1, name: 'Research note', icon: 'note', preferredView: 'focus',
    appearance: { size: 'small', tone: 'rose', shape: 'document' }, creation: { label: 'Add research note' },
    fields: { body: { label: 'Note content', kind: 'text', multiline: true, required: true } },
  })]);
  const service = await startWorkspaceService(directory, registry);
  const client = await connectWorkspace(directory);
  let app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    let page = await app.firstWindow();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: 'Create your first project' }).click();
    await page.getByLabel('Title', { exact: true }).fill('Checkout redesign');
    await page.getByLabel('Project summary').fill('Make billing changes easier to understand.');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    const project = page.getByRole('article', { name: 'Checkout redesign' });
    await expect(project).toBeVisible();
    const projectId = await project.getAttribute('data-item-id');
    await project.click({ button: 'right' });
    await expect(page.getByRole('menu')).toBeVisible();
    await project.click({ button: 'right' });
    await expect(page.getByRole('menu')).toHaveCount(0);
    await project.click({ button: 'right' });
    await page.mouse.click(1000, 400);
    await expect(page.getByRole('menu')).toHaveCount(0);
    await openProjectPicker(page, 'Checkout redesign');
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Quick item types' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Research note', exact: true }).click();
    await page.getByLabel('Title', { exact: true }).fill('Current architecture');
    await page.getByLabel('Note content').fill('The checkout API owns the transaction.');
    const form = page.getByRole('form', { name: 'New item' });
    await expect.poll(() => form.evaluate(element => element.getAnimations().length)).toBe(0);
    const placement = await form.evaluate(element => [element.getAttribute('data-world-x'), element.getAttribute('data-world-y')]);
    const formBefore = (await form.boundingBox())!;
    const heading = (await form.locator('.editor-heading').boundingBox())!;
    await page.mouse.move(heading.x + 60, heading.y + heading.height / 2);
    await page.mouse.down();
    // The title is above the circle; drag down so the form stays within the canvas.
    await page.mouse.move(heading.x + 180, heading.y + heading.height / 2 + 40, { steps: 8 });
    await page.mouse.up();
    const formAfter = (await form.boundingBox())!;
    expect(formAfter.x - formBefore.x).toBeCloseTo(120, 0);
    expect(formAfter.y - formBefore.y).toBeCloseTo(40, 0);
    expect(await form.evaluate(element => [element.getAttribute('data-world-x'), element.getAttribute('data-world-y')])).toEqual(placement);
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Current architecture');
    await expect(page.getByLabel('Note content')).toHaveValue('The checkout API owns the transaction.');
    await page.screenshot({ path: 'test-results/moved-item-form.png' });
    await page.getByRole('button', { name: 'Add research note', exact: true }).click();
    const note = page.getByRole('article', { name: 'Current architecture' });
    await expect(note).toBeVisible();
    const state = await service.store.read();
    expect(state.nodes.find(node => node.resourceId)?.projectId).toBe(projectId);
    expect(state.nodes.find(node => node.resourceId)?.position).toEqual({ x: Number(placement[0]), y: Number(placement[1]) });
    await note.click();
    await expect(page.getByText('The checkout API owns the transaction.')).toBeVisible();
    await page.getByRole('button', { name: 'Back to project' }).click();
    // Editing the project runs the same command path as a second MCP/API client.
    await project.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Project settings…' }).click();
    await page.getByLabel('Project summary').fill('Saved project context');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect.poll(async () => (await service.store.read()).nodes.find(node => node.id === projectId)?.summary).toBe('Saved project context');
    const before = await service.store.read();
    await client.call('apply', { commandId: 'external-edit', expectedRevision: before.revision, actor: { kind: 'agent', id: 'test' }, commands: [{ type: 'node.update', id: projectId, title: 'Billing workspace' }] });
    await expect(page.getByRole('article', { name: 'Billing workspace' })).toBeVisible();
    await page.mouse.move(280, 210); await page.mouse.wheel(0, 80);
    await expect.poll(async () => (await service.store.readView('desktop')).camera?.zoom ?? 2).toBeLessThan(.85);
    const camera = (await service.store.readView('desktop')).camera;
    const positions = (await service.store.read()).nodes.map(node => node.position);
    expect(errors).toEqual([]);
    await exitWithoutShutdown(app);
    app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
    page = await app.firstWindow();
    await expect(page.getByRole('article', { name: 'Billing workspace' })).toBeVisible();
    await expect(page.getByRole('article', { name: 'Current architecture' })).toBeVisible();
    expect(Number(await page.locator('.map-area').getAttribute('data-zoom'))).toBeCloseTo(camera!.zoom);
    expect((await service.store.read()).nodes.map(node => node.position)).toEqual(positions);
    await page.screenshot({ path: 'test-results/persistent-map.png' });
  } finally { await exitWithoutShutdown(app); client.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
