import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from './visual-fixture.ts';
import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

let directory: string;
test.beforeEach(() => { directory = realpathSync(mkdtempSync(join(tmpdir(), 'act-text-editor-'))); });
test.afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

async function addFile(page: Page, name: string, language?: string, id = 'file') {
  const path = join(directory, name);
  await page.evaluate(async ({ path, name, language, id }) => {
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [
      { type: 'item.create', id, projectId: 'billing', position: { x: id === 'file' ? 300 : 620, y: 560 }, resource: { id: `${id}-resource`, pluginId: 'workspace.text', schemaVersion: 1, title: name, data: { path, ...(language ? { language } : {}) } } },
    ] as never });
  }, { path, name, language, id });
  return { path, card: page.getByRole('article', { name }) };
}

async function openFile(page: Page, name: string, language?: string) {
  const { path, card } = await addFile(page, name, language);
  await card.click();
  const region = page.getByRole('region', { name });
  await expect(region.locator('.text-file-view')).toBeVisible();
  return { path, region, view: region.locator('.text-file-view'), editor: region.locator('.cm-content') };
}

async function resizeFile(page: Page, size: 'small' | 'medium' | 'large') {
  await page.evaluate(async size => {
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'node.resize', id: 'file', size }] as never });
  }, size);
}

async function saveAutomatically(page: Page, enabled: boolean) {
  await page.evaluate(async enabled => {
    const saved = await window.craftingTable.settingsRead();
    await window.craftingTable.settingsWrite({ expectedRevision: saved.revision, value: { ...saved.value, plugins: { ...saved.value.plugins, 'workspace.text': { ...saved.value.plugins['workspace.text'], saveAutomatically: enabled } } } });
  }, enabled);
}

const savedState = (page: Page) => page.evaluate(async () => JSON.stringify((await window.craftingTable.workspaceRead()).state));

test('a Markdown file opens rendered, and typing in Edit saves to the file on disk', async ({ visual: { page } }) => {
  writeFileSync(join(directory, 'plan.md'), '# Plan\n\nFirst step\n\n```ts\nconst answer = 42;\n```\n');
  const { path, region, view, editor } = await openFile(page, 'plan.md');
  await expect(region.locator('.text-file-preview h1')).toHaveText('Plan');
  const code = region.locator('.text-file-preview pre code');
  await expect(code.locator('.tok-keyword')).toHaveText('const');
  await expect(code).toHaveText('const answer = 42;');
  expect(await code.locator('.tok-keyword').evaluate(element => getComputedStyle(element).color)).not.toBe(await code.evaluate(element => getComputedStyle(element).color));
  await expect(view).toHaveAttribute('data-mode', 'preview');
  await expect(region.locator('.view-meta')).toContainText('Markdown');
  await expect(region.locator('.text-file-editor')).toBeHidden();

  await region.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(view).toHaveAttribute('data-mode', 'edit');
  await expect(region.locator('.text-file-preview')).toBeHidden();
  await expect(editor).toBeFocused();
  await expect(editor.locator('.tok-heading', { hasText: 'Plan' })).toBeVisible();
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.type('Second step');
  await expect.poll(() => readFileSync(path, 'utf8')).toBe('# Plan\n\nFirst step\n\n```ts\nconst answer = 42;\n```\nSecond step');
  await expect(view).not.toHaveAttribute('data-unsaved', '');

  await page.keyboard.type('!');
  await page.keyboard.press('Meta+s');
  await expect.poll(() => readFileSync(path, 'utf8'), { intervals: [50], timeout: 500 }).toMatch(/Second step!$/);

  await region.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(region.locator('.text-file-preview')).toContainText('Second step!');
  expect((await page.evaluate(() => window.craftingTable.workspaceRead())).state.resources.find(resource => resource.id === 'file-resource')!.data).toEqual({ path });
});

