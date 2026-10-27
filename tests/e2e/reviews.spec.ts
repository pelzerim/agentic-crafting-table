import { test, expect, _electron as electron } from '@playwright/test';
import electronPath from 'electron';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import { githubFixture, pullFixture } from '../fixtures/github.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { resize } from './visual-fixture.ts';
import type { ReviewSource } from '../../packages/provider-runtime/review-sources.ts';
import { prActions } from './pr-actions.ts';

test('PR review buttons create distinct native read-only sessions with chosen models, linked items and retained recordings', async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-reviews-')), fixture = githubFixture(), executable = join(directory, 'review-fixture');
  await writeFile(executable, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/native-review.mjs')).href)};\n`, { mode: 0o700 });
  const source: ReviewSource = { async freeze(resource) { return { connectionId: resource.connectionId, comparison: { repository: 'fixture/billing', number: 42, baseTipSha: 'b'.repeat(40), headSha: 'a'.repeat(40) }, title: fixture.pull.title, description: 'Review fixture', url: 'https://github.com/fixture/billing/pull/42' }; },
    async capture(_directory, requestId, source) { const cwd = join(directory, 'comparisons', requestId, 'repository'); await mkdir(cwd, { recursive: true }); return { ...source.comparison, baseSha: 'c'.repeat(40), changedFiles: ['file.ts'], diff: '+ review change', cwd, digest: requestId }; } };
  const providers = { ...fixture, reviews: { 'github.pull-request': source }, reviewRuntime: { models: async (provider: string) => ({ options: provider === 'codex' ? ['gpt-6-astra', 'fixture-choice'] : ['opus', 'sonnet'], default: provider === 'codex' ? 'gpt-6-astra' : 'opus' }), probe: async () => ({ executable, version: 'scripted review fixture' }) } };
  const runtime = { directory: join(directory, 'runtime'), executable: electronPath as unknown as string, entrypoint: resolve('dist/session-supervisor.cjs'), electronRuntime: true };
  let service = await startWorkspaceService(directory, undefined, runtime, providers);
  await service.control.dispatch({ commandId: 'setup', expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'project.create', id: 'project', title: 'Billing', position: { x: 0, y: 0 } }, { type: 'item.add', id: 'pr', resourceId: 'pr-resource', pluginId: 'github.pull-request', title: fixture.pull.title, data: { owner: 'fixture', repo: 'billing', number: 42 }, projectId: 'project', position: { x: 270, y: 160 } }] });
  let app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    let page = await app.firstWindow();
    await page.getByRole('article', { name: fixture.pull.title, exact: true }).click();
    await prActions(page).pick('Review');
    await expect(page.getByLabel('Codex review model')).toHaveValue('gpt-6-astra'); await expect(page.getByLabel('Claude review model')).toHaveValue('opus');
    await expect(page.getByLabel('Codex review model').locator('option:checked')).toHaveText('Astra');
    await expect(page.locator('.pr-review-actions')).toHaveScreenshot('pull-request-review-actions.png');
    await resize(app, page, 900, 640);
    for (const label of ['Codex', 'Claude']) {
      const group = page.getByRole('region', { name: `${label} local review` });
      const model = (await group.getByLabel(`${label} review model`).boundingBox())!, button = (await group.getByRole('button', { name: `Start ${label} review` }).boundingBox())!;
      expect(Math.abs(model.y - button.y)).toBeLessThanOrEqual(2);
      await expect(group).toContainText('Local session · no GitHub post');
    }
    await expect(page.locator('.pr-review-actions')).toHaveScreenshot('pull-request-review-actions-narrow.png');
    for (const provider of ['codex', 'claude']) {
      const label = provider === 'codex' ? 'Codex' : 'Claude', model = provider === 'codex' ? 'fixture-choice' : 'opus';
      await page.getByLabel(`${label} review model`).selectOption(model);
      await page.getByRole('button', { name: `Start ${label} review`, exact: true }).click();
      const item = page.getByRole('region', { name: `${label} review · #42`, exact: true });
      await item.getByRole('tab', { name: 'Run log', exact: true }).click();
      await expect(item.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');
      await expect(item.locator('.xterm-accessibility')).toContainText(`REVIEW_STARTED:${provider}:${model}`);
      const state = await service.control.read(), resource = state.resources.find(resource => resource.pluginId === 'code.review' && resource.data.provider === provider)!;
      const node = state.nodes.find(node => node.resourceId === resource.id)!; expect(node.projectId).toBe('project'); expect(state.links.some(link => link.sourceId === 'pr' && link.targetId === node.id)).toBe(true);
      const sessionId = String(resource.data.sessionId);
      await expect(page.evaluate(async id => { try { await window.craftingTable.sessionInput(id, 'arbitrary input'); return ''; } catch (error) { return (error as Error).message; } }, sessionId)).resolves.toContain('do not accept');
      const retry = await page.evaluate(({ requestId, provider, model }) => window.craftingTable.runtimeRun({ action: provider === 'codex' ? 'pr.review.codex' : 'pr.review.claude', nodeId: 'pr', arguments: { requestId, model } }), { requestId: randomUUID(), provider, model });
      expect(retry).toBeTruthy(); await expect.poll(async () => service.store.listJobs().filter(job => job.input.action === 'review.prepare' && job.state === 'succeeded').length).toBe(provider === 'codex' ? 2 : 4);
      expect((await service.control.read()).resources.filter(resource => resource.pluginId === 'code.review')).toHaveLength(provider === 'codex' ? 1 : 2);
      if (provider === 'claude') {
        const client = await connectWorkspace(directory);
        try {
          const closed = await client.call<{ entries: { kind: string; sessionId: string }[] }>('lifecycle.close');
          expect(closed.entries).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'analysis', sessionId })]));
          await client.call('lifecycle.recover', { retry: false });
          await expect.poll(async () => (await service.control.read()).resources.find(record => record.id === resource.id)?.data.sessionId).not.toBe(sessionId);
          const current = (await service.control.read()).resources.find(record => record.id === resource.id)!;
          await expect.poll(async () => (await page.evaluate(id => window.craftingTable.sessionRead(id), String(current.data.sessionId))).session.state).toBe('running');
          const resumed = await page.evaluate(id => window.craftingTable.sessionRead(id), String(current.data.sessionId));
          expect(resumed.session.predecessorId).toBe(sessionId); expect(resumed.session.readOnly).toBe(true);
          expect((await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).chunks.map(chunk => chunk.data).join('')).toContain('REVIEW_STARTED:claude');
          expect(current.data.headSha).toBe(resource.data.headSha);
          expect((await service.control.read()).resources.filter(record => record.pluginId === 'code.review')).toHaveLength(2);
        } finally { client.close(); }
      }
      await writeFile(join(String(resource.data.cwd), 'finish'), 'done');
      await item.getByRole('tab', { name: 'Run log', exact: true }).click();
      await expect(item.locator('.native-terminal')).toHaveAttribute('data-session-state', 'exited'); await expect(item.locator('.xterm-accessibility')).toContainText('Review complete');
      await item.getByRole('tab', { name: 'Findings', exact: true }).click();
      const rendered = item.locator('.code-review-result');
      await expect(rendered.getByRole('heading', { name: 'Review complete', level: 2 })).toBeVisible();
      await expect(rendered.locator('li strong')).toHaveText('P2'); await expect(rendered.locator('li code')).toHaveText('file.ts:12');
      await expect(rendered).not.toContainText('**'); await expect(item.getByRole('tab', { name: 'Findings', exact: true })).toHaveAttribute('aria-selected', 'true');
      if (provider === 'codex') await rendered.screenshot({ path: 'test-results/review-markdown.png' });
      await item.getByRole('tab', { name: 'Run log', exact: true }).click();
      await expect(item.locator('.native-terminal')).toBeVisible(); await expect(rendered).toBeHidden();
      await item.getByRole('tab', { name: 'Findings', exact: true }).click(); await expect(rendered).toBeVisible();
      await expect(page.getByRole('status', { name: `${label} review · #42 finished`, exact: true })).toBeVisible();
      await expect.poll(async () => (await service.control.read()).nodes.find(item => item.id === node.id)?.attentionSources?.completion).toBe('finished');
      // The review finished while it was open in the front window: seen as it arrives, no Mark seen needed.
      await expect.poll(async () => { const current = (await service.control.read()).nodes.find(item => item.id === node.id)!; return current.attentionSeenVersion === current.attentionVersion; }).toBe(true);
      await page.getByRole('button', { name: 'Back to project' }).click();
      if (provider === 'codex') await page.getByRole('article', { name: fixture.pull.title, exact: true }).click();
    }
    await page.getByRole('article', { name: fixture.pull.title, exact: true }).click();
    await page.locator('.pr-related > summary').click();
    const savedReview = page.getByRole('button', { name: 'Open review: Claude review · #42', exact: true });
    await expect(savedReview).toContainText('Current revision');
    await savedReview.click();
    await expect(page.getByRole('region', { name: 'Claude review · #42', exact: true }).locator('.native-terminal')).toHaveAttribute('data-session-state', 'exited');
    await exitWithoutShutdown(app); await service.close(); service = await startWorkspaceService(directory, undefined, runtime, providers);
    app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } }); page = await app.firstWindow();
    await page.getByRole('article', { name: 'Claude review · #42', exact: true }).click();
    await expect(page.locator('.code-review-result').getByRole('heading', { name: 'Review complete', level: 2 })).toBeVisible();
    await page.getByRole('tab', { name: 'Run log', exact: true }).click();
    await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'exited'); await expect(page.locator('.xterm-accessibility')).toContainText('Review complete');
    expect((await service.control.read()).resources.filter(resource => resource.pluginId === 'code.review')).toHaveLength(2);
  } finally {
    await exitWithoutShutdown(app); await service.close();
    const supervisor = await connectSupervisor(runtime.directory).catch(() => undefined); await supervisor?.call('admin.shutdown'); supervisor?.close();
    await new Promise(resolve => setTimeout(resolve, 300)); await rm(directory, { recursive: true, force: true });
  }
});

