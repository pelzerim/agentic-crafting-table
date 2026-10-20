import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { join, resolve } from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from './visual-fixture.ts';

const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
async function start(page: Page, mode: string) {
  await page.evaluate(async () => {
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.resourceCreate({ requestId: crypto.randomUUID(), nodeId: crypto.randomUUID(), resourceId: crypto.randomUUID(), expectedRevision: state.revision,
      pluginId: 'terminal.session', title: 'Terminal interaction', projectId: 'billing', position: { x: 700, y: 650 }, data: { cwd: '/tmp' } });
  });
  await page.getByRole('article', { name: 'Terminal interaction', exact: true }).click();
  await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(`${quote(process.execPath)} ${quote(resolve('tests/fixtures/interactive-terminal.mjs'))} ${mode}\n`);
  await expect(page.locator('.xterm-accessibility-tree')).toContainText('Terminal interaction fixture');
}
async function linkPoint(page: Page, text: string, offset = 3) {
  const row = page.locator('.terminal-surface:visible .xterm-accessibility-tree > div').filter({ hasText: text }).first();
  await expect(row).toBeVisible();
  const index = (await row.textContent())!.indexOf(text) + offset, box = (await row.boundingBox())!;
  const cols = await page.locator('.terminal-surface:visible').evaluate(async surface => (await window.craftingTable.sessionRead(surface.getAttribute('data-terminal-id')!.split(':')[0])).session.cols);
  return { x: box.x + (index + .5) * box.width / cols, y: box.y + box.height / 2 };
}
for (const mode of ['', 'no-paste']) test(`Shift+Enter inserts a newline and Enter submits once (${mode || 'bracketed paste'})`, async ({ visual: { page } }) => {
  await start(page, mode);
  await page.keyboard.type('first'); await page.keyboard.press('Shift+Enter'); await page.keyboard.type('second');
  await expect(page.locator('.xterm-accessibility-tree')).toContainText('Draft: "first\\nsecond"');
  await expect(page.locator('.xterm-accessibility-tree')).toContainText('Submitted: ""');
  await expect(page.locator('.xterm-accessibility-tree')).toContainText(`Newline input: ${mode ? 'shift-enter' : 'paste'}`);
  await page.keyboard.press('Enter');
  await expect(page.locator('.xterm-accessibility-tree')).toContainText('Submitted: "first\\nsecond"');
  await expect(page.locator('.xterm-accessibility-tree')).toContainText('Draft: ""');
});

test('agent views send native Shift+Enter even with bracketed paste enabled', async ({ visual: { page } }) => {
  await start(page, '');
  const sessionId = (await page.locator('.terminal-surface').getAttribute('data-terminal-id'))!;
  await page.getByRole('button', { name: 'Back to project', exact: true }).click();
  // Attach the agent view to this isolated local CLI; no Claude process/model.
  await page.evaluate(async sessionId => {
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'test' }, commands: [
      { type: 'item.create', id: 'agent-input', projectId: 'billing', position: { x: 650, y: 850 }, resource: { id: 'agent-input-r', pluginId: 'agent.session', schemaVersion: 1, title: 'Agent input', data: { sessionId, provider: 'claude' } } },
    ] });
  }, sessionId);
  await page.getByRole('article', { name: 'Agent input', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Agent session menu' })).toBeVisible();
  await expect(page.locator('.native-terminal:visible')).toHaveAttribute('data-session-state', 'running');
  await page.locator('.terminal-surface:visible .xterm-helper-textarea').focus();
  await page.keyboard.type('first'); await page.keyboard.press('Shift+Enter'); await page.keyboard.type('second');
  const output = page.locator('.terminal-surface:visible .xterm-accessibility-tree');
  await expect(output).toContainText('Draft: "first\\nsecond"');
  await expect(output).toContainText('Newline input: shift-enter');
  await expect(output).toContainText('Submitted: ""');
  await page.keyboard.press('Enter');
  await expect(output).toContainText('Submitted: "first\\nsecond"');
});

