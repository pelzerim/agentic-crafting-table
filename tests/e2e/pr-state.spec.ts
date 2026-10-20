import { test, expect, _electron as electron } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { githubFixture, pullFixture } from '../fixtures/github.ts';
import { scrollbarArgs, resize } from './visual-fixture.ts';
import { prActions } from './pr-actions.ts';

const title = pullFixture.title;
async function start(prefix: string, providers = githubFixture()) {
  const directory = await mkdtemp(join(tmpdir(), prefix)), service = await startWorkspaceService(directory, undefined, undefined, providers);
  await service.control.dispatch({ commandId: 'add', expectedRevision: 0, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'item.add', id: 'pr', resourceId: 'pr-resource', pluginId: 'github.pull-request', title, position: { x: 0, y: 0 }, data: { owner: 'fixture', repo: 'billing', number: 42 } }] });
  await service.resources.poll();
  const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory, TZ: 'UTC' } });
  return { providers, service, app, page: await app.firstWindow(), close: async () => { await app.close(); await service.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } };
}
async function viewWidth(page: Page, view: Locator, width: number) {
  const handle = page.getByRole('button', { name: `Resize view: ${title}`, exact: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = (await view.boundingBox())!.width;
    if (Math.abs(current - width) < 1) return;
    const grip = (await handle.boundingBox())!, x = grip.x + grip.width / 2, y = grip.y + grip.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + width - current, y, { steps: 10 }); await page.mouse.up();
  }
}

