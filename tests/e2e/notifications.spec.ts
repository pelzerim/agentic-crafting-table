import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../../packages/workspace-service/sqlite-store.ts';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';

for (const state of ['restored', 'failed'] as const) test(`recovery notification ${state === 'restored' ? 'expires without changing recovery data' : 'keeps failures visible until dismissed'}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-notice-')), store = new SqliteStore(join(directory, 'workspace.sqlite'));
  const recovery = { phase: 'open' as const, entries: [{ sessionId: 'saved-session', nodeId: 'saved-node', resourceId: 'saved-resource', title: 'Saved session', kind: 'unavailable' as const, continueWork: false, requestId: 'restore-request', state, ...(state === 'failed' ? { error: 'The saved directory is unavailable.' } : { restoredSessionId: 'new-session' }) }] };
  await store.update(snapshot => ({ ...snapshot,
    nodes: [{ id: 'saved-node', resourceId: 'saved-resource', title: 'Saved session', summary: '', activity: 'idle', attention: 'none', position: { x: 300, y: 300 } }],
    resources: [{ id: 'saved-resource', pluginId: 'agent.session', schemaVersion: 1, title: 'Saved session', data: { provider: 'claude', sessionId: 'saved-session' } }],
  }));
  store.writeRecovery(recovery); store.close();
  const service = await startWorkspaceService(directory, undefined, undefined, { assignments: [] });
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('Desktop connected')).toBeVisible();
    await expect.poll(() => service.store.readRecovery().phase).toBe('open');
    const before = service.store.readRecovery();
    await page.clock.install(); await page.reload();
    const notice = page.getByRole('status', { name: 'Workspace recovery' });
    await expect(notice).toBeVisible();
    if (state === 'restored') await expect(notice).toContainText('1 session restored');
    else await expect(notice).toContainText('The saved directory is unavailable.');
    // Repeated identical status reads must not reset the success expiry timer.
    await page.clock.runFor(6000);
    if (state === 'restored') await expect(notice).toHaveCount(0);
    else {
      await expect(notice).toBeVisible();
      await page.getByRole('button', { name: 'Dismiss recovery status' }).click();
      await expect(notice).toHaveCount(0);
    }
    expect(service.store.readRecovery()).toEqual(before);
  } finally { await exitWithoutShutdown(app); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a recovery checkpoint write failure stays visible and retries through the real service without reloading', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-checkpoint-notice-')), store = new SqliteStore(join(directory, 'workspace.sqlite'));
  store.writeRecovery({ phase: 'closed', entries: [] }); store.close();
  const service = await startWorkspaceService(directory, undefined, undefined, { assignments: [], reviews: {}, workflows: {} });
  const persist = service.store.writeRecovery.bind(service.store); let failing = true;
  // Fault only this isolated store's checkpoint writer, never the host disk.
  service.store.writeRecovery = value => { if (failing) throw new Error('Fixture storage unavailable'); persist(value); };
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow(); await expect(page.getByText('Desktop connected')).toBeVisible();
    const notice = page.getByRole('status', { name: 'Workspace recovery' });
    await expect(notice).toContainText('Recovery needs attention');
    await expect(notice).toContainText('Recovery checkpoint could not be saved: Fixture storage unavailable');
    await expect(notice.getByRole('button', { name: 'Retry recovery' })).toBeEnabled();
    await page.clock.install(); await page.clock.runFor(6000);
    await expect(notice).toBeVisible(); expect(service.store.readRecovery().phase).toBe('closed');
    failing = false; await notice.getByRole('button', { name: 'Retry recovery' }).click();
    await expect.poll(() => service.store.readRecovery().phase).toBe('open');
    await expect.poll(async () => (await page.evaluate(() => window.craftingTable.recoveryStatus())).error).toBeUndefined();
    await expect(page.getByText('Desktop connected')).toBeVisible();
    await expect(notice).toHaveCount(0);
    expect(service.store.listJobs()).toEqual([]);
  } finally { failing = false; await exitWithoutShutdown(app); await service.close(); await rm(directory, { recursive: true, force: true }); }
});


test('a legacy detached-session failure is retired on startup without an attention or zero-restored notice', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-orphan-notice-')), store = new SqliteStore(join(directory, 'workspace.sqlite'));
  store.writeRecovery({ phase: 'open', entries: [{ sessionId: 'saved-orphan', nodeId: 'removed-item', title: 'Detached session', kind: 'unavailable', continueWork: false, requestId: 'orphan-request', state: 'failed', error: 'This session has no restorable map item. Its recording is retained.' }] }); store.close();
  const service = await startWorkspaceService(directory, undefined, undefined, { assignments: [] });
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow(); await expect(page.getByText('Desktop connected')).toBeVisible();
    await expect.poll(() => service.store.readRecovery().entries[0].state).toBe('skipped');
    expect(service.store.readRecovery().entries[0].error).toBeUndefined();
    await expect(page.getByRole('status', { name: 'Workspace recovery' })).toHaveCount(0);
    await page.reload(); await expect(page.getByText('Desktop connected')).toBeVisible();
    await expect(page.getByRole('status', { name: 'Workspace recovery' })).toHaveCount(0);
    expect(service.store.listJobs()).toEqual([]);
    expect((await page.evaluate(() => window.craftingTable.workspaceRead())).state.nodes).toEqual([]);
  } finally { await exitWithoutShutdown(app); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
