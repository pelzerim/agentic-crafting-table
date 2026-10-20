import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resize } from './visual-fixture.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';

test('a render crash shows the recovery screen, logs the error and recovers on Try again', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-render-crash-')), file = join(directory, 'support.json');
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow(); await resize(app, page, 900, 640); await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.getByRole('button', { name: 'Create your first project' })).toBeVisible();
    // A malformed snapshot from the service makes the map throw while rendering.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('workspace:snapshot', { cursor: Number.MAX_SAFE_INTEGER, state: { nodes: 5, links: 5, resources: 5, todos: 5 } }));
    const screen = page.getByRole('alert').filter({ has: page.getByRole('heading', { name: 'Couldn’t open your table' }) });
    await expect(screen).toContainText('Part of the window stopped working. Your workspace data is untouched');
    await expect(screen.locator('pre')).toBeHidden();
    await expect(screen).toHaveScreenshot('error-screen.png');
    await screen.getByText('Error details', { exact: true }).click(); await expect(screen.locator('pre')).toContainText('nodes.filter is not a function');
    await expect.poll(() => readFile(join(directory, 'renderer.log'), 'utf8').catch(() => '')).toMatch(/ caught nodes.filter is not a function/);
    await screen.getByRole('button', { name: 'Open logs folder', exact: true }).click();
    await app.evaluate(({ session }, path) => { session.defaultSession.once('will-download', (_event, item) => item.setSavePath(path)); }, file);
    await screen.getByRole('button', { name: 'Download support report', exact: true }).click();
    await expect(screen.getByRole('status')).toHaveText('Support report downloaded');
    await expect.poll(() => readFile(file, 'utf8').catch(() => '')).toContain('terminalRecordings');
    await screen.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Create your first project' })).toBeVisible();
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a failed initial load shows the recovery screen instead of the raw error and retries on request', async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-load-failure-')), database = join(directory, 'workspace.sqlite');
  await writeFile(database, 'not a database\n'.repeat(512));
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow();
    const screen = page.getByRole('alert').filter({ has: page.getByRole('heading', { name: 'Couldn’t open your table' }) });
    await expect(screen).toContainText('Your workspace data is untouched', { timeout: 30_000 });
    await expect(page.locator('.map-message')).toHaveCount(0);
    await screen.getByText('Error details', { exact: true }).click(); await expect(screen.locator('pre')).not.toBeEmpty();
    expect(await readFile(database, 'utf8')).toBe('not a database\n'.repeat(512));
    await rm(database);
    await screen.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Create your first project' })).toBeVisible({ timeout: 30_000 });
  } finally {
    await exitWithoutShutdown(app);
    const service = await connectWorkspace(directory).catch(() => undefined);
    if (service) { await service.call('admin.shutdown').catch(() => {}); service.close(); }
    await rm(directory, { recursive: true, force: true });
  }
});
