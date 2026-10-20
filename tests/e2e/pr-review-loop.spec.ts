import { test, expect, _electron as electron } from '@playwright/test';
import electronPath from 'electron';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import type { ReviewSource } from '../../packages/provider-runtime/review-sources.ts';
import { githubFixture } from '../fixtures/github.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { scrollbarArgs } from './visual-fixture.ts';
import { prActions } from './pr-actions.ts';

test('Review loop: armed from the PR view after a confirmation, its status line and round strip follow the service, Stop ends it, and the map menu offers it', async () => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-pr-review-loop-')), fixture = githubFixture(), reviewer = join(directory, 'review-fixture');
  await writeFile(reviewer, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/native-review.mjs')).href)};\n`, { mode: 0o700 });
  const source: ReviewSource = { async freeze(resource) { return { connectionId: resource.connectionId, comparison: { repository: 'fixture/billing', number: 42, baseTipSha: 'b'.repeat(40), headSha: 'a'.repeat(40) }, title: fixture.pull.title, description: 'Review fixture', url: 'https://github.com/fixture/billing/pull/42' }; },
    async capture(_directory, requestId, frozen) { const cwd = join(directory, 'comparisons', requestId, 'repository'); await mkdir(cwd, { recursive: true }); return { ...frozen.comparison, baseSha: 'c'.repeat(40), changedFiles: ['file.ts'], diff: '+ review change', cwd, digest: requestId }; } };
  const runtime = { directory: join(directory, 'runtime'), executable: electronPath as unknown as string, entrypoint: resolve('dist/session-supervisor.cjs'), electronRuntime: true };
  const service = await startWorkspaceService(directory, undefined, runtime, { ...fixture, reviews: { 'github.pull-request': source },
    reviewRuntime: { models: async () => ({ options: ['opus', 'gpt-6-astra'], default: 'opus' }), probe: async () => ({ executable: reviewer, version: 'scripted review fixture', structuredOutput: true }) } });
  await service.control.dispatch({ commandId: 'setup', expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [
    { type: 'project.create', id: 'project', title: 'Billing', position: { x: 0, y: 0 }, workingDirectory: directory },
    { type: 'item.add', id: 'pr', resourceId: 'pr-resource', pluginId: 'github.pull-request', title: fixture.pull.title, data: { owner: 'fixture', repo: 'billing', number: 42 }, projectId: 'project', position: { x: 270, y: 160 } }] });
  await service.resources.poll();
  const app = await electron.launch({ args: ['.', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow(), card = page.locator('[data-item-id="pr"]'), frame = page.locator('[data-expanded-item-id=pr]'), actions = prActions(page, frame);
    await card.click();
    await expect(page.locator('.view-header .view-chip')).toHaveText('Open');
    const status = frame.locator('.pr-review-loop-status');
    await expect(status).toBeHidden();

    await actions.pick('Review loop');
    const menu = page.getByRole('menu', { name: 'Review loop', exact: true });
    await expect(menu.locator('.resource-choice-prompt')).toHaveText('Review loop on #42');
    await expect(menu.getByRole('menuitem')).toHaveText([/^Up to 3 rounds/, /^Up to 1 round/, /^Up to 2 rounds/, /^Up to 4 rounds/, /^Up to 5 rounds/, /Cancel/]);
    await menu.getByRole('menuitem', { name: /^Up to 3 rounds/ }).click();
    const confirm = menu.getByRole('group', { name: 'Up to 3 rounds' });
    await expect(confirm).toContainText('Start a review loop on #42?');
    await expect(confirm).toContainText('Reviewer: Claude · opus. Fixer: new agent in Billing. Up to 3 reviews and 3 fix requests. The fixer pushes to billing/plan-changes. Nothing is merged or approved.');
    await confirm.getByRole('menuitem', { name: 'Start review loop', exact: true }).click();

    await expect(status).toBeVisible();
    await expect(status.locator('.pr-review-loop-text')).toHaveText('Review loop · reviewing (round 1 of 3)');
    await expect(status).toHaveAttribute('data-state', 'armed');
    await actions.open();
    await expect(actions.item('Review loop · on')).toBeVisible();
    await page.keyboard.press('Escape');

    // Round 1 is an ordinary review linked from the pull request; its desk names the loop and its rounds.
    const open = status.getByRole('button', { name: 'Open round 1', exact: true });
    await expect(open).toBeVisible({ timeout: 20_000 });
    await open.click();
    const review = page.getByRole('region', { name: 'Claude review · #42', exact: true });
    await expect(review).toBeVisible();
    const strip = review.getByRole('group', { name: 'Review loop rounds' });
    await expect(strip).toContainText('Part of a review loop on #42');
    await expect(strip.getByRole('button')).toHaveText(['R1', 'R2', 'R3']);
    await expect(strip.getByRole('button', { name: 'Round 1' })).toHaveAttribute('aria-current', 'true');
    await expect(strip.getByRole('button', { name: 'Round 2' })).toBeDisabled();
    const state = await service.control.read(), item = state.nodes.find(node => state.resources.find(resource => resource.id === node.resourceId)?.pluginId === 'code.review')!;
    expect(state.links.some(link => link.sourceId === 'pr' && link.targetId === item.id && link.label === 'Review')).toBe(true);

    await page.getByRole('button', { name: 'Back to project', exact: true }).click();
    await card.click();
    await expect(status.locator('.pr-review-loop-text')).toHaveText('Review loop · reviewing (round 1 of 3)');
    await status.getByRole('button', { name: 'Stop review loop', exact: true }).click();
    await expect(status).toBeHidden();
    const record = await page.evaluate(() => window.craftingTable.runtimeRun({ action: 'review.loop' as 'agent.resume', nodeId: 'pr', arguments: { operation: 'status' } })) as { state: string };
    expect(record.state).toBe('stopped');
    expect((await service.control.read()).nodes.find(node => node.id === 'pr')?.attentionSources?.['review-loop']).toBeUndefined();

    await page.getByRole('button', { name: 'Back to project', exact: true }).click();
    await card.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Review loop', exact: true }).hover();
    const submenu = page.getByRole('menu', { name: 'Review loop', exact: true });
    await expect(submenu.getByRole('menuitem', { name: /^Up to 3 rounds/ })).toBeVisible();
    await page.keyboard.press('Escape');
    expect(fixture.posts).toHaveLength(0); expect(fixture.merges).toHaveLength(0);
  } finally {
    await exitWithoutShutdown(app); await service.close();
    const supervisor = await connectSupervisor(runtime.directory).catch(() => undefined);
    await supervisor?.call('admin.shutdown').catch(() => {}); supervisor?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
