import { test, expect } from '@playwright/test';
import { githubFixture } from '../fixtures/github.ts';
import { rolloutFixture } from '../fixtures/rollout.ts';
import { githubRolloutConnector } from '../../src/resource-plugins/items/github-rollout/connector.ts';
import { rolloutPresentation } from '../../src/resource-plugins/items/github-rollout/service.ts';
import type { ResourcePluginRegistry } from '../../src/resource-plugins/registry.ts';
import type { RolloutJob } from '../../packages/provider-runtime/github-rollout.ts';
import { discoveredLinkId } from '../../packages/workspace-service/resources.ts';
import { rolloutDiscoveryKey } from '../../packages/provider-runtime/github-status.ts';
import { rolloutHarness, STAGED_DEPLOY_RULES } from './rollout-harness.ts';

const iso = (at?: number) => at === undefined ? null : new Date(at).toISOString();
/** A Web / Release attempt: preview and live, each finished at the given time or still going. */
const deploy = (preview?: number, live?: number): RolloutJob[] => [
  { id: 201, run_id: 101, name: 'preview / ship', status: preview === undefined ? 'in_progress' : 'completed', conclusion: preview === undefined ? null : 'success', started_at: iso(Date.now() - 600_000), completed_at: iso(preview) },
  { id: 202, run_id: 101, name: 'live / ship', status: live === undefined ? 'queued' : 'completed', conclusion: live === undefined ? null : 'success', started_at: iso(live), completed_at: iso(live) },
];
const check = (id: string, status: string) => ({ id, title: `Check ${id}`, status });

