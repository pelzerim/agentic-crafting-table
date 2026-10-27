import { expect } from '@playwright/test';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from './visual-fixture.ts';

/** A stand-in for the GitHub tags API; the port is fixed before launch so the app can be pointed at it. */
const port = 41000 + (process.pid % 2000);
let server: Server, tags = ['v0.1.0', 'v9.9.0', 'nightly'];
test.use({ launchEnv: { ACT_TEST_UPDATE_TAGS_URL: `http://127.0.0.1:${port}/tags` } });
test.beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url !== '/tags') { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(tags.map(name => ({ name }))));
  });
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
});
test.afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

test('a newer release tag shows in Settings → General and as a notice; dismissing it is remembered per version', async ({ visual: { page } }) => {
  const notice = page.getByRole('status', { name: 'Agentic Crafting Table v9.9.0 is available' });
  await expect(notice).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('treeitem', { name: 'General', exact: true }).click();
  const status = dialog.locator('.settings-update-status');
  await expect(status).toHaveText(/^ACT v\d+\.\d+\.\d+ · not checked yet$/);
  await dialog.getByRole('button', { name: 'Check now' }).click();
  await expect(status).toHaveText(/^ACT v\d+\.\d+\.\d+ · v9\.9\.0 available$/);
  await expect(dialog.getByText(/v9\.9\.0 is available\. In your checkout, quit the app and run npm run update/)).toBeVisible();
  await expect(dialog.getByRole('switch', { name: 'Check for updates daily', exact: true })).toBeChecked();
  await dialog.getByRole('button', { name: 'Close settings' }).click();

  await expect(notice).toBeVisible();
  await expect(notice).toContainText('Update from Settings → General');
  await notice.getByRole('button', { name: 'How to update' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('treeitem', { name: 'General', exact: true })).toHaveAttribute('aria-selected', 'true');
  await dialog.getByRole('button', { name: 'Close settings' }).click();

  await notice.getByRole('button', { name: 'Dismiss the v9.9.0 update notice' }).click();
  await expect(notice).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  await expect(notice).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await dialog.getByRole('treeitem', { name: 'General', exact: true }).click();
  await expect(status).toHaveText(/v9\.9\.0 available$/);
  await dialog.getByRole('button', { name: 'Close settings' }).click();

  // A release newer than the dismissed one is offered again.
  tags = ['v0.1.0', 'v9.9.0', 'v10.0.0'];
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await dialog.getByRole('treeitem', { name: 'General', exact: true }).click();
  await dialog.getByRole('button', { name: 'Check now' }).click();
  await expect(status).toHaveText(/v10\.0\.0 available$/);
  await dialog.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByRole('status', { name: 'Agentic Crafting Table v10.0.0 is available' })).toBeVisible();
});

test('a failed Update and restart shows in Settings → General until a later check succeeds, which deletes its note', async ({ visual: { app, page } }) => {
  const file = join(await app.evaluate(({ app }) => app.getPath('userData')), 'update-failure.json');
  await writeFile(file, JSON.stringify({ at: Date.now(), tag: 'v9.9.0', message: 'The checkout has local changes; commit, stash or discard them first' }));
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('treeitem', { name: 'General', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Update to v9.9.0 failed: The checkout has local changes; commit, stash or discard them first');
  await dialog.getByRole('button', { name: 'Check now' }).click();
  await expect(dialog.locator('.settings-update-status')).toHaveText(/ available$/);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect.poll(() => access(file).then(() => true, () => false)).toBe(false);
});

test('an unreachable tag source is reported in Settings and raises no notice', async ({ visual: { page } }) => {
  tags = [];
  await new Promise(resolve => server.close(resolve));
  try {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('treeitem', { name: 'General', exact: true }).click();
    await dialog.getByRole('button', { name: 'Check now' }).click();
    await expect(dialog.locator('.settings-update-status')).toHaveText(/· could not check: /);
    await dialog.getByRole('button', { name: 'Close settings' }).click();
    await expect(page.locator('.act-toast[data-tone=info]')).toHaveCount(0);
  } finally {
    server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('[]'); });
    await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  }
});
