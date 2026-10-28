import { test, expect } from '@playwright/test';
import { rolloutFixture } from '../fixtures/rollout.ts';
import { rolloutHarness } from './rollout-harness.ts';
import type { RolloutJob } from '../../packages/provider-runtime/github-rollout.ts';

type Harness = Awaited<ReturnType<typeof rolloutHarness>>;
const resize = (h: Harness, size: 'medium' | 'large') => h.page.evaluate(async size => {
  const { state } = await window.craftingTable.workspaceRead();
  await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'node.resize', id: 'rollout', size }] as never });
}, size);

/** A rollout no auto deploy follows: build, preview and staging deployed, production waits at its gate for phase-1, phases 2 and 3 queued behind it. */
function phased() {
  const rollouts = rolloutFixture();
  rollouts.run = { ...rollouts.run, status: 'waiting', repository: { full_name: 'fixture/billing' } };
  const done = (id: number, name: string, minute: number): RolloutJob => ({ id, run_id: 101, name, status: 'completed', conclusion: 'success', started_at: `2026-09-28T09:${String(minute - 3).padStart(2, '0')}:00Z`, completed_at: `2026-09-28T09:${String(minute).padStart(2, '0')}:00Z` });
  rollouts.jobs = [done(201, 'plan', 10), done(202, 'build', 14), done(203, 'deploy-preview / ship', 20), done(204, 'deploy-staging / ship', 27),
    { id: 205, run_id: 101, name: 'production-phase-1 / apply', status: 'waiting', conclusion: null },
    { id: 206, run_id: 101, name: 'production-phase-2 / apply', status: 'queued', conclusion: null }, { id: 207, run_id: 101, name: 'production-phase-3 / apply', status: 'queued', conclusion: null }];
  rollouts.gates = [{ environment: { id: 5, name: 'production' }, wait_timer: 0, current_user_can_approve: true, reviewers: [{ type: 'User' }] }];
  return rollouts;
}

