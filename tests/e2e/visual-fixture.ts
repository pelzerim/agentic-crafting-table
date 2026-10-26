import { test as base, expect, _electron as electron } from '@playwright/test';
import type { Page, ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { SqliteStore } from '../../packages/workspace-service/sqlite-store.ts';
import { enableShowShip } from '../fixtures/github.ts';
import { stateSchema } from '../../packages/core/control.ts';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import type { Reminder } from '../../packages/core/reminders.ts';
import type { MapCorner } from '../../packages/core/settings.ts';

// Process-local only: host mouse/trackpad settings must not change capture width.
export const scrollbarArgs = process.platform === 'darwin' ? ['-AppleShowScrollBars', 'WhenScrolling'] : [];

/** The bottom-right corner (MAP-22). Screenshots and Atlas checks predate the project column, so fixtures show the Atlas unless a test asks for the column. */
export function chooseMapCorner(store: Pick<SqliteStore, 'readSettings' | 'writeSettings'>, mapCorner: MapCorner) {
  const current = store.readSettings();
  if (current.value.mapCorner !== mapCorner) store.writeSettings({ expectedRevision: current.revision, value: { ...current.value, mapCorner } });
}

export const test = base.extend<{ visual: { app: ElectronApplication; page: Page }; legacyLayout: boolean; titleFixture: boolean; launchEnv: Record<string, string>; reminders: Reminder[]; mapCorner: MapCorner }>({
  legacyLayout: [false, { option: true }],
  mapCorner: ['atlas', { option: true }],
  // The service fires reminders on the real clock, so screenshots start without the first-run seeds.
  reminders: [[], { option: true }],
  titleFixture: [false, { option: true }],
  launchEnv: [{}, { option: true }],
  visual: async ({ legacyLayout, titleFixture, launchEnv, reminders, mapCorner }, use, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'craft-visual-'));
    const titleEnv: Record<string, string> = {};
    if (titleFixture) {
      const bin = join(directory, 'bin'); await mkdir(bin);
      await writeFile(join(bin, 'claude'), `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/native-summary.mjs')).href)};\n`, { mode: 0o700 });
      titleEnv.PATH = `${bin}:${process.env.PATH}`; titleEnv.ACT_SUMMARY_FIXTURE_LOG = join(directory, 'title-requests.jsonl');
    }
    const store = new SqliteStore(join(directory, 'workspace.sqlite'));
    try {
      await store.update(state => stateSchema.parse({ ...state, nodes: [
        { id: 'billing', title: 'Billing redesign', position: { x: 300, y: 300 }, workingDirectory: '/tmp', summary: 'Simplify subscription changes.' },
        { id: 'agent', resourceId: 'agent-resource', projectId: 'billing', title: 'Claude · implementation', position: { x: 650, y: 240 }, summary: 'Updating the plan switcher', activity: 'working', attention: 'input', acceptsContext: true },
        { id: 'pr', resourceId: 'pr-resource', projectId: 'billing', title: 'Plan switcher', position: { x: 960, y: 300 }, summary: 'PR #48 · Ready for review', attention: 'review' },
        { id: 'ticket', resourceId: 'ticket-resource', projectId: 'billing', title: 'BIL-128 · Plan changes', position: { x: 640, y: 430 } },
        { id: 'brief', resourceId: 'brief-resource', projectId: 'billing', title: 'Billing experience', position: { x: 970, y: 460 } },
      ], resources: [
        { id: 'agent-resource', pluginId: 'agent.session', schemaVersion: 1, title: 'Claude · implementation', data: { sessionId: 'visual-only', provider: 'claude' } },
        { id: 'pr-resource', pluginId: 'github.pull-request', schemaVersion: 1, title: 'Plan switcher', data: { owner: 'example', repo: 'billing', number: 48 } },
        { id: 'ticket-resource', pluginId: 'linear.ticket', schemaVersion: 1, title: 'BIL-128 · Plan changes', data: { issueId: 'BIL-128' } },
        { id: 'brief-resource', pluginId: 'notion.page', schemaVersion: 1, title: 'Billing experience', data: { pageId: '11111111111111111111111111111111' } },
      ], links: [
        { id: 'ticket-agent', sourceId: 'ticket', targetId: 'agent', kind: 'context' },
        { id: 'brief-pr', sourceId: 'brief', targetId: 'pr', kind: 'reference' },
      ] }));
      if (legacyLayout) await store.update(state => ({ ...state, nodes: state.nodes.map(node => node.resourceId ? { ...node, position: { x: 650, y: 300 } } : node) }));
      await store.writeView('desktop', { camera: { x: 140, y: 100, zoom: .7 } });
      enableShowShip(store);
      store.saveReminders(reminders);
      chooseMapCorner(store, mapCorner);
    } finally { store.close(); }
    // A process-local Cocoa preference keeps automatic mouse/trackpad changes on
    // the host from switching scrollbar layout mid-run. Never write user defaults.
    const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1', '--disable-lcd-text', '--force-color-profile=srgb', ...scrollbarArgs], env: { ...process.env, ...titleEnv, ACT_TEST_DATA_DIR: directory, SHELL: '/bin/sh', TZ: 'UTC', LANG: 'en_US.UTF-8', ...launchEnv } });
    try {
      const page = await app.firstWindow();
      if (process.platform === 'darwin') expect(await app.evaluate(({ systemPreferences }) => systemPreferences.getUserDefault('AppleShowScrollBars', 'string'))).toBe('WhenScrolling');
      await page.route(/^https?:\/\//, route => route.abort());
      await app.evaluate(({ shell }) => { (globalThis as any).openedUrls = []; shell.openExternal = async (url: string) => { (globalThis as any).openedUrls.push(url); }; });
      await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
      await page.clock.setFixedTime(new Date('2026-01-15T12:00:00Z'));
      await resize(app, page, 1280, 800);
      await expect(page.getByText('Desktop connected')).toBeVisible();
      await expect(page.locator('[data-project-label="billing"]')).toContainText('1 asking · 1 my turn · 1 working');
      await page.evaluate(() => document.fonts.ready);
      await testInfo.attach('render-environment', { body: JSON.stringify(await app.evaluate(({ app, BrowserWindow }) => ({ electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform, arch: process.arch, version: app.getVersion(), windowVisible: BrowserWindow.getAllWindows()[0].isVisible(), backgroundThrottling: BrowserWindow.getAllWindows()[0].webContents.getBackgroundThrottling() })), null, 2), contentType: 'application/json' });
      await use({ app, page });
    } finally {
      await exitWithoutShutdown(app);
      for (const connect of [() => connectWorkspace(directory), () => connectSupervisor(join(directory, 'runtime'))]) {
        const client = await connect().catch(() => undefined);
        if (client) {
          try { const stopped = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await stopped; }
          finally { client.close(); }
        }
      }
      // Detached diagnostic writers can drain their final bytes just after IPC
      // closes; retry only removal of this isolated test directory.
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
});

export async function resize(app: ElectronApplication, page: Page, width: number, height: number) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height });
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height });
}

