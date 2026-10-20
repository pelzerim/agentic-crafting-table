import { expect } from '@playwright/test';
import { test } from './visual-fixture.ts';

test('Trigger validation lists connected agents, highlights the path on hover and never sends to a stopped agent', async ({ visual: { page } }) => {
  await page.evaluate(async () => {
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: 'rollout-validation-fixture', expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [
      { type: 'item.add', id: 'rollout', resourceId: 'rollout-r', pluginId: 'github.rollout', title: 'Web / Release', projectId: 'billing', position: { x: 980, y: 560 }, data: { owner: 'acme', repo: 'app', runId: 101 } },
      { type: 'link.save', link: { id: 'rollout-ticket', sourceId: 'rollout', targetId: 'ticket', kind: 'reference', label: '' } },
    ] });
  });
  const rollout = page.getByRole('article', { name: 'Web / Release', exact: true });
  await rollout.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Trigger validation', exact: true }).hover();
  const submenu = page.getByRole('menu', { name: 'Trigger validation', exact: true });
  const agent = submenu.getByRole('menuitem', { name: 'Claude · implementation', exact: true });
  await expect(agent).toBeDisabled();
  await expect(agent).toHaveAttribute('title', /^Stopped · connected through another item/);
  await agent.hover();
  await expect(page.locator('.react-flow__edge[data-id="rollout-ticket"]')).toHaveClass(/connection-active/);
  await expect(page.locator('.react-flow__edge[data-id="ticket-agent"]')).toHaveClass(/connection-active/);
  await expect(page.locator('.react-flow__edge[data-id="brief-pr"]')).toHaveClass(/connection-muted/);
  await expect(page.locator('.map-item-highlights > *')).toHaveCount(3);
  await page.screenshot({ path: 'test-results/rollout-validation-menu.png' });
  await page.keyboard.press('Escape');
  await expect(page.locator('.map-item-highlights > *')).toHaveCount(0);
  expect((await page.evaluate(() => window.craftingTable.workspaceRead())).state.links.some(link => link.targetId === 'agent' && link.sourceId === 'rollout')).toBe(false);
});