for (const provider of ['claude', 'codex'] as const) test(`${provider} map-menu and detail reviews stay bound to their initiating PR while switching views and finishing out of order`, async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-review-binding-'));
  const other = { ...structuredClone(pullFixture), id: 125, number: 43, title: 'Separate search changes', head: { ...pullFixture.head, sha: 'd'.repeat(40) } };
  const fixture = githubFixture([other]), pulls = [fixture.pull, other];
  const executable = join(directory, 'review-fixture');
  await writeFile(executable, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/native-review.mjs')).href)};\n`, { mode: 0o700 });
  const releases = new Map<number, () => void>();
  const source: ReviewSource = {
    async freeze(resource) {
      const pull = pulls.find(pull => pull.number === resource.data.number)!;
      return { connectionId: resource.connectionId, comparison: { repository: 'fixture/billing', number: pull.number, baseTipSha: pull.base.sha, headSha: pull.head.sha }, title: pull.title, description: 'Isolated review fixture', url: `https://github.com/fixture/billing/pull/${pull.number}` };
    },
    async capture(_directory, requestId, source, signal) {
      await new Promise<void>(resolve => releases.set(source.comparison.number, resolve)); signal.throwIfAborted();
      const cwd = join(directory, 'comparisons', requestId, 'repository'); await mkdir(cwd, { recursive: true });
      return { ...source.comparison, baseSha: 'c'.repeat(40), changedFiles: ['file.ts'], diff: '+ review change', cwd, digest: requestId };
    },
  };
  const runtime = { directory: join(directory, 'runtime'), executable: electronPath as unknown as string, entrypoint: resolve('dist/session-supervisor.cjs'), electronRuntime: true };
  const service = await startWorkspaceService(directory, undefined, runtime, { ...fixture, reviews: { 'github.pull-request': source }, reviewRuntime: {
    models: async () => ({ options: ['opus', 'gpt-6-astra'], default: provider === 'claude' ? 'opus' : 'gpt-6-astra' }), probe: async () => ({ executable, version: 'scripted review fixture' }),
  } });
  await service.control.dispatch({ commandId: 'setup', expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: pulls.flatMap((pull, index) => [
    { type: 'project.create' as const, id: `project-${pull.number}`, title: `Project ${pull.number}`, position: { x: index * 700, y: 0 } },
    { type: 'item.add' as const, id: `pr-${pull.number}`, resourceId: `resource-${pull.number}`, pluginId: 'github.pull-request', title: pull.title, data: { owner: 'fixture', repo: 'billing', number: pull.number }, projectId: `project-${pull.number}`, position: { x: index * 700 + 100, y: 150 } },
  ]) });
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow(), label = provider === 'claude' ? 'Claude' : 'Codex';
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const pull of pulls) {
      if (pull.number === 42) {
        await page.getByRole('article', { name: pull.title, exact: true }).click({ button: 'right' });
        await page.getByRole('menuitem', { name: 'Trigger review', exact: true }).hover();
        await page.getByRole('menuitem', { name: label, exact: true }).click();
        await expect.poll(() => releases.has(pull.number)).toBe(true);
        await expect(page.locator('.map-area')).toHaveAttribute('data-focus', '');
        // The linked review item is on the map while its comparison is still being captured.
        const preparing = page.getByRole('article', { name: `${label} review · #42`, exact: true });
        await expect(preparing).toHaveClass(/working-card/);
        expect((await service.control.read()).nodes.find(node => node.title === `${label} review · #42`)?.summary).toBe('Fetching and comparing the PR…');
        await expect(page.getByRole('status', { name: `${label} · ${pull.title}`, exact: true })).toContainText('Added to the map');
        // Repeated activation during preparation reveals the same item instead of preparing another.
        await page.getByRole('article', { name: pull.title, exact: true }).click({ button: 'right' });
        await page.getByRole('menuitem', { name: 'Trigger review', exact: true }).hover();
        await page.getByRole('menuitem', { name: label, exact: true }).click();
        await expect.poll(() => service.store.listJobs().filter(job => job.input.action === 'review.prepare' && typeof job.correlation.aliasOf === 'string')).toHaveLength(1);
        expect((await service.control.read()).resources.filter(resource => resource.pluginId === 'code.review')).toHaveLength(1);
        continue;
      }
      await page.getByRole('article', { name: pull.title, exact: true }).click();
      const detail = page.locator('.pr-detail:visible');
      await expect(page.locator('.expanded .card-heading .card-label strong')).toHaveText(pull.title);
      await expect(page.locator('.expanded .view-meta')).toContainText(`#${pull.number} · fixture/billing`);
      await expect(page.locator('.expanded').getByRole('link', { name: 'Open in GitHub', exact: true })).toHaveAttribute('href', `https://github.com/fixture/billing/pull/${pull.number}`);
      await prActions(page, page.locator('.expanded')).pick('Review');
      await detail.getByRole('button', { name: `Start ${label} review`, exact: true }).click();
      await expect.poll(() => releases.has(pull.number)).toBe(true);
      await expect(page.getByRole('region', { name: `${label} review · #${pull.number}`, exact: true }).getByRole('status')).toHaveText('Fetching and comparing the PR…');
    }
    // Finish the second PR first while its detail is visible. The first run must
    // retain its own source and must not steal focus when it finishes afterward.
    releases.get(43)!();
    await expect(page.getByRole('region', { name: `${label} review · #43`, exact: true }).locator('.rd-state-run')).toHaveText('Reviewing');
    releases.get(42)!();
    await expect.poll(() => service.store.listJobs().filter(job => job.input.action === 'review.prepare' && job.state === 'succeeded').length).toBe(3);
    await expect(page.getByRole('region', { name: `${label} review · #43`, exact: true })).toBeVisible();
    const state = await service.control.read();
    for (const pull of pulls) {
      const job = service.store.listJobs().find(job => job.input.action === 'review.prepare' && job.input.nodeId === `pr-${pull.number}` && !job.correlation.aliasOf)!;
      expect(job.input.arguments.sourceResourceId).toBe(`resource-${pull.number}`);
      const review = state.resources.find(resource => resource.pluginId === 'code.review' && resource.data.sourcePrId === `pr-${pull.number}`)!;
      expect(review).toBeTruthy(); expect(review.data.headSha).toBe(pull.head.sha);
      expect(review.data.model).toBe(provider === 'claude' ? 'opus' : 'gpt-6-astra');
      const node = state.nodes.find(node => node.resourceId === review.id)!;
      expect(node.projectId).toBe(`project-${pull.number}`);
      expect(state.links.filter(link => link.targetId === node.id)).toEqual([expect.objectContaining({ sourceId: `pr-${pull.number}`, kind: 'reference' })]);
      const plan = JSON.parse(await readFile(join(directory, 'review-launches', String(review.data.sessionId), 'plan.json'), 'utf8'));
      expect(plan.input.comparison.number).toBe(pull.number);
      expect(plan.input.prompt).toContain(`Perform one code review of fixture/billing#${pull.number}.`);
      expect(plan.input.comparison.cwd).toBe(join(directory, 'comparisons', String(review.data.sessionId), 'repository'));
      await writeFile(join(String(review.data.cwd), 'finish'), 'done');
    }
    await page.getByRole('button', { name: 'Back to project' }).click();
    await page.getByRole('status', { name: `${label} · ${fixture.pull.title}`, exact: true }).getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.getByRole('region', { name: `${label} review · #42`, exact: true }).locator('.rd-state-ok')).toHaveText('Completed');
    expect((await service.control.read()).resources.filter(resource => resource.pluginId === 'code.review')).toHaveLength(2);
  } finally {
    for (const release of releases.values()) release();
    await exitWithoutShutdown(app); await service.close();
    const supervisor = await connectSupervisor(runtime.directory).catch(() => undefined); await supervisor?.call('admin.shutdown'); supervisor?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('Review selection starts one Claude review per selected pull request, each beside its own PR', async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-review-selection-'));
  const other = { ...structuredClone(pullFixture), id: 125, number: 43, title: 'Separate search changes', head: { ...pullFixture.head, sha: 'd'.repeat(40) } };
  const fixture = githubFixture([other]), pulls = [fixture.pull, other];
  const executable = join(directory, 'review-fixture');
  await writeFile(executable, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/native-review.mjs')).href)};\n`, { mode: 0o700 });
  const source: ReviewSource = {
    async freeze(resource) {
      const pull = pulls.find(pull => pull.number === resource.data.number)!;
      return { connectionId: resource.connectionId, comparison: { repository: 'fixture/billing', number: pull.number, baseTipSha: pull.base.sha, headSha: pull.head.sha }, title: pull.title, description: 'Isolated review fixture', url: `https://github.com/fixture/billing/pull/${pull.number}` };
    },
    async capture(_directory, requestId, source) {
      const cwd = join(directory, 'comparisons', requestId, 'repository'); await mkdir(cwd, { recursive: true });
      return { ...source.comparison, baseSha: 'c'.repeat(40), changedFiles: ['file.ts'], diff: '+ review change', cwd, digest: requestId };
    },
  };
  const runtime = { directory: join(directory, 'runtime'), executable: electronPath as unknown as string, entrypoint: resolve('dist/session-supervisor.cjs'), electronRuntime: true };
  const service = await startWorkspaceService(directory, undefined, runtime, { ...fixture, reviews: { 'github.pull-request': source }, reviewRuntime: {
    models: async () => ({ options: ['opus'], default: 'opus' }), probe: async () => ({ executable, version: 'scripted review fixture' }),
  } });
  await service.control.dispatch({ commandId: 'setup', expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [
    { type: 'project.create', id: 'project', title: 'Project', position: { x: 0, y: 0 } },
    ...pulls.map((pull, index) => ({ type: 'item.add' as const, id: `pr-${pull.number}`, resourceId: `resource-${pull.number}`, pluginId: 'github.pull-request', title: pull.title, data: { owner: 'fixture', repo: 'billing', number: pull.number }, projectId: 'project', position: { x: 300, y: 200 + index * 300 } })),
  ] });
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const pull of pulls) await page.getByRole('article', { name: pull.title, exact: true }).click({ modifiers: ['Shift'] });
    await expect(page.locator('.map-selection rect[data-selected-id]')).toHaveCount(2);
    await page.getByRole('article', { name: pulls[0].title, exact: true }).click({ button: 'right' });
    await expect(page.getByRole('menuitem')).toHaveText(['Review selection', 'Copy URLs', 'Move to project', 'Move to plot', 'Mark done', 'Send selection to Undermap']);
    await page.getByRole('menuitem', { name: 'Review selection', exact: true }).hover();
    await expect(page.getByRole('menuitem', { name: 'Claude', exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: '/review', exact: true })).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'Claude', exact: true }).click();
    for (const pull of pulls) {
      await expect(page.getByRole('status', { name: `Claude · ${pull.title}`, exact: true })).toContainText('Added to the map');
      await expect(page.getByRole('article', { name: `Claude review · #${pull.number}`, exact: true })).toBeVisible();
    }
    const state = await service.control.read(), reviews = state.resources.filter(resource => resource.pluginId === 'code.review');
    expect(reviews.map(review => review.data.sourcePrId).sort()).toEqual(['pr-42', 'pr-43']);
    for (const review of reviews) {
      const node = state.nodes.find(node => node.resourceId === review.id)!, pull = state.nodes.find(node => node.id === review.data.sourcePrId)!;
      expect(state.links.filter(link => link.targetId === node.id)).toEqual([expect.objectContaining({ sourceId: pull.id, kind: 'reference' })]);
      expect(Math.abs(node.position.y - pull.position.y)).toBeLessThan(200);
      await writeFile(join(String(review.data.cwd), 'finish'), 'done');
    }
  } finally {
    await exitWithoutShutdown(app); await service.close();
    const supervisor = await connectSupervisor(runtime.directory).catch(() => undefined); await supervisor?.call('admin.shutdown'); supervisor?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('Trigger review ▸ Claude + Codex starts a Claude and a Codex review of the pull request at the same time', async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-review-both-')), fixture = githubFixture(), executable = join(directory, 'review-fixture');
  await writeFile(executable, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/native-review.mjs')).href)};\n`, { mode: 0o700 });
  const source: ReviewSource = {
    async freeze(resource) { return { connectionId: resource.connectionId, comparison: { repository: 'fixture/billing', number: 42, baseTipSha: fixture.pull.base.sha, headSha: fixture.pull.head.sha }, title: fixture.pull.title, description: 'Review fixture', url: 'https://github.com/fixture/billing/pull/42' }; },
    async capture(_directory, requestId, source) {
      const cwd = join(directory, 'comparisons', requestId, 'repository'); await mkdir(cwd, { recursive: true });
      return { ...source.comparison, baseSha: 'c'.repeat(40), changedFiles: ['file.ts'], diff: '+ review change', cwd, digest: requestId };
    },
  };
  const runtime = { directory: join(directory, 'runtime'), executable: electronPath as unknown as string, entrypoint: resolve('dist/session-supervisor.cjs'), electronRuntime: true };
  const service = await startWorkspaceService(directory, undefined, runtime, { ...fixture, reviews: { 'github.pull-request': source }, reviewRuntime: {
    models: async () => ({ options: ['opus'], default: 'opus' }), probe: async () => ({ executable, version: 'scripted review fixture' }),
  } });
  await service.control.dispatch({ commandId: 'setup', expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [
    { type: 'project.create', id: 'project', title: 'Project', position: { x: 0, y: 0 } },
    { type: 'item.add', id: 'pr', resourceId: 'resource-pr', pluginId: 'github.pull-request', title: fixture.pull.title, data: { owner: 'fixture', repo: 'billing', number: 42 }, projectId: 'project', position: { x: 300, y: 200 } },
  ] });
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('article', { name: fixture.pull.title, exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Trigger review', exact: true }).hover();
    await expect(page.getByRole('menu', { name: 'Trigger review' }).getByRole('menuitem')).toHaveText(['Claude', 'Codex', 'Claude + Codex', '/review']);
    await page.getByRole('menuitem', { name: 'Claude + Codex', exact: true }).click();
    for (const provider of ['Claude', 'Codex']) {
      await expect(page.getByRole('status', { name: `${provider} · ${fixture.pull.title}`, exact: true })).toContainText('Added to the map');
      await expect(page.getByRole('article', { name: `${provider} review · #42`, exact: true })).toBeVisible();
    }
    const reviews = (await service.control.read()).resources.filter(resource => resource.pluginId === 'code.review');
    expect(reviews.map(review => review.data.provider).sort()).toEqual(['claude', 'codex']);
    for (const review of reviews) await writeFile(join(String(review.data.cwd), 'finish'), 'done');
  } finally {
    await exitWithoutShutdown(app); await service.close();
    const supervisor = await connectSupervisor(runtime.directory).catch(() => undefined); await supervisor?.call('admin.shutdown'); supervisor?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('Automatic reviews: turned on in Settings, a pull request added afterwards gets a Claude and a Codex review; one already on the map gets none', async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-review-auto-')), executable = join(directory, 'review-fixture');
  const other = { ...structuredClone(pullFixture), id: 125, number: 43, title: 'Separate search changes', head: { ...pullFixture.head, sha: 'd'.repeat(40) } };
  const fixture = githubFixture([other]), pulls = [fixture.pull, other];
  await writeFile(executable, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/native-review.mjs')).href)};\n`, { mode: 0o700 });
  const source: ReviewSource = {
    async freeze(resource) {
      const pull = pulls.find(pull => pull.number === resource.data.number)!;
      return { connectionId: resource.connectionId, comparison: { repository: 'fixture/billing', number: pull.number, baseTipSha: pull.base.sha, headSha: pull.head.sha }, title: pull.title, description: 'Review fixture', url: `https://github.com/fixture/billing/pull/${pull.number}` };
    },
    async capture(_directory, requestId, source) {
      const cwd = join(directory, 'comparisons', requestId, 'repository'); await mkdir(cwd, { recursive: true });
      return { ...source.comparison, baseSha: 'c'.repeat(40), changedFiles: ['file.ts'], diff: '+ review change', cwd, digest: requestId };
    },
  };
  const runtime = { directory: join(directory, 'runtime'), executable: electronPath as unknown as string, entrypoint: resolve('dist/session-supervisor.cjs'), electronRuntime: true };
  const service = await startWorkspaceService(directory, undefined, runtime, { ...fixture, reviews: { 'github.pull-request': source }, reviewRuntime: {
    models: async () => ({ options: ['opus'], default: 'opus' }), probe: async () => ({ executable, version: 'scripted review fixture' }),
  } });
  const add = (pull: typeof other, y: number) => ({ type: 'item.add' as const, id: `pr-${pull.number}`, resourceId: `resource-${pull.number}`, pluginId: 'github.pull-request', title: pull.title, data: { owner: 'fixture', repo: 'billing', number: pull.number }, projectId: 'project', position: { x: 300, y } });
  await service.control.dispatch({ commandId: 'setup', expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [
    { type: 'project.create', id: 'project', title: 'Project', position: { x: 0, y: 0 } }, add(other, 500),
  ] });
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('treeitem', { name: 'Items', exact: true }).click();
    await dialog.getByRole('treeitem', { name: 'GitHub pull request', exact: true }).click();
    const toggle = dialog.getByRole('switch', { name: 'Review new pull requests', exact: true });
    await expect(toggle).not.toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: 'Claude', exact: true })).toBeDisabled();
    await toggle.check();
    await expect(dialog.getByRole('checkbox', { name: 'Claude', exact: true })).toBeChecked();
    await dialog.getByRole('checkbox', { name: 'Codex', exact: true }).check();
    await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
    expect(service.store.readSettings().value.autoReview).toEqual({ enabled: true, agents: ['claude', 'codex'] });
    await expect.poll(() => service.store.pluginStorage('code.review').get('auto-review', 'state')?.value, { timeout: 20_000 }).toEqual({ on: true, settled: ['resource-43'] });
    const { revision } = await service.control.read();
    await service.control.dispatch({ commandId: 'add', expectedRevision: revision, actor: { kind: 'user', id: 'fixture' }, commands: [add(fixture.pull, 200)] });
    for (const provider of ['Claude', 'Codex']) await expect(page.getByRole('article', { name: `${provider} review · #42`, exact: true })).toBeVisible({ timeout: 30_000 });
    const reviews = (await service.control.read()).resources.filter(resource => resource.pluginId === 'code.review');
    expect(reviews.map(review => [review.data.sourcePrId, review.data.provider]).sort()).toEqual([['pr-42', 'claude'], ['pr-42', 'codex']]);
    for (const review of reviews) await writeFile(join(String(review.data.cwd), 'finish'), 'done');
  } finally {
    await exitWithoutShutdown(app); await service.close();
    const supervisor = await connectSupervisor(runtime.directory).catch(() => undefined); await supervisor?.call('admin.shutdown'); supervisor?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('a review whose preparation fails shows the error on its item and Retry starts it there', async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-review-retry-')), fixture = githubFixture(), executable = join(directory, 'review-fixture');
  await writeFile(executable, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/native-review.mjs')).href)};\n`, { mode: 0o700 });
  let failure = 'Could not fetch the pull request head';
  const source: ReviewSource = { async freeze(resource) { return { connectionId: resource.connectionId, comparison: { repository: 'fixture/billing', number: 42, baseTipSha: 'b'.repeat(40), headSha: 'a'.repeat(40) }, title: fixture.pull.title, description: 'Review fixture', url: 'https://github.com/fixture/billing/pull/42' }; },
    async capture(_directory, requestId, source) { if (failure) throw new Error(failure); const cwd = join(directory, 'comparisons', requestId, 'repository'); await mkdir(cwd, { recursive: true }); return { ...source.comparison, baseSha: 'c'.repeat(40), changedFiles: ['file.ts'], diff: '+ review change', cwd, digest: requestId }; } };
  const runtime = { directory: join(directory, 'runtime'), executable: electronPath as unknown as string, entrypoint: resolve('dist/session-supervisor.cjs'), electronRuntime: true };
  const service = await startWorkspaceService(directory, undefined, runtime, { ...fixture, reviews: { 'github.pull-request': source }, reviewRuntime: { models: async () => ({ options: ['opus'], default: 'opus' }), probe: async () => ({ executable, version: 'scripted review fixture' }) } });
  await service.control.dispatch({ commandId: 'setup', expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'project.create', id: 'project', title: 'Billing', position: { x: 0, y: 0 } }, { type: 'item.add', id: 'pr', resourceId: 'pr-resource', pluginId: 'github.pull-request', title: fixture.pull.title, data: { owner: 'fixture', repo: 'billing', number: 42 }, projectId: 'project', position: { x: 270, y: 160 } }] });
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow();
    await page.getByRole('article', { name: fixture.pull.title, exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Trigger review', exact: true }).hover();
    await page.getByRole('menuitem', { name: 'Claude', exact: true }).click();
    const item = page.getByRole('article', { name: 'Claude review · #42', exact: true });
    await expect(item).toBeVisible();
    await expect.poll(async () => (await service.control.read()).nodes.find(node => node.title === 'Claude review · #42')?.attention).toBe('error');
    await item.click();
    const region = page.getByRole('region', { name: 'Claude review · #42', exact: true });
    await expect(region.getByRole('alert')).toHaveText(failure); await region.screenshot({ path: 'test-results/review-preparation-failed.png' });
    failure = '';
    await region.getByRole('button', { name: 'Retry review', exact: true }).click();
    await expect(region.locator('.rd-state-run')).toHaveText('Reviewing');
    const state = await service.control.read(), reviews = state.resources.filter(resource => resource.pluginId === 'code.review');
    expect(reviews).toHaveLength(1); expect(reviews[0].data.phase).toBeUndefined();
    expect(state.links.filter(link => link.sourceId === 'pr' && link.targetId === state.nodes.find(node => node.resourceId === reviews[0].id)!.id)).toHaveLength(1);
    await writeFile(join(String(reviews[0].data.cwd), 'finish'), 'done');
  } finally {
    await exitWithoutShutdown(app); await service.close();
    const supervisor = await connectSupervisor(runtime.directory).catch(() => undefined); await supervisor?.call('admin.shutdown'); supervisor?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