test('a click on the text of a Markdown preview opens the editor there; a link and a text selection leave the preview', async ({ visual: { app, page } }) => {
  await app.evaluate(({ shell }) => { (globalThis as any).openedUrls = []; shell.openExternal = async (url: string) => { (globalThis as any).openedUrls.push(url); }; });
  const filler = Array.from({ length: 60 }, (_, index) => `Paragraph ${index + 1} of the plan`).join('\n\n');
  writeFileSync(join(directory, 'plan.md'), `# Plan\n\nFirst step\n\nSee [the docs](https://example.com/docs) here\n\n${filler}\n\nLast step\n`);
  const { path, region, view, editor } = await openFile(page, 'plan.md');
  const preview = region.locator('.text-file-preview');
  const paragraph = (text: string) => preview.locator('p', { hasText: text }).last();
  await expect(view).toHaveAttribute('data-mode', 'preview');

  await preview.getByRole('link', { name: 'the docs' }).click();
  await expect.poll(() => app.evaluate(() => (globalThis as any).openedUrls)).toEqual(['https://example.com/docs']);
  await expect(view).toHaveAttribute('data-mode', 'preview');

  const box = (await paragraph('First step').boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 4 }); await page.mouse.up();
  expect(await page.evaluate(() => getSelection()!.toString())).not.toBe('');
  await page.waitForTimeout(200);
  await expect(view).toHaveAttribute('data-mode', 'preview');

  await paragraph('First step').evaluate(element => (element as HTMLElement).click());
  await expect(view).toHaveAttribute('data-mode', 'edit');
  await region.getByRole('button', { name: 'Preview', exact: true }).click();

  await paragraph('First step').click({ position: { x: 1, y: box.height / 2 } });
  await expect(view).toHaveAttribute('data-mode', 'edit');
  await expect(editor).toBeFocused();
  await page.keyboard.type('Very ');
  await expect.poll(() => readFileSync(path, 'utf8')).toContain('\n\nVery First step\n\nSee [the docs]');

  await region.getByRole('button', { name: 'Preview', exact: true }).click();
  await paragraph('Last step').scrollIntoViewIfNeeded();
  await paragraph('Last step').click({ position: { x: 1, y: 8 } });
  await expect(view).toHaveAttribute('data-mode', 'edit');
  await expect(editor.locator('.cm-line', { hasText: 'Last step' })).toBeInViewport();
  await page.keyboard.type('The ');
  await expect.poll(() => readFileSync(path, 'utf8')).toMatch(/Paragraph 60 of the plan\n\nThe Last step\n$/);
});

