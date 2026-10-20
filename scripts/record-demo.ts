// Records the README demo: an agent at work in one tidy project, a zoom out to its neighbours, a further zoom out
// to the project dashboards with their pull request pipelines, then the logo. Assembled into docs/media/demo.gif
// with ImageMagick. The agent is tests/fixtures/demo-agent.mjs on PATH, so no model runs and nothing is read.
// Usage: npm run build && node scripts/record-demo.ts [--keep-frames]
import { _electron as electron } from '@playwright/test';
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SqliteStore } from '../packages/workspace-service/sqlite-store.ts';
import { stateSchema } from '../packages/core/control.ts';
import { cue } from '../tests/fixtures/photo-library-project.ts';
import { openProjectPicker } from '../tests/e2e/project-picker.ts';

const FPS = 10, TOUR_SECONDS = 11.8, LOGO_SECONDS = 2.5, OUTPUT = resolve('docs/media/demo.gif');
const keepFrames = process.argv.includes('--keep-frames');

type Item = { id: string; title: string; pluginId: string; x: number; y: number; data?: Record<string, unknown>; extra?: Record<string, unknown> };
const nodes: Record<string, unknown>[] = [], resources: Record<string, unknown>[] = [], links: Record<string, unknown>[] = [];
const project = (id: string, title: string, color: string, x: number, y: number, items: Item[]) => {
  nodes.push({ id, title, color, position: { x, y }, workingDirectory: '/tmp' });
  for (const item of items) {
    nodes.push({ id: item.id, resourceId: `${item.id}-r`, projectId: id, title: item.title, position: { x: x + item.x, y: y + item.y }, ...item.extra });
    resources.push({ id: `${item.id}-r`, pluginId: item.pluginId, schemaVersion: 1, title: item.title, data: item.data ?? {} });
  }
};
const link = (sourceId: string, targetId: string, kind = 'context') => links.push({ id: `${sourceId}-${targetId}`, sourceId, targetId, kind });
const pr = (number: number, label: string, tone: 'green' | 'amber' | 'red', icon: string, stage: 'ready' | 'failing' | 'done') => ({ pluginId: 'github.pull-request', data: { owner: 'example', repo: 'billing', number }, extra: { indicators: cue(label, tone, icon, stage) } });
const agent = (session: string, summary: string) => ({ pluginId: 'agent.session', data: { sessionId: session, provider: 'claude' }, extra: { summary, activity: 'working', acceptsContext: true } });

// The featured project: three tidy rows, every item linked to the work it feeds. The working agent is started
// through the app itself once it is open and then moved into the empty slot at the top of the middle column.
const AGENT_SLOT = { x: 0, y: -160 }, AGENT_TITLE = 'Claude · implementation';
project('billing', 'Billing redesign', '#91b78b', 0, 0, [
  { id: 'ticket', title: 'BIL-128 · Plan changes', pluginId: 'linear.ticket', x: -340, y: -160, data: { issueId: 'BIL-128', workspaceKey: 'acme' }, extra: { indicators: cue('In progress', 'blue', 'clock') } },
  { id: 'pr', title: 'Plan switcher', x: 340, y: -160, ...pr(42, 'Review requested', 'amber', 'alert-triangle', 'ready'), extra: { indicators: cue('Review requested', 'amber', 'alert-triangle', 'ready'), summary: 'PR #42 · Ready for review', attention: 'review' } },
  { id: 'brief', title: 'Billing experience', pluginId: 'notion.page', x: -340, y: 20, data: { pageId: '11111111111111111111111111111111' } },
  { id: 'reviewer', title: 'Claude · review', x: 0, y: 20, ...agent('demo-review', 'Checking the proration maths') },
  { id: 'rollout', title: 'Deploy billing', pluginId: 'github.rollout', x: 340, y: 20, data: { owner: 'example', repo: 'billing', runId: 101 }, extra: { indicators: cue('Staging passed', 'green', 'check', 'done') } },
  { id: 'notes', title: 'Proration rules', pluginId: 'workspace.note', x: -340, y: 200, data: { text: 'Charge the difference on upgrade; credit on downgrade.' } },
  { id: 'refund', title: 'Refund flow', x: 0, y: 200, ...pr(43, 'Approved', 'green', 'check', 'ready') },
  { id: 'check', title: 'Check billing flows', pluginId: 'workspace.todo', x: 340, y: 200, extra: { inTodoList: true } },
]);
link('pr', 'reviewer'); link('pr', 'rollout'); link('notes', 'refund', 'reference'); link('refund', 'rollout'); link('rollout', 'check');

