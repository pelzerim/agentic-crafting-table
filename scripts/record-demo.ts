// Records the README demo as one story: an agent at work, two pull requests joining its project, reviews triggered
// from the map menu, findings sent to the agent, a merge, the rollout it discovers with a passing validation, the
// finished work sent to the Undermap, then the zoom out and the logo. Assembled into docs/media/demo.gif with
// ImageMagick. The workspace service runs in this process on the e2e fixtures (GitHub, rollouts, the scripted
// reviewer) and the agent is tests/fixtures/demo-agent.mjs, so no model runs and nothing leaves the machine.
// Usage: npm run build && node scripts/record-demo.ts [--keep-frames]
import { _electron as electron } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import electronPath from 'electron';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SqliteStore } from '../packages/workspace-service/sqlite-store.ts';
import { startWorkspaceService } from '../packages/workspace-service/server.ts';
import { agentProviders } from '../packages/workspace-service/agent-providers.ts';
import type { AgentProvider } from '../packages/workspace-service/agent-providers.ts';
import type { ReviewSource } from '../packages/workspace-service/reviews.ts';
import { stateSchema } from '../packages/core/control.ts';
import type { WorkspaceCommand } from '../packages/core/control.ts';
import { githubFixture, pullFixture } from '../tests/fixtures/github.ts';
import { rolloutFixture } from '../tests/fixtures/rollout.ts';

import { sampleReview } from '../tests/fixtures/review-findings.ts';
import type { ReviewFindings } from '../src/pull-requests/review-findings.ts';
import { cue } from '../tests/fixtures/photo-library-project.ts';
import { openProjectPicker } from '../tests/e2e/project-picker.ts';
import { githubRolloutConnector } from '../src/resource-plugins/items/github-rollout/connector.ts';
import { rolloutPresentation } from '../src/resource-plugins/items/github-rollout/service.ts';
import type { ResourcePluginRegistry } from '../src/resource-plugins/registry.ts';

/** Every beat in the timeline below is written at pace 1 and held PACE times as long, so the map stays readable. */
const PACE = 2, FPS = 10, TOUR_BEAT = 21_000, MENU_HOLD = 900, LOGO_SECONDS = 4, OUTPUT = resolve('docs/media/demo.gif');
const keepFrames = process.argv.includes('--keep-frames');
const WIDTH = 1280, HEIGHT = 800, FOCUS = { x: 180, y: 20 }, ZOOM = .8, POINTER = { x: WIDTH / 2, y: HEIGHT / 2 - 90 };
const AGENT_SLOT = { x: 0, y: -160 }, AGENT_TITLE = 'Claude · implementation', PR_SLOTS = { 42: { x: 330, y: -160 }, 43: { x: 330, y: 60 } };
const SHA = 'c'.repeat(40);

