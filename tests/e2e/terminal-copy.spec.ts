import { expect } from '@playwright/test';
import { resolve } from 'node:path';
import { test } from './visual-fixture.ts';

// Finder/Dock starts have no shell locale. Exercise that production boundary.
test.use({ launchEnv: { LANG: '', LC_ALL: '', LC_CTYPE: '' } });

for (const mode of ['terminal-selection', 'native-selection']) test(`drag-selected ${mode} Unicode reaches the native clipboard unchanged`, async ({ visual: { app, page } }) => {
  test.skip(process.platform !== 'darwin', 'macOS copy path');
  // Materialize every original format in main-process memory, never in test
  // output/files. Restore only if the clipboard still contains our fixture.
  await app.evaluate(async ({ clipboard, ClipboardItem }) => {
    const original = await clipboard.read();
    (globalThis as any).clipboardBeforeTest = await Promise.all(original.map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))));
  });
  try {
    await page.evaluate(async () => {
      const { state } = await window.craftingTable.workspaceRead();
      await window.craftingTable.resourceCreate({ requestId: crypto.randomUUID(), nodeId: crypto.randomUUID(), resourceId: crypto.randomUUID(),
        expectedRevision: state.revision, pluginId: 'terminal.session', title: 'Unicode copy', projectId: 'billing', position: { x: 600, y: 600 }, data: { cwd: '/tmp' } });
    });
    await page.getByRole('article', { name: 'Unicode copy' }).click();
    await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(`${quote(process.execPath)} ${quote(resolve('tests/fixtures/unicode-terminal.mjs'))} ${mode}\n`);
    await expect(page.locator('.xterm-accessibility-tree')).toContainText('120–340KB');
    const first = (await page.locator('.xterm-accessibility-tree > div').first().boundingBox())!;
    const fourth = (await page.locator('.xterm-accessibility-tree > div').nth(3).boundingBox())!;
    await page.mouse.move(first.x + 1, first.y + first.height / 2); await page.mouse.down();
    await page.mouse.move(fourth.x + fourth.width - 1, fourth.y + fourth.height / 2, { steps: 12 }); await page.mouse.up();
    if (mode === 'native-selection') await expect(page.locator('.xterm-accessibility-tree')).toContainText('COPIED_BY_NATIVE_FIXTURE');
    await page.keyboard.press('Meta+c');
    await expect.poll(() => app.evaluate(async ({ clipboard }) => {
      const text = await clipboard.readText();
      // Return only equality flags; never report unrelated clipboard content.
      return { unicode: text.includes('┌────────────┬───────────┐') && text.includes('120–340KB') && text.includes('Grüße') && text.includes('世界 🛠'), corrupted: text.includes('‚î') };
    })).toEqual({ unicode: true, corrupted: false });
  } finally {
    await app.evaluate(async ({ clipboard }) => {
      if ((await clipboard.readText()).includes('Copy test')) await clipboard.write((globalThis as any).clipboardBeforeTest);
      delete (globalThis as any).clipboardBeforeTest;
    });
  }
});
