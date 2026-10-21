import { test, expect } from '@playwright/test';
import { githubFixture } from '../fixtures/github.ts';
import { rolloutFixture } from '../fixtures/rollout.ts';
import { githubRolloutConnector } from '../../src/resource-plugins/items/github-rollout/connector.ts';
import { rolloutPresentation } from '../../src/resource-plugins/items/github-rollout/service.ts';
import type { ResourcePluginRegistry } from '../../src/resource-plugins/registry.ts';
import { rolloutHarness } from './rollout-harness.ts';
import { prActions } from './pr-actions.ts';

test('Auto validate: the pull request view has a checkbox, on by default and saved per PR, and a rollout the merge discovers is validated without a click', async () => {
  test.setTimeout(120_000);
  const github = githubFixture(), rollouts = rolloutFixture();
  rollouts.run = { ...rollouts.run, repository: { full_name: 'fixture/billing' } };
  const providers = { ...github, host(registry: ResourcePluginRegistry) { const host = github.host(registry); host.register('github.rollout', githubRolloutConnector(() => rollouts.client)); host.present('github.rollout', rolloutPresentation); return host; } };
  const h = await rolloutHarness(providers, ['claude'], agent => [
    { type: 'item.add', id: 'pr', resourceId: 'pr-r', pluginId: 'github.pull-request', connectionId: 'github-fixture', title: 'PR', projectId: 'project', position: { x: 260, y: 200 }, data: { owner: 'fixture', repo: 'billing', number: 42 } },
    agent('claude', 'Claude · billing', 60),
    { type: 'link.save', link: { id: 'pr-claude', sourceId: 'pr', targetId: 'claude', kind: 'context', label: '' } },
  ], { summary: 'BILLING_BRIEF' });
  try {
    const { page, service } = h, frame = page.locator('[data-expanded-item-id=pr]'), box = frame.getByRole('checkbox', { name: 'Auto validate', exact: true });
    const saved = async () => (await service.control.read()).resources.find(resource => resource.id === 'pr-r')!.data;
    const rollout = async () => { const state = await service.control.read(); return state.nodes.find(node => state.resources.find(resource => resource.id === node.resourceId)?.pluginId === 'github.rollout'); };
    await page.locator('[data-item-id="pr"]').click();
    await expect(page.locator('.view-header .view-chip')).toHaveText('Open');

    // On by default, left of Actions, and it applies at once without remounting the view.
    await expect(box).toBeChecked();
    const boxEdge = await box.boundingBox(), actionsEdge = await prActions(page, frame).button.boundingBox();
    expect(boxEdge!.x + boxEdge!.width).toBeLessThanOrEqual(actionsEdge!.x);
    expect(await saved()).toEqual({ owner: 'fixture', repo: 'billing', number: 42 });
    await page.locator('.pr-detail').evaluate(element => { element.setAttribute('data-kept', 'yes'); });
    await box.uncheck();
    await expect.poll(saved).toEqual({ owner: 'fixture', repo: 'billing', number: 42, autoValidate: false });
    await expect(box).not.toBeChecked(); await expect(box).toBeEnabled();
    await expect(page.locator('.pr-detail')).toHaveAttribute('data-kept', 'yes');
    await page.getByRole('button', { name: 'Back to project', exact: true }).click();
    await page.locator('[data-item-id="pr"]').click();
    await expect(box).not.toBeChecked();

    // Unchecked: the merge's deploy run joins the map, and nobody is asked to validate it.
    github.runs = [{ id: 101, name: 'Web / Release', path: '.github/workflows/release.yml', event: 'push', status: 'in_progress', head_sha: 'c'.repeat(40) }];
    github.pull = { ...github.pull, state: 'closed', merged: true, merge_commit_sha: 'c'.repeat(40), merged_at: new Date().toISOString() } as typeof github.pull;
    await h.tick();
    await expect.poll(rollout).toBeTruthy();
    await h.tick();
    expect(await h.output('claude')).not.toContain('validationId');

    // Checked again while the run is still going: the service starts the rollout's hidden validation agent, once; the agent connected through the PR is left alone.
    await box.check();
    await expect.poll(saved).toEqual({ owner: 'fixture', repo: 'billing', number: 42 });
    const started = async () => { const state = await service.control.read(); return state.nodes.filter(node => node.id !== 'claude' && state.resources.find(resource => resource.id === node.resourceId)?.pluginId === 'agent.session'); };
    await expect.poll(async () => (await started()).length, { timeout: 30_000 }).toBe(1);
    const state = await service.control.read(), [agent] = await started(), deploy = (await rollout())!, session = state.resources.find(resource => resource.id === agent.resourceId)!;
    expect(agent.title).toBe('Validate · Web / Release'); expect(agent.hiddenAt).toBeTruthy(); expect(agent.hideLabel).toBe('validation agent');
    expect(state.links.filter(link => link.targetId === agent.id).map(link => link.sourceId).sort()).toEqual(['pr', deploy.id].sort());
    expect(state.links.some(link => link.sourceId === deploy.id && link.targetId === 'claude')).toBe(false);
    const printed = () => h.session(String(session.data.sessionId)).output().then(output => output.replace(/\r/g, ''));
    await expect.poll(printed, { timeout: 30_000 }).toContain(`workspace_report_validation (rolloutNodeId "${deploy.id}", validationId "V1")`);
    expect(await printed()).toContain('You lead this validation');
    expect(await h.output('claude')).not.toContain('validationId');
    await page.getByRole('button', { name: 'Back to project', exact: true }).click();
    await page.locator(`[data-item-id="${deploy.id}"]`).click();
    await expect(page.locator('.rollout-detail .rv-card[aria-label^="V1 · "] .rv-card-meta')).toContainText('V1 · automatic · requested');
    await h.tick(); await h.tick();
    expect(await started()).toHaveLength(1);
    const validations = (await page.evaluate(nodeId => window.craftingTable.runtimeRun({ action: 'rollout.validation' as 'agent.resume', nodeId, arguments: { operation: 'list' } }), deploy.id) as any).validations;
    expect(validations.map((view: any) => [view.label, view.agentNodeId, view.automatic, view.agentHidden])).toEqual([['V1', agent.id, true, true]]);
  } finally { await h.close(); }
});
