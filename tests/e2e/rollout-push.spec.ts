import { test, expect } from '@playwright/test';
import { rolloutFixture } from '../fixtures/rollout.ts';
import { rolloutHarness } from './rollout-harness.ts';

/** Milliseconds from the first moment the service holds the validation until the open view shows it. */
async function latency(created: () => boolean, shown: () => Promise<boolean>) {
  while (!created()) await new Promise(resolve => setTimeout(resolve, 5));
  const start = Date.now();
  while (!await shown()) { if (Date.now() - start > 10_000) return Infinity; await new Promise(resolve => setTimeout(resolve, 10)); }
  return Date.now() - start;
}

test('a new validation shows in the open rollout view as soon as the service records it, while the request is still under way', async () => {
  test.setTimeout(90_000);
  const providers = rolloutFixture(), get = providers.transport.get;
  let slow = false;
  // GitHub answering slowly keeps the request busy after the validation is recorded.
  providers.transport.get = async (path, signal) => { if (slow) await new Promise(resolve => setTimeout(resolve, 2_000)); return get(path, signal); };
  const h = await rolloutHarness(providers, ['claude'], agent => [
    { type: 'item.add', id: 'rollout', resourceId: 'rollout-r', pluginId: 'github.rollout', title: 'Rollout', projectId: 'project', position: { x: 260, y: 200 }, data: { owner: 'fixture', repo: 'web', runId: 101 } },
    agent('claude', 'Claude · validator', 60),
    { type: 'link.save', link: { id: 'rollout-claude', sourceId: 'rollout', targetId: 'claude', kind: 'context', label: '' } },
  ]);
  try {
    const { page, service } = h, detail = page.locator('.rollout-detail'), card = (id: string) => detail.locator(`.rv-card[aria-label^="${id} · "]`);
    // The view's timers run on the page clock, so pausing it leaves only what the service pushes.
    await page.clock.install();
    await page.locator('[data-item-id="rollout"]').click();
    await detail.getByRole('button', { name: 'Show the jobs rail', exact: true }).click();
    await expect(detail.getByRole('list', { name: 'Rollout jobs' }).getByRole('listitem')).toHaveCount(3);
    await page.clock.pauseAt(new Date(Date.now() + 60_000));
    const validations = () => service.store.rolloutValidations({ rolloutResourceId: 'rollout-r' });

    slow = true;
    await page.evaluate(() => { void window.craftingTable.runtimeRun({ action: 'rollout.validation' as 'agent.resume', nodeId: 'rollout', arguments: { operation: 'trigger', sourceResourceId: 'rollout-r', value: 'claude', requestId: crypto.randomUUID() } }); });
    const created = await latency(() => validations().length === 1, () => card('V1').isVisible());
    console.log(`new validation shown after ${created} ms`);
    expect(created).toBeLessThan(500);
    await expect(card('V1')).toContainText('Waiting for Claude');
    await expect.poll(() => h.output('claude'), { timeout: 15_000 }).toContain('validationId "V1"');
    slow = false;

    // A report on the existing validation arrives the same way.
    void h.report('claude', 'rollout', { validationId: 'V1', sequence: 1, phase: 'progress', summary: 'Checking the preview rollout', checks: [{ id: 'C1', title: 'Preview instances ready', status: 'running' }] });
    const reported = await latency(() => validations()[0]?.reports === 1, async () => (await card('V1').textContent())?.includes('Checking the preview rollout') ?? false);
    console.log(`progress report shown after ${reported} ms`);
    expect(reported).toBeLessThan(500);
  } finally { await h.close(); }
});

test('a final report settles the open view and the map card at once, and an older validation left running no longer shows as validating', async () => {
  test.setTimeout(90_000);
  const providers = rolloutFixture();
  providers.run = { ...providers.run, status: 'completed', conclusion: 'success' };
  providers.jobs = providers.jobs.map(job => ({ ...job, status: 'completed', conclusion: 'success' }));
  const h = await rolloutHarness(providers, ['claude', 'second'], agent => [
    { type: 'item.add', id: 'rollout', resourceId: 'rollout-r', pluginId: 'github.rollout', title: 'Rollout', projectId: 'project', position: { x: 260, y: 200 }, data: { owner: 'fixture', repo: 'web', runId: 101 } },
    agent('claude', 'Claude · validator', 60), agent('second', 'Claude · second look', 460),
    { type: 'link.save', link: { id: 'rollout-claude', sourceId: 'rollout', targetId: 'claude', kind: 'context', label: '' } },
    { type: 'link.save', link: { id: 'rollout-second', sourceId: 'rollout', targetId: 'second', kind: 'context', label: '' } },
  ]);
  try {
    const { page, service } = h, detail = page.locator('.rollout-detail'), card = (id: string) => detail.locator(`.rv-card[aria-label^="${id} · "]`), item = page.locator('[data-item-id="rollout"]');
    const trigger = (value: string) => page.evaluate(value => window.craftingTable.runtimeRun({ action: 'rollout.validation' as 'agent.resume', nodeId: 'rollout', arguments: { operation: 'trigger', sourceResourceId: 'rollout-r', value, requestId: crypto.randomUUID() } }), value);
    await page.clock.install();
    await item.click();
    await detail.getByRole('button', { name: 'Show the jobs rail', exact: true }).click();
    await expect(detail.getByRole('list', { name: 'Rollout jobs' }).getByRole('listitem')).toHaveCount(3);
    await page.clock.pauseAt(new Date(Date.now() + 60_000));
    const validations = () => service.store.rolloutValidations({ rolloutResourceId: 'rollout-r' });

    await trigger('claude');
    await h.report('claude', 'rollout', { validationId: 'V1', sequence: 1, phase: 'progress', summary: 'Watching preview', checks: [{ id: 'C1', title: 'Preview instances ready', status: 'running' }] });
    await trigger('second');
    await h.report('second', 'rollout', { validationId: 'V2', sequence: 1, phase: 'progress', summary: 'Checking the preview rollout', checks: [{ id: 'C1', title: 'Preview instances ready', status: 'running' }] });
    await expect(card('V2')).toContainText('Checking the preview rollout');

    void h.report('second', 'rollout', { validationId: 'V2', sequence: 2, phase: 'final', verdict: 'passed', summary: 'Preview healthy', checks: [{ id: 'C1', title: 'Preview instances ready', status: 'passed' }] });
    const final = await latency(() => validations().find(entry => entry.ordinal === 2)?.state === 'final', () => card('V2').locator('.rv-badge[data-v="passed"]').isVisible());
    console.log(`final report shown after ${final} ms`);
    expect(final).toBeLessThan(500);
    await expect(detail.locator('.rv-verdict')).toContainText('Current verdict: passed', { timeout: 1_000 });
    await expect(detail.locator('.rv-verdict')).not.toContainText('re-checking');
    await expect(card('V1')).toContainText('Resolved by V2', { timeout: 1_000 });
    await expect(detail.locator('.rv-badge[data-v="running"], .rv-badge[data-v="requested"]')).toHaveCount(0);
    await expect(item.locator('[data-indicator="rollout-validated"]')).toHaveAttribute('aria-label', 'Validated · Claude', { timeout: 1_000 });
  } finally { await h.close(); }
});
