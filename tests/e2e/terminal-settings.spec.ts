import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import type { AppSettings } from '../../packages/core/settings.ts';

async function openTerminal(run: (app: ElectronApplication, page: Page, sessionId: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-terminal-settings-'));
  const profile = join(directory, 'profile'); await mkdir(profile);
  await writeFile(join(profile, '.zshrc'), "PROMPT='PREFS> '\nunset HISTFILE\n");
  // The default: macOS reports no assistive technology.
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory, ACT_TEST_ASSISTIVE_TECH: '0', SHELL: '/bin/zsh', ZDOTDIR: profile } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('Desktop connected')).toBeVisible();
    const sessionId = await page.evaluate(async cwd => {
      const id = crypto.randomUUID();
      await window.craftingTable.resourceCreate({ requestId: id, nodeId: crypto.randomUUID(), resourceId: crypto.randomUUID(), expectedRevision: 0,
        pluginId: 'terminal.session', title: 'Preferences terminal', position: { x: 250, y: 230 }, data: { cwd } });
      return id;
    }, directory);
    await page.getByRole('article', { name: 'Preferences terminal' }).click();
    await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');
    await expect.poll(async () => (await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).chunks.map(chunk => chunk.data).join('')).toContain('PREFS>');
    await run(app, page, sessionId);
  } finally {
    await exitWithoutShutdown(app);
    for (const connect of [() => connectWorkspace(directory), () => connectSupervisor(join(directory, 'runtime'))]) {
      const client = await connect().catch(() => undefined);
      if (client) { const disconnected = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await disconnected; client.close(); }
    }
    await rm(directory, { recursive: true, force: true });
  }
}

const writeTerminalSettings = (page: Page, terminal: Partial<AppSettings['terminal']>) => page.evaluate(async terminal => {
  const settings = await window.craftingTable.settingsRead();
  await window.craftingTable.settingsWrite({ expectedRevision: settings.revision, value: { ...settings.value, terminal: { ...settings.value.terminal, ...terminal } } });
}, terminal);

test('an open terminal follows the screen reader setting and assistive technology without remounting', async () => {
  await openTerminal(async (app, page) => {
    const surface = page.locator('.terminal-surface'), mount = await surface.getAttribute('data-mount-id');
    const tree = page.locator('.terminal-surface .xterm-accessibility');
    await expect(tree).toHaveCount(0);
    expect((await page.evaluate(() => window.craftingTable.settingsRead())).value.terminal.screenReader).toBe(false);

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('treeitem', { name: 'General', exact: true }).click();
    const screenReader = dialog.getByRole('switch', { name: 'Screen reader support for terminals' });
    await expect(screenReader).not.toBeChecked(); await expect(screenReader).toBeEnabled();
    await screenReader.check();
    await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(tree).toHaveCount(1);
    await expect(page.locator('.xterm-accessibility-tree')).toContainText('PREFS>');
    await writeTerminalSettings(page, { screenReader: false });
    await expect(tree).toHaveCount(0);

    // VoiceOver starting or stopping while the terminal is open.
    const report = (enabled: boolean) => app.evaluate(({ BrowserWindow }, enabled) => BrowserWindow.getAllWindows()[0].webContents.send('app:assistive-technology', enabled), enabled);
    await report(true);
    await expect(tree).toHaveCount(1);
    await report(false);
    await expect(tree).toHaveCount(0);
    await expect(surface).toHaveAttribute('data-mount-id', mount!);
  });
});

test('an open terminal applies a new scrollback length, trimming older history when it shrinks', async () => {
  await openTerminal(async (_app, page, sessionId) => {
    const surface = page.locator('.terminal-surface'), mount = await surface.getAttribute('data-mount-id');
    await expect(surface).toHaveAttribute('data-terminal-scrollback', '5000');
    await writeTerminalSettings(page, { screenReader: true });
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('i=0; while [ $i -lt 8000 ]; do i=$((i+1)); echo "LINE $i"; done; echo PRINT""ED\n');
    await expect(page.locator('.xterm-accessibility-tree')).toContainText('PRINTED', { timeout: 20_000 });
    // The first retained row, reached by scrolling the history to its top.
    const top = async () => Number(/LINE (\d+)/.exec(await page.locator('.xterm-accessibility-tree > div').first().innerText())?.[1] ?? 0);
    const firstLine = async () => {
      await page.locator('.xterm-helper-textarea').focus();
      // Shift+Page Up scrolls xterm's own history one page at a time.
      // 300 pages exceed 8,000 lines; the accessibility tree settles within a second.
      for (let i = 0; i < 300; i++) await page.keyboard.press('Shift+PageUp');
      let previous = -1;
      for (let attempt = 0; attempt < 10; attempt++) {
        await page.waitForTimeout(1200);
        const line = await top();
        if (line > 0 && line === previous) return line;
        previous = line;
      }
      throw new Error(`History did not settle at its top (last first line ${previous})`);
    };
    const rows = (await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).session.rows;
    const defaultTop = await firstLine();
    // 8,000 lines plus the prompt and command exceed 5,000 lines of scrollback and the screen.
    expect(defaultTop).toBeGreaterThan(8000 - 5000 - rows);
    expect(defaultTop).toBeLessThan(8000 - 5000 + rows);

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('treeitem', { name: 'General', exact: true }).click();
    const lines = dialog.getByLabel('Scrollback lines');
    await expect(lines).toHaveValue('5000');
    await lines.selectOption('2000');
    await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(surface).toHaveAttribute('data-terminal-scrollback', '2000');
    const trimmedTop = await firstLine();
    expect(trimmedTop).toBeGreaterThan(8000 - 2000 - rows);

    await writeTerminalSettings(page, { scrollback: 25000 });
    await expect(surface).toHaveAttribute('data-terminal-scrollback', '25000');
    expect(await firstLine()).toBe(trimmedTop);
    await expect(surface).toHaveAttribute('data-mount-id', mount!);
  });
});