// Claude cannot start a session in this harness, so each stage falls back to the agent connected through the pull request.
test('a staged deploy run asks for one validation per stage, preview, live and 10 minutes later, and takes follow-up and unrequested reports', async () => {
  test.setTimeout(180_000);
  const github = githubFixture(), rollouts = rolloutFixture();
  rollouts.run = { ...rollouts.run, name: 'Web / Release' };
  rollouts.jobs = deploy();
  const providers = { ...github, host(registry: ResourcePluginRegistry) { const host = github.host(registry); host.register('github.rollout', githubRolloutConnector(() => rollouts.client)); host.present('github.rollout', rolloutPresentation); return host; } };
  const h = await rolloutHarness(providers, ['claude'], agent => [
    { type: 'item.add', id: 'pr', resourceId: 'pr-r', pluginId: 'github.pull-request', connectionId: 'github-fixture', title: 'Ship plan changes', projectId: 'project', position: { x: 260, y: 200 }, data: { owner: 'fixture', repo: 'billing', number: 42 } },
    { type: 'item.add', id: 'rollout', resourceId: 'rollout-r', pluginId: 'github.rollout', title: 'Web / Release', projectId: 'project', position: { x: 620, y: 200 }, data: { owner: 'fixture', repo: 'web', runId: 101 } },
    { type: 'link.save', link: { id: discoveredLinkId('pr-r', rolloutDiscoveryKey(101)), sourceId: 'pr', targetId: 'rollout', kind: 'reference', label: '' } },
    agent('claude', 'Claude · billing', 60),
    { type: 'link.save', link: { id: 'pr-claude', sourceId: 'pr', targetId: 'claude', kind: 'context', label: '' } },
  ], { stageRules: STAGED_DEPLOY_RULES, claudeMissing: true });
  try {
    const { page } = h, detail = page.locator('.rollout-detail'), card = (label: string) => detail.locator(`.rv-card[aria-label^="${label} · "]`);
    const prompted = (id: string) => expect.poll(async () => { await h.tick(); return h.output('claude'); }, { timeout: 60_000, intervals: [1_000] }).toContain(`validationId "${id}"`);
    await h.tick(); await h.tick();
    expect(await h.output('claude')).not.toContain('validationId');

    // Preview finished: V1, with the table's context.
    rollouts.jobs = deploy(Date.now() - 30_000);
    await prompted('V1');
    const first = await h.output('claude');
    expect(first).toContain('focus: preview.');
    expect(first).toContain('one lead subagent');
    expect(first).toContain('"url": "https://github.com/fixture/billing/pull/42"');
    expect(first).toContain('"path": "src/billing"');
    await page.locator('[data-item-id="rollout"]').click();
    await expect(card('V1').locator('.rv-card-meta')).toContainText('V1 · automatic · preview done · requested');

    // Progress stays visible: finished checks and the ones still pending.
    await h.report('claude', 'rollout', { validationId: 'V1', sequence: 1, phase: 'progress', summary: 'Waiting on the metrics check.', checks: [check('C1', 'passed'), check('C2', 'pending'), check('C3', 'running')] });
    await expect(card('V1').locator('.rv-pips i')).toHaveCount(3);
    await expect(card('V1').locator('.rv-card-foot')).toContainText('1 passed · 2 to go');
    await h.report('claude', 'rollout', { validationId: 'V1', sequence: 2, phase: 'final', verdict: 'passed', summary: 'Preview is healthy.', checks: [check('C1', 'passed')] });
    await h.idle('claude');

    // Live finished: V2 at once, V3 ten minutes after it.
    rollouts.jobs = deploy(Date.now() - 120_000, Date.now() - 10 * 60_000 + 25_000);
    await prompted('V2');
    expect(await h.output('claude')).toContain('focus: live.');
    expect(await h.output('claude')).toContain('"previous": {');
    expect(await h.output('claude')).toContain('"validationId": "V1"');
    expect(await h.output('claude')).not.toContain('validationId "V3"');
    await h.report('claude', 'rollout', { validationId: 'V2', sequence: 1, phase: 'final', verdict: 'passed', summary: 'Live is healthy.', checks: [check('C1', 'passed')] });
    await h.idle('claude');
    await prompted('V3');
    expect(await h.output('claude')).toContain('focus: live, 10 minutes after it finished.');
    await expect(card('V3').locator('.rv-card-meta')).toContainText('V3 · automatic · live +10 min · requested');
    await h.report('claude', 'rollout', { validationId: 'V3', sequence: 1, phase: 'final', verdict: 'passed', summary: 'Still healthy after the settle window.', checks: [check('C1', 'passed')] });

    // A follow-up amends V1 and changes its verdict; a report for an id nobody asked for is kept and labelled.
    const amended = await h.report('claude', 'rollout', { validationId: 'V1', sequence: 3, phase: 'followup', verdict: 'concerns', summary: 'Preview response times crept up later.', checks: [check('C1', 'concern')] });
    expect([amended.state, amended.sequence]).toEqual(['final', 3]);
    await expect(card('V1').locator('.rv-tag')).toHaveText('Follow-up');
    await expect(card('V1').locator('.rv-card-meta')).toContainText('was passed');
    await expect(card('V1')).toHaveAttribute('data-v', 'concerns');
    const extra = await h.report('claude', 'rollout', { validationId: 'V7', sequence: 1, phase: 'progress', summary: 'Checking the upload backlog on my own.', checks: [check('C1', 'running')] });
    expect(extra.warnings[0]).toContain('V7 was not requested');
    await expect(card('V7').locator('.rv-tag')).toHaveText('Unrequested');
    await expect(card('V7').locator('.rv-card-meta')).toContainText('V7 · unrequested · first report');
    const validations = (await page.evaluate(() => window.craftingTable.runtimeRun({ action: 'rollout.validation' as 'agent.resume', nodeId: 'rollout', arguments: { operation: 'list' } })) as any).validations;
    expect(validations.map((view: any) => [view.label, view.scope.stage ?? '', view.automatic === true, view.unrequested === true])).toEqual([
      ['V1', 'preview', true, false], ['V2', 'live', true, false], ['V3', 'settle', true, false], ['V7', '', false, true]]);
  } finally { await h.close(); }
});
