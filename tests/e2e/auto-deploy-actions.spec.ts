import { test, expect } from '@playwright/test';
import { rolloutFixture } from '../fixtures/rollout.ts';
import { githubFixture } from '../fixtures/github.ts';
import { rolloutHarness } from './rollout-harness.ts';
import { githubRolloutConnector } from '../../src/resource-plugins/items/github-rollout/connector.ts';
import { rolloutPresentation } from '../../src/resource-plugins/items/github-rollout/service.ts';
import type { ResourcePluginRegistry } from '../../src/resource-plugins/registry.ts';
import { discoveredLinkId } from '../../packages/workspace-service/resources.ts';
import { rolloutDiscoveryKey } from '../../packages/provider-runtime/github-status.ts';
import { AUTO_DEPLOY_COLLECTION } from '../../packages/workspace-service/auto-deploy.ts';
import type { AutoDeployRecord } from '../../src/resource-plugins/items/github-rollout/auto-deploy.ts';

/** A finished auto deploy of a merged pull request: rebased by an agent, review findings fixed, merged, then its rollout validated and approved. */
function finishedRun(): AutoDeployRecord {
  const at = (minutes: number) => Date.now() - (90 - minutes) * 60_000, head = 'a'.repeat(40), rebased = '9c41e07'.padEnd(40, '0'), fixed = 'b7d02aa'.padEnd(40, '0');
  return { version: 1, id: 'run-1', pullResourceId: 'pr-r', pullNodeId: 'pr', armedAt: at(0), updatedAt: at(80), state: 'done', step: 'done', base: 'main', mergedAt: at(30),
    writes: [{ key: 'tag', kind: 'tag', requestId: 't', at: at(1), state: 'sent' }, { key: 'rebase:1', kind: 'rebase', requestId: 'r', at: at(2), state: 'sent' }, { key: 'findings:review', kind: 'findings', requestId: 's', at: at(12), state: 'sent' },
      { key: 'merge', kind: 'merge', requestId: 'm', at: at(29), state: 'sent' }, { key: 'approve:rollout:101:1:5', kind: 'approve', requestId: 'a', at: at(50), state: 'sent', label: 'canary' }],
    rebases: [{ head, base: 'f'.repeat(40), at: at(2), mode: 'agent', agentNodeId: 'claude', agentTitle: 'Claude · impl', pushed: rebased, pushedAt: at(10) }],
    findingSends: [{ reviewNodeId: 'review', reviewTitle: 'Claude review', sendId: '00000000-0000-4000-8000-000000000001', findingIds: ['F1', 'F2', 'F3'], head: rebased, at: at(12), agentNodeId: 'claude', agentTitle: 'Claude · impl',
      counts: '1 critical, 1 high, 1 security', left: '4 medium', fixed: ['F1', 'F2', 'F3'], pushed: fixed, pushedAt: at(24) }],
    fixes: [], checks: [{ key: 'rollout:101:1:gate:5@205', rolloutNodeId: 'rollout', label: 'staging', requestId: 'v', validationId: 'V1', requestedAt: at(40), jobs: [204], verdict: 'passed', answeredAt: at(48) }] };
}

test('Auto deploy lists its actions: under the PR status line with the rollout part under its run, and in the rollout timeline as auto deploy entries', async () => {
  test.setTimeout(120_000);
  const github = githubFixture(), rollouts = rolloutFixture();
  github.pull = { ...github.pull, state: 'closed', merged: true };
  rollouts.run = { ...rollouts.run, status: 'completed', conclusion: 'success', repository: { full_name: 'fixture/billing' } };
  const providers = { ...github, host(registry: ResourcePluginRegistry) { const host = github.host(registry); host.register('github.rollout', githubRolloutConnector(() => rollouts.client)); host.present('github.rollout', rolloutPresentation); return host; } };
  const h = await rolloutHarness(providers, ['claude'], agent => [
    { type: 'item.add', id: 'rollout', resourceId: 'rollout-r', pluginId: 'github.rollout', title: 'Rollout', projectId: 'project', position: { x: 260, y: 200 }, data: { owner: 'fixture', repo: 'billing', runId: 101 } },
    { type: 'item.add', id: 'pr', resourceId: 'pr-r', pluginId: 'github.pull-request', connectionId: 'github-fixture', title: 'PR', projectId: 'project', position: { x: 260, y: 420 }, data: { owner: 'fixture', repo: 'billing', number: 42, autoValidate: false } },
    { type: 'link.save', link: { id: discoveredLinkId('pr-r', rolloutDiscoveryKey(101)), sourceId: 'pr', targetId: 'rollout', kind: 'reference', label: '' } },
    agent('claude', 'Claude · impl', 60),
  ]);
  h.service.store.pluginStorage('github.rollout').put(AUTO_DEPLOY_COLLECTION, 'pr-r', finishedRun() as never);
  try {
    const { page } = h, frame = page.locator('[data-expanded-item-id]:visible');
    await page.locator('[data-item-id="pr"]').click();
    const status = frame.locator('.pr-auto-deploy-status'), list = frame.locator('.pr-auto-deploy-actions');
    await expect(status.locator('.pr-auto-deploy-text')).toHaveText('Auto deploy · done');
    const toggle = status.getByRole('button', { name: '11 actions of auto deploy', exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(list).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(list.locator('.pr-auto-deploy-action-text')).toHaveText([
      'Armed by you', 'Tagged the title [ship]', 'Asked Claude · impl to rebase onto main (1/2) Claude · impl', 'Claude · impl rebased and pushed 9c41e07 Claude · impl · 9c41e07',
      'Sent 3 findings of Claude review to Claude · impl · 1 critical, 1 high, 1 security · 4 medium left for you Claude · impl', 'Claude · impl fixed 3 and pushed b7d02aa Claude · impl · b7d02aa',
      'Merged into main', 'Asked Claude to validate staging · V1', 'V1 passed', 'Approved canary', 'Done']);
    await expect(list.locator('.pr-auto-deploy-group')).toHaveText(['On run #28']);
    await expect(list.locator('.pr-auto-deploy-action[data-now]')).toHaveCount(0);
    await toggle.click();
    await expect(list).toBeHidden();

    await page.getByRole('button', { name: 'Back to project', exact: true }).click();
    await page.locator('[data-item-id="rollout"]').click();
    const auto = page.locator('.rollout-detail .rv-event.rv-auto');
    await expect(auto.first()).toBeVisible({ timeout: 20_000 });
    await expect(auto).toHaveText([/Auto deploy done/, /approved canary/, /V1 passed/, /asked Claude to validate staging · V1/, /merged into main/, /Claude · impl fixed 3 and pushed b7d02aa/,
      /sent 3 findings of Claude review to Claude · impl/, /Claude · impl rebased and pushed 9c41e07/, /asked Claude · impl to rebase onto main \(1\/2\)/, /tagged the title \[ship\]/, /armed by you/]);
  } finally { await h.close(); }
});