test('a click in a table, a code block, a quote, a list and after an entity of a Markdown preview puts the caret on the clicked text', async ({ visual: { page } }) => {
  writeFileSync(join(directory, 'places.md'), '| k | v |\n|---|---|\n| a | 1 |\n| b | 1 |\n\n```js\nif (a) b = 1;\nif (a) c = 2;\n```\n\n> first line\n> second line\n\n- item one\n  continues here\n\nTom &amp; Jerry\n');
  const { path, region, view, editor } = await openFile(page, 'places.md');
  const preview = region.locator('.text-file-preview');
  const pointOf = (text: string, occurrence: number) => preview.evaluate((element, [text, occurrence]) => {
    const texts = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let seen = 0;
    for (let node = texts.nextNode(); node; node = texts.nextNode()) {
      for (let at = node.nodeValue!.indexOf(text); at >= 0; at = node.nodeValue!.indexOf(text, at + 1)) {
        if (seen++ < occurrence) continue;
        const range = document.createRange();
        range.setStart(node, at); range.setEnd(node, at + 1);
        const box = range.getBoundingClientRect();
        return { x: box.left + 1, y: box.top + box.height / 2 };
      }
    }
    throw new Error(`The preview does not show ${text}`);
  }, [text, occurrence] as const);
  const places: [string, number, string][] = [
    ['1', 1, '| a | 1 |\n| b | X1 |'], ['if', 1, 'if (a) b = 1;\nXif (a) c = 2;'], ['second line', 0, '> first line\n> Xsecond line'],
    ['continues', 0, '- item one\n  Xcontinues here'], ['Jerry', 0, 'Tom &amp; XJerry'],
  ];
  for (const [text, occurrence, written] of places) {
    await expect(view).toHaveAttribute('data-mode', 'preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText(text);
    const point = await pointOf(text, occurrence);
    await page.mouse.click(point.x, point.y);
    await expect(view).toHaveAttribute('data-mode', 'edit');
    await expect(editor).toBeFocused();
    await page.keyboard.type('X');
    await expect.poll(() => readFileSync(path, 'utf8'), { message: `a click on ${text}` }).toContain(written);
    await region.getByRole('button', { name: 'Preview', exact: true }).click();
  }
});

test('a click with a modifier key leaves the Markdown preview', async ({ visual: { page } }) => {
  const filler = Array.from({ length: 60 }, (_, index) => `Paragraph ${index + 1} of the plan`).join('\n\n');
  writeFileSync(join(directory, 'plan.md'), `# Plan\n\nFirst step\n\n${filler}\n\nLast step\n`);
  const { region, view } = await openFile(page, 'plan.md');
  const preview = region.locator('.text-file-preview');
  const paragraph = (text: string) => preview.locator('p', { hasText: text }).last();
  await expect(view).toHaveAttribute('data-mode', 'preview');

  for (const modifier of ['Shift', 'Meta', 'Alt'] as const) {
    await paragraph('First step').click({ modifiers: [modifier], position: { x: 1, y: 8 } });
    await expect(view).toHaveAttribute('data-mode', 'preview');
  }
});

test('a double click on the text of a Markdown preview opens the editor where the first click was', async ({ visual: { page } }) => {
  const filler = Array.from({ length: 60 }, (_, index) => `Paragraph ${index + 1} of the plan`).join('\n\n');
  writeFileSync(join(directory, 'plan.md'), `# Plan\n\nFirst step\n\n${filler}\n\nLast step\n`);
  const { path, region, view, editor } = await openFile(page, 'plan.md');
  const paragraph = region.locator('.text-file-preview p', { hasText: 'Last step' });
  await paragraph.scrollIntoViewIfNeeded();
  await paragraph.dblclick({ position: { x: 1, y: 8 } });
  await expect(view).toHaveAttribute('data-mode', 'edit');
  await expect(editor).toBeFocused();
  await page.keyboard.type('The ');
  await expect.poll(() => readFileSync(path, 'utf8')).toMatch(/Paragraph 60 of the plan\n\nThe Last step\n$/);

  await editor.locator('.cm-line', { hasText: 'Paragraph 60' }).dblclick({ position: { x: 4, y: 8 } });
  await page.keyboard.type('Part');
  await expect.poll(() => readFileSync(path, 'utf8')).toMatch(/\n\nPart 60 of the plan\n\nThe Last step\n$/);
});

test('code blocks in the Markdown preview take the colours of the language their fence names, and stay text', async ({ visual: { page } }) => {
  writeFileSync(join(directory, 'blocks.md'), '<mark>raw</mark>\n\n```\nplain block\n```\n\n```html\n<b onclick="window.fired = true">bold</b>\n```\n\n- step\n\n  ```py\n  answer = 42  # six by seven\n  ```\n\n```mermaid\ngraph TD\n```\n');
  const { region } = await openFile(page, 'blocks.md');
  const preview = region.locator('.text-file-preview'), blocks = preview.locator('pre > code');
  await expect(blocks).toHaveCount(4);
  await expect(blocks.nth(2).locator('.tok-number')).toHaveText('42');
  await expect(blocks.nth(2).locator('.tok-comment')).toHaveText('# six by seven');
  await expect(blocks.nth(1).locator('.tok-typeName').first()).toHaveText('b');
  await expect(blocks.nth(1)).toHaveText('<b onclick="window.fired = true">bold</b>');
  await expect(blocks.nth(0).locator('span')).toHaveCount(0);
  await expect(blocks.nth(3).locator('span')).toHaveCount(0);
  await expect(preview.locator('b, mark')).toHaveCount(0);
  await expect(preview).toContainText('<mark>raw</mark>');
  expect(await preview.locator('pre *').evaluateAll(elements => [...new Set(elements.map(element => element.tagName))].sort())).toEqual(['CODE', 'SPAN']);
});

test('a code file opens highlighted and read-only until Edit, with the language from its name or the item', async ({ visual: { page } }) => {
  writeFileSync(join(directory, 'answer.ts'), 'export const answer: number = 42; // six by seven\nexport const unit = "none";\n');
  const { path, region, editor } = await openFile(page, 'answer.ts');
  await expect(region.locator('.view-meta')).toContainText('TypeScript');
  await expect(editor.locator('.tok-keyword').first()).toHaveText('export');
  const colorOf = (selector: string) => editor.locator(selector).first().evaluate(element => getComputedStyle(element).color);
  const plain = await editor.evaluate(element => getComputedStyle(element).color);
  const colors = [await colorOf('.tok-keyword'), await colorOf('.tok-number'), await colorOf('.tok-string'), await colorOf('.tok-typeName'), await colorOf('.tok-comment')];
  expect(new Set([plain, ...colors]).size).toBe(6);
  await expect(editor).toHaveAttribute('contenteditable', 'false');
  await editor.click(); await page.keyboard.type('lost');
  await region.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await page.keyboard.press('Meta+ArrowDown'); await page.keyboard.type('// kept');
  await expect.poll(() => readFileSync(path, 'utf8')).toBe('export const answer: number = 42; // six by seven\nexport const unit = "none";\n// kept');
});

test('a change on disk replaces the open text quietly, and asks only beside unsaved edits', async ({ visual: { page } }) => {
  writeFileSync(join(directory, 'notes.txt'), 'first\n');
  const { path, region, view, editor } = await openFile(page, 'notes.txt');
  await expect(region.locator('.view-meta')).toContainText('Plain text');
  await expect(editor).toHaveText('first');
  writeFileSync(path, 'changed outside\n');
  await expect(editor).toContainText('changed outside');
  await expect(region.locator('.text-file-changed')).toBeHidden();

  await region.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.keyboard.press('Meta+ArrowDown'); await page.keyboard.type('mine');
  writeFileSync(path, 'theirs\n');
  const bar = region.locator('.text-file-changed');
  await expect(bar).toContainText('Changed on disk');
  await expect(editor).toContainText('mine');
  expect(readFileSync(path, 'utf8')).toBe('theirs\n');
  await bar.getByRole('button', { name: 'Keep mine', exact: true }).click();
  await expect(bar).toBeHidden();
  await expect.poll(() => readFileSync(path, 'utf8')).toBe('changed outside\nmine');

  await expect(editor).toBeFocused();
  await page.keyboard.type(' again');
  writeFileSync(path, 'theirs, twice\n');
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(bar).toBeHidden();
  await expect(editor).toHaveText('theirs, twice');
  await expect(view).not.toHaveAttribute('data-unsaved', '');
  expect(readFileSync(path, 'utf8')).toBe('theirs, twice\n');
});

test('closing saves the edits over a change on disk that waited for a decision', async ({ visual: { page } }) => {
  writeFileSync(join(directory, 'notes.txt'), 'first\n');
  const { path, region, view, editor } = await openFile(page, 'notes.txt');
  await region.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.keyboard.press('Meta+ArrowDown'); await page.keyboard.type('mine');
  writeFileSync(path, 'theirs\n');
  const bar = region.locator('.text-file-changed');
  await expect(bar).toContainText('Changed on disk');
  await page.keyboard.press('Escape');
  await expect(region).toHaveCount(0);
  await expect.poll(() => readFileSync(path, 'utf8')).toBe('first\nmine');

  await page.getByRole('article', { name: 'notes.txt' }).click();
  await expect(editor).toContainText('mine');
  await expect(bar).toBeHidden();
  await expect(view).not.toHaveAttribute('data-unsaved', '');
});

test('with Save automatically off only ⌘S writes, and closing with unsaved edits asks first', async ({ visual: { page } }) => {
  await saveAutomatically(page, false);
  writeFileSync(join(directory, 'notes.txt'), 'first\n');
  const { path, region, view, editor } = await openFile(page, 'notes.txt');
  const prompt = region.locator('.text-file-close-prompt');
  await region.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.keyboard.press('Meta+ArrowDown'); await page.keyboard.type('mine');
  await expect(view).toHaveAttribute('data-unsaved', '');
  await expect(region.locator('.view-meta')).toContainText('Unsaved');
  await page.waitForTimeout(1200);
  await region.getByRole('button', { name: 'Preview', exact: true }).click();
  await region.getByRole('button', { name: 'Edit', exact: true }).click();
  expect(readFileSync(path, 'utf8')).toBe('first\n');
  await expect(view).toHaveAttribute('data-unsaved', '');

  await page.keyboard.press('Escape');
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText('Unsaved, really close?');
  await expect(prompt.getByRole('button', { name: 'Save and close', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(prompt).toBeHidden();
  await expect(view).toBeVisible();
  await expect(editor).toBeFocused();
  expect(readFileSync(path, 'utf8')).toBe('first\n');

  await page.keyboard.press('Escape');
  await prompt.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(prompt).toBeHidden();
  await expect(view).toBeVisible();
  await page.keyboard.press('Escape');
  await prompt.getByRole('button', { name: 'Close without saving', exact: true }).click();
  await expect(region).toHaveCount(0);
  expect(readFileSync(path, 'utf8')).toBe('first\n');

  await page.getByRole('article', { name: 'notes.txt' }).click();
  await expect(editor).toHaveText('first');
  await expect(view).not.toHaveAttribute('data-unsaved', '');
  await editor.click();
  await page.keyboard.press('Meta+ArrowDown'); await page.keyboard.type('kept');
  await page.keyboard.press('Meta+s');
  await expect.poll(() => readFileSync(path, 'utf8')).toBe('first\nkept');
  await expect(view).not.toHaveAttribute('data-unsaved', '');
  await expect(region.locator('.view-meta')).not.toContainText('Unsaved');
  await page.keyboard.press('Escape');
  await expect(region).toHaveCount(0);

  await page.getByRole('article', { name: 'notes.txt' }).click();
  await editor.click();
  await page.keyboard.press('Meta+ArrowDown'); await page.keyboard.type(' more');
  await page.keyboard.press('Escape');
  await prompt.getByRole('button', { name: 'Save and close', exact: true }).click();
  await expect(region).toHaveCount(0);
  await expect.poll(() => readFileSync(path, 'utf8')).toBe('first\nkept more');
});

test('a close whose save does not reach the disk asks with the reason, and closes once it is saved', async ({ visual: { page } }) => {
  writeFileSync(join(directory, 'notes.txt'), 'first\n');
  const { path, region, view } = await openFile(page, 'notes.txt');
  const prompt = region.locator('.text-file-close-prompt');
  await region.getByRole('button', { name: 'Edit', exact: true }).click();
  chmodSync(path, 0o444);
  await page.keyboard.press('Meta+ArrowDown'); await page.keyboard.type('mine');
  await page.keyboard.press('Escape');
  await expect(prompt).toContainText('Not saved: No permission to write the file. Really close?');
  await expect(view).toBeVisible();
  await prompt.getByRole('button', { name: 'Save and close', exact: true }).click();
  await expect(prompt).toContainText('Not saved: No permission to write the file. Really close?');
  await expect(prompt.getByRole('button', { name: 'Save and close', exact: true })).toBeEnabled();
  await expect(view).toBeVisible();
  expect(readFileSync(path, 'utf8')).toBe('first\n');

  chmodSync(path, 0o644);
  await prompt.getByRole('button', { name: 'Save and close', exact: true }).click();
  await expect(region).toHaveCount(0);
  expect(readFileSync(path, 'utf8')).toBe('first\nmine');
});

test('travelling to Undermap asks the open text file before it leaves', async ({ visual: { page } }) => {
  await saveAutomatically(page, false);
  writeFileSync(join(directory, 'notes.txt'), 'first\n');
  const { path, region, view } = await openFile(page, 'notes.txt');
  const prompt = region.locator('.text-file-close-prompt');
  await region.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.keyboard.press('Meta+ArrowDown'); await page.keyboard.type('mine');
  await page.getByRole('button', { name: 'Go to Undermap', exact: true }).evaluate(portal => (portal as HTMLButtonElement).click());
  await expect(prompt).toBeVisible();
  await expect(view).toBeVisible();
  await expect(page.getByRole('button', { name: 'Go to Undermap', exact: true })).toHaveCount(1);
  expect(readFileSync(path, 'utf8')).toBe('first\n');

  await prompt.getByRole('button', { name: 'Save and close', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Back to the map', exact: true })).toHaveCount(1);
  expect(readFileSync(path, 'utf8')).toBe('first\nmine');
});

test('asking to travel twice while the open text file asks travels once', async ({ visual: { page } }) => {
  await saveAutomatically(page, false);
  await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'dark' });
  writeFileSync(join(directory, 'notes.txt'), 'first\n');
  const { region } = await openFile(page, 'notes.txt');
  const prompt = region.locator('.text-file-close-prompt'), portal = page.getByRole('button', { name: 'Go to Undermap', exact: true });
  await region.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.keyboard.press('Meta+ArrowDown'); await page.keyboard.type('mine');
  await page.evaluate(() => {
    const probe = window as unknown as { wipes: number }; probe.wipes = 0;
    new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) if (node instanceof Element && node.matches('.below-wipe')) probe.wipes++; })
      .observe(document.querySelector('.live-workspace')!, { childList: true });
  });
  await portal.evaluate(button => (button as HTMLButtonElement).click());
  await expect(prompt).toBeVisible();
  await portal.evaluate(button => (button as HTMLButtonElement).click());
  await prompt.getByRole('button', { name: 'Save and close', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Back to the map', exact: true })).toHaveCount(1);
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => (window as unknown as { wipes: number }).wipes)).toBe(1);
});

test('revealing an Undermap item asks the open text file once, and Cancel is not asked again', async ({ visual: { app, page } }) => {
  await saveAutomatically(page, false);
  writeFileSync(join(directory, 'notes.txt'), 'first\n'); writeFileSync(join(directory, 'other.txt'), 'other\n');
  await addFile(page, 'other.txt', undefined, 'other');
  await page.evaluate(async () => {
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'node.below', id: 'other' }] as never });
  });
  await expect(page.getByRole('article', { name: 'other.txt' })).toHaveCount(0);
  const { path, region, view } = await openFile(page, 'notes.txt');
  const prompt = region.locator('.text-file-close-prompt');
  // A notification that names the Undermap item is opened.
  const revealOther = () => app.evaluate(({ ipcMain, BrowserWindow }) => {
    ipcMain.removeHandler('app:notification-target');
    ipcMain.handleOnce('app:notification-target', () => ({ nodeId: 'other' }));
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('app:notification-open', null);
  });
  await region.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.keyboard.press('Meta+ArrowDown'); await page.keyboard.type('mine');

  await revealOther();
  await expect(prompt).toContainText('Unsaved, really close?');
  await revealOther();
  await page.waitForTimeout(200);
  await prompt.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForTimeout(500);
  await expect(prompt).toBeHidden();
  await expect(view).toBeVisible();
  await expect(page.getByRole('button', { name: 'Go to Undermap', exact: true })).toHaveCount(1);

  await revealOther();
  await prompt.getByRole('button', { name: 'Save and close', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Back to the map', exact: true })).toHaveCount(1);
  await expect(page.getByRole('article', { name: 'other.txt' })).toBeVisible();
  expect(readFileSync(path, 'utf8')).toBe('first\nmine');
});

