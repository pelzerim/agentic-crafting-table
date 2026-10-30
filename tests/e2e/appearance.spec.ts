import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';

async function launch(appearance: string | undefined, run: (app: ElectronApplication, page: Page, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-appearance-'));
  const { ACT_TEST_APPEARANCE: _inherited, ...inherited } = process.env;
  const app = await electron.launch({ args: ['.'], env: { ...inherited, ACT_TEST_DATA_DIR: directory, ...(appearance ? { ACT_TEST_APPEARANCE: appearance } : {}) } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('Desktop connected')).toBeVisible();
    await run(app, page, directory);
  } finally {
    await exitWithoutShutdown(app);
    for (const connect of [() => connectWorkspace(directory), () => connectSupervisor(join(directory, 'runtime'))]) {
      const client = await connect().catch(() => undefined);
      if (client) { const disconnected = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await disconnected; client.close(); }
    }
    await rm(directory, { recursive: true, force: true });
  }
}
/** Playwright emulates prefers-color-scheme: light, so these also show the page ignores it. */
const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);
const token = (page: Page, name: string) => page.evaluate(name => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), name);

test('a test launch is dark whatever the machine uses', async () => {
  await launch(undefined, async (app, page) => {
    expect(await theme(page)).toBe('dark');
    expect(await token(page, '--act-bg')).toBe('#141a17');
    expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark');
  });
});

test('the light theme reaches tokens, the window and the terminal, and Settings saves the choice', async () => {
  await launch('light', async (app, page, directory) => {
    expect(await theme(page)).toBe('light');
    expect(await token(page, '--act-bg')).toBe('#eef2ee');
    expect(await token(page, '--act-ink')).toBe('#17231b');
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase())).toBe('#eef2ee');

    await page.evaluate(async cwd => {
      const id = crypto.randomUUID();
      await window.craftingTable.resourceCreate({ requestId: id, nodeId: crypto.randomUUID(), resourceId: crypto.randomUUID(), expectedRevision: 0,
        pluginId: 'terminal.session', title: 'Light terminal', position: { x: 250, y: 230 }, data: { cwd } });
    }, directory);
    await page.getByRole('article', { name: 'Light terminal' }).click();
    await expect(page.locator('.terminal-surface')).toHaveAttribute('data-terminal-theme', 'light');
    await page.keyboard.press('Escape');

    expect((await page.evaluate(() => window.craftingTable.settingsRead())).value.appearance).toBe('system');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('treeitem', { name: 'General', exact: true }).click();
    const colours = dialog.getByRole('radiogroup', { name: 'Colours' });
    await expect(colours.getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'true');
    await colours.getByRole('radio', { name: 'Dark' }).click();
    await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect((await page.evaluate(() => window.craftingTable.settingsRead())).value.appearance).toBe('dark');
    await expect.poll(() => theme(page)).toBe('dark');
    await expect(page.locator('.terminal-surface')).toHaveAttribute('data-terminal-theme', 'dark');
  });
});

test('a theme change reaches the open page and terminal without reloading, as when macOS switches on System', async () => {
  await launch('light', async (app, page, directory) => {
    await page.evaluate(async cwd => {
      const id = crypto.randomUUID();
      await window.craftingTable.resourceCreate({ requestId: id, nodeId: crypto.randomUUID(), resourceId: crypto.randomUUID(), expectedRevision: 0,
        pluginId: 'terminal.session', title: 'Switching terminal', position: { x: 250, y: 230 }, data: { cwd } });
    }, directory);
    await page.getByRole('article', { name: 'Switching terminal' }).click();
    const surface = page.locator('.terminal-surface'), mount = await surface.getAttribute('data-mount-id');
    await expect(surface).toHaveAttribute('data-terminal-theme', 'light');
    await page.evaluate(() => { (window as unknown as { loaded: boolean }).loaded = true; });

    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; });
    await expect.poll(() => theme(page)).toBe('dark');
    expect(await token(page, '--act-bg')).toBe('#141a17');
    await expect(surface).toHaveAttribute('data-terminal-theme', 'dark');
    expect(await surface.getAttribute('data-mount-id')).toBe(mount);
    expect(await page.evaluate(() => (window as unknown as { loaded?: boolean }).loaded)).toBe(true);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase())).toBe('#141a17');
  });
});
