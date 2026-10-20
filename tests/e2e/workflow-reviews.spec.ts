import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { githubFixture } from '../fixtures/github.ts';
import { timedWorkflowYaml, workflowFixture } from '../fixtures/workflow.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { GitHubError } from '../../packages/provider-runtime/github.ts';
import type { WorkflowSource } from '../../packages/provider-runtime/workflow-sources.ts';
import { prActions } from './pr-actions.ts';

async function fixture(uncertain = false, commentAge = 0) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-workflow-')), github = githubFixture(), workflow = workflowFixture(() => new Date(Date.now() - commentAge).toISOString());
  if (uncertain) workflow.postFailure = new GitHubError('GITHUB_POST_UNCERTAIN', 'Fixture accepted then disconnected');
  const source: WorkflowSource = { freeze: resource => ({ identity: { owner: 'fixture', repo: 'billing', number: 42 }, sourceData: resource.data, connectionId: 'github-fixture', account: 'fixture-developer' }), client: () => workflow.client };
  const providers = { ...github, workflows: { 'github.pull-request': source } };
  const service = await startWorkspaceService(directory, undefined, undefined, providers);
  await service.control.dispatch({ commandId: 'setup', expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [
    { type: 'project.create', id: 'project', title: 'Billing', position: { x: 0, y: 0 } },
    { type: 'item.add', id: 'pr', resourceId: 'pr-resource', pluginId: 'github.pull-request', title: github.pull.title, projectId: 'project', position: { x: 270, y: 160 }, data: { owner: 'fixture', repo: 'billing', number: 42 } },
  ] });
  return { directory, providers, service, workflow, github };
}