// Neighbour projects, seeded straight into the store: no connection, so their cards keep the cues they were given.
type Item = { id: string; title: string; pluginId: string; x: number; y: number; data?: Record<string, unknown>; extra?: Record<string, unknown> };
const nodes: Record<string, unknown>[] = [], resources: Record<string, unknown>[] = [], links: Record<string, unknown>[] = [];
const project = (id: string, title: string, color: string, x: number, y: number, items: Item[]) => {
  nodes.push({ id, title, color, position: { x, y }, workingDirectory: '/tmp' });
  for (const item of items) {
    nodes.push({ id: item.id, resourceId: `${item.id}-r`, projectId: id, title: item.title, position: { x: x + item.x, y: y + item.y }, ...item.extra });
    resources.push({ id: `${item.id}-r`, pluginId: item.pluginId, schemaVersion: 1, title: item.title, data: item.data ?? {} });
  }
};
const pr = (number: number, label: string, tone: 'green' | 'amber' | 'red', icon: string, stage: 'ready' | 'failing' | 'done') => ({ pluginId: 'github.pull-request', data: { owner: 'example', repo: 'billing', number }, extra: { indicators: cue(label, tone, icon, stage) } });
const agent = (session: string, summary: string) => ({ pluginId: 'agent.session', data: { sessionId: session, provider: 'claude' }, extra: { summary, activity: 'working', acceptsContext: true } });
project('billing', 'Billing redesign', '#91b78b', 0, 0, [
  { id: 'ticket', title: 'BIL-128 · Plan changes', pluginId: 'linear.ticket', x: -340, y: -160, data: { issueId: 'BIL-128', workspaceKey: 'acme' }, extra: { indicators: cue('In progress', 'blue', 'clock') } },
  { id: 'brief', title: 'Billing experience', pluginId: 'notion.page', x: -340, y: 60, data: { pageId: '11111111111111111111111111111111' } },
  { id: 'notes', title: 'Proration rules', pluginId: 'workspace.note', x: 0, y: 60, data: { text: 'Charge the difference on upgrade; credit on downgrade.' } },
]);
links.push({ id: 'ticket-brief', sourceId: 'brief', targetId: 'ticket', kind: 'reference' });
project('payments', 'Payments API', '#5b7fd6', 1150, -300, [
  { id: 'pay-agent', title: 'Claude · retries', x: -160, y: 0, ...agent('demo-pay', 'Adding idempotency keys') },
  { id: 'pay-pr', title: 'Idempotent retries', x: 180, y: 0, ...pr(51, 'Checks running', 'amber', 'clock', 'ready') },
  { id: 'pay-pr2', title: 'Webhook signatures', x: 180, y: 180, ...pr(52, 'Approved', 'green', 'check', 'ready') },
]);
project('checkout', 'Checkout web', '#e3c55a', 950, 650, [
  { id: 'co-pr', title: 'Address autocomplete', x: -160, y: 0, ...pr(61, 'Checks failing', 'red', 'x', 'failing') },
  { id: 'co-ticket', title: 'WEB-77 · Express pay', pluginId: 'linear.ticket', x: 180, y: 0, data: { issueId: 'WEB-77', workspaceKey: 'acme' } },
]);
project('infra', 'Build infra', '#d0564c', -1050, 450, [
  { id: 'infra-roll', title: 'Nightly images', pluginId: 'github.rollout', x: -160, y: 0, data: { owner: 'example', repo: 'infra', runId: 7 }, extra: { indicators: cue('Awaiting approval', 'amber', 'clock') } },
  { id: 'infra-pr', title: 'Cache the toolchain', x: 180, y: 0, ...pr(71, 'Merged', 'green', 'check', 'done') },
]);
project('mobile', 'Mobile app', '#6fd6cf', 2400, 500, [
  { id: 'mob-agent', title: 'Codex · onboarding', pluginId: 'agent.session', x: -160, y: 0, data: { sessionId: 'demo-mobile', provider: 'codex' }, extra: { summary: 'Shortening the sign-up flow', activity: 'working' } },
  { id: 'mob-pr', title: 'Sign-up in two steps', x: 180, y: 0, ...pr(81, 'Draft', 'amber', 'clock', 'ready') },
]);
project('data', 'Data pipeline', '#b8945f', 300, 1500, [
  { id: 'data-pr', title: 'Backfill invoices', x: -160, y: 0, ...pr(91, 'Approved', 'green', 'check', 'ready') },
  { id: 'data-note', title: 'Schema notes', pluginId: 'workspace.note', x: 180, y: 0, data: { text: 'Invoices keep their original currency.' } },
]);
project('docs', 'Docs site', '#a884d8', -850, -650, [
  { id: 'docs-pr', title: 'Pricing page copy', x: -160, y: 0, ...pr(101, 'Review requested', 'amber', 'alert-triangle', 'ready') },
  { id: 'docs-agent', title: 'Claude · docs', x: 180, y: 0, ...agent('demo-docs', 'Rewriting the plans page') },
]);
project('search', 'Search', '#63a99c', 2300, -950, [
  { id: 'search-pr', title: 'Typo tolerance', x: -160, y: 0, ...pr(111, 'Checks failing', 'red', 'x', 'failing') },
  { id: 'search-ticket', title: 'SRCH-9 · Synonyms', pluginId: 'linear.ticket', x: 180, y: 0, data: { issueId: 'SRCH-9', workspaceKey: 'acme' } },
]);

