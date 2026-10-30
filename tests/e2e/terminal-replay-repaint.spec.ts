import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';

test('a view that skipped earlier output asks a running full-screen program to redraw', async () => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-replay-repaint-'));
  const profile = join(directory, 'profile'), signals = join(directory, 'winch.log'); await mkdir(profile);
  await writeFile(join(profile, '.zshrc'), "PROMPT='REPAINT> '\nunset HISTFILE\n");
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory, SHELL: '/bin/zsh', ZDOTDIR: profile } });
  const count = async () => (await readFile(signals, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('Desktop connected')).toBeVisible();
    const sessionId = await page.evaluate(async cwd => {
      const id = crypto.randomUUID();
      await window.craftingTable.resourceCreate({ requestId: id, nodeId: crypto.randomUUID(), resourceId: crypto.randomUUID(), expectedRevision: 0, pluginId: 'terminal.session', title: 'Repaint terminal', position: { x: 250, y: 230 }, data: { cwd } });
      return id;
    }, directory);
    const card = page.getByRole('article', { name: 'Repaint terminal' });
    await card.click();
    await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');
    await expect(page.locator('.xterm-accessibility-tree')).toContainText('REPAINT>');
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    await page.keyboard.type(`${quote(process.execPath)} ${quote(resolve('tests/fixtures/winch-tui.mjs'))} ${quote(signals)} 2\n`);
    await page.getByRole('button', { name: 'Back to project' }).click();
    await expect.poll(async () => (await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).chunks.map(chunk => chunk.data).join('').includes('WINCH_READY'), { timeout: 60_000 }).toBe(true);
    await page.reload();
    await expect(page.getByText('Desktop connected')).toBeVisible();
    const before = await count();
    await card.click();
    await expect(page.getByText('Earlier output skipped')).toBeVisible();
    await expect.poll(count, { timeout: 10_000 }).toBeGreaterThan(before);
  } finally {
    await exitWithoutShutdown(app);
    await rm(directory, { recursive: true, force: true });
  }
});
