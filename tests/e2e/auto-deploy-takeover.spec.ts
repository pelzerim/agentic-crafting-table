import { test, expect } from '@playwright/test';
import { rolloutFixture } from '../fixtures/rollout.ts';
import { githubFixture } from '../fixtures/github.ts';
import { rolloutHarness } from './rollout-harness.ts';
import { prActions } from './pr-actions.ts';
import { githubRolloutConnector } from '../../src/resource-plugins/items/github-rollout/connector.ts';
import { rolloutPresentation } from '../../src/resource-plugins/items/github-rollout/service.ts';
import type { ResourcePluginRegistry } from '../../src/resource-plugins/registry.ts';
import type { RolloutJob } from '../../packages/provider-runtime/github-rollout.ts';
import { discoveredLinkId } from '../../packages/workspace-service/resources.ts';
import { rolloutDiscoveryKey } from '../../packages/provider-runtime/github-status.ts';

/** A merged pull request whose rollout runs eight phases: build, preview and staging deployed, canary waits at its gate, phase-1 to phase-4 queued. */
function eightPhases() {
  const github = githubFixture(), rollouts = rolloutFixture();
  github.pull = { ...github.pull, state: 'closed', merged: true };
  rollouts.run = { ...rollouts.run, status: 'waiting', repository: { full_name: 'fixture/billing' } };
  const done = (id: number, name: string, minute: number): RolloutJob => ({ id, run_id: 101, name, status: 'completed', conclusion: 'success', started_at: `2026-09-28T09:${String(minute - 3).padStart(2, '0')}:00Z`, completed_at: `2026-09-28T09:${String(minute).padStart(2, '0')}:00Z` });
  const queued = (id: number, name: string): RolloutJob => ({ id, run_id: 101, name, status: 'queued', conclusion: null });
  rollouts.jobs = [done(201, 'plan', 10), done(202, 'build', 14), done(203, 'deploy-preview / ship', 20), done(204, 'apply-staging / apply', 27), { id: 205, run_id: 101, name: 'apply-canary / apply', status: 'waiting', conclusion: null },
    ...[1, 2, 3, 4].flatMap(phase => [queued(200 + phase * 10, `phase-${phase} / apply (region-${phase * 2 - 1})`), queued(201 + phase * 10, `phase-${phase} / apply (region-${phase * 2})`)])];
  rollouts.gates = [{ environment: { id: 5, name: 'canary' }, wait_timer: 0, current_user_can_approve: true, reviewers: [{ type: 'User' }] }];
  const providers = { ...github, host(registry: ResourcePluginRegistry) { const host = github.host(registry); host.register('github.rollout', githubRolloutConnector(() => rollouts.client)); host.present('github.rollout', rolloutPresentation); return host; } };
  return { github, rollouts, providers };
}

