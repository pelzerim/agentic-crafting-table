import { test, expect } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { githubFixture } from '../fixtures/github.ts';
import { rolloutFixture } from '../fixtures/rollout.ts';
import { githubRolloutConnector } from '../../src/resource-plugins/items/github-rollout/connector.ts';
import { rolloutPresentation } from '../../src/resource-plugins/items/github-rollout/service.ts';
import type { ResourcePluginRegistry } from '../../src/resource-plugins/registry.ts';
import type { RolloutJob } from '../../packages/provider-runtime/github-rollout.ts';
import { rolloutHarness, STAGED_DEPLOY_RULES } from './rollout-harness.ts';
import { prActions } from './pr-actions.ts';

const iso = (at?: number) => at === undefined ? null : new Date(at).toISOString();
/** A Web / Release attempt: preview and live, each finished at the given time or still going. */
const deploy = (preview?: number, live?: number): RolloutJob[] => [
  { id: 201, run_id: 101, name: 'preview / ship', status: preview === undefined ? 'in_progress' : 'completed', conclusion: preview === undefined ? null : 'success', started_at: iso(Date.now() - 600_000), completed_at: iso(preview) },
  { id: 202, run_id: 101, name: 'live / ship', status: live === undefined ? 'queued' : 'completed', conclusion: live === undefined ? null : 'success', started_at: iso(live), completed_at: iso(live) },
];
const check = (id: string, status: string) => ({ id, title: `Check ${id}`, status });

test('a validation asked for in chat gets an id and a label on the rollout', async () => {
  test.setTimeout(180_000);
  const github = githubFixture(), rollouts = rolloutFixture();
  rollouts.run = { ...rollouts.run, name: 'Web / Release' };
  rollouts.jobs = deploy(Date.now() - 20 * 60_000, Date.now() - 2 * 60_000);
  const providers = { ...github, host(registry: ResourcePluginRegistry) { const host = github.host(registry); host.register('github.rollout', githubRolloutConnector(() => rollouts.client)); host.present('github.rollout', rolloutPresentation); return host; } };
  const h = await rolloutHarness(providers, ['claude'], agent => [
    { type: 'item.add', id: 'rollout', resourceId: 'rollout-r', pluginId: 'github.rollout', title: 'Web / Release', projectId: 'project', position: { x: 620, y: 200 }, data: { owner: 'fixture', repo: 'web', runId: 101 } },
    agent('claude', 'Claude · web', 60),
    { type: 'link.save', link: { id: 'rollout-claude', sourceId: 'rollout', targetId: 'claude', kind: 'context', label: '' } },
  ], { stageRules: STAGED_DEPLOY_RULES });
  try {
    const { page } = h, detail = page.locator('.rollout-detail'), card = (label: string) => detail.locator(`.rv-card[aria-label^="${label} · "]`);
    const receipt = await h.report('claude', 'rollout', { sequence: 1, phase: 'progress', summary: 'Interim: live looks healthy. Waiting for the error-rate window.', checks: [check('C1', 'passed'), check('C2', 'pending')] });
    expect(receipt.validationId).toBe('V1');
    expect(receipt.warnings.join(' ')).toContain('started from chat as V1');
    await page.locator('[data-item-id="rollout"]').click();
    await expect(card('V1').locator('.rv-tag')).toHaveText('Started from chat');
    await expect(card('V1').locator('.rv-card-meta')).toContainText('V1 · started from chat · live done · first report');

    // Liveness: the last report and the lead's current step, on the map card and in the view; amber once quiet for 3 minutes.
    const cue = page.locator('[data-item-id="rollout"] [data-indicator="rollout-validating"]');
    await expect(cue).toHaveAttribute('aria-label', 'Validating · Claude · 1/2 · just now · Interim: live looks healthy.');
    await expect(detail.locator('.rv-verdict .rv-live')).toContainText('Last report');
    await expect(detail.locator('.rv-verdict .rv-live')).toContainText('Interim: live looks healthy.');
    await expect(card('V1').locator('.rv-live')).toContainText('Interim: live looks healthy.');
    await expect(card('V1').locator('.rv-live')).not.toHaveAttribute('data-quiet');
    const db = new DatabaseSync(h.service.store.file);
    db.exec(`UPDATE rollout_validations SET updated_at = updated_at - 240000, report = json_set(report, '$.at', json_extract(report, '$.at') - 240000)`); db.close();
    await expect(card('V1').locator('.rv-live')).toHaveAttribute('data-quiet', '', { timeout: 15_000 });
    await expect(card('V1').locator('.rv-live')).toContainText('No report for 4 min');
    await expect(detail.locator('.rv-verdict .rv-live')).toContainText('No report for 4 min');
    await expect(cue).toHaveAttribute('aria-label', 'Validating · Claude · 1/2 · No report for 4 min · Interim: live looks healthy.', { timeout: 30_000 });

    // Validate from the item while the chat validation runs: it is shown instead of asked again, and Re-run asks again.
    await h.idle('claude');
    const view = page.getByRole('region', { name: 'Web / Release', exact: true }), menu = page.getByRole('menu', { name: 'Trigger validation', exact: true });
    await prActions(page, view).pick('Validate');
    const reuse = detail.locator('.rv-reuse');
    await expect(reuse).toContainText('Showing V1, started from chat, instead of a second validation');
    await expect(card('V1').getByRole('button', { name: 'Hide report ▴' })).toBeVisible();
    expect(await h.output('claude')).not.toContain('validationId "V2"');
    await reuse.getByRole('button', { name: 'Re-run', exact: true }).click();
    await expect(menu.locator('.resource-choice-prompt')).toContainText('V1, started from chat, covers live and is still running');
    await expect(menu.getByRole('menuitem', { name: 'Show V1', exact: true })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Claude · web', exact: true })).toContainText('Re-run · Ready');
    await menu.getByRole('menuitem', { name: 'Claude · web', exact: true }).click();
    await expect.poll(() => h.output('claude'), { timeout: 15_000 }).toContain('validationId "V2"');
    await expect(reuse).toBeHidden();
  } finally { await h.close(); }
});