for (const entry of ['detail', 'map menu'] as const) test(`workflow ${entry} action creates a linked review, watches the report across restart, and retains safe result navigation`, async () => {
  test.setTimeout(45_000);
  const f = await fixture(); let service = f.service;
  let app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: f.directory } });
  try {
    let page = await app.firstWindow();
    if (entry === 'map menu') {
      await page.getByRole('article', { name: f.github.pull.title, exact: true }).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Trigger review', exact: true }).hover();
      expect(f.workflow.posts).toBe(0);
      await page.getByRole('menuitem', { name: '/review', exact: true }).click();
      await expect(page.locator('.map-area')).toHaveAttribute('data-focus', '');
      await page.getByRole('status', { name: `/review · ${f.github.pull.title}`, exact: true }).getByRole('button', { name: 'Open', exact: true }).click();
    } else {
      await page.getByRole('article', { name: f.github.pull.title, exact: true }).click();
      await prActions(page).pick('Review');
      await expect(page.getByRole('button', { name: 'Post /review on GitHub', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: 'Post /review on GitHub', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Open workflow review', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: 'Open workflow review', exact: true }).click();
    }
    await expect.poll(() => f.workflow.posts).toBe(1);
    await expect(page.locator('.workflow-review-detail')).toBeVisible();
    const state = await service.control.read(), item = state.nodes.find(n => state.resources.some(r => r.id === n.resourceId && r.pluginId === 'github.review-run'))!;
    expect(item.projectId).toBe('project'); expect(state.links.some(link => link.sourceId === 'pr' && link.targetId === item.id)).toBe(true);
    await exitWithoutShutdown(app); await service.close();
    f.workflow.complete(); f.workflow.comments.at(-1)!.body += '\n<script>window.workflowInjection=true</script>';
    service = await startWorkspaceService(f.directory, undefined, undefined, f.providers);
    app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: f.directory } }); page = await app.firstWindow();
    await page.getByRole('article', { name: 'Workflow review · #42', exact: true }).click();
    await expect(page.locator('[data-expanded-item-id]:visible .view-chip')).toHaveText('Complete', { timeout: 15_000 }); await expect(page.locator('[data-expanded-item-id]:visible .view-meta')).toHaveText('PR #42 · fixture/billing · requested with /review');
    await expect(page.getByRole('link', { name: 'Review result', exact: true })).toHaveAttribute('href', 'https://github.com/fixture/billing/pull/42#issuecomment-400');
    await expect(page.locator('.workflow-report')).toContainText('<script>window.workflowInjection=true</script>'); expect(await page.evaluate(() => 'workflowInjection' in window)).toBe(false);
    await expect(page.locator('[data-expanded-item-id]:visible')).toHaveScreenshot('workflow-review-complete.png');
    expect(f.workflow.posts).toBe(1);
    await page.getByRole('button', { name: 'Back to PR #42', exact: true }).click(); await expect(page.locator('[data-expanded-item-id]:visible .card-label strong')).toHaveText(f.github.pull.title);
  } finally { await exitWithoutShutdown(app); await service.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test('timed workflow review without the run-name contract is labelled as matched by time and adopts the single nearby run', async () => {
  test.setTimeout(45_000);
  const f = await fixture(false, 5 * 60_000); f.workflow.yaml = timedWorkflowYaml;
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: f.directory } });
  try {
    const page = await app.firstWindow();
    await page.getByRole('article', { name: f.github.pull.title, exact: true }).click();
    await prActions(page).pick('Review');
    await expect(page.getByRole('button', { name: 'Post /review on GitHub', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Post /review on GitHub', exact: true }).click();
    await page.getByRole('button', { name: 'Open workflow review', exact: true }).click();
    await expect.poll(() => f.workflow.posts).toBe(1);
    const meta = page.locator('[data-expanded-item-id]:visible .view-meta');
    await expect(meta).toHaveText('PR #42 · fixture/billing · requested with /review · matched by time');
    f.workflow.complete(101, 'Claude Code');
    await expect(page.locator('[data-expanded-item-id]:visible .view-chip')).toHaveText('Complete', { timeout: 20_000 });
    await expect(meta).toHaveText('PR #42 · fixture/billing · requested with /review · matched by time');
    await expect(page.getByRole('link', { name: 'Workflow run', exact: true })).toHaveAttribute('href', 'https://github.com/fixture/billing/actions/runs/200');
    await expect(page.getByRole('link', { name: 'Review result', exact: true })).toHaveAttribute('href', 'https://github.com/fixture/billing/pull/42#issuecomment-400');
    await expect(page.locator('.workflow-report')).toContainText('Fixture findings'); expect(f.workflow.posts).toBe(1);
  } finally { await exitWithoutShutdown(app); await f.service.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test('timed workflow review beside another /review fails as ambiguous and links the workflow runs', async () => {
  test.setTimeout(45_000);
  const f = await fixture(false, 5 * 60_000); f.workflow.yaml = timedWorkflowYaml;
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: f.directory } });
  try {
    const page = await app.firstWindow();
    await page.getByRole('article', { name: f.github.pull.title, exact: true }).click();
    await prActions(page).pick('Review');
    await page.getByRole('button', { name: 'Post /review on GitHub', exact: true }).click();
    await page.getByRole('button', { name: 'Open workflow review', exact: true }).click();
    await expect.poll(() => f.workflow.posts).toBe(1);
    const trigger = f.workflow.comments.find(comment => comment.id === 101)!;
    f.workflow.comments.push({ id: 102, body: '/review', user: { login: 'teammate' }, created_at: f.workflow.later(trigger.created_at, 30), updated_at: f.workflow.later(trigger.created_at, 30) });
    f.workflow.complete(101, 'Claude Code');
    await expect(page.locator('.wr-notice')).toContainText('Another /review comment', { timeout: 20_000 });
    await expect(page.getByRole('link', { name: 'Workflow runs', exact: true })).toHaveAttribute('href', 'https://github.com/fixture/billing/actions/workflows/review.yml');
    await expect(page.getByRole('link', { name: 'Review result', exact: true })).toHaveCount(0); expect(f.workflow.posts).toBe(1);
  } finally { await exitWithoutShutdown(app); await f.service.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test('unsupported /review menu action reports the setup error without creating a job or posting', async () => {
  const f = await fixture(); f.workflow.yaml = 'name: Unsupported workflow';
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: f.directory } });
  try {
    const page = await app.firstWindow();
    await page.getByRole('article', { name: f.github.pull.title, exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Trigger review', exact: true }).hover();
    await page.getByRole('menuitem', { name: '/review', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('/review');
    expect(f.workflow.posts).toBe(0); expect(f.service.store.listJobs()).toHaveLength(0);
    await expect(page.locator('.map-area')).toHaveAttribute('data-focus', '');
  } finally { await exitWithoutShutdown(app); await f.service.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test('unknown comment outcome presents explicit reconciliation and never silently sends another review', async () => {
  test.setTimeout(40_000);
  const f = await fixture(true), app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: f.directory } });
  try {
    const page = await app.firstWindow(); await page.getByRole('article', { name: f.github.pull.title, exact: true }).click();
      await prActions(page).pick('Review');
    await page.getByRole('button', { name: 'Post /review on GitHub', exact: true }).click(); await page.getByRole('button', { name: 'Open workflow review', exact: true }).click();
    await expect(page.locator('[data-expanded-item-id]:visible .view-chip')).toHaveText('Unconfirmed'); await expect(page.locator('[data-expanded-item-id]:visible .view-chip')).toHaveAttribute('data-tone', 'amber');
    await expect(page.getByRole('button', { name: 'Track this request: comment #101', exact: true })).toBeVisible({ timeout: 15_000 });
    const candidate = page.locator('.workflow-candidate');
    await expect(candidate).toContainText('@fixture-developer'); await expect(candidate.locator('pre')).toHaveText('/review');
    await expect(candidate.locator('time')).toHaveAttribute('datetime', /Z$/);
    await expect(candidate.getByRole('link', { name: 'View on GitHub' })).toHaveAttribute('href', 'https://github.com/fixture/billing/pull/42#issuecomment-101');
    await expect(page.locator('.workflow-report')).toBeHidden();
    await expect(page.getByRole('button', { name: 'I checked: no comment was posted' })).toBeVisible();
    await expect(page.locator('[data-expanded-item-id]:visible')).toHaveScreenshot('workflow-review-uncertain.png', { mask: [candidate.locator('time')] });
    expect(f.workflow.posts).toBe(1); f.workflow.complete();
    await page.getByRole('button', { name: 'Track this request: comment #101', exact: true }).click();
    await expect(page.locator('[data-expanded-item-id]:visible .view-chip')).toHaveText('Complete', { timeout: 10_000 }); expect(f.workflow.posts).toBe(1);
  } finally { await exitWithoutShutdown(app); await f.service.close(); await rm(f.directory, { recursive: true, force: true }); }
});
