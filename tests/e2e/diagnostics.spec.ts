import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { resize } from './visual-fixture.ts';

test('diagnostic settings persist and support download contains only safe aggregate data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-diagnostics-view-')), file = join(directory, 'support.json');
  let service = await startWorkspaceService(directory, undefined, undefined, {});
  await service.control.dispatch({ commandId: 'private', expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'project.create', id: 'PRIVATE_ID', title: 'PRIVATE_TITLE', summary: 'PRIVATE_PROMPT', workingDirectory: '/PRIVATE_PATH', position: { x: 400, y: 300 } }] });
  const launch = () => electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  let app = await launch();
  try {
    let page = await app.firstWindow(); await resize(app, page, 900, 640); await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('treeitem', { name: 'Data & diagnostics', exact: true }).click();
    await page.getByLabel('Diagnostic log size', { exact: true }).fill('3'); await page.getByLabel('Diagnostic log backups', { exact: true }).fill('1');
    await expect(page.locator('.local-diagnostics')).toContainText('Up to 6 MiB per service'); await expect(page.locator('.local-diagnostics')).toContainText('Terminal recordings are preserved');
    await page.getByRole('button', { name: 'Save settings', exact: true }).click(); await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
    await exitWithoutShutdown(app); await service.close(); service = await startWorkspaceService(directory, undefined, undefined, {}); app = await launch(); page = await app.firstWindow(); await resize(app, page, 900, 640);
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('treeitem', { name: 'Data & diagnostics', exact: true }).click();
    await expect(page.getByLabel('Diagnostic log size', { exact: true })).toHaveValue('3'); await expect(page.getByLabel('Diagnostic log backups', { exact: true })).toHaveValue('1');
    // Isolated destination avoids a foreground native save dialog during automation.
    await app.evaluate(({ session }, path) => { session.defaultSession.once('will-download', (_event, item) => item.setSavePath(path)); }, file);
    await page.getByRole('button', { name: 'Download support report', exact: true }).click();
    await expect.poll(() => readFile(file, 'utf8').catch(() => '')).toContain('terminalRecordings');
    const text = await readFile(file, 'utf8'), report = JSON.parse(text);
    expect(text).not.toMatch(/PRIVATE_|craft-diagnostics-view-|\/Users\/|workspaceId|sessionId/);
    expect(report.workspace.projects).toBe(1); expect(report.diagnostics).toEqual({ fileMiB: 3, backups: 1, terminalRecordings: 'preserved' });
    expect(report.performance.sampleLimit).toBe(512); expect(report.app.version).toBe('0.1.0');
    const output = await page.getByRole('button', { name: 'Download support report', exact: true }).boundingBox(); expect(output!.y + output!.height).toBeLessThanOrEqual(640);
    await expect(page.locator('.local-diagnostics')).toHaveScreenshot('local-data-support.png');
  } finally { await exitWithoutShutdown(app); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('service health shows lag, snapshot rates, disconnects and the slowest operations after a few commits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-service-health-')), file = join(directory, 'health.json');
  const service = await startWorkspaceService(directory, undefined, undefined, {});
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow(); await resize(app, page, 1100, 800); await page.emulateMedia({ reducedMotion: 'reduce' });
    for (let n = 0; n < 3; n++) {
      await page.evaluate(async n => {
        const { state } = await window.craftingTable.workspaceRead();
        await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'test' },
          commands: [{ type: 'project.create', id: `PRIVATE_ID_${n}`, title: `PRIVATE_TITLE_${n}`, summary: '', position: { x: n * 500, y: 0 } }] });
      }, n);
    }
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('treeitem', { name: 'Data & diagnostics', exact: true }).click();
    const health = page.getByRole('region', { name: 'Service health' });
    await expect(health.getByRole('table')).toHaveCount(0);
    await health.getByRole('button', { name: 'Show service health', exact: true }).click();
    await health.getByRole('button', { name: 'Refresh service health', exact: true }).click();
    await expect(health).toContainText(/Event-loop lag: max \d+(\.\d)? ms · p95 \d+(\.\d)? ms/);
    await expect(health).toContainText(/Snapshots: \d+(\.\d)? per minute · [\d.]+ (B|KB|MB) per minute/);
    await expect(health).toContainText(/Coalesced snapshots: 0 · Dropped clients: 0/);
    await expect(health).toContainText('No disconnects since the app started');
    const operations = health.getByRole('table', { name: 'Slowest operations' });
    await expect(operations.getByRole('row').filter({ hasText: /^apply/ }).first()).toBeVisible();
    await app.evaluate(({ session }, path) => { session.defaultSession.once('will-download', (_event, item) => item.setSavePath(path)); }, file);
    await health.getByRole('button', { name: 'Download service health', exact: true }).click();
    await expect.poll(() => readFile(file, 'utf8').catch(() => '')).toContain('slowestOperations');
    const text = await readFile(file, 'utf8'), report = JSON.parse(text);
    expect(report.service.broadcasts.snapshots).toBeGreaterThanOrEqual(3);
    expect(report.service.operationCounts.broadcast.count).toBeGreaterThanOrEqual(3);
    expect(report.connection.events.map((event: { status: string }) => event.status)).toContain('connected');
    expect(text).not.toMatch(/PRIVATE_/);
  } finally { await exitWithoutShutdown(app); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
