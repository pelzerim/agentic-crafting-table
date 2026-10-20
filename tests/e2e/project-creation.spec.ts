import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';

test('right-click creates a project at the chosen map position and label options edit it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-project-menu-'));
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('Desktop connected')).toBeVisible();
    await expect(page.getByRole('button', { name: '+ New project', exact: true })).toHaveCount(0);
    const map = (await page.locator('.map-area').boundingBox())!;
    const point = { x: 450, y: 410 };
    await page.mouse.click(map.x + point.x, map.y + point.y, { button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'New item', exact: true })).toBeVisible();
    await page.getByRole('menuitem', { name: 'New project', exact: true }).click();
    const form = page.getByRole('form', { name: 'New item' });
    const placement = await form.evaluate(element => ({ x: Number(element.getAttribute('data-world-x')), y: Number(element.getAttribute('data-world-y')) }));
    const camera = await page.evaluate(() => window.craftingTable.viewRead());
    expect(placement.x).toBeCloseTo((point.x - (camera.camera?.x ?? 70)) / (camera.camera?.zoom ?? .85));
    expect(placement.y).toBeCloseTo((point.y - (camera.camera?.y ?? 80)) / (camera.camera?.zoom ?? .85));
    await page.getByLabel('Title', { exact: true }).fill('Right-click project');
    await page.getByRole('radio', { name: 'Diamond', exact: true }).click();
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    const label = page.getByRole('article', { name: 'Right-click project' });
    await expect(label).toHaveClass('project-neighborhood-title');
    const project = (await page.evaluate(() => window.craftingTable.workspaceRead())).state.nodes[0];
    expect(project.position).toEqual(placement); expect(project.projectId).toBeUndefined(); expect(project.color).toBe('#6fd6cf');
    await page.getByRole('button', { name: 'Project options: Right-click project' }).click();
    await page.getByRole('menuitem', { name: 'Project settings…', exact: true }).click();
    await page.getByLabel('Project summary').fill('Accessible through the neighborhood title');
    const colors = page.getByRole('radiogroup', { name: 'Neighborhood color', exact: true });
    await expect(colors.getByRole('radio', { name: 'Diamond', exact: true })).toHaveAttribute('aria-checked', 'true');
    await colors.getByRole('radio', { name: 'Redstone', exact: true }).click();
    await expect(colors.getByRole('radio', { name: 'Redstone', exact: true })).toHaveAttribute('aria-checked', 'true');
    await colors.locator('xpath=ancestor::form').screenshot({ path: 'test-results/project-color-picker.png' });
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.craftingTable.workspaceRead())).state.nodes[0].summary).toBe('Accessible through the neighborhood title');
    expect((await page.evaluate(() => window.craftingTable.workspaceRead())).state.nodes[0].color).toBe('#d0564c');
    await expect(page.locator(`[data-project-field="${project.id}"] .neighborhood-paint`)).toHaveAttribute('data-color', '#d0564c');
    expect(await page.locator(`[data-project-field="${project.id}"] .neighborhood-paint`).evaluate(el => getComputedStyle(el).fill)).toBe('rgb(208, 86, 76)');
    await page.locator(`.react-flow__node[data-id="${project.id}"]`).focus();
    await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menuitem', { name: 'Project settings…', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.locator('.map-area')).toHaveAttribute('data-level', 'neighborhood');
    await page.screenshot({ path: 'test-results/project-context-creation.png' });
  } finally {
    await exitWithoutShutdown(app);
    const client = await connectWorkspace(directory).catch(() => undefined);
    if (client) { const disconnected = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await disconnected; client.close(); }
    await rm(directory, { recursive: true, force: true });
  }
});
