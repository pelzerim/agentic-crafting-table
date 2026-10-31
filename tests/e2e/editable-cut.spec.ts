import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';

async function withApp(run: (app: ElectronApplication, page: Page, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-editable-cut-')), profile = join(directory, 'profile'); await mkdir(profile);
  await writeFile(join(profile, '.zshrc'), "PROMPT='CUT> '\nunset HISTFILE\n");
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory, SHELL: '/bin/zsh', ZDOTDIR: profile } });
  // These tests use the real clipboard; put back what the person had on it.
  await app.evaluate(async ({ clipboard, ClipboardItem }) => {
    (globalThis as any).clipboardBeforeTest = await Promise.all((await clipboard.read()).filter(item => item.types.length).map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))));
  });
  try {
    const page = await app.firstWindow();
    // The open view scales in; a drag needs the terminal at its final size.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await run(app, page, directory);
  } finally {
    await app.evaluate(async ({ clipboard }) => { await clipboard.write((globalThis as any).clipboardBeforeTest); }).catch(() => {});
    await exitWithoutShutdown(app);
    for (const connect of [() => connectWorkspace(directory), () => connectSupervisor(join(directory, 'runtime'))]) {
      const client = await connect().catch(() => undefined);
      if (client) { const disconnected = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await disconnected; client.close(); }
    }
    await rm(directory, { recursive: true, force: true });
  }
}
const clipboard = (app: ElectronApplication) => app.evaluate(({ clipboard }) => clipboard.readText());

test('the cut key cuts selected text in the app\'s text fields', async () => {
  test.setTimeout(60_000);
  await withApp(async (app, page, directory) => {
    await page.getByRole('button', { name: 'Create your first project' }).click();
    for (const [label, text] of [['Title', 'a single line'], ['Project summary', 'several words\non two lines']]) {
      const field = page.getByLabel(label, { exact: true });
      await field.fill(text); await field.press('Control+a'); await field.press('Control+x');
      await expect(field).toHaveValue('');
      await expect.poll(() => clipboard(app)).toBe(text);
      await field.press('Control+v');
      await expect(field).toHaveValue(text);
    }
    await page.getByLabel('Project working directory', { exact: true }).fill(directory);
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await page.evaluate(async () => {
      const { state } = await window.craftingTable.workspaceRead();
      await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'cut-fixture' }, commands: [{ type: 'item.add', id: 'note', resourceId: 'note-resource', pluginId: 'workspace.note', title: 'Note', position: { x: 300, y: 300 }, data: { text: 'note text' } }] });
    });
    await page.locator('.paper-face').click();
    const editor = page.getByRole('textbox', { name: 'Note text' });
    await expect(editor).toHaveValue('note text');
    await editor.press('Control+a'); await editor.press('Control+x');
    await expect(editor).toHaveValue('');
    await expect.poll(() => clipboard(app)).toBe('note text');
  });
});

test('in a shell the cut key removes a selection from the command line and only copies output', async () => {
  test.setTimeout(60_000);
  await withApp(async (app, page, directory) => {
    await expect(page.getByText('Desktop connected')).toBeVisible();
    const sessionId = await page.evaluate(async cwd => {
      const id = crypto.randomUUID();
      await window.craftingTable.resourceCreate({ requestId: id, nodeId: crypto.randomUUID(), resourceId: crypto.randomUUID(), expectedRevision: 0, pluginId: 'terminal.session', title: 'Cut terminal', position: { x: 250, y: 230 }, data: { cwd } });
      return id;
    }, directory);
    await page.getByRole('article', { name: 'Cut terminal' }).click();
    await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');
    const tree = page.locator('.xterm-accessibility');
    await expect(tree).toContainText('CUT>');
    const recording = async () => (await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).chunks.map(chunk => chunk.data).join('');
    const select = async (rowText: string, word: string) => {
      const { cols, rows } = (await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).session;
      const box = (await page.locator('.xterm-screen').boundingBox())!, width = box.width / cols, height = box.height / rows;
      const [row, column] = await page.evaluate(([value, part]) => { const lines = [...document.querySelectorAll('.xterm-accessibility-tree > div')], index = lines.findIndex(line => line.textContent?.replaceAll(' ', ' ').includes(value)); return [index, lines[index].textContent!.replaceAll(' ', ' ').indexOf(part)]; }, [rowText, word]);
      const y = box.y + (row + .5) * height;
      await page.mouse.move(box.x + column * width + 1, y); await page.mouse.down();
      await page.mouse.move(box.x + (column + word.length) * width + 1, y, { steps: 4 }); await page.mouse.up();
    };
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('echo hello brave world');
    await expect(tree).toContainText('world');
    await select('echo hello', 'brave');
    await page.keyboard.press('Control+x');
    await expect.poll(() => clipboard(app)).toBe('brave');
    await expect.poll(async () => (await tree.textContent())!.replaceAll(' ', ' ')).toContain('echo hello  world');
    await page.keyboard.press('Enter');
    await expect.poll(recording).toContain('hello world\r\n');

    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('.xterm-accessibility-tree > div')].some(line => line.textContent?.replaceAll('\u00a0', ' ').trim() === 'hello world'))).toBe(true);
    await select('hello world', 'hello');
    await page.keyboard.press('Control+x');
    await expect.poll(() => clipboard(app)).toBe('hello');
    await page.keyboard.type('still typing');
    await expect(tree).toContainText('still typing');
    expect((await tree.textContent())!.replaceAll(' ', ' ')).toContain('echo hello  world');
    await expect(page.locator('.terminal-error')).toHaveCount(0);
  });
});