test('Auto deploy from here: the confirm shows the plan per catch-up, then a phase track follows the rollout, the gate row says auto deploy approves, and Stop removes it', async () => {
  test.setTimeout(180_000);
  const { rollouts, providers } = eightPhases();
  const h = await rolloutHarness(providers, ['claude'], agent => [
    { type: 'item.add', id: 'rollout', resourceId: 'rollout-r', pluginId: 'github.rollout', title: 'Rollout', projectId: 'project', position: { x: 260, y: 200 }, data: { owner: 'fixture', repo: 'billing', runId: 101 } },
    { type: 'item.add', id: 'pr', resourceId: 'pr-r', pluginId: 'github.pull-request', connectionId: 'github-fixture', title: 'PR', projectId: 'project', position: { x: 260, y: 420 }, data: { owner: 'fixture', repo: 'billing', number: 42, autoValidate: false } },
    { type: 'link.save', link: { id: discoveredLinkId('pr-r', rolloutDiscoveryKey(101)), sourceId: 'pr', targetId: 'rollout', kind: 'reference', label: '' } },
    agent('claude', 'Claude · validator', 60),
    { type: 'link.save', link: { id: 'rollout-claude', sourceId: 'rollout', targetId: 'claude', kind: 'context', label: '' } },
  ]);
  try {
    const { page } = h, frame = page.locator('[data-expanded-item-id]:visible'), detail = page.locator('.rollout-detail'), actions = prActions(page, frame);
    const run = (action: string, input: object) => page.evaluate(([action, input]) => window.craftingTable.runtimeRun({ action: action as 'agent.resume', nodeId: 'rollout', arguments: input as never }), [action, input] as const);
    // Preview was validated before anyone armed auto deploy: V1 passed on its job.
    await run('rollout.validation', { operation: 'trigger', sourceResourceId: 'rollout-r', value: 'claude', requestId: crypto.randomUUID(), phase: { focus: 'preview', jobs: [203] } });
    await expect.poll(() => h.output('claude'), { timeout: 15_000 }).toContain('validationId "V1"');
    await h.report('claude', 'rollout', { validationId: 'V1', sequence: 1, phase: 'final', verdict: 'passed', summary: 'Preview healthy', checks: [{ id: 'C1', title: 'Preview answers', status: 'passed', jobIds: [203] }] });

    await page.locator('[data-item-id="rollout"]').click();
    await expect(detail.locator('.rv-track')).toHaveAttribute('data-state', 'off', { timeout: 20_000 });
    await expect(detail.locator('.rv-track-top')).toHaveCount(0);
    await actions.open();
    await expect(actions.menu.getByRole('menuitem')).toHaveText(['Approve and validate', 'Approve', 'Validate', 'Validate with…', 'Auto deploy from here…']);
    await actions.item('Auto deploy from here…').click();
    const menu = page.getByRole('menu', { name: 'Auto deploy', exact: true }), confirm = menu.getByRole('group', { name: 'Start auto deploy' });
    await expect(confirm).toContainText('Auto deploy run #28 from here?');
    const plan = confirm.locator('.resource-choice-plan'), foot = confirm.locator('.resource-choice-foot');
    await expect(confirm.getByRole('radio', { name: /Validate what shipped first/ })).toBeChecked();
    await expect(plan.locator('dt')).toHaveText(['preview', 'staging', 'canary']);
    await expect(plan.locator('dd')).toHaveText([/^V1 passed at \d\d:\d\d · counts$/, /^deployed \d\d:\d\d · validate now$/, 'approve after staging passes, then validate once deployed']);
    await expect(foot).toHaveText('One validation (staging) before canary. Validates canary after it deploys. Any doubt halts.');
    await expect(menu).toHaveScreenshot('auto-deploy-confirm.png', { mask: [plan.locator('dd').nth(0), plan.locator('dd').nth(1)] });
    await confirm.getByRole('radio', { name: /Start from the next phase/ }).check();
    await expect(plan.locator('dd').nth(1)).toHaveText(/^deployed \d\d:\d\d · counts as accepted, not validated$/);
    await expect(plan.locator('dd').nth(2)).toHaveText('approve now, then validate once deployed');
    await expect(foot).toHaveText('Approves canary at once. Validates canary after it deploys. Any doubt halts.');
    await confirm.getByRole('radio', { name: /Validate what shipped first/ }).check();
    expect(rollouts.approvals).toHaveLength(0);
    await confirm.getByRole('menuitem', { name: 'Start auto deploy', exact: true }).click();

    // The track: eight pips, a folded prefix, staging validated now with the lane centred on it.
    const track = detail.locator('.rv-track'), lane = track.locator('.rv-lane');
    await expect(track).toBeVisible({ timeout: 20_000 });
    await expect(track).toHaveAttribute('data-state', 'armed');
    await expect(track.locator('.rv-track-pip')).toHaveCount(8);
    await expect(track.locator('.rv-track-count')).toHaveText(/^3 of 8 deployed · 1 validated$/);
    await expect(track.locator('.rv-track-fold')).toContainText('2 phases');
    await expect(track.locator('.rv-track-fold')).toContainText('build → preview');
    await expect(track.locator('.rv-track-now')).toContainText('Auto deploy');
    await expect(track.locator('.rv-track-now')).toContainText('Then: approve canary');
    const current = lane.locator('.rv-cell[data-now]');
    await expect(current).toContainText('staging');
    await expect(current).toContainText(/V2 validating/, { timeout: 30_000 });
    expect(await lane.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
    await expect.poll(() => current.evaluate(cell => { const box = cell.getBoundingClientRect(), outer = cell.closest('.rv-lane')!.getBoundingClientRect(); return Math.abs(box.left + box.width / 2 - (outer.left + outer.width / 2)) < 2 || cell.closest('.rv-lane')!.scrollLeft === 0; })).toBe(true);
    await expect(track.getByRole('button', { name: 'Open #42', exact: true })).toBeVisible();
    await expect(frame).toHaveScreenshot('auto-deploy-track.png', { mask: [page.locator('.view-freshness'), page.locator('.rv-time'), page.locator('.rv-rail-summary'), track.locator('.rv-cell-when'), page.locator('.rv-verdict'), page.locator('.rv-feed')] });

    // The gate row says auto deploy approves it, without an Approve button.
    await detail.getByRole('button', { name: 'Show the jobs rail', exact: true }).click();
    const gate = detail.locator('.rv-gate').filter({ hasText: 'canary' });
    await expect(gate.locator('.rv-gate-note')).toHaveText('Auto deploy approves after V2 passes');
    await expect(gate.getByRole('button', { name: 'Approve ▾' })).toHaveCount(0);

    // Auto deploy's own entries are in the timeline under All and Validations.
    await expect(detail.locator('.rv-event.rv-auto')).toHaveText([/asked Claude to validate before canary .* · V2/, /armed by you from here · V1 counts/]);
    await detail.getByRole('button', { name: /^Validations/ }).click();
    await expect(detail.locator('.rv-event.rv-auto')).toHaveCount(2);
    await detail.getByRole('button', { name: /^All/ }).click();

    // A pip click scrolls the lane to its phase.
    await track.locator('.rv-track-pip').last().click();
    await expect.poll(() => lane.evaluate(node => Math.round(node.scrollLeft + node.clientWidth) >= node.scrollWidth - 2)).toBe(true);

    // Stop ends it: the rollout's own track takes its place, the entry offers it again.
    await track.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(track).toHaveAttribute('data-state', 'off');
    await expect(track.locator('.rv-track-top')).toHaveCount(0);
    await actions.open();
    await expect(actions.item('Auto deploy from here…')).toBeEnabled();
    await page.keyboard.press('Escape');
    expect(rollouts.approvals).toHaveLength(0);

    // The merged pull request's menu offers auto deploy of its running rollout.
    await page.getByRole('button', { name: 'Back to project', exact: true }).click();
    await page.locator('[data-item-id="pr"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Auto deploy', exact: true }).hover();
    const submenu = page.getByRole('menu', { name: 'Auto deploy', exact: true });
    await expect(submenu.getByRole('menuitem', { name: 'Auto deploy its rollout', exact: true })).toBeEnabled();
    await page.keyboard.press('Escape');
    // The rollout card's right-click menu offers it too.
    await page.locator('[data-item-id="rollout"]').click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Auto deploy from here…', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
  } finally { await h.close(); }
});