const directory = await mkdtemp(join(tmpdir(), 'craft-demo-'));
const store = new SqliteStore(join(directory, 'workspace.sqlite'));
try {
  await store.update(state => stateSchema.parse({ ...state, nodes, resources, links }));
  await store.writeView('desktop', { camera: { x: WIDTH / 2 - FOCUS.x * ZOOM, y: HEIGHT / 2 - FOCUS.y * ZOOM, zoom: ZOOM } });
  const settings = store.readSettings();
  store.writeSettings({ expectedRevision: settings.revision, value: { ...settings.value, mapDashboards: { ...settings.value.mapDashboards, belowZoom: .5, sections: { ...settings.value.mapDashboards.sections, pipelines: true } } } });
  store.saveReminders([]);
} finally { store.close(); }

// The agent: the demo script stands in for the Claude CLI. The reviewer: the scripted reviewer of the review specs.
const claudeScript = join(directory, 'claude'), reviewer = join(directory, 'reviewer');
await writeFile(claudeScript, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/demo-agent.mjs')).href)};\n`, { mode: 0o700 });
await writeFile(reviewer, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/native-review.mjs')).href)};\n`, { mode: 0o700 });
const providers = agentProviders as Record<string, AgentProvider>, realClaude = providers.claude;
providers.claude = { ...realClaude, probe: async () => ({ executable: claudeScript, version: '2.1.281 (demo)', remoteControl: true, autoMode: true }) };

const other = { ...structuredClone(pullFixture), id: 125, number: 43, title: 'Refund flow', head: { ...pullFixture.head, sha: 'd'.repeat(40) } };
const github = githubFixture([other]), rollouts = rolloutFixture();
github.pull = { ...github.pull, title: 'Plan switcher' };
rollouts.run = { ...rollouts.run, name: 'Deploy billing', display_title: 'Plan switcher', repository: { full_name: 'fixture/billing' } };
const pulls = () => [github.pull, other];
const reviews: ReviewSource = {
  async freeze(resource) {
    const pull = pulls().find(pull => pull.number === resource.data.number)!;
    return { connectionId: resource.connectionId, comparison: { repository: 'fixture/billing', number: pull.number, baseTipSha: pull.base.sha, headSha: pull.head.sha }, title: pull.title, description: 'Demo', url: `https://github.com/fixture/billing/pull/${pull.number}` };
  },
  async capture(_directory, requestId, source) {
    const cwd = join(directory, 'comparisons', requestId, 'repository'); await mkdir(cwd, { recursive: true });
    return { ...source.comparison, baseSha: SHA, changedFiles: ['file.ts'], diff: '+ review change', cwd, digest: requestId };
  },
};
const runtime = { directory: join(directory, 'runtime'), executable: electronPath as unknown as string, entrypoint: resolve('dist/session-supervisor.cjs'), electronRuntime: true };
const service = await startWorkspaceService(directory, undefined, runtime, { ...github, reviews: { 'github.pull-request': reviews },
  reviewRuntime: { models: async () => ({ options: ['opus'], default: 'opus' }), probe: async () => ({ executable: reviewer, version: 'scripted review fixture', structuredOutput: true }) },
  host(registry: ResourcePluginRegistry) { const host = github.host(registry); host.register('github.rollout', githubRolloutConnector(() => rollouts.client)); host.present('github.rollout', rolloutPresentation); return host; } });
const dispatch = async (commands: WorkspaceCommand[]) => { const state = await service.control.read(); await service.control.dispatch({ commandId: randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'demo' }, commands }); };
const tick = async () => { const db = new DatabaseSync(service.store.file); db.exec('UPDATE resource_cache SET checked_at=0'); db.close(); await service.resources.poll(); };
/** Every review the scripted reviewer is waiting on gets the sample findings, once `expected` reviews have been captured. */
const cleanReview: ReviewFindings = { schemaVersion: 1, summary: 'No issues. The plan switcher keeps proration intact.', findings: [], checked: ['Proration on upgrade and downgrade', 'Plan switch idempotency'], tests: { ran: true, notes: 'Billing suite green.' } };
/** Finishes every captured review that has no result yet with `result`; called once per pull request, so each call finishes one review. */
const finishReviews = async (expected: number, result: ReviewFindings) => {
  const root = join(directory, 'comparisons');
  for (let attempt = 0; attempt < 100; attempt++) {
    const requests = existsSync(root) ? await readdir(root) : [];
    if (requests.length >= expected) {
      for (const requestId of requests) {
        const cwd = join(root, requestId); if (!existsSync(join(cwd, 'repository')) || existsSync(join(cwd, 'finish'))) continue;
        const file = join(cwd, `finish-${randomUUID()}`); await writeFile(file, JSON.stringify(result)); await rename(file, join(cwd, 'finish'));
      }
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Only ${existsSync(root) ? (await readdir(root)).length : 0} of ${expected} reviews were captured`);
};
const nodeByTitle = async (title: string) => (await service.control.read()).nodes.find(node => node.title === title);
const nodeOf = async (pluginId: string) => { const state = await service.control.read(); return state.nodes.find(node => node.projectId === 'billing' && state.resources.find(resource => resource.id === node.resourceId)?.pluginId === pluginId); };

const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1', '--disable-lcd-text', '--force-color-profile=srgb', '-AppleShowScrollBars', 'WhenScrolling'], env: { ...process.env, ACT_TEST_DATA_DIR: directory, CLAUDE_CONFIG_DIR: join(directory, 'claude-history'), TZ: 'UTC' } });
const frames: { at: number; png: Buffer }[] = [];
const zoomOf = (page: Page) => page.locator('.map-area').getAttribute('data-zoom').then(Number);
let mcp: Client | undefined;
/** The tour's length in ms: its beats plus the time spent resting on menu entries. */
let tourMs = TOUR_BEAT * PACE;
try {
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width: WIDTH, height: HEIGHT });
  await page.route(/^https?:\/\//, route => route.abort());
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByText('Desktop connected').waitFor();
  await page.getByRole('article', { name: 'BIL-128 · Plan changes', exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  // Start the agent the way a person would, then place it in its slot and connect it to the ticket and the brief.
  await openProjectPicker(page, 'Billing redesign');
  await page.getByRole('button', { name: 'Agent session', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill(AGENT_TITLE);
  await page.getByRole('button', { name: 'Start Claude', exact: true }).click();
  let agentNode; for (let attempt = 0; attempt < 50 && !agentNode; attempt++) { agentNode = await nodeByTitle(AGENT_TITLE); if (!agentNode) await page.waitForTimeout(100); }
  if (!agentNode) throw new Error('The agent item did not appear');
  const agentId = agentNode.id;
  await dispatch([
    { type: 'nodes.move', positions: [{ id: agentId, position: AGENT_SLOT }] },
    { type: 'link.save', link: { id: 'ticket-agent', sourceId: 'ticket', targetId: agentId, kind: 'context', label: '' } },
    { type: 'link.save', link: { id: 'brief-agent', sourceId: 'brief', targetId: agentId, kind: 'reference', label: '' } },
  ]);
  // The MCP client that reports the validation as the agent; connected now so the report is instant later.
  mcp = new Client({ name: 'demo-agent', version: '1' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp/entry.ts')], env: { ...process.env, ACT_DATA_DIR: directory, ACT_NODE_ID: agentId } as Record<string, string>, stderr: 'pipe' }));
  await page.getByRole('article', { name: AGENT_TITLE, exact: true }).click();
  await page.locator('.native-terminal[data-session-state="running"]').waitFor({ timeout: 20_000 });
  // Screenshots carry no pointer, so the page draws one that follows the mouse events Playwright sends.
  await page.evaluate(() => {
    const cursor = document.createElement('div'), at = { x: -40, y: -40 }, draw = (scale = 1) => { cursor.style.transform = `translate(${at.x - 3}px, ${at.y - 2}px) scale(${scale})`; };
    cursor.innerHTML = `<svg width="24" height="28" viewBox="0 0 24 28"><path d="M3 2 L3 22 L8.5 17 L12 25 L15.5 23.5 L12 16 L19 16 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
    Object.assign(cursor.style, { position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none', transformOrigin: '3px 2px', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.6))' });
    document.body.append(cursor); draw();
    window.addEventListener('mousemove', event => { at.x = event.clientX; at.y = event.clientY; draw(); }, true);
    window.addEventListener('mousedown', () => draw(.8), true);
    window.addEventListener('mouseup', () => draw(), true);
  });
  const pointer = { x: 0, y: 0 };
  const moveTo = async (x: number, y: number) => { await page.mouse.move(x, y, { steps: 16 }); pointer.x = x; pointer.y = y; };
  const centre = async (target: Locator) => { const box = await target.boundingBox(); if (!box) throw new Error(`No box for ${target}`); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; };
  const clickOn = async (target: Locator, options: { button?: 'left' | 'right' } = {}) => { const { x, y } = await centre(target); await moveTo(x, y); await page.waitForTimeout(120); await page.mouse.click(x, y, options); };
  const hoverOn = async (target: Locator) => { const { x, y } = await centre(target); await moveTo(x, y); };
  // Into a submenu `pick` goes across along the parent's row first, then down, so no other row is hovered on the way.
  const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => { await moveTo(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 14 }); pointer.x = to.x; pointer.y = to.y; await page.mouse.up(); };
  await moveTo(POINTER.x, POINTER.y);
  await page.waitForTimeout(300);

  let recording = true; const started = Date.now();
  const capture = (async () => { while (recording) { try { frames.push({ at: Date.now() - started, png: await page.screenshot({ type: 'png', caret: 'hide' }) }); } catch { if (recording) throw new Error('Capture stopped'); } } })().catch(() => {});
  // Time spent resting on a menu entry before it is clicked; every later beat moves back by it.
  let held = 0;
  const until = async (beat: number) => { const ms = beat * PACE + held, left = started + ms - Date.now(); console.log(`${String(Date.now() - started).padStart(6)} ms  until ${ms}${left < 0 ? `  LATE by ${-left} ms` : ''}`); if (left > 0) await page.waitForTimeout(left); };
  // A menu entry is shown under the pointer for a moment before it is clicked, so the video says what was picked.
  const pick = async (target: Locator, path: 'submenu' | 'direct' = 'submenu') => {
    const { x, y } = await centre(target);
    if (path === 'submenu') await moveTo(x, pointer.y);
    await moveTo(x, y); await page.waitForTimeout(MENU_HOLD); held += MENU_HOLD; await page.mouse.click(x, y);
  };
  const zoomOutTo = async (zoom: number) => { while (await zoomOf(page) > zoom) { await page.mouse.wheel(0, 20); await page.waitForTimeout(20); } };
  const card = (title: string) => page.getByRole('article', { name: title, exact: true });
  const rightClick = (title: string) => clickOn(card(title), { button: 'right' });
  const back = async () => { await clickOn(page.getByRole('button', { name: 'Back to project', exact: true })); await moveTo(POINTER.x, POINTER.y); };
  const shiftClick = async (id: string) => { await page.keyboard.down('Shift'); await clickOn(page.locator(`.react-flow__node[data-id="${id}"]`)); await page.keyboard.up('Shift'); };

  // 1. The agent at work.
  await until(2200);
  await back();
  // 2. Two pull requests join the project, connected to the agent.
  await until(2700);
  await dispatch([
    { type: 'item.add', id: 'pr-42', resourceId: 'pr-42-r', pluginId: 'github.pull-request', connectionId: 'github-fixture', title: 'Plan switcher', projectId: 'billing', position: PR_SLOTS[42], data: { owner: 'fixture', repo: 'billing', number: 42 } },
    { type: 'link.save', link: { id: 'pr-42-agent', sourceId: 'pr-42', targetId: agentId, kind: 'context', label: '' } },
  ]);
  await service.resources.read('pr-42', true);
  await until(3300);
  await dispatch([
    { type: 'item.add', id: 'pr-43', resourceId: 'pr-43-r', pluginId: 'github.pull-request', connectionId: 'github-fixture', title: 'Refund flow', projectId: 'billing', position: PR_SLOTS[43], data: { owner: 'fixture', repo: 'billing', number: 43 } },
    { type: 'link.save', link: { id: 'pr-43-agent', sourceId: 'pr-43', targetId: agentId, kind: 'context', label: '' } },
  ]);
  await service.resources.read('pr-43', true);
  // 3. Reviews from the map menu, one per pull request; each lands beside its pull request by the service's own rule, so nothing is moved afterwards.
  await until(4000);
  for (const [title, at, count, result] of [['Plan switcher', 4000, 1, cleanReview], ['Refund flow', 5400, 2, sampleReview]] as const) {
    await until(at);
    await rightClick(title);
    await hoverOn(page.getByRole('menuitem', { name: 'Trigger review', exact: true }));
    await until(at + 500);
    await pick(page.getByRole('menuitem', { name: 'Claude', exact: true }));
    await moveTo(POINTER.x, POINTER.y);
    await until(at + 1100);
    await finishReviews(count, result);
  }
  // 4. Open the review of the refund flow, pick two findings, send them to the agent.
  await until(6900);
  await dispatch([{ type: 'node.update', id: agentId, activity: 'idle' }]);
  await clickOn(card('Claude review · #43'));
  const desk = page.getByRole('region', { name: 'Claude review · #43' }).getByRole('region', { name: 'Review findings' });
  await desk.getByRole('option').nth(2).waitFor();
  // Once the view has settled, pull it to the corner and fill the window with it: the rail and the trail step out of its way.
  await until(7300);
  const review43 = (await nodeByTitle('Claude review · #43'))!, frame = page.locator(`.item-view[data-item-view="${review43.id}"]`);
  const grip = await centre(frame.locator('.card-heading .item-glyph').first()), at = (await frame.boundingBox())!;
  await drag(grip, { x: grip.x + 12 - at.x, y: grip.y + 12 - at.y });
  await until(7600);
  await drag(await centre(frame.locator('.item-view-resize-handle')), { x: WIDTH - 14, y: HEIGHT - 14 });
  console.log(`review view ${JSON.stringify(await frame.boundingBox())}`);
  await until(7900);
  await clickOn(desk.getByRole('option', { name: /Tokens are logged/ }).locator('input[type=checkbox]'));
  await until(8300);
  await clickOn(desk.getByRole('option', { name: /resized synchronously/ }).locator('input[type=checkbox]'));
  await until(8900);
  await clickOn(desk.locator('.rd-split-main'));
  await until(9600);
  await clickOn(desk.getByRole('dialog').getByRole('button', { name: `Send to ${AGENT_TITLE}` }));
  await until(10600);
  await back();
  // 5. Merge the plan switcher from the map menu; its deploy run joins the map and is validated.
  github.runs = [{ id: 101, name: 'Deploy billing', path: '.github/workflows/deploy.yml', event: 'push', status: 'in_progress', head_sha: SHA }];
  await until(11000);
  await rightClick('Plan switcher');
  await hoverOn(page.getByRole('menuitem', { name: 'Merge…', exact: true }));
  await until(11500);
  await pick(page.getByRole('menu', { name: 'Merge…' }).getByRole('menuitem', { name: 'Squash and merge' }));
  await moveTo(POINTER.x, POINTER.y);
  await until(12000);
  await tick();
  let rollout; for (let attempt = 0; attempt < 50 && !rollout; attempt++) { rollout = await nodeOf('github.rollout'); if (!rollout) await page.waitForTimeout(100); }
  if (!rollout) throw new Error('The rollout did not appear');
  console.log(`rollout at ${JSON.stringify(rollout.position)}`);
  const reported = (result: Awaited<ReturnType<Client['callTool']>>) => console.log(`report: ${JSON.stringify(result.content).slice(0, 300)}`);
  reported(await mcp.callTool({ name: 'workspace_report_validation', arguments: { rolloutNodeId: rollout.id, validationId: 'V1', sequence: 1, phase: 'progress', summary: 'Checking staging against PR #42', checks: [{ id: 'C1', title: 'Error rate', status: 'running' }, { id: 'C2', title: 'Plan switch latency', status: 'running' }, { id: 'C3', title: 'Proration totals', status: 'running' }] } }));
  await until(13000);
  reported(await mcp.callTool({ name: 'workspace_report_validation', arguments: { rolloutNodeId: rollout.id, validationId: 'V1', sequence: 2, phase: 'final', verdict: 'passed', summary: 'Staging matches PR #42: no concerns.', checks: [{ id: 'C1', title: 'Error rate', status: 'passed', method: 'metrics', observation: '0.02 % over 10 minutes, unchanged' }, { id: 'C2', title: 'Plan switch latency', status: 'passed', method: 'metrics', observation: 'p95 180 ms' }, { id: 'C3', title: 'Proration totals', status: 'passed', method: 'smoke', observation: '40 sampled invoices add up' }] } }));
  rollouts.run = { ...rollouts.run, status: 'completed', conclusion: 'success' }; rollouts.jobs = rollouts.jobs.map(job => ({ ...job, status: 'completed', conclusion: 'success' }));
  await tick();
  // 6. The report.
  await until(13800);
  await clickOn(page.locator(`[data-item-id="${rollout.id}"]`));
  await page.locator('.rollout-detail .rv-card[aria-label^="V1 · "]').waitFor();
  await until(14600);
  const showReport = page.locator('.rollout-detail').getByRole('button', { name: /Show report/ });
  if (await showReport.count()) await clickOn(showReport.first());
  await moveTo(POINTER.x, POINTER.y + 200);
  await until(16000);
  await back();
  // 7. The merged pull request, its rollout and its review go to the Undermap together.
  await until(16400);
  const review42 = await nodeByTitle('Claude review · #42');
  for (const id of ['pr-42', rollout.id, review42!.id]) { await shiftClick(id); await page.waitForTimeout(150); }
  await moveTo(POINTER.x, POINTER.y + 200);
  await until(17200);
  await rightClick('Plan switcher');
  await until(17600);
  await pick(page.getByRole('menuitem', { name: 'Send selection to Undermap', exact: true }), 'direct');
  await moveTo(POINTER.x, POINTER.y);
  // 8. Out to the neighbours and the pipelines.
  await until(18800);
  await zoomOutTo(.52);
  await until(19900);
  await zoomOutTo(.28);
  await moveTo(200, 700);
  await until(TOUR_BEAT);
  tourMs += held;
  recording = false; await capture;
  console.log(`Captured ${frames.length} frames; final zoom ${await zoomOf(page)}`);
} catch (error) {
  const last = frames.at(-1); if (last) { await writeFile(join(directory, 'last-frame.png'), last.png); console.error(`Last frame: ${join(directory, 'last-frame.png')}`); }
  throw error;
} finally {
  await mcp?.close().catch(() => {});
  await app.close();
  await service.close().catch(() => {});
  providers.claude = realClaude;
}