test('another item takes the place of the open text file only once it agrees, and is recorded as opened only then', async ({ visual: { page } }) => {
  await saveAutomatically(page, false);
  writeFileSync(join(directory, 'notes.txt'), 'first\n'); writeFileSync(join(directory, 'other.txt'), 'other\n');
  await addFile(page, 'other.txt', undefined, 'other');
  const { path, region } = await openFile(page, 'notes.txt');
  const prompt = region.locator('.text-file-close-prompt'), recent = async () => (await page.evaluate(() => window.craftingTable.viewRead())).recentItems?.[0];
  const findOther = async () => {
    await region.locator('.view-meta').click();
    await page.keyboard.press('Meta+f');
    await page.getByRole('combobox', { name: 'Find on map' }).fill('other.txt');
    await page.keyboard.press('Enter');
  };
  await region.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.keyboard.press('Meta+ArrowDown'); await page.keyboard.type('mine');
  await expect.poll(recent).toBe('file');

  await findOther();
  await expect(prompt).toContainText('Unsaved, really close?');
  await prompt.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(region.locator('.text-file-view')).toBeVisible();
  await page.waitForTimeout(300);
  expect(await recent()).toBe('file');

  await findOther();
  await prompt.getByRole('button', { name: 'Save and close', exact: true }).click();
  await expect(page.getByRole('region', { name: 'other.txt' }).locator('.text-file-view')).toBeVisible();
  await expect.poll(recent).toBe('other');
  expect(readFileSync(path, 'utf8')).toBe('first\nmine');
});