test('right-click Change state converts to draft, marks ready and closes with a comment posted first', async () => {
  const { providers, page, close } = await start('craft-pr-state-menu-');
  try {
    const card = page.locator('[data-item-id="pr"]'), state = card.locator('[data-indicator="review-state"]');
    const submenu = page.getByRole('menu', { name: 'Change state', exact: true });
    const openMenu = async () => { await card.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Change state', exact: true }).hover(); };
    await expect(state).toHaveAttribute('aria-label', 'Open');
    await openMenu();
    await expect(submenu.getByRole('menuitem')).toHaveText([`Change #42 “${title}” on GitHub?`, 'Convert to draft', 'Close pull request…']);
    await submenu.getByRole('menuitem', { name: 'Convert to draft', exact: true }).click();
    await expect(state).toHaveAttribute('aria-label', 'Draft', { timeout: 20_000 });

    await openMenu();
    await expect(submenu.getByRole('menuitem')).toHaveText([/^Change #42/, 'Mark ready for review', 'Close pull request…']);
    await submenu.getByRole('menuitem', { name: 'Mark ready for review', exact: true }).click();
    await expect(state).toHaveAttribute('aria-label', 'Open', { timeout: 20_000 });

    await openMenu();
    await submenu.getByRole('menuitem', { name: 'Close pull request…', exact: true }).click();
    const confirm = submenu.getByRole('group', { name: 'Close pull request…', exact: true });
    await expect(confirm).toContainText(`Close #42 “${title}”? You can reopen it later.`);
    const comment = confirm.getByRole('textbox', { name: 'Comment (optional)' });
    await expect(comment).toBeFocused();
    await expect(submenu.getByRole('menuitem', { name: 'Convert to draft', exact: true })).toBeDisabled();
    // Typing keeps its caret keys and never reaches map shortcuts or menu navigation.
    await comment.pressSequentially('Superseded by #43.'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Home');
    await expect(comment).toHaveValue('Superseded by #43.');
    await expect(submenu).toHaveScreenshot('context-menu-pr-close-confirm.png');
    expect(providers.writes).toEqual(['draft:true', 'draft:false']);
    await confirm.getByRole('menuitem', { name: 'Close pull request', exact: true }).click();
    await expect(state).toHaveAttribute('aria-label', 'Closed', { timeout: 20_000 });
    expect(providers.writes).toEqual(['draft:true', 'draft:false', 'comment', 'state:closed']);
    expect(providers.posts).toEqual([{ path: '/repos/fixture/billing/issues/42/comments', body: 'Superseded by #43.' }]);

    await openMenu();
    await expect(submenu.getByRole('menuitem')).toHaveText([/^Change #42/, 'Reopen pull request']);
    await submenu.getByRole('menuitem', { name: 'Reopen pull request', exact: true }).click();
    await expect(state).toHaveAttribute('aria-label', 'Open', { timeout: 20_000 });
    expect(providers.writes.at(-1)).toBe('state:open');
  } finally { await close(); }
});

test('the PR view header toggles draft, closes without a comment, reopens and reports a missing permission', async () => {
  const { providers, page, close } = await start('craft-pr-state-view-');
  try {
    await page.locator('[data-item-id="pr"]').click();
    const view = page.locator('[data-expanded-item-id="pr"].expanded'), chip = view.locator('.view-header .view-chip');
    const draft = view.locator('.pr-draft-toggle'), closer = view.locator('.pr-close-toggle');
    await expect(chip).toHaveText('Open', { timeout: 20_000 });
    await expect(draft).toBeEnabled(); await expect(closer).toBeEnabled();

    await prActions(page, view).pick('Convert to draft');
    const draftMenu = page.getByRole('menu', { name: 'Convert to draft', exact: true });
    await expect(draftMenu.locator('.resource-choice-prompt')).toHaveText(`Change #42 “${title}” on GitHub?`);
    await expect(draftMenu.getByRole('menuitem')).toHaveText(['Convert to draft', 'Cancel']);
    await draftMenu.getByRole('menuitem', { name: 'Convert to draft', exact: true }).click();
    await expect(chip).toHaveText('Draft', { timeout: 20_000 });
    const ready = view.locator('.pr-draft-toggle');
    await expect(ready).toBeEnabled(); await expect(ready).toHaveText('Ready for review');
    await expect(view.locator('.pr-merge')).toHaveAttribute('title', 'Draft — GitHub may decline'); await expect(view.locator('.pr-merge')).toBeEnabled();

    await prActions(page, view).pick('Close…');
    const closeMenu = page.getByRole('menu', { name: 'Close…', exact: true }), confirm = closeMenu.getByRole('group', { name: 'Close pull request…', exact: true });
    await expect(confirm).toContainText(`Close #42 “${title}”? You can reopen it later.`);
    await expect(confirm.getByRole('textbox', { name: 'Comment (optional)' })).toBeFocused();
    await expect(closeMenu).toHaveScreenshot('pr-close-confirm.png');
    await confirm.getByRole('menuitem', { name: 'Cancel', exact: true }).click();
    await expect(closeMenu).toHaveCount(0); await expect(prActions(page, view).button).toBeFocused();
    await prActions(page, view).pick('Close…'); await page.keyboard.press('Escape'); await expect(closeMenu).toHaveCount(0);
    expect(providers.writes).toEqual(['draft:true']);

    await prActions(page, view).pick('Close…'); await confirm.getByRole('menuitem', { name: 'Close pull request', exact: true }).click();
    await expect(chip).toHaveText('Closed', { timeout: 20_000 });
    expect(providers.writes).toEqual(['draft:true', 'state:closed']); expect(providers.posts).toEqual([]);
    const reopen = view.locator('.pr-close-toggle');
    await expect(reopen).toBeEnabled(); await expect(reopen).toHaveText('Reopen'); await expect(ready).toHaveAttribute('hidden', '');

    providers.replyToState(() => ({ status: 403, body: { message: 'Must have admin rights to Repository.' }, headers: new Headers() }));
    await prActions(page, view).pick('Reopen');
    const reopenMenu = page.getByRole('menu', { name: 'Reopen', exact: true });
    await reopenMenu.getByRole('menuitem', { name: 'Reopen pull request', exact: true }).click();
    await expect(view.locator('.pr-error')).toHaveText('Reopening #42 didn’t go through: This GitHub account doesn’t have permission to change this pull request. Check its repository access.', { timeout: 20_000 });
    await expect(chip).toHaveText('Closed');
    providers.replyToState(undefined);
    await prActions(page, view).pick('Reopen'); await reopenMenu.getByRole('menuitem', { name: 'Reopen pull request', exact: true }).click();
    await expect(chip).toHaveText('Draft', { timeout: 20_000 });
    expect(providers.writes).toEqual(['draft:true', 'state:closed', 'state:open', 'state:open']);

    providers.pull = { ...providers.pull, state: 'closed', merged: true, draft: false };
    await view.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(chip).toHaveText('Merged', { timeout: 20_000 });
    await prActions(page, view).open();
    for (const name of ['Convert to draft', 'Ready for review', 'Close…', 'Reopen']) await expect(prActions(page, view).item(name)).toHaveCount(0);
    await expect(prActions(page, view).item('Review')).toBeVisible();
  } finally { await close(); }
});

test('at a narrow width the Actions menu still offers Close… and opens its confirmation with a comment', async () => {
  const { providers, app, page, close } = await start('craft-pr-state-overflow-');
  try {
    await resize(app, page, 1600, 1000);
    await page.locator('[data-item-id="pr"]').click();
    const view = page.locator('[data-expanded-item-id="pr"].expanded');
    await expect(view.locator('.view-header .view-chip')).toHaveText('Open', { timeout: 20_000 });
    await view.locator('.card-heading').focus();
    for (let step = 0; step < 40 && (await view.boundingBox())!.x > 160; step++) await page.keyboard.press('Shift+ArrowLeft');
    await viewWidth(page, view, 560);
    const more = view.getByRole('button', { name: 'Actions', exact: true });
    await expect(more).toBeVisible();
    await more.click();
    const overflow = page.getByRole('menu', { name: 'Actions', exact: true });
    await expect(overflow.getByRole('menuitem', { name: 'Close…', exact: true })).toBeEnabled();
    await expect(overflow.getByRole('menuitem', { name: 'Convert to draft', exact: true })).toBeEnabled();
    await overflow.getByRole('menuitem', { name: 'Close…', exact: true }).click();
    const confirm = page.getByRole('menu', { name: 'Close…', exact: true }).getByRole('group', { name: 'Close pull request…', exact: true });
    const comment = confirm.getByRole('textbox', { name: 'Comment (optional)' });
    await expect(comment).toBeFocused();
    const placed = (await page.locator('.resource-choice-menu').boundingBox())!, anchor = (await view.locator('.view-more').boundingBox())!;
    expect(placed.y).toBeGreaterThanOrEqual(anchor.y + anchor.height);
    await comment.fill('Closing in favour of a smaller change.');
    await confirm.getByRole('menuitem', { name: 'Close pull request', exact: true }).click();
    await expect(view.locator('.view-header .view-chip')).toHaveText('Closed', { timeout: 20_000 });
    expect(providers.writes).toEqual(['comment', 'state:closed']);
    expect(providers.posts.map(post => post.body)).toEqual(['Closing in favour of a smaller change.']);
  } finally { await close(); }
});