test('a rollout without auto deploy shows its phase track: pips, gates from GitHub, checks from its validations; a cell click filters the rail and timeline, and the large card shows pips', async () => {
  test.setTimeout(150_000);
  const rollouts = phased();
  const h = await rolloutHarness(rollouts, ['claude'], agent => [
    { type: 'item.add', id: 'rollout', resourceId: 'rollout-r', pluginId: 'github.rollout', title: 'Rollout', projectId: 'project', position: { x: 260, y: 200 }, data: { owner: 'fixture', repo: 'billing', runId: 101 } },
    agent('claude', 'Claude · validator', 60),
    { type: 'link.save', link: { id: 'rollout-claude', sourceId: 'rollout', targetId: 'claude', kind: 'context', label: '' } },
  ]);
  try {
    const { page } = h, frame = page.locator('[data-expanded-item-id]:visible'), detail = page.locator('.rollout-detail');
    const run = (action: string, input: object) => page.evaluate(([action, input]) => window.craftingTable.runtimeRun({ action: action as 'agent.resume', nodeId: 'rollout', arguments: input as never }), [action, input] as const);
    await run('rollout.validation', { operation: 'trigger', sourceResourceId: 'rollout-r', value: 'claude', requestId: crypto.randomUUID(), phase: { focus: 'preview', jobs: [203] } });
    await expect.poll(() => h.output('claude'), { timeout: 15_000 }).toContain('validationId "V1"');
    await h.report('claude', 'rollout', { validationId: 'V1', sequence: 1, phase: 'final', verdict: 'passed', summary: 'Preview healthy', checks: [{ id: 'C1', title: 'Preview answers', status: 'passed', jobIds: [203] }] });

    await page.locator('[data-item-id="rollout"]').click();
    const track = detail.locator('.rv-track'), lane = track.locator('.rv-lane'), cell = (name: string) => lane.locator('.rv-cell[data-i]').filter({ has: page.locator('.rv-cell-name > span', { hasText: new RegExp(`^${name}$`) }) });
    await expect(track).toBeVisible({ timeout: 20_000 });
    await expect(track).toHaveAttribute('data-state', 'off');
    await expect(track).toHaveAttribute('aria-label', 'Phases');
    await expect(track.locator('.rv-track-top')).toHaveCount(0);
    expect(await track.evaluate(node => Boolean(node.previousElementSibling?.matches('.rv-head')))).toBe(true);
    await expect(track.locator('.rv-track-pip')).toHaveCount(6);
    await expect(track.locator('.rv-track-gate')).toHaveCount(3);
    await expect(track.locator('.rv-track-count')).toHaveText('3 of 6 deployed · 1 validated');
    await expect(track.locator('.rv-track-fold')).toContainText('2 phases');
    await expect(track.locator('.rv-track-fold')).toContainText('build → preview');
    await expect(cell('staging').locator('.rv-cell-check')).toHaveText('not validated');
    await expect(cell('staging').locator('.rv-cell-check')).toHaveAttribute('data-v', 'missing');
    const joins = lane.locator('.rv-join[data-s]');
    await expect(joins).toHaveText(['youwaiting', 'youlater', 'youlater']);
    await expect(joins.first()).toHaveAttribute('data-s', 'you');
    await expect(cell('production · phase-2').locator('.rv-cell-check')).toHaveText('no validation yet');
    await expect(track.locator('.rv-track-pip[data-now]')).toHaveCount(0);
    await expect(frame).toHaveScreenshot('rollout-phase-track.png', { mask: [page.locator('.view-freshness'), page.locator('.rv-time'), page.locator('.rv-rail-summary'), track.locator('.rv-cell-when'), track.locator('.rv-track-fold .rv-cell-check'), page.locator('.rv-verdict'), page.locator('.rv-feed')] });

    // A cell click filters the rail and the timeline to its phase; clicking it again, or Esc, clears it.
    await detail.getByRole('button', { name: 'Show the jobs rail', exact: true }).click();
    const jobs = detail.getByRole('list', { name: 'Rollout jobs' }).locator('.rv-job');
    await expect(jobs).toHaveCount(7);
    await cell('staging').click();
    await expect(cell('staging')).toHaveAttribute('aria-pressed', 'true');
    await expect(jobs).toHaveText([/deploy-staging \/ ship/]);
    const chip = detail.locator('.rv-job-chip[data-filter=phase]');
    await expect(chip).toContainText('staging');
    await expect(detail.locator('.rv-rail-foot')).toHaveText('Esc clears the phase filter');
    await expect(detail.locator('.rv-feed .rv-event').first()).toBeVisible();
    for (const text of await detail.locator('.rv-feed .rv-event .rv-text').allTextContents()) expect(text).toContain('deploy-staging');
    // A job click replaces the phase filter.
    await jobs.getByRole('button', { name: /^deploy-staging \/ ship/ }).click();
    await expect(detail.locator('.rv-job-chip[data-filter=job]')).toContainText('deploy-staging / ship');
    await expect(cell('staging')).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('Escape');
    await cell('staging').click();
    await cell('staging').click();
    await expect(chip).toHaveCount(0);
    await expect(jobs).toHaveCount(7);
    await cell('production · phase-1').click();
    await expect(jobs).toHaveText([/production-phase-1 \/ apply/]);
    await page.keyboard.press('Escape');
    await expect(detail.locator('.rv-job-chip')).toHaveCount(0);
    await expect(jobs).toHaveCount(7);
    await expect(frame).toBeVisible();

    // A pip click filters to its phase and scrolls the lane to it.
    await track.locator('.rv-track-pip').last().click();
    await expect(chip).toContainText('production · phase-3');
    await expect.poll(() => lane.evaluate(node => Math.round(node.scrollLeft + node.clientWidth) >= node.scrollWidth - 2)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(chip).toHaveCount(0);

    // The map card at large size shows the pips and the count, under its state line.
    await page.getByRole('button', { name: 'Back to project', exact: true }).click();
    await resize(h, 'large');
    const card = page.locator('[data-item-id="rollout"]'), pips = card.locator('.card-pips');
    await expect(pips).toBeVisible();
    await expect(pips.locator('i')).toHaveCount(9);
    await expect(pips.locator('.card-pips-count')).toHaveText('3 of 6 deployed · 1 validated');
    await expect(pips).toHaveAttribute('aria-label', '3 of 6 deployed · 1 validated');
    await expect(card).toHaveScreenshot('rollout-card-pips.png');
    await resize(h, 'medium');
    await expect(pips).toHaveCount(0);
  } finally { await h.close(); }
});

test('a rollout of one phase has no phase track and no card pips', async () => {
  test.setTimeout(90_000);
  const rollouts = rolloutFixture();
  const h = await rolloutHarness(rollouts, [], () => [
    { type: 'item.add', id: 'rollout', resourceId: 'rollout-r', pluginId: 'github.rollout', title: 'Rollout', projectId: 'project', position: { x: 260, y: 200 }, data: { owner: 'fixture', repo: 'web', runId: 101 } },
  ]);
  try {
    const { page } = h, detail = page.locator('.rollout-detail');
    await resize(h, 'large');
    await expect(page.locator('[data-item-id="rollout"] [data-indicator="rollout-state"]')).toBeVisible();
    await expect(page.locator('[data-item-id="rollout"] .card-pips')).toHaveCount(0);
    await page.locator('[data-item-id="rollout"]').click();
    await expect(page.locator('.rollout-state')).toHaveText('Ongoing');
    await expect(detail.locator('.rv-verdict')).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(detail.locator('.rv-track')).toBeHidden();
  } finally { await h.close(); }
});