const framesDirectory = join(directory, 'frames'); await mkdir(framesDirectory);
const files: string[] = [];
for (let tick = 0; tick < FPS * tourMs / 1000; tick++) {
  const at = tick * 1000 / FPS, frame = [...frames].reverse().find(frame => frame.at <= at) ?? frames[0];
  const file = join(framesDirectory, `frame-${String(tick).padStart(3, '0')}.png`); await writeFile(file, frame.png); files.push(file);
}
const magick = (args: string[]) => execFileSync('magick', args, { stdio: 'inherit' });
const logo = join(framesDirectory, 'logo.png'), icon = resolve('apps/desktop/assets/app-icon.png');
magick(['-size', `${WIDTH}x${HEIGHT}`, 'xc:#141a17', '(', icon, '-resize', '300x300', ')', '-gravity', 'center', '-geometry', '+0-90', '-composite',
  '-font', 'Helvetica-Bold', '-pointsize', '54', '-fill', '#e1eae2', '-annotate', '+0+135', 'Agentic Crafting Table',
  '-font', 'Helvetica', '-pointsize', '26', '-fill', '#98d6ac', '-annotate', '+0+195', 'Focus on one thing. The map keeps track of everything else.', logo]);
const fades: string[] = [];
for (let step = 1; step <= 5; step++) {
  const file = join(framesDirectory, `fade-${step}.png`); magick([files[files.length - 1], logo, '-compose', 'blend', '-define', `compose:args=${step * 20}`, '-composite', file]); fades.push(file);
}
await mkdir(resolve('docs/media'), { recursive: true });
// One palette for every frame and no dithering: the UI is flat colour, so per-frame dithered palettes turn into noise between frames.
const palette = join(directory, 'palette.png');
magick([...files.filter((_, index) => index % 20 === 10), logo, '+append', '-colors', '255', '-unique-colors', palette]);
magick(['-delay', String(100 / FPS), '-loop', '0', ...files, ...fades, '-delay', String(LOGO_SECONDS * 100), logo, '-dither', 'None', '-remap', palette, '-layers', 'OptimizeFrame', OUTPUT]);
console.log(`Wrote ${OUTPUT}${keepFrames ? `; frames kept in ${framesDirectory}` : ''}`);
if (!keepFrames) await rm(directory, { recursive: true, force: true });