test('quitting asks the open text file about unsaved edits, and Cancel keeps the app open', async ({ visual: { app, page } }) => {
  await saveAutomatically(page, false);
  writeFileSync(join(directory, 'notes.txt'), 'first\n');
  const { path, region, editor } = await openFile(page, 'notes.txt');
  const prompt = region.locator('.text-file-close-prompt');
  await region.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.keyboard.press('Meta+ArrowDown'); await page.keyboard.type('mine');
  await app.evaluate(({ app }) => { app.quit(); });
  await expect(prompt).toContainText('Unsaved, really close?');
  await prompt.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(prompt).toBeHidden();
  await expect(editor).toContainText('mine');
  expect(readFileSync(path, 'utf8')).toBe('first\n');
  expect((await page.evaluate(() => window.craftingTable.recoveryStatus())).phase).toBe('open');

  // The next quit asks again; a save lets it go on.
  const closed = app.waitForEvent('close');
  await app.evaluate(({ app }) => { app.quit(); });
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: 'Save and close', exact: true }).click();
  await closed;
  expect(readFileSync(path, 'utf8')).toBe('first\nmine');
});

test('quitting saves what was just typed', async ({ visual: { app, page } }) => {
  writeFileSync(join(directory, 'notes.txt'), 'first\n');
  const { path, region } = await openFile(page, 'notes.txt');
  await region.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.keyboard.press('Meta+ArrowDown'); await page.keyboard.type('mine');
  const closed = app.waitForEvent('close');
  await app.evaluate(({ app }) => { app.quit(); });
  await closed;
  expect(readFileSync(path, 'utf8')).toBe('first\nmine');
});