// The neighbours seen on the way out, each with pull requests for its pipeline strip.
project('payments', 'Payments API', '#5b7fd6', 1050, -300, [
  { id: 'pay-agent', title: 'Claude · retries', x: -160, y: 0, ...agent('demo-pay', 'Adding idempotency keys') },
  { id: 'pay-pr', title: 'Idempotent retries', x: 180, y: 0, ...pr(51, 'Checks running', 'amber', 'clock', 'ready') },
  { id: 'pay-pr2', title: 'Webhook signatures', x: 180, y: 180, ...pr(52, 'Approved', 'green', 'check', 'ready') },
]);
project('checkout', 'Checkout web', '#e3c55a', 850, 600, [
  { id: 'co-pr', title: 'Address autocomplete', x: -160, y: 0, ...pr(61, 'Checks failing', 'red', 'x', 'failing') },
  { id: 'co-ticket', title: 'WEB-77 · Express pay', pluginId: 'linear.ticket', x: 180, y: 0, data: { issueId: 'WEB-77', workspaceKey: 'acme' } },
]);
project('infra', 'Build infra', '#d0564c', -1050, 420, [
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
project('docs', 'Docs site', '#a884d8', -850, -620, [
  { id: 'docs-pr', title: 'Pricing page copy', x: -160, y: 0, ...pr(101, 'Review requested', 'amber', 'alert-triangle', 'ready') },
  { id: 'docs-agent', title: 'Claude · docs', x: 180, y: 0, ...agent('demo-docs', 'Rewriting the plans page') },
]);
project('search', 'Search', '#63a99c', 2300, -950, [
  { id: 'search-pr', title: 'Typo tolerance', x: -160, y: 0, ...pr(111, 'Checks failing', 'red', 'x', 'failing') },
  { id: 'search-ticket', title: 'SRCH-9 · Synonyms', pluginId: 'linear.ticket', x: 180, y: 0, data: { issueId: 'SRCH-9', workspaceKey: 'acme' } },
]);

const WIDTH = 1280, HEIGHT = 800, FOCUS = { x: 0, y: 60 }, POINTER = { x: WIDTH / 2, y: HEIGHT / 2 - 90 };
const directory = await mkdtemp(join(tmpdir(), 'craft-demo-'));
const bin = join(directory, 'bin'); await mkdir(bin);
await writeFile(join(bin, 'claude'), `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/demo-agent.mjs')).href)};\n`, { mode: 0o700 });
const store = new SqliteStore(join(directory, 'workspace.sqlite'));
try {
  await store.update(state => stateSchema.parse({ ...state, nodes, resources, links }));
  await store.writeView('desktop', { camera: { x: WIDTH / 2 - FOCUS.x, y: HEIGHT / 2 - FOCUS.y, zoom: 1 } });
  const settings = store.readSettings();
  store.writeSettings({ expectedRevision: settings.revision, value: { ...settings.value, mapDashboards: { ...settings.value.mapDashboards, belowZoom: .5, sections: { ...settings.value.mapDashboards.sections, pipelines: true } } } });
  store.saveReminders([]);
} finally { store.close(); }

const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1', '--disable-lcd-text', '--force-color-profile=srgb', '-AppleShowScrollBars', 'WhenScrolling'], env: { ...process.env, ACT_TEST_DATA_DIR: directory, CLAUDE_CONFIG_DIR: join(directory, 'claude-history'), PATH: `${bin}:${process.env.PATH}`, TZ: 'UTC' } });
const frames: { at: number; png: Buffer }[] = [];
const zoomOf = (page: Page) => page.locator('.map-area').getAttribute('data-zoom').then(Number);
try {
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width: WIDTH, height: HEIGHT });
  await page.route(/^https?:\/\//, route => route.abort());
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByText('Desktop connected').waitFor();
  await page.getByRole('article', { name: 'Plan switcher', exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  // Start the agent the way a person would, then place it in its grid slot and connect it to the ticket, brief and PR.
  await openProjectPicker(page, 'Billing redesign');
  await page.getByRole('button', { name: 'Agent session', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill(AGENT_TITLE);
  await page.getByRole('button', { name: 'Start Claude', exact: true }).click();
  const agentId = await page.evaluate(async title => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const { state } = await window.craftingTable.workspaceRead(), node = state.nodes.find(node => node.title === title);
      if (node) return node.id;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('The agent item did not appear');
  }, AGENT_TITLE);
  const placed = await page.evaluate(async ({ id, slot }) => {
    const { state } = await window.craftingTable.workspaceRead();
    try { await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'demo' }, commands: [
      { type: 'nodes.move', positions: [{ id, position: slot }] },
      { type: 'link.save', link: { id: 'ticket-agent', sourceId: 'ticket', targetId: id, kind: 'context', label: '' } },
      { type: 'link.save', link: { id: 'brief-agent', sourceId: 'brief', targetId: id, kind: 'reference', label: '' } },
      { type: 'link.save', link: { id: 'agent-pr', sourceId: id, targetId: 'pr', kind: 'reference', label: '' } },
    ] } as never); } catch (error) { return (error as Error).message; }
  }, { id: agentId, slot: AGENT_SLOT });
  if (placed) throw new Error(`Placing the agent failed: ${placed}`);
  await page.getByRole('article', { name: AGENT_TITLE, exact: true }).click();
  await page.locator('.native-terminal[data-session-state="running"]').waitFor({ timeout: 20_000 });
  await page.mouse.move(POINTER.x, POINTER.y);
  await page.waitForTimeout(300);

  let recording = true; const started = Date.now();
  const capture = (async () => { while (recording) frames.push({ at: Date.now() - started, png: await page.screenshot({ type: 'png', caret: 'hide' }) }); })();
  const until = async (ms: number) => { const left = started + ms - Date.now(); if (left > 0) await page.waitForTimeout(left); };
  // Small wheel steps read as one continuous zoom; each step is a fixed fraction, so the pace is even.
  const zoomOutTo = async (zoom: number) => { while (await zoomOf(page) > zoom) { await page.mouse.wheel(0, 20); await page.waitForTimeout(20); } };

  await until(5200);
  await page.getByRole('button', { name: 'Back to project', exact: true }).click();
  await page.mouse.move(POINTER.x, POINTER.y);
  await until(7200);
  await zoomOutTo(.52);
  await until(9400);
  await zoomOutTo(.28);
  // Off the dashboards, so no hover preview opens while the pipeline view holds.
  await page.mouse.move(200, 700);
  await until(TOUR_SECONDS * 1000);
  recording = false; await capture;
  console.log(`Captured ${frames.length} frames; final zoom ${await zoomOf(page)}`);
} finally { await app.close(); }

const framesDirectory = join(directory, 'frames'); await mkdir(framesDirectory);
const files: string[] = [];
for (let tick = 0; tick < FPS * TOUR_SECONDS; tick++) {
  const at = tick * 1000 / FPS, frame = [...frames].reverse().find(frame => frame.at <= at) ?? frames[0];
  const file = join(framesDirectory, `frame-${String(tick).padStart(3, '0')}.png`); await writeFile(file, frame.png); files.push(file);
}
const magick = (args: string[]) => execFileSync('magick', args, { stdio: 'inherit' });
const logo = join(framesDirectory, 'logo.png'), icon = resolve('apps/desktop/assets/app-icon.png');
magick(['-size', `${WIDTH}x${HEIGHT}`, 'xc:#141a17', '(', icon, '-resize', '300x300', ')', '-gravity', 'center', '-geometry', '+0-90', '-composite',
  '-font', 'Helvetica-Bold', '-pointsize', '54', '-fill', '#e1eae2', '-annotate', '+0+135', 'Agentic Crafting Table',
  '-font', 'Helvetica', '-pointsize', '26', '-fill', '#98d6ac', '-annotate', '+0+195', 'Your agents, pull requests and tickets on one map.', logo]);
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
