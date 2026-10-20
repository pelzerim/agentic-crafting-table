import { test, expect, _electron as electron } from '@playwright/test';
import { choose } from './combobox.ts';
import type { Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { githubFixture, pullFixture } from '../fixtures/github.ts';
import { scrollbarArgs } from './visual-fixture.ts';
import { prActions } from './pr-actions.ts';

const read = (page: Page) => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
const shot = (page: Page, name: string) => page.screenshot({ path: test.info().outputPath(name) });

async function start(prefix: string, links: { id: string; sourceId: string; targetId: string; kind: 'reference' | 'blocks' }[] = []) {
  const blocker = { ...structuredClone(pullFixture), id: 64, number: 64, title: 'Thumbnail refresh loop' };
  const directory = await mkdtemp(join(tmpdir(), prefix)), providers = githubFixture([blocker]);
  const service = await startWorkspaceService(directory, undefined, undefined, providers);
  await service.control.dispatch({ commandId: 'add', expectedRevision: 0, actor: { kind: 'user', id: 'test' }, commands: [
    { type: 'item.add', id: 'blocker', resourceId: 'blocker-resource', pluginId: 'github.pull-request', title: 'Thumbnail refresh loop', position: { x: 200, y: 300 }, data: { owner: 'fixture', repo: 'billing', number: 64 } },
    { type: 'item.add', id: 'pr', resourceId: 'pr-resource', pluginId: 'github.pull-request', title: 'Plan changes', position: { x: 700, y: 300 }, data: { owner: 'fixture', repo: 'billing', number: 42 } },
    ...links.map(link => ({ type: 'link.save' as const, link: { ...link, label: '' } })),
  ] });
  await service.resources.poll();
  const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory, TZ: 'UTC' } });
  const page = await app.firstWindow();
  await expect(page.getByText('Desktop connected')).toBeVisible();
  return { blocker, providers, service, page, close: async () => { await app.close(); await service.close(); await rm(directory, { recursive: true, force: true }); } };
}
const edgeMiddle = (page: Page, id: string) => page.locator(`.react-flow__edge[data-id="${id}"] .react-flow__edge-path`).evaluate((path: SVGPathElement) => {
  const p = path.getPointAtLength(path.getTotalLength() / 2), screen = new DOMPoint(p.x, p.y).matrixTransform(path.getScreenCTM()!); return { x: screen.x, y: screen.y };
});

test('a blocking link made in the connection editor marks the blocked PR until its blocker merges, then quietly clears', async () => {
  const { blocker, service, page, close } = await start('craft-blocking-editor-');
  try {
    const card = page.locator('[data-item-id="pr"]'), source = page.locator('[data-item-id="blocker"]');
    await source.hover(); await source.getByRole('button', { name: /^Connect / }).focus(); await page.keyboard.press('Enter');
    const form = page.getByRole('form', { name: 'Connect items' });
    await choose(page, 'Connect to', 'pr');
    await expect(page.getByRole('radio', { name: 'Reference', exact: true })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('radio', { name: 'Blocks', exact: true }).click();
    await expect(form).toContainText('Plan changes waits until Thumbnail refresh loop is done'.replace('Plan changes', (await read(page)).nodes.find(node => node.id === 'pr')!.title));
    await shot(page, 'blocking-editor.png');
    await form.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect.poll(async () => (await read(page)).links).toEqual([expect.objectContaining({ sourceId: 'blocker', targetId: 'pr', kind: 'blocks' })]);
    const linkId = (await read(page)).links[0].id, edge = page.locator(`.react-flow__edge[data-id="${linkId}"]`);
    await expect(edge).toHaveClass(/blocks-edge/); await expect(edge).not.toHaveClass(/blocks-resolved/);
    await expect(edge.locator('.blocks-stop')).toHaveCount(1);
    await expect(edge).toHaveAttribute('aria-label', /^Blocking: .* blocks /);
    const badge = card.locator('.blocked-badge');
    await expect(badge).toHaveAttribute('title', 'Blocked by #64 Thumbnail refresh loop');
    await expect(source.locator('.blocked-badge')).toHaveCount(0);
    const middle = await edgeMiddle(page, linkId); await page.mouse.move(middle.x, middle.y);
    await expect(card).toHaveAttribute('data-link-end', 'true'); await expect(source).toHaveAttribute('data-link-end', 'true');
    await expect(page.getByRole('tooltip')).toHaveText(/blocks/);
    await shot(page, 'blocking-link-unresolved.png');
    await page.mouse.move(4, 4); await expect(card).not.toHaveAttribute('data-link-end', 'true');

    blocker.merged = true; blocker.state = 'closed';
    await service.resources.read('blocker', true);
    await expect(edge).toHaveClass(/blocks-resolved/);
    await expect(badge).toHaveCount(0);
    await expect(page.getByRole('status', { name: /is unblocked$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Needs me: / })).toHaveCount(0);
    await shot(page, 'blocking-link-resolved.png');
  } finally { await close(); }
});

test('Make blocking lands while other writes keep moving the workspace revision', async () => {
  const { service, page, close } = await start('craft-blocking-busy-', [{ id: 'related', sourceId: 'blocker', targetId: 'pr', kind: 'reference' }]);
  let busy = true;
  const storm = (async () => {
    for (let tick = 0; busy; tick++) {
      const state = await service.control.read();
      await service.control.dispatch({ commandId: `noise-${tick}`, expectedRevision: state.revision, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'node.update', id: 'blocker', summary: `tick ${tick}` }] }).catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  })();
  try {
    const edge = page.locator('.react-flow__edge[data-id="related"]');
    await edge.focus(); await page.keyboard.press('Shift+F10');
    await page.getByRole('menuitem', { name: 'Make blocking' }).focus(); await page.keyboard.press('Enter');
    await expect.poll(async () => (await read(page)).links[0].kind).toBe('blocks');
    await expect(page.getByText(/Revision conflict/)).toHaveCount(0);
  } finally { busy = false; await storm; await close(); }
});

