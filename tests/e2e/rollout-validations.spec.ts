import { test, expect, _electron as electron } from '@playwright/test';
import electronPath from 'electron';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import type { SessionSnapshot } from '../../packages/session-runtime/protocol.ts';
import type { RolloutJob } from '../../packages/provider-runtime/github-rollout.ts';
import { rolloutFixture } from '../fixtures/rollout.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { resize } from './visual-fixture.ts';
import { prActions } from './pr-actions.ts';
import { scriptedClaude } from './rollout-harness.ts';

const origin = Date.now(), at = (minutes: number) => new Date(origin + minutes * 60_000).toISOString();
const names = ['build / thumbnail-image', 'deploy / staging-a', 'e2e / staging smoke-test', 'deploy / preview-a', 'verify / preview 10 min', 'deploy / prod-a', 'deploy / prod-b', 'deploy / prod-c'];
/** Jobs of one attempt; ids differ per attempt as on GitHub. */
function jobs(attempt: number, states: Record<number, [string, string | null, number?, number?]>): RolloutJob[] {
  return names.map((name, index) => { const [status, conclusion, started, completed] = states[index] ?? ['queued', null];
    return { id: attempt * 100 + index, run_id: 101, name, status, conclusion, started_at: started === undefined ? null : at(started), completed_at: completed === undefined ? null : at(completed) }; });
}
const text = (result: any) => (result.content as { text: string }[])[0].text;
/** Elements painted in a warm hue (amber, copper, red). Agent brand marks and anything about a failed attempt are expected. */
const warmPaint = (view: import('@playwright/test').Locator) => view.evaluate(root => {
  const warm = (value: string) => [...value.matchAll(/rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/g)].some(([, r, g, b, a]) => a !== '0' && +r >= +g && +r - +b > 18 && +r > 40);
  return [...root.querySelectorAll<HTMLElement>('.rv *')].filter(node => node.getClientRects().length && !node.closest('.rv-claude,.rv-codex,.rv-avatar,[data-state=failed],[data-tone=bad],.stale,.rv-bad'))
    .filter(node => { const style = getComputedStyle(node); return [style.color, style.backgroundColor, style.borderTopColor, style.borderLeftColor, style.boxShadow].some(warm); })
    .map(node => `${node.getAttribute('class')} ${node.textContent?.trim().slice(0, 24)}`);
});