test('a missing file says so and is created only on request', async ({ visual: { page } }) => {
  const { path, region, editor } = await openFile(page, 'drafts/idea.md');
  await expect(region.locator('.view-chip')).toHaveText('File missing');
  await expect(region.locator('.text-file-blank')).toContainText('File missing');
  expect(existsSync(path)).toBe(false);
  await region.getByRole('button', { name: 'Create file', exact: true }).click();
  await expect(region.locator('.text-file-blank')).toBeHidden();
  expect(readFileSync(path, 'utf8')).toBe('');
  await region.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.keyboard.type('# Idea');
  await expect.poll(() => readFileSync(path, 'utf8')).toBe('# Idea');
  await expect(editor).toContainText('# Idea');
});

test('Reveal in Finder hands the file to the system, and is not offered while the file is missing', async ({ visual: { app, page } }) => {
  writeFileSync(join(directory, 'plan.md'), '# Plan\n');
  const { path, region } = await openFile(page, 'plan.md');
  const reveal = region.getByRole('button', { name: 'Reveal in Finder', exact: true });
  await reveal.click();
  await expect.poll(() => app.evaluate(() => (globalThis as any).actRevealedFiles)).toEqual([path]);
  rmSync(path);
  await expect(region.locator('.view-chip')).toHaveText('File missing');
  await expect(reveal).toBeHidden();
  expect(await page.evaluate(async () => { try { await window.craftingTable.revealFile('notes/plan.md'); return 'revealed'; } catch { return 'refused'; } })).toBe('refused');
  expect(await app.evaluate(() => (globalThis as any).actRevealedFiles)).toEqual([path]);
});

