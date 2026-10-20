import { test as base, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { SqliteStore } from '../../packages/workspace-service/sqlite-store.ts';
import { stateSchema } from '../../packages/core/control.ts';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { resize, scrollbarArgs } from './visual-fixture.ts';
import { STANDUP_ENABLED } from '../../packages/core/standup.ts';

const NATIVE = '00000000-0000-4000-8000-000000000020';
type Fixture = { app: ElectronApplication; page: Page; log: () => Promise<{ model: string; standup: string; range?: string; instruction?: string; facts?: number }[]> };
/** A table with one Claude conversation from today, a to-do done today and the scripted native helper: no model or provider is called. */
const test = base.extend<{ standup: Fixture }>({
  standup: async ({}, use, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'craft-standup-')), bin = join(directory, 'bin'), log = join(directory, 'standup-requests.jsonl'), claude = join(directory, 'claude-config');
    await mkdir(bin); await mkdir(join(claude, 'projects', '-tmp-billing'), { recursive: true });
    await writeFile(join(bin, 'claude'), `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/native-summary.mjs')).href)};\n`, { mode: 0o700 });
    const at = new Date(Date.now() - 5 * 60_000).toISOString();
    await writeFile(join(claude, 'projects', '-tmp-billing', `${NATIVE}.jsonl`), [
      { type: 'user', timestamp: at, message: { role: 'user', content: 'Why are cart totals off by a cent? password=FAKE_PRIVATE_CREDENTIAL' } },
      { type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'The cart rounds each line before it adds them up.' }] } },
    ].map(line => JSON.stringify(line)).join('\n') + '\n');
    const store = new SqliteStore(join(directory, 'workspace.sqlite'), { reminderSeeds: [] });
    try {
      await store.update(state => stateSchema.parse({ ...state, nodes: [
        { id: 'billing', title: 'Billing', position: { x: 300, y: 300 }, workingDirectory: '/tmp' },
        { id: 'agent', resourceId: 'agent-resource', projectId: 'billing', title: 'Claude · cart totals', position: { x: 620, y: 260 } },
      ], resources: [{ id: 'agent-resource', pluginId: 'agent.session', schemaVersion: 1, title: 'Claude · cart totals', data: { sessionId: 'standup-only', provider: 'claude', nativeSessionId: NATIVE } }],
      todos: [{ id: 'migration', title: 'Write the migration', completed: true, nodeIds: [], doneAt: new Date().toISOString() }] }));
      await store.writeView('desktop', { camera: { x: 100, y: 60, zoom: .8 } });
    } finally { store.close(); }
    const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1', '--disable-lcd-text', '--force-color-profile=srgb', ...scrollbarArgs],
      env: { ...process.env, ACT_TEST_DATA_DIR: directory, ACT_SUMMARY_FIXTURE_LOG: log, CLAUDE_CONFIG_DIR: claude, PATH: `${bin}:${process.env.PATH}`, SHELL: '/bin/sh', TZ: 'UTC', LANG: 'en_US.UTF-8' } });
    try {
      const page = await app.firstWindow();
      await page.route(/^https?:\/\//, route => route.abort());
      await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
      await resize(app, page, 1280, 800);
      await expect(page.getByText('Desktop connected')).toBeVisible();
      await page.evaluate(() => { const copied: string[] = []; (window as any).copied = copied; Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (text: string) => { copied.push(text); } }); });
      await use({ app, page, log: () => readFile(log, 'utf8').then(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))).catch(() => []) });
    } finally {
      const errors = await readFile(log + '.errors', 'utf8').catch(() => '');
      if (errors) await testInfo.attach('fixture-errors', { body: errors, contentType: 'text/plain' });
      await exitWithoutShutdown(app);
      for (const connect of [() => connectWorkspace(directory), () => connectSupervisor(join(directory, 'runtime'))]) {
        const client = await connect().catch(() => undefined);
        if (client) { try { const stopped = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await stopped; } finally { client.close(); } }
      }
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
});

const openReport = async (page: Page) => {
  await page.getByRole('button', { name: 'Table actions', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Table actions' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Standup report…' }).click();
  const panel = page.getByRole('dialog', { name: 'Standup report' });
  await expect(panel).toBeVisible(); await expect(page.getByRole('menu', { name: 'Table actions' })).toBeHidden();
  return panel;
};
/** The fixture's work is from today, so most checks read the 1 day range. */
const openToday = async (page: Page) => {
  const panel = await openReport(page);
  await panel.getByRole('radio', { name: '1 day' }).click();
  return panel;
};
const copied = (page: Page) => page.evaluate(() => (window as any).copied as string[]);
const shots = process.env.ACT_STANDUP_SHOTS;