test('the link menu turns a connection blocking and back with the keyboard, and merge asks to merge anyway', async () => {
  const { providers, page, close } = await start('craft-blocking-menu-', [{ id: 'related', sourceId: 'blocker', targetId: 'pr', kind: 'reference' }]);
  try {
    const edge = page.locator('.react-flow__edge[data-id="related"]'), card = page.locator('[data-item-id="pr"]');
    await edge.focus(); await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menuitem')).toHaveText(['Make blocking', 'Remove connection']);
    await expect(page.getByRole('menuitem', { name: 'Make blocking' })).toHaveAttribute('title', /Thumbnail refresh loop blocks /);
    await page.getByRole('menuitem', { name: 'Make blocking' }).focus(); await page.keyboard.press('Enter');
    await expect.poll(async () => (await read(page)).links[0].kind).toBe('blocks');
    await expect(card.locator('.blocked-badge')).toHaveAttribute('title', 'Blocked by #64 Thumbnail refresh loop');
    await shot(page, 'blocked-badge.png');

    await card.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Merge…', exact: true }).hover();
    const submenu = page.getByRole('menu', { name: 'Merge…', exact: true });
    await expect(submenu.getByRole('menuitem').nth(1)).toHaveText('Blocked by #64 Thumbnail refresh loop (open). Merge #42 “Make billing plan changes predictable” into main at aaaaaaa?');
    await expect(submenu.getByRole('menuitem')).toHaveText(['Cancel', /^Blocked by/, 'Squash and merge anyway', 'Create a merge commit anyway', 'Rebase and merge anyway']);
    await shot(page, 'blocking-merge-warning-menu.png');
    await page.keyboard.press('Escape'); await expect(page.getByRole('menu')).toHaveCount(0);

    await card.click();
    const chips = page.getByRole('group', { name: 'Blocked by #64 Thumbnail refresh loop' });
    await expect(chips.getByRole('button', { name: '#64 Thumbnail refresh loop' })).toBeVisible();
    const merge = page.locator('.pr-merge'), menu = page.getByRole('menu', { name: 'Merge pull request', exact: true });
    await expect(merge).toBeEnabled(); await prActions(page).pick('Merge');
    await expect(menu.locator('.resource-choice-prompt')).toHaveText(/^Blocked by #64 Thumbnail refresh loop \(open\)\. Merge #42/);
    await shot(page, 'blocking-merge-warning-view.png');
    await menu.getByRole('menuitem', { name: 'Squash and merge anyway', exact: true }).click();
    await expect(page.locator('.view-header .view-chip')).toHaveText('Merged', { timeout: 20_000 });
    expect(providers.merges.map(merge => merge.method)).toEqual(['SQUASH']);
    await page.getByRole('button', { name: 'Back to project', exact: true }).click();

    const blocking = page.locator('.react-flow__edge[data-id="related"]');
    await blocking.focus(); await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menuitem')).toHaveText(['Make normal', 'Reverse blocking', 'Remove connection']);
    await page.getByRole('menuitem', { name: 'Make normal' }).click();
    await expect.poll(async () => (await read(page)).links[0].kind).toBe('reference');
    await expect(card.locator('.blocked-badge')).toHaveCount(0);
  } finally { await close(); }
});

test('a blocking cycle is refused with a clear message and leaves the links unchanged', async () => {
  const { page, close } = await start('craft-blocking-cycle-', [{ id: 'order', sourceId: 'blocker', targetId: 'pr', kind: 'blocks' }]);
  try {
    const target = page.locator('[data-item-id="pr"]');
    await target.hover(); await target.getByRole('button', { name: /^Connect / }).focus(); await page.keyboard.press('Enter');
    await choose(page, 'Connect to', 'blocker');
    await page.getByRole('radio', { name: 'Blocks', exact: true }).click();
    await expect(page.getByRole('form', { name: 'Connect items' }).getByRole('alert')).toHaveText(/already blocks .*This would create a blocking cycle\./);
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeDisabled();
    expect((await read(page)).links).toHaveLength(1);
  } finally { await close(); }
});