test('the pasted or dropped path of a file opens the text file form; a path with no file is still a note', async ({ visual: { app, page } }) => {
  const path = join(directory, 'plan.md'), dropped = join(directory, 'totals.ts');
  writeFileSync(path, '# Plan\n'); writeFileSync(dropped, 'export const total = 1;\n');
  const form = page.getByRole('form', { name: 'New item' });
  const state = async () => (await page.evaluate(() => window.craftingTable.workspaceRead())).state;
  const paste = async (text: string, point: { x: number; y: number }) => {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), text);
    await page.mouse.move(point.x, point.y); await page.mouse.click(point.x, point.y);
    await page.keyboard.press('Meta+v');
  };

  await paste(path, { x: 470, y: 650 });
  await expect(form.getByLabel('File', { exact: true })).toHaveValue(path);
  expect((await state()).resources.filter(resource => resource.pluginId === 'workspace.text')).toEqual([]);
  await form.locator('button[type="submit"]').click();
  await expect(page.getByRole('article', { name: 'plan.md' })).toBeVisible();
  const created = (await state()).resources.find(resource => resource.pluginId === 'workspace.text')!;
  expect(created.data).toEqual({ path }); expect(created.title).toBe('plan.md');

  for (const [text, x] of [[join(directory, 'absent.md'), 1000], [directory, 730]] as const) {
    await paste(text, { x, y: 650 });
    await expect.poll(async () => (await state()).resources.filter(resource => resource.pluginId === 'workspace.note').map(resource => resource.data.text)).toContain(text);
    await expect(form).toHaveCount(0);
  }

  await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'dropped-file-fixture'; input.hidden = true; document.body.append(input); });
  await page.locator('#dropped-file-fixture').setInputFiles(dropped);
  const drop = await page.locator('.map-area').evaluate(element => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add((document.querySelector('#dropped-file-fixture') as HTMLInputElement).files![0]);
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, clientX: 470, clientY: 720 });
    const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientX: 470, clientY: 720 });
    element.dispatchEvent(over); element.dispatchEvent(drop);
    return { overPrevented: over.defaultPrevented, dropPrevented: drop.defaultPrevented };
  });
  expect(drop).toEqual({ overPrevented: true, dropPrevented: true });
  await expect(form.getByLabel('File', { exact: true })).toHaveValue(dropped);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await expect(form).toHaveCount(0);
  expect((await state()).resources.filter(resource => resource.pluginId === 'workspace.text')).toHaveLength(1);
});

