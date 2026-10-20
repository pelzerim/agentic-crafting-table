import { test, expect, _electron as electron } from '@playwright/test';
import electronPath from 'electron';
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import type { SessionSnapshot } from '../../packages/session-runtime/protocol.ts';
import { githubFixture } from '../fixtures/github.ts';
import { questionReview, sampleReview } from '../fixtures/review-findings.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { resize } from './visual-fixture.ts';
import type { ReviewSource } from '../../packages/provider-runtime/review-sources.ts';

const finish = async (cwd: string, content: string) => { const file = join(cwd, `finish-${randomUUID()}`); await writeFile(file, content); await rename(file, join(cwd, 'finish')); };

test('structured review findings: triage, send to idle and busy agents, fixed reports, roll-ups, minimum width and text fallback', async () => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-review-findings-')), fixture = githubFixture();
  const reviewer = join(directory, 'review-fixture'), agentScript = join(directory, 'agent-fixture');
  await writeFile(reviewer, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/native-review.mjs')).href)};\n`, { mode: 0o700 });
  await writeFile(agentScript, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/scripted-agent.mjs')).href)};\n`, { mode: 0o700 });
  const source: ReviewSource = { async freeze(resource) { return { connectionId: resource.connectionId, comparison: { repository: 'fixture/billing', number: 42, baseTipSha: 'b'.repeat(40), headSha: 'a'.repeat(40) }, title: fixture.pull.title, description: 'Review fixture', url: 'https://github.com/fixture/billing/pull/42' }; },
    async capture(_directory, requestId, source) { const cwd = join(directory, 'comparisons', requestId, 'repository'); await mkdir(cwd, { recursive: true }); return { ...source.comparison, baseSha: 'c'.repeat(40), changedFiles: ['file.ts'], diff: '+ review change', cwd, digest: requestId }; } };
  const runtime = { directory: join(directory, 'runtime'), executable: electronPath as unknown as string, entrypoint: resolve('dist/session-supervisor.cjs'), electronRuntime: true };
  const service = await startWorkspaceService(directory, undefined, runtime, { ...fixture, reviews: { 'github.pull-request': source }, reviewRuntime: { models: async () => ({ options: ['opus', 'gpt-6-astra'], default: 'opus' }), probe: async () => ({ executable: reviewer, version: 'scripted review fixture', structuredOutput: true }) } });
  const agent = (id: string, x: number) => ({ type: 'item.add' as const, id, resourceId: `${id}-r`, pluginId: 'agent.session', title: `Claude · ${id}`, projectId: 'project', position: { x, y: 560 }, data: { provider: 'claude', sessionId: `${id}-session` } });
  await service.control.dispatch({ commandId: 'setup', expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [
    { type: 'project.create', id: 'project', title: 'Billing', position: { x: 0, y: 0 } },
    { type: 'item.add', id: 'pr', resourceId: 'pr-resource', pluginId: 'github.pull-request', title: fixture.pull.title, data: { owner: 'fixture', repo: 'billing', number: 42 }, projectId: 'project', position: { x: 270, y: 160 } },
    agent('impl', 100), agent('docs', 500), { type: 'node.update', id: 'impl', activity: 'idle' }, { type: 'node.update', id: 'docs', activity: 'working' },
  ] });
  const supervisor = await connectSupervisor(runtime.directory);
  for (const id of ['impl', 'docs']) await supervisor.call('sessions.launch', { sessionId: `${id}-session`, requestId: `${id}-session`, nodeId: id, workspaceId: 'fixture', cwd: directory, executable: agentScript, args: [], cols: 200, rows: 40 });
  const output = async (id: string) => (await supervisor.call<SessionSnapshot>('sessions.read', { sessionId: `${id}-session` })).chunks.map(chunk => chunk.data).join('');
  let apply = async (_commands: object[]): Promise<unknown> => undefined;
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  const mcp = new Client({ name: 'fixture-agent', version: '1' });
  try {
    const page = await app.firstWindow(); await page.emulateMedia({ reducedMotion: 'reduce' }); await resize(app, page, 1440, 900);
    apply = commands => page.evaluate(async commands => { const { state } = await window.craftingTable.workspaceRead();
      return window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: commands as never }); }, commands);
    await page.evaluate(requestId => window.craftingTable.runtimeRun({ action: 'pr.review.claude', nodeId: 'pr', arguments: { requestId, model: 'opus' } }), randomUUID());
    const card = page.getByRole('article', { name: 'Claude review · #42', exact: true });
    await expect(card).toBeVisible(); await card.click();
    const view = page.getByRole('region', { name: 'Claude review · #42', exact: true }), desk = view.getByRole('region', { name: 'Review findings' });
    await expect(view.locator('.rd-frame .rd-state-run')).toHaveText('Reviewing');
    await expect(desk.locator('.rd-split')).toHaveCount(0);
    await desk.screenshot({ path: 'test-results/review-findings-b6-running.png' });

    const state = await service.control.read(), review = state.resources.find(resource => resource.pluginId === 'code.review')!, reviewNode = state.nodes.find(node => node.resourceId === review.id)!;
    await finish(String(review.data.cwd), JSON.stringify(sampleReview));
    await expect(desk.getByRole('option')).toHaveCount(3);
    await expect(view.locator('.rd-frame .rd-state-ok')).toHaveText('Completed');
    await expect(view.getByRole('tab', { name: /Findings/ })).toContainText('3');
    await expect(desk.locator('.rd-summary b')).toHaveText('No blocking issues.');
    await expect(desk.getByRole('option').first()).toContainText('Tokens are logged');
    await expect(desk.getByRole('button', { name: 'Critical 1' })).toBeVisible();
    const chip = desk.locator('.rd-detail .rd-loc-chip').first();
    await expect(chip).toHaveAttribute('href', `https://github.com/fixture/billing/blob/${'a'.repeat(40)}/src/log.ts#L10`);
    await expect.poll(async () => (await service.control.read()).nodes.find(node => node.id === reviewNode.id)?.attentionSources?.findings).toBe('review');
    await desk.screenshot({ path: 'test-results/review-findings-b1-default.png' });

    // No agent linked yet: the picker explains how to connect one and keeps the selection.
    await desk.getByRole('listbox', { name: 'Findings' }).focus();
    await page.keyboard.press('Space'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Space');
    await expect(desk.locator('.rd-selcount')).toHaveText('2 of 3 selected');
    await expect(desk.locator('.rd-breakdown')).toHaveText('1 critical · 1 low');
    await page.keyboard.press('Enter');
    const picker = desk.getByRole('dialog');
    await expect(picker).toContainText('No agent to send to'); await desk.screenshot({ path: 'test-results/review-findings-b5-no-agent.png' });
    await page.keyboard.press('Escape'); await expect(picker).toBeHidden(); await expect(desk.locator('.rd-selcount')).toHaveText('2 of 3 selected');

    await apply([{ type: 'link.save', link: { id: 'pr-impl', sourceId: 'pr', targetId: 'impl', kind: 'context', label: '' } }, { type: 'link.save', link: { id: 'review-docs', sourceId: reviewNode.id, targetId: 'docs', kind: 'context', label: '' } }]);
    await page.keyboard.press('Shift+ArrowDown');
    await expect(desk.locator('.rd-selcount')).toHaveText('3 of 3 selected'); await page.keyboard.press('Space');
    await expect(desk.locator('.rd-selcount')).toHaveText('2 of 3 selected');
    await desk.screenshot({ path: 'test-results/review-findings-b2-selected.png' });
    await page.keyboard.press('Enter');
    await expect(picker.getByRole('radio')).toHaveCount(2);
    await expect(picker.getByRole('radio', { name: /Claude · docs/ })).toHaveAttribute('aria-checked', 'true');
    await expect(picker.getByRole('button', { name: 'Queue for Claude · docs' })).toBeVisible();
    await picker.getByRole('radio', { name: /Claude · impl/ }).click();
    await expect(picker.getByRole('radio', { name: /Claude · impl/ })).toHaveAttribute('aria-checked', 'true');
    await expect(picker.getByRole('radio', { name: /Claude · docs/ })).toContainText('queued and delivered when it’s idle');
    await expect(picker).toContainText('Via PR #42'); await expect(picker).toContainText('Connected to this review');
    await picker.getByLabel('Note for the agent').fill('Keep the public API unchanged');
    await picker.getByRole('button', { name: 'Preview message' }).click();
    await expect(picker.locator('.rd-preview')).toContainText('Fix only F3, F1');
    await desk.screenshot({ path: 'test-results/review-findings-b3-picker.png' });
    await picker.getByRole('button', { name: 'Send to Claude · impl' }).click();
    await expect(desk.locator('.rd-toast.done')).toContainText('Sent F3, F1 to Claude · impl');
    await expect(desk.getByRole('option', { name: /Tokens are logged/ })).toContainText('Sent to Claude · impl');
    await expect.poll(() => output('impl')).toContain('Fix only F3, F1'); await expect.poll(() => output('impl')).toContain('</review>');
    const received = await output('impl');
    expect(received).toContain('Note from the user: Keep the public API unchanged');
    expect(received.split('<review>')[0]).not.toContain('Readers match exact file names');
    expect(received.split('<review>')[1]).toContain('Readers match exact file names');
    expect(received).toContain('workspace_report_review_fixes');
    await desk.screenshot({ path: 'test-results/review-findings-b4-sent.png' });

    // A working agent gets the findings queued, then delivered when it becomes idle.
    await desk.getByRole('option', { name: /Readers match exact file names/ }).locator('input[type=checkbox]').check();
    await expect(desk.locator('.rd-split-main')).toHaveText('Send to Claude · impl'); await desk.locator('.rd-split-main').click();
    await picker.getByRole('radio', { name: /Claude · docs/ }).click();
    await picker.getByRole('button', { name: 'Queue for Claude · docs' }).click();
    await expect(desk.locator('.rd-toast.done')).toContainText('Queued F2 for Claude · docs');
    await expect(desk.getByRole('option', { name: /Readers match/ })).toContainText('Queued for Claude · docs');
    expect(await output('docs')).not.toContain('Fix only F2');
    await apply([{ type: 'node.update', id: 'docs', activity: 'idle' }]);
    await expect.poll(() => output('docs')).toContain('Fix only F2');
    await expect(desk.getByRole('option', { name: /Readers match/ })).toContainText('Sent to Claude · docs');

    // Fixed reports arrive over MCP from the agent the finding was sent to.
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp/entry.ts')], env: { ...process.env, ACT_DATA_DIR: directory, ACT_NODE_ID: 'impl' } as Record<string, string>, stderr: 'pipe' }));
    const wrong = await mcp.callTool({ name: 'workspace_report_review_fixes', arguments: { reviewNodeId: reviewNode.id, findingIds: ['F2'] } });
    expect(wrong.isError).toBe(true); expect(JSON.stringify(wrong.content)).toContain('not sent to this agent');
    const refused = await mcp.callTool({ name: 'workspace_run', arguments: { action: 'review.findings', nodeId: reviewNode.id, arguments: { operation: 'send', requestId: randomUUID(), reviewSessionId: String(review.data.sessionId), findingIds: ['F2'], agentNodeId: 'impl' } } });
    expect(refused.isError).toBe(true);
    const fixed = await mcp.callTool({ name: 'workspace_report_review_fixes', arguments: { reviewNodeId: reviewNode.id, findingIds: ['F1'], commit: 'abc1234', note: 'Resized asynchronously' } });
    expect(fixed.isError).not.toBe(true);
    const low = desk.getByRole('option', { name: /Thumbnails are resized/ });
    await expect(low).toContainText('Fixed in abc1234');
    await low.click(); await expect(desk.locator('.rd-history')).toContainText('Fixed by Claude · impl in abc1234');
    await desk.getByRole('button', { name: 'Reopen', exact: true }).click();
    await expect(low).not.toContainText('Fixed in'); await expect(desk.locator('.rd-history')).toContainText('Reopened by you');
    // The person's own mark is Ignore: it never reads as fixed.
    await desk.getByRole('button', { name: 'Ignore', exact: true }).click();
    await expect(low.locator('.rd-stat')).toHaveText('Ignored'); await expect(desk.locator('.rd-d-top .rd-stat')).toHaveText('Ignored');
    await expect(desk.locator('.rd-history li').last()).toContainText('Ignored by you');
    await expect(desk.getByRole('button', { name: 'Stop ignoring', exact: true })).toBeVisible();
    await desk.screenshot({ path: 'test-results/review-findings-ignored.png' });

    // Copy whole report: one Markdown document with every finding and its current state.
    await page.evaluate(() => { const copied: string[] = []; (window as any).copiedReports = copied; Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (text: string) => { copied.push(text); } }); });
    const copyAll = desk.getByRole('button', { name: 'Copy whole report', exact: true });
    await copyAll.click(); await expect(desk.locator('.rd-head').getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
    const report = await page.evaluate(() => (window as any).copiedReports.at(-1) as string);
    expect(report.startsWith(`# Review: ${fixture.pull.title}\n\n`)).toBe(true); expect(report).toContain(sampleReview.summary);
    expect([...report.matchAll(/^### (F\d+) /gm)].map(match => match[1])).toEqual(['F3', 'F1', 'F2']);
    expect(report).toContain('Suggested fix: Resize asynchronously.\n\nStatus: Ignored'); expect(report).toContain('Status: Sent to Claude · impl'); expect(report).toContain('- File names stay unique');
    await expect(copyAll).toBeVisible({ timeout: 4000 });

    // Minimum width: the view cannot be resized narrower than 750 px.
    const handle = page.getByRole('button', { name: 'Resize view: Claude review · #42' }), grip = (await handle.boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await page.mouse.down();
    await page.mouse.move(grip.x - 700, grip.y, { steps: 10 }); await page.mouse.up();
    expect((await view.boundingBox())!.width).toBe(750);
    await desk.screenshot({ path: 'test-results/review-findings-min-width.png' });

    // Roll-ups: the map card pips and the PR's connected reviews.
    await apply([{ type: 'node.resize', id: reviewNode.id, size: 'medium' }]);
    await page.getByRole('button', { name: 'Back to project' }).click();
    await expect(card.locator('.card-pips i')).toHaveCount(3);
    await expect(card.locator('.card-pips i[data-style=fixed]')).toHaveCount(1);
    await expect(card.locator('.card-summary')).toContainText('3 findings · 1 critical · 1 low · 1 hard.');
    await expect(card.locator('.card-summary')).toContainText('2 sent · 1 ignored'); await expect(card.locator('.card-summary')).not.toContainText('fixed');
    await card.screenshot({ path: 'test-results/review-findings-map-card.png' });
    await page.getByRole('article', { name: fixture.pull.title, exact: true }).click();
    await page.locator('.pr-related > summary').click();
    const linked = page.getByRole('button', { name: 'Open review: Claude review · #42', exact: true });
    await expect(linked.locator('.pr-linked-mix')).toContainText('1 critical'); await expect(linked.locator('.pr-linked-mix')).toContainText('1 hardening');
    await expect(linked.locator('.pr-linked-progress')).toContainText('2 sent · 1 ignored · to Claude · docs');
    await page.locator('.pr-connected-reviews').screenshot({ path: 'test-results/review-findings-pr-connected.png' });
    await page.getByRole('button', { name: 'Back to project' }).click();

    // A text review keeps its Markdown with the reason and can run again as findings.
    await page.evaluate(requestId => window.craftingTable.runtimeRun({ action: 'pr.review.codex', nodeId: 'pr', arguments: { requestId, model: 'gpt-6-astra' } }), randomUUID());
    await expect.poll(async () => (await service.control.read()).resources.find(resource => resource.pluginId === 'code.review' && resource.data.provider === 'codex')?.data.cwd).toBeTruthy();
    const codex = (await service.control.read()).resources.find(resource => resource.pluginId === 'code.review' && resource.data.provider === 'codex')!;
    await finish(String(codex.data.cwd), 'done');
    const codexCard = page.getByRole('article', { name: 'Codex review · #42', exact: true });
    await codexCard.click();
    const legacy = page.getByRole('region', { name: 'Codex review · #42', exact: true }).getByRole('region', { name: 'Review findings' });
    await expect(legacy.locator('.rd-banner')).toContainText('Shown as text.');
    await expect(legacy.locator('.code-review-result').getByRole('heading', { name: 'Review complete', level: 2 })).toBeVisible();
    await expect(legacy.getByRole('button', { name: /Send whole review/ })).toBeVisible();
    await legacy.getByRole('button', { name: 'Copy whole report', exact: true }).click(); await expect(legacy.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).copiedReports.at(-1) as string)).toMatch(/^## Review complete/);
    await expect(legacy.getByRole('button', { name: 'Copy whole report', exact: true })).toBeVisible({ timeout: 4000 });
    await legacy.screenshot({ path: 'test-results/review-findings-b7-text.png' });
    await legacy.getByRole('button', { name: 'Retry as findings' }).click();
    await expect.poll(async () => { const current = (await service.control.read()).resources.find(resource => resource.id === codex.id)!; return current.data.sessionId !== codex.data.sessionId && !current.data.phase; }).toBe(true);
    const retried = (await service.control.read()).resources.find(resource => resource.id === codex.id)!;
    await finish(String(retried.data.cwd), JSON.stringify(sampleReview));
    await expect(page.getByRole('region', { name: 'Codex review · #42', exact: true }).getByRole('option')).toHaveCount(3);
  } finally {
    await mcp.close().catch(() => {});
    await exitWithoutShutdown(app); await service.close();
    await supervisor.call('admin.shutdown').catch(() => {}); supervisor.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});


test('review desk polish: frame title bar, compact header, readable run log, one detail scroll and full titles', async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-review-polish-')), fixture = githubFixture(), reviewer = join(directory, 'review-fixture');
  await writeFile(reviewer, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/native-review.mjs')).href)};\n`, { mode: 0o700 });
  const source: ReviewSource = { async freeze(resource) { return { connectionId: resource.connectionId, comparison: { repository: 'fixture/billing', number: 42, baseTipSha: 'b'.repeat(40), headSha: 'a'.repeat(40) }, title: fixture.pull.title, description: 'Review fixture', url: 'https://github.com/fixture/billing/pull/42' }; },
    async capture(_directory, requestId, source) { const cwd = join(directory, 'comparisons', requestId, 'repository'); await mkdir(cwd, { recursive: true }); return { ...source.comparison, baseSha: 'c'.repeat(40), changedFiles: ['file.ts'], diff: '+ review change', cwd, digest: requestId }; } };
  const runtime = { directory: join(directory, 'runtime'), executable: electronPath as unknown as string, entrypoint: resolve('dist/session-supervisor.cjs'), electronRuntime: true };
  const service = await startWorkspaceService(directory, undefined, runtime, { ...fixture, reviews: { 'github.pull-request': source }, reviewRuntime: { models: async () => ({ options: ['opus', 'gpt-6-astra'], default: 'opus' }), probe: async () => ({ executable: reviewer, version: 'scripted review fixture', structuredOutput: true }) } });
  await service.control.dispatch({ commandId: 'setup', expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [
    { type: 'project.create', id: 'project', title: 'Billing', position: { x: 0, y: 0 } },
    { type: 'item.add', id: 'pr', resourceId: 'pr-resource', pluginId: 'github.pull-request', title: fixture.pull.title, data: { owner: 'fixture', repo: 'billing', number: 42 }, projectId: 'project', position: { x: 270, y: 160 } },
  ] });
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow(); await page.emulateMedia({ reducedMotion: 'reduce' }); await resize(app, page, 1440, 900);
    await page.evaluate(requestId => window.craftingTable.runtimeRun({ action: 'pr.review.claude', nodeId: 'pr', arguments: { requestId, model: 'opus' } }), randomUUID());
    const card = page.getByRole('article', { name: 'Claude review · #42', exact: true });
    await expect(card).toBeVisible();
    const glyph = card.locator('.item-glyph');
    await expect(glyph).toHaveAttribute('data-icon', 'review'); await expect(glyph).toHaveClass(/brand-claude/);
    await expect(glyph).toHaveCSS('color', 'rgb(227, 154, 121)');
    await card.click();
    const view = page.getByRole('region', { name: 'Claude review · #42', exact: true }), desk = view.getByRole('region', { name: 'Review findings' }), heading = view.locator('.card-heading');
    await expect(heading.locator('.item-glyph[data-icon=review].brand-claude')).toBeVisible();
    await expect(heading.locator('.item-frame-slot .rd-state-run')).toHaveText('Reviewing');
    await expect(desk.locator('.rd-progress')).toBeVisible();
    await expect(desk.locator('.rd-logtail')).toContainText('Started · opus');
    await view.screenshot({ path: 'test-results/review-polish-running.png' });

    const review = (await service.control.read()).resources.find(resource => resource.pluginId === 'code.review')!;
    await finish(String(review.data.cwd), JSON.stringify(questionReview));
    await expect(desk.getByRole('option')).toHaveCount(1);
    // The frame title bar carries the PR link, run state and tabs; the desk keeps only the summary.
    await expect(heading.getByRole('tab', { name: /Findings/ })).toHaveAttribute('aria-selected', 'true');
    await expect(heading.getByRole('link', { name: 'fixture/billing #42' })).toHaveAttribute('href', 'https://github.com/fixture/billing/pull/42');
    await expect(heading.locator('.rd-state-ok')).toHaveText('Completed');
    await expect(heading.locator('.rd-state-ok')).toHaveAttribute('title', /Completed · .* · c{7} → a{7}/);
    await expect(desk.locator('.rd-titlebar, .rd-kicker')).toHaveCount(0);
    await expect(desk.locator('.rd-statusbar')).toContainText('ccccccc → aaaaaaa reviewed head');
    await expect(desk.locator('.rd-statusbar .rd-key-hint')).toHaveText('Select findings to have an agent fix them');
    const summary = desk.locator('.rd-summary'), toggle = desk.getByRole('button', { name: 'Hide review summary' });
    await expect(summary).toBeVisible(); await expect(summary.locator('b')).toHaveText('Looks correct.');
    // Full titles and notes: no mid-word clamp; the list may clamp visually.
    const detail = desk.locator('.rd-detail');
    await expect(detail.locator('.rd-d-title')).toHaveText(questionReview.findings[0].title);
    await expect(detail.locator('.rd-d-ver')).toContainText('so their values could not be checked.');
    await expect(desk.getByRole('option').locator('.rd-title')).toHaveAttribute('title', questionReview.findings[0].title);
    await view.screenshot({ path: 'test-results/review-polish-1040.png' });
    // Hovering and scrolling don't start reviewing; the first click does.
    await desk.getByRole('option').hover(); await detail.locator('.rd-d-scroll').hover(); await page.mouse.wheel(0, 200);
    await expect(summary).toBeVisible();
    await desk.getByRole('option').click();
    await expect(summary).toBeHidden(); await expect(desk.locator('.rd-head')).toHaveClass(/collapsed/);
    await expect(desk.locator('.rd-head .rd-verdict')).toHaveText('Looks correct.');
    await desk.getByRole('button', { name: 'Show review summary' }).click(); await expect(summary).toBeVisible();
    await desk.getByRole('option').click(); await expect(summary).toBeVisible();
    await toggle.click(); await expect(summary).toBeHidden();

    // History, then the detail scrolls as one container with the actions at its end.
    const ignore = desk.getByRole('button', { name: 'Ignore', exact: true }), stop = desk.getByRole('button', { name: 'Stop ignoring', exact: true });
    await ignore.click(); await expect(stop).toBeVisible();
    await stop.click(); await expect(ignore).toBeVisible(); await expect(desk.locator('.rd-history li').last()).toContainText('No longer ignored by you');
    await ignore.click(); await expect(desk.locator('.rd-history li')).toHaveCount(3);
    await expect(desk.locator('.rd-history')).not.toContainText(/fixed/i);
    const scroll = detail.locator('.rd-d-scroll');
    expect(await detail.evaluate(node => [...node.querySelectorAll('*')].filter(child => ['auto', 'scroll'].includes(getComputedStyle(child).overflowY) && child.scrollHeight > child.clientHeight).map(child => child.className))).toEqual(['rd-d-scroll']);
    for (const part of ['.rd-d-top', '.rd-d-title', '.rd-d-ver', '.rd-dl', '.rd-history', '.rd-d-actions']) await expect(scroll.locator(part)).toHaveCount(1);
    await scroll.evaluate(node => { node.scrollTop = node.scrollHeight; });
    // The send button sits in a strip reserved below the detail's scroll area, so it never covers content.
    const send = desk.locator('.rd-split'), area = await scroll.boundingBox(), button = await send.boundingBox();
    expect(area!.y + area!.height).toBeLessThanOrEqual(button!.y + 1);
    await view.screenshot({ path: 'test-results/review-polish-1040-scrolled.png' });

    // The send split button: disabled until something is selected; the chevron chooses the recipient.
    const main = desk.locator('.rd-split-main'), chevron = desk.getByRole('button', { name: 'Choose who gets the findings' });
    await expect(main).toBeDisabled(); await expect(main).toHaveAttribute('title', /Select findings to send/);
    await chevron.click();
    const menu = desk.getByRole('menu', { name: 'Send to' });
    await expect(menu.getByRole('menuitem', { name: /Run in new Claude agent/ })).toHaveAttribute('aria-disabled', 'true');
    await expect(menu).toContainText('Set a working directory on this review’s project');
    await page.keyboard.press('Escape'); await expect(menu).toBeHidden(); await expect(chevron).toBeFocused();
    await service.control.dispatch({ commandId: 'workdir', expectedRevision: (await service.control.read()).revision, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'node.update', id: 'project', workingDirectory: directory }] });
    await desk.getByRole('listbox', { name: 'Findings' }).focus(); await page.keyboard.press('Space');
    await expect(desk.locator('.rd-selcount')).toHaveText('1 of 1 selected'); await expect(desk.locator('.rd-list-head').getByRole('button', { name: 'Clear' })).toBeVisible();
    await expect(main).toBeEnabled();
    await page.keyboard.press('Enter');
    const confirm = desk.getByRole('dialog', { name: 'Send findings to an agent' });
    await expect(confirm.getByRole('radio', { name: /New Claude agent/ })).toBeVisible();
    await confirm.getByRole('radio', { name: /New Claude agent/ }).click();
    await expect(confirm.getByRole('button', { name: 'Start Claude agent and send' })).toBeEnabled();
    await confirm.getByRole('button', { name: 'Preview message' }).click(); await expect(confirm.locator('.rd-preview')).toContainText('Fix only F1');
    await view.screenshot({ path: 'test-results/review-polish-confirm.png' });
    await confirm.getByRole('button', { name: 'Cancel' }).click(); await expect(confirm).toBeHidden();
    await expect(main).toHaveText('Send to new Claude agent');
    await chevron.focus(); await page.keyboard.press('Enter');
    await expect(menu.getByRole('menuitem', { name: /Run in new Claude agent/ })).toBeFocused();
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowUp');
    await expect(menu.getByRole('menuitem', { name: /Run in new Claude agent/ })).toBeFocused();
    await view.screenshot({ path: 'test-results/review-polish-menu.png' });
    await page.keyboard.press('Enter');
    await expect(confirm.getByRole('radio', { name: /New Claude agent/ })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape'); await expect(confirm).toBeHidden();

    const handle = page.getByRole('button', { name: 'Resize view: Claude review · #42' }), grip = (await handle.boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await page.mouse.down();
    await page.mouse.move(grip.x - 700, grip.y, { steps: 10 }); await page.mouse.up();
    expect((await view.boundingBox())!.width).toBe(750);
    await expect(heading.getByRole('tab', { name: 'Run log' })).toBeVisible(); await expect(heading.locator('.rd-state-ok')).toBeVisible();
    await scroll.evaluate(node => { node.scrollTop = 0; });
    await desk.getByRole('button', { name: 'Show review summary' }).click();
    await view.screenshot({ path: 'test-results/review-polish-750.png' });
    await scroll.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await view.screenshot({ path: 'test-results/review-polish-750-scrolled.png' });
    await heading.getByRole('tab', { name: 'Run log' }).click();
    const transcript = desk.getByRole('log', { name: 'Review transcript' });
    await expect(transcript.locator('.rd-tl.done')).toContainText('Finished · 3 turns · 1 min 12 s');
    await expect(transcript.locator('.rd-tl.tool')).toContainText('Read repository/file.ts');
    await expect(transcript).not.toContainText('"type"');
    await view.screenshot({ path: 'test-results/review-polish-run-log.png' });
    await desk.getByRole('button', { name: 'Show terminal output' }).click(); await expect(transcript).toBeHidden();
    await desk.getByRole('button', { name: 'Show transcript' }).click(); await expect(transcript).toBeVisible();
    await page.getByRole('button', { name: 'Back to project' }).click();
    await card.screenshot({ path: 'test-results/review-polish-map-card.png' });
  } finally {
    await exitWithoutShutdown(app); await service.close();
    const supervisor = await connectSupervisor(runtime.directory).catch(() => undefined);
    await supervisor?.call('admin.shutdown').catch(() => {}); supervisor?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
