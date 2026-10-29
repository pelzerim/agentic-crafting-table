import { test, expect, _electron as electron } from '@playwright/test';
import electronPath from 'electron';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import { githubFixture } from '../fixtures/github.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import type { ReviewSource } from '../../packages/provider-runtime/review-sources.ts';
import { prActions } from './pr-actions.ts';

const ARTIFACT_URL = 'https://claude.ai/code/artifact/00000000-0000-4000-8000-000000000016';

/** The scripted native agent stands in for Claude: no model runs and nothing is published. */
test('Explain architecture starts one connected Claude session whose published artifact lands on the map and opens in the browser', async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-architecture-')), bin = join(directory, 'bin'), originalPath = process.env.PATH;
  await mkdir(bin);
  await writeFile(join(bin, 'claude'), `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/native-agent.mjs')).href)};\n`, { mode: 0o700 });
  process.env.PATH = `${bin}:${originalPath}`;
  const claudeConfig = join(directory, 'claude-config'), originalConfig = process.env.CLAUDE_CONFIG_DIR;
  await mkdir(claudeConfig); await writeFile(join(claudeConfig, '.claude.json'), '{}');
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  const fixture = githubFixture(), head = fixture.pull.head.sha;
  const source: ReviewSource = {
    async freeze(resource) { return { connectionId: resource.connectionId, comparison: { repository: 'fixture/billing', number: 42, baseTipSha: 'b'.repeat(40), headSha: head }, title: fixture.pull.title, description: 'Architecture fixture', url: 'https://github.com/fixture/billing/pull/42' }; },
    async capture(_directory, requestId, source) {
      const cwd = join(directory, 'comparisons', requestId, 'repository'); await mkdir(cwd, { recursive: true });
      await writeFile(join(cwd, 'billing.ts'), 'export const plan = "captured";\n');
      return { ...source.comparison, baseSha: 'c'.repeat(40), changedFiles: ['billing.ts'], diff: '+ export const plan = "captured";', cwd, digest: requestId };
    },
  };
  const runtime = { directory: join(directory, 'runtime'), executable: electronPath as unknown as string, entrypoint: resolve('dist/session-supervisor.cjs'), electronRuntime: true };
  const service = await startWorkspaceService(directory, undefined, runtime, { ...fixture, reviews: { 'github.pull-request': source } });
  await service.control.dispatch({ commandId: 'setup', expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [
    { type: 'project.create', id: 'project', title: 'Billing', summary: 'BILLING_BRIEF', position: { x: 0, y: 0 } },
    { type: 'item.add', id: 'pr', resourceId: 'pr-resource', pluginId: 'github.pull-request', title: fixture.pull.title, data: { owner: 'fixture', repo: 'billing', number: 42 }, projectId: 'project', position: { x: 270, y: 160 } },
  ] });
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ shell }) => { (globalThis as any).openedUrls = []; shell.openExternal = async (url: string) => { (globalThis as any).openedUrls.push(url); }; });
    const opened = () => app.evaluate(() => (globalThis as any).openedUrls.slice() as string[]);
    const read = () => service.control.read();
    const pr = page.getByRole('article', { name: fixture.pull.title, exact: true });
    await pr.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Explain architecture', exact: true }).hover();
    const submenu = page.getByRole('menu', { name: 'Explain architecture', exact: true });
    await expect(submenu.getByRole('menuitem', { name: 'Claude', exact: true })).toHaveAttribute('title', /private claude\.ai artifact/);
    await submenu.getByRole('menuitem', { name: 'Claude', exact: true }).click();

    await expect(page.getByRole('article', { name: 'Architecture · #42', exact: true })).toBeVisible({ timeout: 30_000 });
    let state = await read();
    const agentResource = state.resources.find(resource => resource.pluginId === 'agent.session')!, agent = state.nodes.find(node => node.resourceId === agentResource.id)!;
    expect(agent.projectId).toBe('project');
    expect(state.links).toContainEqual(expect.objectContaining({ sourceId: 'pr', targetId: agent.id, kind: 'context' }));
    expect(agentResource.data.architecture).toMatchObject({ sourcePrId: 'pr', headSha: head, baseSha: 'c'.repeat(40) });
    await expect.poll(async () => JSON.parse(await readFile(join(String(agentResource.data.cwd), 'fixture-flags.json'), 'utf8').catch(() => '{}')).permissionMode, { timeout: 20_000 }).toBe('auto');

    // The fixture's synthetic Artifact hook adds the card, titled from the published page.
    await expect.poll(async () => (await read()).resources.filter(resource => resource.pluginId === 'claude.artifact').length, { timeout: 30_000 }).toBe(1);
    state = await read();
    const artifactResource = state.resources.find(resource => resource.pluginId === 'claude.artifact')!, artifact = state.nodes.find(node => node.resourceId === artifactResource.id)!;
    expect(artifact.title).toBe('Billing plan architecture'); expect(artifact.projectId).toBe('project');
    expect(artifactResource.data).toMatchObject({ url: ARTIFACT_URL, sourcePrId: 'pr', headSha: head, sessionId: agentResource.data.sessionId });
    expect(state.links).toContainEqual(expect.objectContaining({ sourceId: agent.id, targetId: artifact.id }));
    expect(state.links).toContainEqual(expect.objectContaining({ sourceId: 'pr', targetId: artifact.id }));

    // A second request for the same comparison opens the running session instead of launching again.
    await pr.click();
    await prActions(page).pick('Review');
    await page.getByRole('region', { name: 'Explain architecture', exact: true }).getByRole('button', { name: 'Explain architecture', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Architecture · #42', exact: true })).toBeVisible({ timeout: 30_000 });
    expect((await read()).resources.filter(resource => resource.pluginId === 'agent.session')).toHaveLength(1);

    // Republishing the same artifact keeps one card and its title.
    await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('publish-artifact\n');
    await expect(page.locator('.xterm-accessibility')).toContainText('ARTIFACT_REPUBLISHED');
    expect((await read()).resources.filter(resource => resource.pluginId === 'claude.artifact')).toHaveLength(1);
    expect((await read()).nodes.find(node => node.id === artifact.id)?.title).toBe('Billing plan architecture');

    const trusted = async () => (JSON.parse(await readFile(join(claudeConfig, '.claude.json'), 'utf8')).projects ?? {})[join(directory, 'comparisons')]?.hasTrustDialogAccepted;
    await expect.poll(trusted, { message: 'the comparisons folder is trusted for Claude, so the session does not wait on the trust question' }).toBe(true);
    await page.getByRole('button', { name: 'Back to project' }).click();
    const card = page.getByRole('article', { name: 'Billing plan architecture', exact: true });
    await card.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Open on claude.ai', exact: true }).click();
    await expect.poll(opened).toEqual([ARTIFACT_URL]);
    await card.click();
    const panel = page.getByRole('region', { name: 'Billing plan architecture', exact: true });
    await expect(panel.getByRole('button', { name: 'Pull request · ' + fixture.pull.title })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Agent · Architecture · #42' })).toBeVisible();
    await panel.getByRole('button', { name: 'Open in browser', exact: true }).click();
    await expect.poll(opened).toEqual([ARTIFACT_URL, ARTIFACT_URL]);
  } finally {
    process.env.PATH = originalPath;
    if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = originalConfig;
    await exitWithoutShutdown(app); await service.close();
    const supervisor = await connectSupervisor(runtime.directory).catch(() => undefined); await supervisor?.call('admin.shutdown'); supervisor?.close();
    await new Promise(resolve => setTimeout(resolve, 300)); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