test.skip(!STANDUP_ENABLED, 'The standup report is disabled (STANDUP_ENABLED in packages/core/standup.ts).');

test('rail Actions opens the standup report; ranges, unticked stories and the outlook follow the table', async ({ standup: { page, log } }) => {
  test.setTimeout(60_000);
  await page.getByRole('button', { name: 'Table actions', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Table actions' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Table actions', exact: true })).toHaveAttribute('aria-expanded', 'true');
  if (shots) await page.screenshot({ path: join(shots, 'rail-actions-menu.png') });
  await page.keyboard.press('Escape'); await expect(page.getByRole('menu', { name: 'Table actions' })).toBeHidden();
  const panel = await openToday(page);
  const story = panel.getByRole('article', { name: 'Cart totals were off by a cent' });
  await expect(story).toBeVisible({ timeout: 20_000 });
  await expect(story.getByRole('listitem')).toHaveCount(3);
  await expect(panel.getByRole('region', { name: 'Done' }).getByRole('article')).toHaveCount(2);
  await expect(panel.getByRole('region', { name: 'This week' })).toHaveCount(0);
  await expect(story.locator('.standup-chip')).toContainText('Claude · cart totals');
  expect((await log()).filter(entry => entry.range !== 'Last week').map(entry => [entry.standup, entry.model])).toEqual([['agent-day', 'haiku'], ['report', 'sonnet']]);

  await panel.getByRole('radio', { name: '7 days' }).click();
  await expect(panel.getByRole('radio', { name: '7 days' })).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => (await log()).filter(entry => entry.standup === 'report' && entry.range !== 'Last week').length).toBe(2);
  await expect(story).toBeVisible();
  expect((await log()).filter(entry => entry.standup === 'agent-day')).toHaveLength(1);

  await story.getByRole('checkbox').uncheck();
  await expect(story).toHaveAttribute('data-off', 'true');
  await expect(panel.getByRole('status').last()).toHaveText('1 of 2 stories');
  await panel.getByRole('button', { name: 'Copy for Slack' }).click();
  await expect(panel.getByText('Copied for Slack')).toBeVisible();
  const slack = (await copied(page)).at(-1)!;
  expect(slack).toMatch(/^\*Standup · .+\*\n\n\*Done\*\n\n\*Write the migration\*\n• Done to-do: Write the migration\.\nTo-do · Write the migration$/);
  expect(slack).not.toContain('Cart totals');

  await page.evaluate(async () => {
    const state = (await window.craftingTable.workspaceRead()).state;
    await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'todo.save', todo: { id: 'retry-limit', title: 'Agree the retry limit', completed: false, nodeIds: [] } }] });
  });
  await panel.getByRole('radio', { name: '1 day' }).click();
  const week = panel.getByRole('region', { name: 'This week' });
  await expect(week).toBeVisible({ timeout: 20_000 });
  await expect(week.getByRole('article', { name: 'Agree the retry limit' })).toBeVisible();
  await expect(story.getByRole('checkbox')).toBeChecked();
  if (shots) await page.screenshot({ path: join(shots, 'report-stories-outlook.png') });
  await panel.getByRole('button', { name: 'Copy Markdown' }).click();
  const markdown = (await copied(page)).at(-1)!;
  expect(markdown).toContain('### This week\n\n**Agree the retry limit**\n- Still open: Agree the retry limit.');
  if (shots) await writeFile(join(shots, 'copied-markdown.txt'), markdown);
  await panel.getByRole('radio', { name: 'Brief' }).click();
  await expect(story.getByRole('listitem')).toHaveCount(1);
  if (shots) await page.screenshot({ path: join(shots, 'report-brief.png') });
  await panel.getByRole('button', { name: 'Copy for Slack' }).click();
  if (shots) await writeFile(join(shots, 'copied-slack.txt'), (await copied(page)).at(-1)!);

  await panel.getByRole('radio', { name: 'Normal' }).click();
  await panel.getByRole('textbox', { name: 'Tell Claude what to change' }).fill('shorter');
  await panel.getByRole('button', { name: 'Rewrite' }).click();
  await expect(story.getByRole('listitem')).toHaveCount(1, { timeout: 20_000 });
  expect((await log()).at(-1)).toMatchObject({ standup: 'report', instruction: 'shorter' });
  await panel.getByRole('button', { name: 'Close standup report' }).click();
  await expect(panel).toBeHidden();
});

