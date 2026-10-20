import { openDiagnosticSessions } from './session-navigation.ts';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';

test('item and Sessions controls cancel a preparing agent before its terminal launches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-pending-stop-')), bin = join(directory, 'bin'), repo = join(directory, 'repo');
  await mkdir(bin); await mkdir(repo);
  await writeFile(join(bin, 'codex'), `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/native-codex.mjs')).href)};\n`, { mode: 0o700 });
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory, SHELL: '/bin/sh', CODEX_FIXTURE_HOME: repo, CODEX_FIXTURE_PAUSE_METHOD: 'thread/inject_items', PATH: `${bin}:${process.env.PATH}` } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('Desktop connected')).toBeVisible();
    for (const control of ['item', 'sessions']) {
      const requestId = randomUUID();
      // Arrange an in-flight production creation, then exercise the actual UI.
      const creation = page.evaluate(async ({ requestId, nodeId, resourceId, repo, control }) => {
        const state = (await window.craftingTable.workspaceRead()).state;
        return window.craftingTable.resourceCreate({ requestId, nodeId, resourceId, expectedRevision: state.revision,
          pluginId: 'agent.session', title: `Preparing ${control}`, position: { x: control === 'item' ? 250 : 650, y: 300 },
          data: { provider: 'codex', model: 'gpt-6-astra', cwd: repo } });
      }, { requestId, nodeId: randomUUID(), resourceId: randomUUID(), repo, control }).then(value => ({ value }), error => ({ error: String(error) }));
      await expect.poll(() => existsSync(join(repo, 'native-paused'))).toBe(true);
      const pid = Number(await readFile(join(repo, 'native-server.pid'), 'utf8'));
      if (control === 'item') {
        await page.getByRole('article', { name: 'Preparing item', exact: true }).click();
        await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'starting');
        await page.getByRole('button', { name: 'Stop session', exact: true }).click();
        await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'exited');
        await expect(page.getByRole('button', { name: 'Stop session', exact: true })).toBeDisabled();
        await expect(page.locator('.terminal-error')).toHaveCount(0);
        await page.getByRole('button', { name: 'Back to project' }).click();
      } else {
        await openDiagnosticSessions(page);
        const row = page.locator(`[data-session-id="${requestId}"]`);
        await expect(row).toContainText('starting');
        await row.getByRole('button', { name: 'Stop', exact: true }).click();
        // A stopped session leaves Current for Ended.
        await expect(row).toHaveCount(0);
        await page.getByRole('button', { name: 'Ended sessions' }).click();
        await expect(row).toContainText('exited');
        await expect(row.getByRole('button', { name: 'Delete entry', exact: true })).toHaveCount(0);
        await expect(row.getByRole('button', { name: 'Archive', exact: true })).toBeEnabled();
      }
      expect(await creation).not.toHaveProperty('error');
      const { session, chunks } = await page.evaluate(id => window.craftingTable.sessionRead(id), requestId);
      expect(session.stopRequestedAt).toBeTruthy(); expect(session.pid).toBeUndefined(); expect(chunks).toEqual([]);
      await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }).toBe(false);
      expect(existsSync(join(repo, 'native-codex.json'))).toBe(false);
      await rm(join(repo, 'native-paused'));
    }
  } finally {
    await exitWithoutShutdown(app);
    for (const connect of [() => connectWorkspace(directory), () => connectSupervisor(join(directory, 'runtime'))]) {
      const client = await connect().catch(() => undefined);
      if (client) { const disconnected = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await disconnected; client.close(); }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
