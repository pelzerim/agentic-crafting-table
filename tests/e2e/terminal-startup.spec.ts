import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { resize } from './visual-fixture.ts';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';

test('Terminal keeps shell history, has no startup toggle and ignores legacy resume preferences after relaunch', async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-terminal-startup-')), profile = join(directory, 'profile'), work = join(directory, 'work');
  await mkdir(profile); await mkdir(work); await mkdir(join(work, 'nested'));
  await writeFile(join(profile, '.zshrc'), "PROMPT='ACT_TEST> '\nunset HISTFILE\n");
  const env = { ...process.env, ACT_TEST_DATA_DIR: directory, SHELL: '/bin/zsh', ZDOTDIR: profile };
  const launch = () => electron.launch({ args: ['.', '--force-device-scale-factor=1'], env });
  let app = await launch();
  try {
    let page = await app.firstWindow(); await resize(app, page, 1280, 800); await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.getByText('Desktop connected')).toBeVisible();
    const created = await page.evaluate(async cwd => {
      const id = crypto.randomUUID(), nodeId = crypto.randomUUID();
      await window.craftingTable.resourceCreate({ requestId: id, nodeId, resourceId: crypto.randomUUID(), expectedRevision: 0, pluginId: 'terminal.session', title: 'Development server', position: { x: 450, y: 300 }, data: { cwd } });
      return { id, nodeId };
    }, work);
    const open = async () => { await page.getByRole('article', { name: 'Development server', exact: true }).click(); await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running'); };
    await open();
    const checkbox = () => page.getByRole('checkbox', { name: 'Resume when starting Agentic Crafting Table', exact: true });
    await expect(page.getByRole('button', { name: 'History', exact: true })).toHaveCount(0);
    await expect(checkbox()).toHaveCount(0);
    await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type("cd nested\n");
    const command = "printf '%s\\n' 'STARTED' >> starts.txt";
    await page.keyboard.type(command + '\n');
    await expect.poll(() => readFile(join(work, 'nested/starts.txt'), 'utf8').catch(() => '')).toBe('STARTED\n');
    await page.keyboard.press('ArrowUp'); await page.keyboard.press('Enter');
    await expect.poll(() => readFile(join(work, 'nested/starts.txt'), 'utf8')).toBe('STARTED\nSTARTED\n');
    await page.evaluate(async nodeId => {
      const { state } = await window.craftingTable.workspaceRead();
      const node = state.nodes.find(node => node.id === nodeId)!, resource = state.resources.find(r => r.id === node.resourceId)!;
      await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'item.update', id: nodeId, data: { ...resource.data, resumeOnStartup: true } }] });
    }, created.nodeId);
    const quit = async () => {
      await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });
      const closed = app.waitForEvent('close'); await app.evaluate(({ app }) => { app.quit(); }); await closed;
    };
    await quit(); app = await launch(); page = await app.firstWindow();
    await expect(page.getByRole('article', { name: 'Development server', exact: true })).toBeVisible();
    await expect.poll(async () => (await page.evaluate(() => window.craftingTable.recoveryStatus())).phase).toBe('open');
    expect((await page.evaluate(() => window.craftingTable.sessionsList('all'))).filter(session => session.state === 'running')).toHaveLength(0);
    expect(await readFile(join(work, 'nested/starts.txt'), 'utf8')).toBe('STARTED\nSTARTED\n');
  } finally {
    await exitWithoutShutdown(app);
    for (const connect of [() => connectWorkspace(directory), () => connectSupervisor(join(directory, 'runtime'))]) {
      const client = await connect().catch(() => undefined);
      if (client) { const disconnected = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await disconnected; client.close(); }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