test('Escape closes what the editor has open before it closes the item, and completions carry no icons', async ({ visual: { page } }) => {
  writeFileSync(join(directory, 'retry.ts'), 'const retries = 3;\n');
  const { path, region, editor } = await openFile(page, 'retry.ts');
  await region.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.keyboard.press('Meta+ArrowDown'); await page.keyboard.type('ret');
  const completions = region.locator('.cm-tooltip-autocomplete');
  await expect(completions).toContainText('retries');
  await expect(completions.locator('.cm-completionIcon')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(completions).toHaveCount(0);
  await expect(editor).toBeFocused();

  await page.keyboard.press('Meta+f');
  const search = region.locator('.cm-search');
  await expect(search).toBeVisible();
  await editor.click();
  await page.keyboard.press('Escape');
  await expect(search).toHaveCount(0);
  await expect(editor).toBeVisible();

  await page.keyboard.press('Meta+ArrowDown'); await page.keyboard.type('urn');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await expect(region).toHaveCount(0);
  await expect.poll(() => readFileSync(path, 'utf8')).toBe('const retries = 3;\nreturn');
});

test(`the editor's fold marks, folded code mark and search close button are pixel glyphs in place of CodeMirror's characters`, async ({ visual: { page } }) => {
  writeFileSync(join(directory, 'answer.ts'), 'export function answer() {\n  return 42;\n}\n');
  const { region, editor } = await openFile(page, 'answer.ts');
  const drawn = (mark: Locator) => mark.evaluate(element => {
    const own = getComputedStyle(element), glyph = getComputedStyle(element, '::before');
    return { characters: own.fontSize, width: glyph.width, height: glyph.height, inked: glyph.backgroundColor === own.color, mask: glyph.maskImage };
  });
  const glyphDrawn = { characters: '0px', width: '8px', height: '8px', inked: true, mask: expect.stringMatching(/^url\("data:image\/svg\+xml,/) };

  const fold = region.locator('.cm-foldGutter span[title="Fold line"]');
  await expect(fold).toHaveCount(1);
  const foldMark = await drawn(fold);
  expect(foldMark).toEqual(glyphDrawn);
  await fold.click();
  const unfold = region.locator('.cm-foldGutter span[title="Unfold line"]:visible'), folded = region.locator('.cm-foldPlaceholder');
  await expect(unfold).toHaveCount(1);
  const unfoldMark = await drawn(unfold), foldedMark = await drawn(folded);
  expect(unfoldMark).toEqual(glyphDrawn);
  expect(foldedMark).toEqual(glyphDrawn);

  await editor.click();
  await page.keyboard.press('Meta+f');
  const close = region.locator('.cm-search button[name="close"]');
  await expect(close).toBeVisible();
  const closeMark = await drawn(close);
  expect(closeMark).toEqual(glyphDrawn);
  expect(new Set([foldMark.mask, unfoldMark.mask, foldedMark.mask, closeMark.mask]).size).toBe(4);
  const box = await close.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(16); expect(box!.height).toBeGreaterThanOrEqual(16);
  await close.click();
  await expect(region.locator('.cm-search')).toHaveCount(0);
});

test('a large card shows the first lines of a code file in its colours, and follows the file on disk', async ({ visual: { page } }) => {
  writeFileSync(join(directory, 'answer.ts'), `export const answer: number = 42;\nexport const unit = "none";\n${'// and so on\n'.repeat(80)}`);
  const { path, card } = await addFile(page, 'answer.ts');
  await expect(card).toBeVisible();
  await expect(card.locator('.card-node-view')).toHaveCount(0);

  await resizeFile(page, 'large');
  const face = card.locator('.text-file-card');
  await expect(face.locator('.tok-keyword').first()).toHaveText('export');
  await expect(face).toContainText('export const answer: number = 42;\nexport const unit = "none";\n');
  expect(await face.locator('.tok-comment').count()).toBeLessThan(80);
  expect(await face.locator('.tok-keyword').first().evaluate(element => getComputedStyle(element).color)).not.toBe(await face.locator('.tok-number').evaluate(element => getComputedStyle(element).color));
  const cardBox = (await card.boundingBox())!, faceBox = (await face.boundingBox())!;
  expect(faceBox.y + faceBox.height).toBeLessThanOrEqual(cardBox.y + cardBox.height);

  writeFileSync(path, 'let changed = true;\n');
  await expect(face).toHaveText('let changed = true;\n', { timeout: 12_000 });
  rmSync(path);
  await expect(face).toHaveText('File missing', { timeout: 12_000 });
  const saved = await savedState(page);
  expect(saved).not.toContain('answer: number'); expect(saved).not.toContain('changed = true');

  await resizeFile(page, 'small');
  await expect(card.locator('.card-node-view')).toHaveCount(0);
});

test('a large card shows the start of a Markdown file rendered, with raw HTML as text', async ({ visual: { page } }) => {
  writeFileSync(join(directory, 'plan.md'), '# Plan\n\nFirst <mark>step</mark>\n\n```ts\nconst answer = 42;\n```\n');
  const { card } = await addFile(page, 'plan.md');
  await resizeFile(page, 'large');
  const face = card.locator('.text-file-card');
  await expect(face.locator('h1')).toHaveText('Plan');
  await expect(face.locator('pre code .tok-keyword')).toHaveText('const');
  await expect(face.locator('mark')).toHaveCount(0);
  await expect(face).toContainText('<mark>step</mark>');
  expect(await savedState(page)).not.toContain('First');

  await card.click();
  await expect(page.getByRole('region', { name: 'plan.md' }).locator('.text-file-preview h1')).toHaveText('Plan');
});
