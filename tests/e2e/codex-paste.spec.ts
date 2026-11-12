import { openProjectPicker } from './project-picker.ts';
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const START = '\x1b[200~', END = '\x1b[201~';

async function openCodex(run: (app: ElectronApplication, page: Page, received: () => Promise<string>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-codex-paste-')), bin = join(directory, 'bin'), repo = join(directory, 'repo'), log = join(directory, 'input.log');
  await mkdir(bin); await mkdir(repo); await writeFile(log, '');
  await writeFile(join(bin, 'codex'), `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/native-codex.mjs')).href)};\n`, { mode: 0o700 });
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory, CODEX_FIXTURE_HOME: repo, CODEX_FIXTURE_INPUT_LOG: log, PATH: `${bin}:${process.env.PATH}` } });
  // These tests use the real clipboard; put back what the person had on it.
  await app.evaluate(async ({ clipboard, ClipboardItem }) => {
    (globalThis as any).clipboardBeforeTest = await Promise.all((await clipboard.read()).filter(item => item.types.length).map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))));
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Create your first project' }).click();
    await page.getByLabel('Title', { exact: true }).fill('Paste project');
    await page.getByLabel('Project working directory', { exact: true }).fill(repo);
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await openProjectPicker(page, 'Paste project');
    await page.getByRole('button', { name: 'Agent session', exact: true }).click();
    await page.getByRole('radio', { name: 'Codex', exact: true }).check();
    await expect(page.getByLabel('Model', { exact: true })).not.toHaveValue('');
    await page.getByLabel('Title', { exact: true }).fill('Paste Codex');
    await page.getByRole('button', { name: 'Start Codex', exact: true }).click();
    await page.getByRole('article', { name: 'Paste Codex', exact: true }).click();
    await expect(page.locator('.xterm-accessibility')).toContainText('NATIVE_READY:');
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
    await run(app, page, () => readFile(log, 'utf8'));
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

test('the paste key pastes a large block of text into Codex as one complete bracketed paste', async () => {
  test.setTimeout(60_000);
  await openCodex(async (app, page, received) => {
    // Larger than one terminal write, with a numbered line to catch reordering.
    const text = Array.from({ length: 12_000 }, (_, line) => `line ${String(line).padStart(5, '0')} of a pasted block`).join('\n');
    expect(text.length).toBeGreaterThan(256 * 1024);
    await app.evaluate(async ({ clipboard }, value) => { await clipboard.writeText(value); }, text);
    await page.keyboard.press('ControlOrMeta+v');
    await expect.poll(async () => (await received()).includes(END), { timeout: 15_000 }).toBe(true);
    const input = await received();
    expect(input).not.toContain('\x16');
    expect(input.slice(input.indexOf(START) + START.length, input.indexOf(END))).toBe(text.replaceAll('\n', '\r'));
    await expect(page.locator('.terminal-error')).toHaveCount(0);
  });
});

test('the paste key with a screenshot on the clipboard gives Codex a local image path', async () => {
  test.setTimeout(60_000);
  await openCodex(async (app, page, received) => {
    await app.evaluate(async ({ clipboard, ClipboardItem }, png) => { await clipboard.write([new ClipboardItem({ 'image/png': new Blob([Buffer.from(png, 'base64')], { type: 'image/png' }) })]); }, PNG);
    await page.keyboard.press('ControlOrMeta+v');
    await expect.poll(async () => (await received()).includes(END), { timeout: 15_000 }).toBe(true);
    const input = await received();
    expect(input).not.toContain('\x16');
    const path = input.slice(input.indexOf(START) + START.length, input.indexOf(END));
    expect(path).toMatch(/\.png$/);
    expect((await readFile(path)).subarray(1, 4).toString()).toBe('PNG');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(page.locator('.terminal-error')).toHaveCount(0);
  });
});

test('Ctrl+Shift+V pastes through the same path, and an empty clipboard sends nothing', async () => {
  test.skip(process.platform === 'darwin', 'macOS leaves Ctrl+V to the agent and has no Ctrl+Shift+V paste');
  test.setTimeout(60_000);
  await openCodex(async (app, page, received) => {
    await app.evaluate(async ({ clipboard }) => { await clipboard.writeText('short text'); });
    await page.keyboard.press('Control+Shift+v');
    await expect.poll(received).toContain(`${START}short text${END}`);
    await app.evaluate(async ({ clipboard }) => { await clipboard.clear(); });
    await page.keyboard.press('Control+v');
    await page.keyboard.type('after\n');
    await expect.poll(received).toContain('after');
    const input = await received();
    expect(input.split(START)).toHaveLength(2);
    expect(input).not.toContain('\x16');
  });
});

test('dropping an image on the terminal types its path, as a terminal app does', async () => {
  test.setTimeout(60_000);
  await openCodex(async (_app, page, received) => {
    // A browser image has no file on disk behind it, so it is saved like a pasted one.
    const accepted = await page.locator('.terminal-host .xterm-screen').evaluate((target, png) => {
      const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(atob(png), c => c.charCodeAt(0))], 'shot.png', { type: 'image/png' }));
      const over = new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true });
      target.dispatchEvent(over);
      target.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
      return over.defaultPrevented;
    }, PNG);
    expect(accepted).toBe(true);
    await expect.poll(async () => (await received()).includes(END), { timeout: 15_000 }).toBe(true);
    const input = await received(), path = input.slice(input.indexOf(START) + START.length, input.indexOf(END));
    expect(path).toMatch(/\.png$/);
    expect((await readFile(path)).subarray(1, 4).toString()).toBe('PNG');
    await expect(page.locator('.terminal-error')).toHaveCount(0);
  });
});