export async function capture(page: Page, name: string) {
  await page.mouse.move(4, 4);
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await expect(page).toHaveScreenshot(name);
}

export async function captureTerminal(page: Page, name: string) {
  const renderer = await page.locator('.terminal-host').getAttribute('data-terminal-renderer');
  // Keep DOM fallback baselines usable on runners without WebGL2. GPU cell
  // rounding/rasterization is intentionally different from DOM glyph layout.
  await capture(page, renderer === 'webgl' ? name.replace('.png', '-webgl.png') : name);
}

export async function openTerminal(page: Page, dense = false) {
  await page.evaluate(async () => {
    const state = (await window.craftingTable.workspaceRead()).state;
    await window.craftingTable.resourceCreate({ requestId: '00000000-0000-4000-8000-000000000023', nodeId: '00000000-0000-4000-8000-000000000021', resourceId: '00000000-0000-4000-8000-000000000022',
      expectedRevision: state.revision, pluginId: 'terminal.session', title: 'Development terminal', projectId: 'billing', position: { x: 660, y: 620 }, data: { cwd: '/tmp' } });
  });
  await page.getByRole('article', { name: 'Development terminal' }).click();
  await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(`${quote(process.execPath)} ${quote(resolve('tests/fixtures/visual-terminal.mjs'))}${dense ? ' dense' : ''}\n`);
  await expect(page.locator('.xterm-accessibility-tree')).toContainText('Last terminal row · ready for input');
  // The first screen can paint before the debounced PTY resize arrives. Do not
  // use its initial 100-column launch grid as the baseline for later resizing.
  await terminalResized(page);
}

export async function terminalResized(page: Page) {
  await expect.poll(() => page.locator('.terminal-host').evaluate(host => {
    const screen = host.querySelector('.xterm-screen')!.getBoundingClientRect(), outer = host.getBoundingClientRect();
    return screen.bottom <= outer.bottom && screen.right <= outer.right;
  })).toBe(true);
  const sessionId = (await page.locator('.terminal-surface').getAttribute('data-terminal-id'))!;
  const rows = await page.locator('.xterm-accessibility-tree > div').count();
  const session = () => page.evaluate(async id => (await window.craftingTable.sessionRead(id)).session, sessionId);
  await expect.poll(async () => (await session()).rows).toBe(rows);
  const resized = await session();
  await expect(page.locator('.xterm-accessibility-tree > div').last()).toContainText(`ready for input · ${resized.cols} × ${resized.rows}`);
  await expect(page.locator('.xterm-accessibility-tree')).toContainText('Billing workspace');
}
