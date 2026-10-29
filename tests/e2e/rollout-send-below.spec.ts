import { test, expect } from '@playwright/test';
import { rolloutFixture } from '../fixtures/rollout.ts';
import { rolloutHarness } from './rollout-harness.ts';

test('a finished rollout\'s open view offers Send to Undermap at its top right; a running one does not', async () => {
  test.setTimeout(120_000);
  const rollouts = rolloutFixture();
  const h = await rolloutHarness(rollouts, [], () => [
    { type: 'item.add', id: 'rollout', resourceId: 'rollout-r', pluginId: 'github.rollout', title: 'Rollout', projectId: 'project', position: { x: 260, y: 200 }, data: { owner: 'fixture', repo: 'web', runId: 101 } },
  ]);
  try {
    const { page } = h, frame = page.locator('[data-expanded-item-id]:visible'), send = frame.getByRole('button', { name: 'Send to Undermap', exact: true });
    const read = () => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state.nodes.find(node => node.id === 'rollout'));
    await page.locator('[data-item-id="rollout"]').click();
    await expect(page.locator('.rollout-detail')).toBeVisible();
    await expect(send).toHaveCount(0);
    await page.keyboard.press('Escape');
    rollouts.run.status = 'completed'; rollouts.run.conclusion = 'success';
    rollouts.jobs = rollouts.jobs.map(job => ({ ...job, status: 'completed', conclusion: 'success' }));
    await h.tick();
    await expect.poll(async () => (await read())?.activity, { timeout: 30_000 }).toBe('complete');
    await page.locator('[data-item-id="rollout"]').click();
    await expect(send).toBeVisible();
    expect(await send.evaluate(node => getComputedStyle(node).color)).toBe(await page.evaluate(() => { const probe = document.createElement('i'); probe.style.color = 'var(--act-undermap-accent)'; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; }));
    await send.click();
    await expect.poll(async () => Boolean((await read())?.belowAt)).toBe(true);
    await expect(frame).toHaveCount(0);
  } finally { await h.close(); }
});
