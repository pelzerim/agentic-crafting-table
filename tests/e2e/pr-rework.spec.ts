import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { githubFixture } from '../fixtures/github.ts';
import { scrollbarArgs } from './visual-fixture.ts';

test('an agent reworking a pull request keeps it working with a line above the description; Mark as completed manually clears it', async () => {
  test.setTimeout(60_000);
  const providers = githubFixture();
  const directory = await mkdtemp(join(tmpdir(), 'craft-pr-rework-')), service = await startWorkspaceService(directory, undefined, undefined, providers);
  await service.control.dispatch({ commandId: 'setup', expectedRevision: 0, actor: { kind: 'user', id: 'test' }, commands: [
    { type: 'item.add', id: 'pr', resourceId: 'pr-resource', pluginId: 'github.pull-request', title: 'PR', position: { x: 0, y: 0 }, data: { owner: 'fixture', repo: 'billing', number: 42 } },
    { type: 'item.add', id: 'fixer', resourceId: 'fixer-r', pluginId: 'agent.session', title: 'Claude · review fixes', position: { x: 400, y: 0 }, data: { sessionId: 'fixture-session', provider: 'claude' } },
  ] });
  await service.resources.poll();
  const app = await electron.launch({ args: ['.', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow(), card = page.locator('[data-item-id="pr"]'), frame = page.locator('[data-expanded-item-id=pr]');
    await card.click();
    const line = frame.locator('.pr-rework');
    await expect(line).toBeHidden();
    await page.evaluate(async () => {
      const { state } = await window.craftingTable.workspaceRead();
      await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'node.rework', id: 'pr', note: 'Addressing two review findings', by: 'fixer' }] });
    });
    await expect(line).toBeVisible();
    await expect(line).toHaveAttribute('role', 'status');
    await expect(line.locator('.pr-rework-text')).toHaveText('Reworking · Addressing two review findings · Claude · review fixes');
    expect(await line.evaluate(element => element.compareDocumentPosition(element.closest('.pr-desk')!.querySelector('.pr-description-panel')!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();
    await service.resources.poll();
    expect((await service.control.read()).nodes.find(node => node.id === 'pr')!.activity).toBe('working');
    await line.getByRole('button', { name: 'Mark as completed manually', exact: true }).click();
    await expect(line).toBeHidden();
    const node = (await service.control.read()).nodes.find(node => node.id === 'pr')!;
    expect([node.rework, node.activity]).toEqual([undefined, 'idle']);
  } finally {
    await app.close(); await service.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