test('the report opens on Last week and keeps going after the panel closes; reopening shows it without asking again', async ({ standup: { page, log } }) => {
  test.setTimeout(60_000);
  let panel = await openReport(page);
  await expect(panel.getByRole('radio', { name: 'Last week' })).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByText('You can close this panel: the report keeps going and is here when you come back.')).toBeVisible();
  await panel.getByRole('button', { name: 'Close standup report' }).click();
  await expect(panel).toBeHidden();
  await expect.poll(async () => (await page.evaluate(() => window.craftingTable.standupStatus())).state, { timeout: 20_000 }).toBe('done');
  const asked = (await log()).filter(entry => entry.standup === 'report').length;

  panel = await openReport(page);
  await expect(panel.locator('.standup-read')).toBeVisible();
  await expect(panel.getByRole('radio', { name: 'Last week' })).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByText(/^You can close this panel/)).toHaveCount(0);
  expect((await log()).filter(entry => entry.standup === 'report')).toHaveLength(asked);

  await panel.getByRole('radio', { name: '1 day' }).click();
  await expect(panel.getByRole('article', { name: 'Cart totals were off by a cent' })).toBeVisible({ timeout: 20_000 });
  await panel.getByRole('button', { name: 'Close standup report' }).click();
  panel = await openReport(page);
  await expect(panel.getByRole('radio', { name: '1 day' })).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByRole('article', { name: 'Cart totals were off by a cent' })).toBeVisible();
});

test('with standup digests off the report is the plain facts list and says why, without a model call', async ({ standup: { page, log } }) => {
  await page.evaluate(async () => {
    const current = await window.craftingTable.settingsRead();
    await window.craftingTable.settingsWrite({ expectedRevision: current.revision, value: { ...current.value, summaries: { ...current.value.summaries, standupDigests: false } } });
  });
  const panel = await openToday(page);
  await expect(panel.getByText('Standup digests are off in Settings → AI features, so this is the stored facts without a summary.')).toBeVisible({ timeout: 20_000 });
  const fact = panel.getByRole('article', { name: 'Write the migration' });
  await expect(fact).toBeVisible(); await expect(fact.getByRole('listitem')).toHaveCount(0);
  await expect(panel.getByRole('region', { name: 'This week' })).toHaveCount(0);
  if (shots) await page.screenshot({ path: join(shots, 'report-ai-off.png') });
  expect(await log()).toEqual([]);
  await panel.getByRole('button', { name: 'Copy for Slack' }).click();
  expect((await copied(page)).at(-1)).toMatch(/\n\*Write the migration\*\nTo-do · Write the migration$/);
});

test('visual: Actions menu, a report with stories and the outlook, and the facts list', async ({ standup: { page } }) => {
  await page.getByRole('button', { name: 'Table actions', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Table actions' })).toBeVisible();
  await page.mouse.move(4, 4);
  await expect(page).toHaveScreenshot('standup-actions-menu.png', { clip: { x: 0, y: 360, width: 360, height: 120 } });
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    const state = (await window.craftingTable.workspaceRead()).state;
    await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'todo.save', todo: { id: 'retry-limit', title: 'Agree the retry limit', completed: false, nodeIds: [] } }] });
  });
  const panel = await openToday(page);
  await expect(panel.getByRole('region', { name: 'This week' })).toBeVisible({ timeout: 20_000 });
  const mask = [panel.locator('.standup-range-label'), panel.locator('.standup-chip')];
  await page.mouse.move(4, 4);
  await expect(panel).toHaveScreenshot('standup-report.png', { mask });
  await page.evaluate(async () => {
    const current = await window.craftingTable.settingsRead();
    await window.craftingTable.settingsWrite({ expectedRevision: current.revision, value: { ...current.value, summaries: { ...current.value.summaries, standupDigests: false } } });
  });
  await panel.getByRole('radio', { name: 'Last week' }).click();
  await expect(panel.getByText(/^Standup digests are off/)).toBeVisible({ timeout: 20_000 });
  await page.mouse.move(4, 4);
  await expect(panel).toHaveScreenshot('standup-facts.png', { mask });
});