for (const mode of ['', 'mouse']) test(`terminal URLs and OSC links offer safe actions without input or navigation (${mode || 'normal'})`, async ({ visual: { app, page } }) => {
  // Exercise the actual isolated IPC boundary without touching the user's
  // clipboard or opening a network/browser window. Unicode clipboard has its
  // own existing real-pasteboard regressions.
  await app.evaluate(({ clipboard, shell }) => {
    (globalThis as any).linkActions = [];
    clipboard.writeText = async text => { (globalThis as any).linkActions.push(['copy', text]); };
    shell.openExternal = async url => { (globalThis as any).linkActions.push(['open', url]); };
  });
  await start(page, mode);
  const url = 'https://example.com/pr/42?hello=world#review';
  const point = await linkPoint(page, url);
  await page.mouse.move(point.x, point.y);
  await expect(page.locator('.xterm-screen')).toHaveClass(/xterm-cursor-pointer/);
  expect(await app.evaluate(() => (globalThis as any).linkActions)).toEqual([]);
  await page.mouse.click(point.x, point.y);
  const menu = page.getByRole('menu', { name: 'Terminal link', exact: true });
  await expect(menu).toContainText(url); await expect(menu.getByRole('menuitem', { name: 'Copy link', exact: true })).toBeFocused();
  await expect(page.locator('.xterm-accessibility-tree')).toContainText('Mouse reports: 0');
  await expect(menu).toHaveScreenshot('terminal-link-menu.png');
  await page.keyboard.press('Enter'); await expect(menu).toHaveCount(0);
  expect(await app.evaluate(() => (globalThis as any).linkActions)).toEqual([['copy', url]]);
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
  const osc = await linkPoint(page, 'Architecture overview'); await page.mouse.move(osc.x, osc.y); await page.mouse.click(osc.x, osc.y);
  await expect(menu).toContainText('https://example.com/architecture?pr=42');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  expect(await app.evaluate(() => (globalThis as any).linkActions)).toEqual([['copy', url], ['open', 'https://example.com/architecture?pr=42']]);
  await expect(page.locator('.map-area')).not.toHaveAttribute('data-focus', '');
  // A continuation row is still one complete URL supplied by xterm's addon.
  const wrapped = await linkPoint(page, 'long-path/'); await page.mouse.move(wrapped.x, wrapped.y); await page.mouse.click(wrapped.x, wrapped.y);
  await expect(menu).toContainText('https://example.com/' + 'long-path/'.repeat(15) + 'end');
  await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0);
  await page.mouse.click(point.x, point.y); await expect(menu).toBeVisible();
  await page.getByRole('button', { name: 'Back to project' }).click(); await expect(menu).toHaveCount(0);
  await page.getByRole('article', { name: 'Terminal interaction', exact: true }).click();
  await expect(page.getByRole('button', { name: 'History', exact: true })).toHaveCount(0);
  await expect(page.locator('.terminal-surface:visible .xterm-helper-textarea')).toBeFocused();
  await page.mouse.move(point.x, point.y, { steps: 10 });
  await expect(page.locator('.terminal-surface:visible .xterm-screen')).toHaveClass(/xterm-cursor-pointer/);
  // Drag selection retains its normal behavior and never opens the link menu.
  await page.keyboard.down('Shift'); await page.mouse.move(point.x, point.y); await page.mouse.down();
  await page.mouse.move(point.x + 50, point.y, { steps: 8 }); await page.mouse.up(); await page.keyboard.up('Shift');
  await expect(menu).toHaveCount(0);
  await page.mouse.click(point.x, point.y); await expect(menu).toBeVisible(); await page.keyboard.press('Escape');
  await expect(page.locator('.terminal-surface:visible .xterm-accessibility-tree')).toContainText('Submitted: \"\"');
  await expect(page.locator('.terminal-surface:visible .xterm-accessibility-tree')).toContainText('Mouse reports: 0');
  await expect(page.locator('.terminal-surface:visible .xterm-accessibility-tree')).toContainText('Draft: \"\"');
  await page.getByRole('button', { name: 'Stop session', exact: true }).click();
  await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'exited');
  const stopped = await linkPoint(page, url); await page.mouse.move(stopped.x, stopped.y, { steps: 10 });
  await expect(page.locator('.terminal-surface:visible .xterm-screen')).toHaveClass(/xterm-cursor-pointer/);
  await page.mouse.click(stopped.x, stopped.y);
  await expect(menu).toBeVisible(); await page.keyboard.press('Escape');
  for (const action of ['openUrl', 'copyUrl'] as const) expect(await page.evaluate(async action => {
    try { await window.craftingTable[action]('javascript:alert(1)'); return false; } catch { return true; }
  }, action)).toBe(true);
});

test('Shift+Enter in a real zsh prompt inserts a second command line without executing the first', async ({ visual: { page } }) => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-newline-')), file = join(directory, 'proof.txt');
  try {
    await start(page, ''); await page.keyboard.press('Control+c');
    await page.keyboard.type("/bin/zsh -f\n"); await page.keyboard.type("printf '\\nZSH_READY\\n'\n");
    await expect(page.locator('.xterm-accessibility-tree > div').filter({ hasText: /^ZSH_READY$/ })).toBeVisible();
    await page.keyboard.type(`printf first > ${quote(file)}`); await page.keyboard.press('Shift+Enter');
    await page.keyboard.type(`printf second >> ${quote(file)}`);
    await expect(page.locator('.xterm-accessibility-tree')).toContainText('printf second');
    expect(await readFile(file, 'utf8').catch(() => '')).toBe('');
    await page.keyboard.press('Enter');
    await expect.poll(() => readFile(file, 'utf8').catch(() => '')).toBe('firstsecond');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
