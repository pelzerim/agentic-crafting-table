import { openProjectPicker } from './project-picker.ts';
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';

// Each agent's selection covers different cells, so the same words take a different drag.
for (const { provider, name, fixture, endCol } of [
  { provider: 'codex', name: 'Codex', fixture: 'native-codex.mjs', endCol: 7 },
  { provider: 'claude', name: 'Claude', fixture: 'native-agent.mjs', endCol: 6 },
]) test(`in a ${name} view the cut key removes a prompt selection, only copies a transcript selection and is a key without one`, async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-terminal-cut-')), bin = join(directory, 'bin'), repo = join(directory, 'repo'), log = join(directory, 'input.log');
  await mkdir(bin); await mkdir(repo); await writeFile(log, '');
  await writeFile(join(bin, provider), `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve(`tests/fixtures/${fixture}`)).href)};\n`, { mode: 0o700 });
  const app: ElectronApplication = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory, CODEX_FIXTURE_HOME: repo, CODEX_FIXTURE_INPUT_LOG: log, CODEX_FIXTURE_DRAFT: 'cut me here', AGENT_FIXTURE_INPUT_LOG: log, AGENT_FIXTURE_DRAFT: 'cut me here', CLAUDE_CONFIG_DIR: join(directory, 'claude-history'), PATH: `${bin}:${process.env.PATH}` } });
  // This test uses the real clipboard; put back what the person had on it.
  await app.evaluate(async ({ clipboard, ClipboardItem }) => {
    (globalThis as any).clipboardBeforeTest = await Promise.all((await clipboard.read()).filter(item => item.types.length).map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))));
  });
  try {
    const page: Page = await app.firstWindow();
    // The open view scales in; the drag needs the terminal at its final size.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: 'Create your first project' }).click();
    await page.getByLabel('Title', { exact: true }).fill('Cut project');
    await page.getByLabel('Project summary', { exact: true }).fill('BILLING_BRIEF');
    await page.getByLabel('Project working directory', { exact: true }).fill(repo);
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await openProjectPicker(page, 'Cut project');
    await page.getByRole('button', { name: 'Agent session', exact: true }).click();
    await page.getByRole('radio', { name, exact: true }).check();
    await page.getByLabel('Title', { exact: true }).fill('Cut agent');
    await page.getByRole('button', { name: `Start ${name}`, exact: true }).click();
    await page.getByRole('article', { name: 'Cut agent', exact: true }).click();
    const tree = page.locator('.xterm-accessibility');
    await expect(tree).toContainText('cut me here');
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
    const received = () => readFile(log, 'utf8');
    const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText());
    // The view fits the terminal after it opens, so the grid is read when it is needed.
    const grid = () => page.evaluate(async agent => { const { state } = await window.craftingTable.workspaceRead(), { session } = await window.craftingTable.sessionRead(String(state.resources.find(resource => resource.data.provider === agent)!.data.sessionId)); return { cols: session.cols, rows: session.rows }; }, provider);
    await expect.poll(async () => (await page.locator('.xterm-screen').boundingBox())!.width / (await grid()).cols).toBeGreaterThan(5);
    const rowOf = (text: string) => page.evaluate(([value]) => [...document.querySelectorAll('.xterm-accessibility-tree > div')].findIndex(row => row.textContent?.includes(value)) + 1, [text]);
    const drag = async (row: number, from: number, to: number) => {
      const box = (await page.locator('.xterm-screen').boundingBox())!, { cols, rows } = await grid(), x = (col: number) => box.x + (col - 1) * box.width / cols + 1, y = box.y + (row - .5) * box.height / rows;
      await page.mouse.move(x(from), y); await page.mouse.down(); await page.mouse.move(x(to), y, { steps: 4 }); await page.mouse.up();
    };

    await drag(await rowOf('NATIVE_'), 1, endCol);
    await page.keyboard.press('Control+x');
    await expect.poll(clipboard).toBe('NATIVE');
    await drag(await rowOf('cut me here'), 1, endCol);
    await page.keyboard.press('Control+x');
    await expect.poll(clipboard).toBe('cut me');
    await expect.poll(received).toContain('\x7f');
    expect((await received()).split('\x7f')).toHaveLength(2);
    expect(await received()).not.toContain('\x18');
    await page.keyboard.press('Control+x');
    await expect.poll(received).toContain('\x18');
    expect(await clipboard()).toBe('cut me');

    // Shift+drag makes a terminal selection even while the agent owns the mouse.
    await page.keyboard.down('Shift');
    await drag(await rowOf('cut me here'), 8, 12);
    await page.keyboard.up('Shift');
    await page.keyboard.press('Control+x');
    await expect.poll(clipboard).toBe('here');
    await expect.poll(async () => (await received()).split('\x7f').length).toBe(6);
    await expect(page.locator('.terminal-error')).toHaveCount(0);
  } finally {
    await app.evaluate(async ({ clipboard }) => { await clipboard.write((globalThis as any).clipboardBeforeTest); }).catch(() => {});
    await exitWithoutShutdown(app);
    for (const connect of [() => connectWorkspace(directory), () => connectSupervisor(join(directory, 'runtime'))]) {
      const client = await connect().catch(() => undefined);
      if (client) { const disconnected = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await disconnected; client.close(); }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
