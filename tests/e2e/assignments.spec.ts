import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { githubFixture } from '../fixtures/github.ts';
import { githubAssignmentAdapter } from '../../packages/provider-runtime/github-assignments.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';

test('assigned PRs arrive automatically; opening keeps Needs me and only Seen acknowledges the current cycle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-assigned-')), fixture = githubFixture(); let assigned = true;
  const providers = { ...fixture, assignments: [{ ...githubAssignmentAdapter(() => fixture.client), async discover() { return assigned ? [{ title: fixture.pull.title, data: { owner: 'fixture', repo: 'billing', number: 42 }, assigned: true }] : []; } }] };
  let service = await startWorkspaceService(directory, undefined, undefined, providers);
  const settings = service.store.readSettings(); service.store.writeSettings({ expectedRevision: settings.revision, value: { ...settings.value, connections: fixture.accounts } });
  let app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    let page = await app.firstWindow();
    const needs = page.getByRole('button', { name: 'Needs me: 1', exact: true });
    await expect(needs).toBeVisible();
    const state = await service.control.read(), nodeId = state.nodes[0].id, raised = state.nodes[0];
    const read = await page.evaluate(nodeId => window.craftingTable.runtimeRun({ action: 'resource.read', nodeId, arguments: {} }), nodeId) as any;
    expect(read.attentionReceipt).toBeTruthy(); await expect(needs).toBeVisible();
    await needs.click();
    await page.getByRole('button', { name: 'Open ' + fixture.pull.title, exact: true }).click();
    await expect(page.locator('[data-expanded-item-id]:visible .card-label strong')).toHaveText(fixture.pull.title);
    await expect(page.locator('.item-view:visible .view-freshness')).toHaveText(/^Read /);
    await page.getByRole('button', { name: 'Back to project' }).click();
    await page.getByRole('article', { name: fixture.pull.title, exact: true }).click();
    await expect(page.locator('.item-view:visible .view-freshness')).toHaveText(/^Read /);
    await page.getByRole('button', { name: 'Back to project' }).click();
    await expect(needs).toBeVisible();
    let node = (await service.control.read()).nodes[0];
    expect(node.attentionSources).toEqual(raised.attentionSources); expect(node.attentionSeenVersion).toBe(raised.attentionSeenVersion);
    await needs.click(); await page.getByRole('button', { name: `Dismiss ${fixture.pull.title} from Needs me`, exact: true }).click();
    await expect(needs).toHaveCount(0);
    assigned = false; await page.evaluate(() => window.craftingTable.providerRefresh()); assigned = true; await page.evaluate(() => window.craftingTable.providerRefresh());
    await expect(needs).toBeVisible();
    expect(await page.evaluate(({ nodeId, receipt }) => window.craftingTable.runtimeRun({ action: 'resource.viewed', nodeId, arguments: { receipt } }), { nodeId, receipt: read.attentionReceipt })).toEqual({ acknowledged: false });
    node = (await service.control.read()).nodes[0];
    await exitWithoutShutdown(app); await service.close(); service = await startWorkspaceService(directory, undefined, undefined, providers);
    app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } }); page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Needs me: 1', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sync now', exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Sync now', exact: true }).click();
    expect((await service.control.read()).nodes).toHaveLength(1); expect((await service.control.read()).nodes[0].attentionVersion).toBe(node.attentionVersion);
  } finally { await app.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
