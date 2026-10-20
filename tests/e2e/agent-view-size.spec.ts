import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { test, expect, _electron as electron } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import { openProjectPicker } from './project-picker.ts';

/** How far the terminal grid falls short of the space its view gives it. */
async function terminalGap(page: Page) {
  const surface = page.locator('.terminal-surface'), id = (await surface.getAttribute('data-terminal-id'))!;
  const { rows } = (await page.evaluate(id => window.craftingTable.sessionRead(id), id)).session;
  return surface.evaluate((element, rows) => {
    const screen = element.querySelector('.xterm-screen')!.getBoundingClientRect(), host = element.querySelector('.terminal-host')!.getBoundingClientRect();
    return { width: host.width - screen.width, height: host.height - screen.height, cell: screen.height / rows };
  }, rows);
}

test('after restarting, a previously resized agent view opens at the size it was given with the terminal filling it', async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-agent-view-')), bin = join(directory, 'bin'), repo = join(directory, 'repo');
  await mkdir(bin); await mkdir(repo);
  await writeFile(join(bin, 'claude'), `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/native-agent.mjs')).href)};\n`, { mode: 0o700 });
  const env = { ...process.env, ACT_TEST_DATA_DIR: directory, CLAUDE_CONFIG_DIR: join(directory, 'claude-history'), PATH: `${bin}:${process.env.PATH}` };
  let app = await electron.launch({ args: ['.'], env });
  try {
    let page = await app.firstWindow();
    await page.getByRole('button', { name: 'Create your first project' }).click();
    await page.getByLabel('Title', { exact: true }).fill('Agent project');
    await page.getByLabel('Project summary', { exact: true }).fill('BILLING_BRIEF');
    await page.getByLabel('Project working directory', { exact: true }).fill(repo);
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await openProjectPicker(page, 'Agent project');
    await page.getByRole('button', { name: 'Agent session', exact: true }).click();
    await page.getByLabel('Title', { exact: true }).fill('Sized Claude');
    await page.getByRole('button', { name: 'Start Claude', exact: true }).click();
    await page.getByRole('article', { name: 'Sized Claude' }).click();
    await expect(page.locator('.xterm-accessibility')).toContainText('NATIVE_IDLE:');
    const handle = page.getByRole('button', { name: 'Resize view: Sized Claude' }), grip = (await handle.boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2 - 260, grip.y + grip.height / 2 - 160, { steps: 10 }); await page.mouse.up();
    await page.waitForTimeout(400);
    const sized = (await page.getByRole('region', { name: 'Sized Claude', exact: true }).boundingBox())!;
    await page.getByRole('button', { name: 'Back to project' }).click();
    await exitWithoutShutdown(app); app = await electron.launch({ args: ['.'], env }); page = await app.firstWindow();
    await page.getByRole('article', { name: 'Sized Claude' }).click();
    const view = page.getByRole('region', { name: 'Sized Claude', exact: true });
    await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');
    await expect.poll(async () => { const box = await view.boundingBox(); return box && [Math.round(box.width), Math.round(box.height)]; }).toEqual([Math.round(sized.width), Math.round(sized.height)]);
    await page.waitForTimeout(600);
    await page.screenshot({ path: 'test-results/agent-view-first-open.png' });
    const gap = await terminalGap(page);
    expect(gap.height).toBeLessThan(gap.cell + 1); expect(gap.width).toBeLessThan(gap.cell * 2 + 24);
  } finally {
    await exitWithoutShutdown(app);
    for (const connect of [() => connectWorkspace(directory), () => connectSupervisor(join(directory, 'runtime'))]) {
      const client = await connect().catch(() => undefined);
      if (client) { const disconnected = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await disconnected; client.close(); }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