test('rollout validations: trigger, progress and final reports, Needs me, stale attempts, job filter, No report and Ask to report', async () => {
  test.setTimeout(180_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-rollout-validations-')), providers = rolloutFixture(), agentScript = join(directory, 'agent-fixture'), restoreClaude = await scriptedClaude(directory);
  await writeFile(agentScript, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/scripted-agent.mjs')).href)};\n`, { mode: 0o700 });
  providers.run = { ...providers.run, name: 'Deploy API', display_title: 'Resize thumbnails on upload', run_number: 41, head_sha: 'abc1234def56'.padEnd(40, 'b') };
  providers.jobs = jobs(1, { 0: ['completed', 'success', -110, -106], 1: ['completed', 'success', -106, -103], 2: ['completed', 'success', -103, -95], 3: ['in_progress', null, -95] });
  const runtime = { directory: join(directory, 'runtime'), executable: electronPath as unknown as string, entrypoint: resolve('dist/session-supervisor.cjs'), electronRuntime: true };
  const service = await startWorkspaceService(directory, undefined, runtime, providers);
  const agent = (id: string, title: string, provider: string, x: number) => ({ type: 'item.add' as const, id, resourceId: `${id}-r`, pluginId: 'agent.session', title, projectId: 'project', position: { x, y: 520 }, data: { provider, sessionId: `${id}-session` } });
  await service.control.dispatch({ commandId: 'setup', expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [
    { type: 'project.create', id: 'project', title: 'Platform', position: { x: 0, y: 0 } },
    { type: 'item.add', id: 'rollout', resourceId: 'rollout-r', pluginId: 'github.rollout', title: 'Rollout', projectId: 'project', position: { x: 260, y: 200 }, data: { owner: 'fixture', repo: 'web', runId: 101 } },
    agent('claude', 'Claude · validator', 'claude', 60), agent('codex', 'Codex · deploy-review', 'codex', 460),
    { type: 'link.save', link: { id: 'rollout-claude', sourceId: 'rollout', targetId: 'claude', kind: 'context', label: '' } },
    { type: 'link.save', link: { id: 'rollout-codex', sourceId: 'rollout', targetId: 'codex', kind: 'context', label: '' } },
    { type: 'node.update', id: 'claude', activity: 'idle' }, { type: 'node.update', id: 'codex', activity: 'idle' },
  ] });
  const supervisor = await connectSupervisor(runtime.directory);
  for (const id of ['claude', 'codex']) await supervisor.call('sessions.launch', { sessionId: `${id}-session`, requestId: `${id}-session`, nodeId: id, workspaceId: 'fixture', cwd: directory, executable: agentScript, args: [], cols: 200, rows: 40 });
  const output = async (id: string) => (await supervisor.call<SessionSnapshot>('sessions.read', { sessionId: `${id}-session` })).chunks.map(chunk => chunk.data).join('');
  const tick = async () => { const db = new DatabaseSync(service.store.file); db.exec('UPDATE resource_cache SET checked_at=0'); db.close(); await service.resources.poll(); };
  await tick();
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  const mcp = { claude: new Client({ name: 'claude-fixture', version: '1' }), codex: new Client({ name: 'codex-fixture', version: '1' }) };
  try {
    for (const [id, client] of Object.entries(mcp)) await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp/entry.ts')], env: { ...process.env, ACT_DATA_DIR: directory, ACT_NODE_ID: id } as Record<string, string>, stderr: 'pipe' }));
    const reportAs = async (who: 'claude' | 'codex', body: object) => { const result = await mcp[who].callTool({ name: 'workspace_report_validation', arguments: { rolloutNodeId: 'rollout', ...body } }); expect(result.isError, text(result)).not.toBe(true); return JSON.parse(text(result)); };
    const page = await app.firstWindow(); await page.emulateMedia({ reducedMotion: 'reduce' }); await resize(app, page, 1440, 900);
    const card = page.locator('[data-item-id="rollout"]'), view = page.getByRole('region', { name: 'Deploy API', exact: true }), detail = view.locator('.rollout-detail');
    const feed = detail.getByRole('list', { name: 'Rollout timeline' }), vcard = (label: string) => feed.locator(`.rv-card[aria-label^="${label} · "]`);
    const validate = async (agentTitle: string) => {
      await prActions(page, view).pick('Validate with…');
      await page.getByRole('menu', { name: 'Trigger validation', exact: true }).getByRole('menuitem', { name: agentTitle, exact: true }).click();
    };
    const idle = async () => { for (const id of ['claude', 'codex']) await page.evaluate(async id => { const { state } = await window.craftingTable.workspaceRead();
      await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'node.update', id, activity: 'idle' }] }); }, id); };

    // Attempt 1: Claude is asked from the full view, reports progress, then a failed verdict on preview.
    await card.click();
    await expect(view.locator('.rollout-state')).toHaveText('Ongoing');
    await detail.getByRole('button', { name: 'Show the jobs rail', exact: true }).click();
    await expect(detail.getByRole('list', { name: 'Rollout jobs' }).getByRole('listitem')).toHaveCount(8);
    await validate('Claude · validator');
    await expect.poll(() => output('claude'), { timeout: 15_000 }).toContain('workspace_report_validation (rolloutNodeId "rollout", validationId "V1")');
    expect(await output('claude')).not.toContain('attention.set');
    await expect(vcard('V1')).toContainText('Waiting for Claude');
    const refused = await mcp.codex.callTool({ name: 'workspace_report_validation', arguments: { rolloutNodeId: 'rollout', validationId: 'V1', sequence: 1, phase: 'progress', checks: [] } });
    expect(refused.isError).toBe(true); expect(text(refused)).toContain('requested from another agent');
    await reportAs('claude', { validationId: 'V1', sequence: 1, phase: 'progress', summary: 'Checking the preview rollout', scope: { jobs: [103] }, checks: [{ id: 'C1', title: 'Preview instances ready', status: 'running' }, { id: 'C2', title: 'Error rate', status: 'pending' }] });
    await expect(vcard('V1')).toContainText('Checking the preview rollout');
    await expect(vcard('V1').locator('.rv-check')).toHaveCount(2);
    providers.jobs = jobs(1, { 0: ['completed', 'success', -110, -106], 1: ['completed', 'success', -106, -103], 2: ['completed', 'success', -103, -95], 3: ['completed', 'failure', -95, -88] });
    providers.run = { ...providers.run, status: 'completed', conclusion: 'failure' }; await tick();
    await reportAs('claude', { validationId: 'V1', sequence: 2, phase: 'final', verdict: 'failed', summary: 'Preview never became ready: the image pull timed out', checks: [
      { id: 'C1', title: 'Preview instances ready', status: 'failed', target: 'preview-a', observation: '0/3 ready after 10 min; the image pull failed 3 times.', evidence: [{ label: 'GitHub job', url: 'https://github.com/fixture/web/actions/runs/101/job/103', kind: 'job' }] },
      { id: 'C2', title: 'Error rate', status: 'skipped', observation: 'No traffic reached preview.' }], recommendations: [{ text: 'Re-run once the image is published.', blocking: true }] });
    await expect(vcard('V1')).toHaveAttribute('data-v', 'failed');
    await expect(page.getByRole('button', { name: 'Needs me: 1', exact: true })).toBeVisible();
    await expect.poll(async () => (await service.control.read()).nodes.find(node => node.id === 'rollout')?.attentionSources?.['validation:claude']).toBe('error');

    // Attempt 2: a re-run makes V1 stale and withdraws its Needs me entry without marking it seen (S3).
    providers.run = { ...providers.run, run_attempt: 2, status: 'in_progress', conclusion: null };
    providers.jobs = jobs(2, { 0: ['in_progress', null, -16] }); await tick();
    await view.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(view.locator('.view-meta')).toContainText('attempt 2');
    await expect.poll(async () => (await service.control.read()).nodes.find(node => node.id === 'rollout')?.attentionSources?.['validation:claude']).toBeUndefined();
    await expect(detail.locator('.rv-system')).toContainText('V1 (Claude, failed) was about an earlier attempt');
    await expect(detail.locator('.rv-divider')).toContainText('Attempt 1 · failed at preview · superseded');
    await expect(detail.getByRole('tab', { name: '#1 failed' })).toBeVisible();
    await expect(detail.locator('.rv-verdict')).toContainText("Claude's failed validation was about attempt 1 and no longer counts.");
    await view.screenshot({ path: '.local/rollout-validations/s3-superseded.png' });
    await detail.getByRole('button', { name: 'Show', exact: true }).click();
    await expect(vcard('V1')).toHaveClass(/stale/);
    await expect(vcard('V1').locator('.rv-card-meta')).toContainText('about attempt 1');

    // S1: two jobs running while Codex validates staging, triggered from the full view.
    providers.jobs = jobs(2, { 0: ['completed', 'success', -16, -12], 1: ['completed', 'success', -12, -9], 2: ['in_progress', null, -6], 3: ['in_progress', null, -4] }); await tick();
    await view.getByRole('button', { name: 'Refresh', exact: true }).click();
    await idle(); await validate('Codex · deploy-review');
    await expect.poll(() => output('codex'), { timeout: 15_000 }).toContain('validationId "V2"');
    const long = 'Thumbnails shrink as intended. Resized images are uploaded once per attempt instead of per retry, so the storage per run falls from 3.8 MB to 1.1 MB across all image formats on staging, with no change in what the gallery page can show.';
    await reportAs('codex', { validationId: 'V2', sequence: 1, phase: 'progress', summary: 'Checking staging against PR #16', scope: { jobs: [201, 202] }, checks: [
      { id: 'C1', title: 'Upload failure rate', status: 'passed', target: 'staging-a', metrics: [{ label: 'failure rate', before: 0.9, after: 0.8, unit: '%', better: 'lower' }] },
      { id: 'C2', title: 'Thumbnail size per run', status: 'passed', observation: long, metrics: [{ label: 'size', before: 3.8, after: 1.1, unit: 'MB', better: 'lower' }] },
      { id: 'C3', title: 'Staging e2e suite (smoke-test)', status: 'running', observation: 'Waiting for the e2e job.', jobIds: [202] },
      { id: 'C4', title: 'Gallery reads old and new image formats', status: 'pending' }] });
    await expect(vcard('V2')).toHaveAttribute('data-v', 'running');
    await expect(detail.locator('.rv-job', { hasText: 'e2e / staging smoke-test' }).locator('.rv-stamp')).toHaveAttribute('data-v', 'running');
    await expect(detail.locator('.rv-verdict')).toContainText('Codex is validating staging · 2 of 4 checks.');
    await expect(detail.locator('.rv-rail-summary')).toHaveText('2 running · 2 done · 4 queued');

    // A check row is a disclosure: one truncated line until opened, the full wrapped text after, kept across re-renders.
    const sizeRow = vcard('V2').locator('.rv-check', { hasText: 'Thumbnail size per run' }), sizeToggle = sizeRow.getByRole('button', { name: /Thumbnail size per run/ });
    await expect(sizeToggle).toHaveAttribute('aria-expanded', 'false');
    expect(await sizeToggle.locator('.rv-check-main').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    const collapsedHeight = (await sizeRow.boundingBox())!.height;
    await sizeToggle.click();
    await expect(sizeToggle).toHaveAttribute('aria-expanded', 'true');
    const sizeDetail = sizeRow.locator('.rv-check-detail');
    await expect(sizeDetail.locator('.rv-observation')).toHaveText(long);
    await expect(sizeDetail).toHaveAttribute('id', (await sizeToggle.getAttribute('aria-controls'))!);
    expect((await sizeRow.boundingBox())!.height).toBeGreaterThan(collapsedHeight * 2);
    expect(await sizeDetail.locator('.rv-observation').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await view.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(view.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
    await expect(sizeToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(sizeDetail.locator('.rv-observation')).toHaveText(long);
    await vcard('V2').screenshot({ path: '.local/rollout-validations/check-open.png' });
    await sizeToggle.focus(); await page.keyboard.press('Enter');
    await expect(sizeToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(sizeToggle).toBeFocused();
    await expect(sizeDetail).toHaveCount(0);
    await page.keyboard.press('Space');
    await expect(sizeToggle).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Enter');
    await expect(sizeToggle).toHaveAttribute('aria-expanded', 'false');
    // Nothing is wrong here: jobs run and an agent validates, so no amber, copper or red.
    expect(await warmPaint(view)).toEqual([]);
    await view.screenshot({ path: '.local/rollout-validations/s1-running.png' });
    await page.getByRole('button', { name: 'Back to project', exact: true }).click();
    await expect(card.locator('[data-indicator="rollout-jobs"]')).toHaveAttribute('aria-label', '2 running');
    await expect(card.locator('[data-indicator="rollout-validating"]')).toHaveAttribute('aria-label', /^Validating · Codex · \d\/\d · just now · /);
    await card.screenshot({ path: '.local/rollout-validations/card-running.png' });

    // S2: waiting at the production gate; Codex passed staging, Claude has concerns about preview, Codex re-checks.
    await reportAs('codex', { validationId: 'V2', sequence: 2, phase: 'final', verdict: 'passed', summary: 'Staging matches PR #16', checks: [{ id: 'C1', title: 'Upload failure rate', status: 'passed' }, { id: 'C2', title: 'Thumbnail size per run', status: 'passed' }, { id: 'C3', title: 'Staging e2e suite (smoke-test)', status: 'passed' }, { id: 'C4', title: 'Gallery reads old and new image formats', status: 'passed' }] });
    providers.jobs = jobs(2, { 0: ['completed', 'success', -16, -12], 1: ['completed', 'success', -12, -9], 2: ['completed', 'success', -6, -1], 3: ['completed', 'success', -4, -0.5], 4: ['completed', 'success', -0.5, -0.2], 5: ['waiting', null], 6: ['waiting', null], 7: ['waiting', null] });
    providers.run = { ...providers.run, status: 'waiting' }; providers.gates = [{ environment: { id: 7, name: 'production' }, wait_timer: 0, current_user_can_approve: true, reviewers: [{ type: 'Team' }] }]; await tick();
    await card.click(); await idle(); await validate('Claude · validator');
    await expect.poll(() => output('claude'), { timeout: 15_000 }).toContain('validationId "V3"');
    await reportAs('claude', { validationId: 'V3', sequence: 1, phase: 'final', verdict: 'concerns', summary: 'Preview healthy on errors and memory, but uploads got 40% slower', scope: { jobs: [203, 204] }, checks: [
      { id: 'C1', title: 'Upload duration, p95', status: 'concern', target: 'preview-a', observation: 'Slower since preview took traffic. Only large uploads are affected.', metrics: [{ label: 'p95', before: 2.1, after: 2.9, unit: 's', better: 'lower' }], evidence: [{ label: 'Dashboard · uploads', url: 'https://metrics.example.com/d/upload', kind: 'dashboard' }] },
      { id: 'C2', title: 'Upload timeout errors', status: 'concern', target: 'preview-a', metrics: [{ label: 'errors', before: 4, after: 17, better: 'lower' }], evidence: [{ label: 'Logs · upload errors', url: 'https://logs.example.com/q', kind: 'logs' }] },
      { id: 'C3', title: 'Upload failure rate', status: 'passed', metrics: [{ label: 'failure rate', before: 0.44, after: 0.41, unit: '%', better: 'lower' }] },
      { id: 'C4', title: 'Preview instances ready, no restarts', status: 'passed' }],
      recommendations: [{ text: 'Hold the production gate until upload p95 is back under 2.3 s.', blocking: true }] });
    await idle(); await validate('Codex · deploy-review');
    await expect.poll(() => output('codex'), { timeout: 15_000 }).toContain('validationId "V4"');
    await reportAs('codex', { validationId: 'V4', sequence: 1, phase: 'progress', summary: 'Checking the settle window before the production gate', checks: [{ id: 'C1', title: 'Storage write latency', status: 'concern' }, { id: 'C2', title: 'Error budget', status: 'passed' }, { id: 'C3', title: 'Memory', status: 'passed' }, { id: 'C4', title: 'Upload p95', status: 'running' }, { id: 'C5', title: 'Thumbnail backlog', status: 'pending' }, { id: 'C6', title: 'Logs', status: 'pending' }] });
    await expect(vcard('V4')).toHaveAttribute('data-v', 'running');
    await expect(vcard('V3')).toHaveAttribute('data-v', 'concerns');
    await expect(vcard('V3').locator('.rv-recs li.block')).toContainText('Hold the production gate');
    await expect(detail.locator('.rv-verdict')).toContainText('Current verdict: concerns from Claude on the preview');
    await expect(detail.locator('.rv-gate')).toContainText('production · approval gate');
    await expect(page.getByRole('button', { name: 'Needs me: 1', exact: true })).toBeVisible();
    await expect.poll(async () => (await service.control.read()).nodes.find(node => node.id === 'rollout')?.attentionSources?.['validation:claude']).toBe('validation');
    await view.screenshot({ path: '.local/rollout-validations/s2-concerns.png' });

    // S2′: clicking the preview job filters the timeline across both attempts; Escape clears it.
    await detail.getByRole('button', { name: /^deploy \/ preview-a: done/ }).click();
    await expect(detail.locator('.rv-job-chip')).toContainText('deploy / preview-a');
    await expect(detail.locator('.rv-filters')).toContainText('both attempts');
    await expect(feed.locator('.rv-card')).toHaveCount(2);
    await expect(feed.locator('.rv-event', { hasText: 'failed' })).toHaveCount(1);
    await view.screenshot({ path: '.local/rollout-validations/s2f-filtered.png' });
    await page.keyboard.press('Escape');
    await expect(detail.locator('.rv-job-chip')).toHaveCount(0);
    await expect(view).toBeVisible();
    await page.getByRole('button', { name: 'Back to project', exact: true }).click();
    await expect(card.locator('[data-indicator="rollout-verdict"]')).toHaveAttribute('aria-label', 'Concerns · Claude');
    await expect(card.locator('[data-indicator="rollout-verdict"]')).toHaveCSS('color', 'rgb(232, 189, 114)');
    await card.screenshot({ path: '.local/rollout-validations/card-concerns.png' });
    await page.getByRole('button', { name: 'Needs me: 1', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Needs me', exact: true })).toContainText('Production needs approval · Validation found concerns');
    await page.getByRole('button', { name: 'Close needs me', exact: true }).click();

    // S4: approve from the gate row, Codex's pass on the whole run resolves the concern, the run passes.
    await card.click();
    // A scroll behind an open menu closes it, so bring the gate row into view first.
    const approve = detail.locator('.rv-gate').getByRole('button', { name: 'Approve ▾' });
    await approve.scrollIntoViewIfNeeded(); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await approve.click();
    await page.getByRole('menu', { name: 'Approve deployment', exact: true }).getByRole('menuitem', { name: 'Confirm', exact: true }).click();
    await page.getByRole('menu', { name: 'Approve deployment', exact: true }).getByRole('menuitem', { name: 'Confirm approval', exact: true }).click();
    await expect(view.locator('.rollout-state')).toHaveText('Ongoing', { timeout: 20_000 });
    expect(providers.approvals).toHaveLength(1);
    await reportAs('codex', { validationId: 'V4', sequence: 2, phase: 'final', verdict: 'passed', summary: 'Uploads settled at 2.2 s p95 after the settle window: preview safe to promote', checks: [{ id: 'C1', title: 'Storage write latency', status: 'passed' }, { id: 'C2', title: 'Error budget', status: 'passed' }] });
    await expect.poll(async () => (await service.control.read()).nodes.find(node => node.id === 'rollout')?.attentionSources?.['validation:claude']).toBeUndefined();
    await expect(vcard('V3')).toContainText('Resolved by V4');
    const finished = Date.now() - origin;
    providers.jobs = jobs(2, { 0: ['completed', 'success', -16, -12], 1: ['completed', 'success', -12, -9], 2: ['completed', 'success', -6, -1], 3: ['completed', 'success', -4, -0.5], 4: ['completed', 'success', -0.5, -0.2],
      5: ['completed', 'success', finished / 60_000 - 0.2, finished / 60_000 - 0.1], 6: ['completed', 'success', finished / 60_000 - 0.2, finished / 60_000 - 0.05], 7: ['completed', 'success', finished / 60_000 - 0.2, finished / 60_000 - 0.02] });
    providers.run = { ...providers.run, status: 'completed', conclusion: 'success' }; providers.gates = []; await tick();
    await view.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(view.locator('.rollout-state')).toHaveText('Passed');
    await expect(feed.locator('.rv-event', { hasText: 'approved by you in the app' })).toHaveCount(1);
    await expect(feed.locator('.rv-event', { hasText: 'Run passed' })).toHaveCount(1);
    await expect(detail.locator('.rv-verdict')).toContainText('Current verdict: passed from Codex');
    await view.screenshot({ path: '.local/rollout-validations/s4-finished.png' });

    // No report: an idle agent without a final report; Ask to report prompts it again.
    await idle(); await validate('Claude · validator');
    await expect.poll(() => output('claude'), { timeout: 15_000 }).toContain('validationId "V5"');
    await expect.poll(() => { const db = new DatabaseSync(service.store.file); const row = db.prepare('SELECT idle_since FROM rollout_validations WHERE ordinal = 5').get(); db.close(); return row?.idle_since; }, { timeout: 15_000 }).not.toBeNull();
    { const db = new DatabaseSync(service.store.file); db.exec('UPDATE rollout_validations SET idle_since = 1 WHERE ordinal = 5'); db.close(); }
    await expect(vcard('V5')).toHaveAttribute('data-v', 'no-report', { timeout: 15_000 });
    await expect(vcard('V5')).toContainText('No report');
    await view.screenshot({ path: '.local/rollout-validations/no-report.png' });
    await vcard('V5').getByRole('button', { name: 'Ask to report', exact: true }).click();
    await expect.poll(() => output('claude'), { timeout: 15_000 }).toContain('have not reported a result on the table yet');
    await expect(vcard('V5')).toHaveAttribute('data-v', 'requested');
    await reportAs('claude', { validationId: 'V5', sequence: 1, phase: 'final', verdict: 'passed', summary: 'Production healthy everywhere', checks: [{ id: 'C1', title: 'Error rate', status: 'passed' }] });
    await expect(vcard('V5')).toHaveAttribute('data-v', 'passed');
    expect(Object.keys((await service.control.read()).nodes.find(node => node.id === 'rollout')?.attentionSources ?? {}).filter(source => source.startsWith('validation:'))).toEqual([]);
  } finally {
    for (const client of Object.values(mcp)) await client.close().catch(() => {});
    await exitWithoutShutdown(app); await service.close(); restoreClaude();
    await supervisor.call('admin.shutdown').catch(() => {}); supervisor.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
