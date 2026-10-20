import { openDiagnosticSessions } from './session-navigation.ts';
import { resizeItemOnMap } from './resize-item.ts';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test, capture, openTerminal } from './visual-fixture.ts';

const read = (page: Page) => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
async function action(page: Page, title: string, name: string) {
  await page.getByRole('article', { name: title, exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name, exact: true }).click();
}
/** Archiving now happens below the map: send it below, travel, archive there, come back. */
async function archiveFromBelow(page: Page, title: string, project = false) {
  await action(page, title, project ? 'Send project to Undermap' : 'Send to Undermap');
  await page.getByRole('button', { name: 'Go to Undermap', exact: true }).click();
  await action(page, title, project ? 'Archive project' : 'Archive');
  await page.getByRole('button', { name: 'Back to the map', exact: true }).click();
  await expect(page.locator('.map-area')).toHaveAttribute('data-layer', 'map');
}
/** Delete sits in each archive row's ⋯ menu. */
async function deleteFromArchive(page: Page, title: string) {
  await page.getByRole('button', { name: `More actions for ${title}`, exact: true }).click();
  await page.getByRole('menuitem', { name: `Delete ${title}`, exact: true }).click();
}
async function archive(page: Page) {
  await page.mouse.click(100, 650, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Open archive', exact: true }).click();
}

test('done, archive, restore and delete preserve independent state through reload', async ({ visual: { page } }) => {
  const before = await read(page), agent = page.getByRole('article', { name: 'Claude · implementation', exact: true });
  const originalSize = (await agent.boundingBox())!;
  await action(page, 'Claude · implementation', 'Mark done');
  await expect(agent).toHaveAttribute('data-completed', 'true');
  // Done keeps the item's size, opacity, content and links; only the title is struck through.
  await page.mouse.move(4, 4);
  const doneSize = (await agent.boundingBox())!;
  expect([doneSize.width, doneSize.height].map(Math.round)).toEqual([originalSize.width, originalSize.height].map(Math.round));
  expect(await agent.evaluate(element => getComputedStyle(element).opacity)).toBe('1');
  await expect(agent.locator('.card-label strong')).toHaveCSS('text-decoration-line', 'line-through');
  await expect(page.locator('.react-flow__edge[data-id="ticket-agent"]')).toBeVisible();
  const done = await read(page);
  expect(done.nodes.find(n => n.id === 'agent')!.activity).toBe('working');
  expect(done.resources).toEqual(before.resources); expect(done.links).toEqual(before.links);
  await capture(page, 'map-done-item.png');
  await page.reload(); await expect(agent).toHaveAttribute('data-completed', 'true');
  await action(page, 'Claude · implementation', 'Reopen'); await expect(agent).toHaveAttribute('data-completed', 'false');
  await archiveFromBelow(page, 'BIL-128 · Plan changes');
  await archiveFromBelow(page, 'Billing redesign', true);
  await expect(agent).toHaveCount(0);
  await archive(page);
  // An archived project's items collapse into its row; an item archived on its own waits for the project.
  const projectRow = page.locator('[data-archived-id="billing"]');
  await expect(projectRow).toContainText('3 items return with the project');
  await expect(page.getByRole('button', { name: 'Restore Claude · implementation', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Restore BIL-128 · Plan changes', exact: true })).toBeDisabled();
  await expect(page.locator('[data-archived-id="ticket"]')).toContainText('Restore Billing redesign first');
  await expect(projectRow.getByRole('button', { name: /^Delete / })).toHaveCount(0);
  await capture(page, 'archive-browser.png');
  await page.getByRole('button', { name: 'Restore Billing redesign', exact: true }).click();
  await page.getByRole('button', { name: 'Restore BIL-128 · Plan changes', exact: true }).click();
  await page.getByRole('button', { name: 'Close archive' }).click();
  await expect(agent).toHaveCount(0); // Restored items return to Undermap, where they were archived from.
  await page.getByRole('button', { name: 'Go to Undermap', exact: true }).click();
  await page.getByRole('article', { name: 'BIL-128 · Plan changes', exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Bring back to map', exact: true })).toBeDisabled(); // Its project is still below.
  await page.keyboard.press('Escape');
  await action(page, 'Billing redesign', 'Bring back to map');
  await action(page, 'BIL-128 · Plan changes', 'Bring back to map');
  await expect(page.locator('.below-empty')).toBeVisible();
  await page.getByRole('button', { name: 'Back to the map', exact: true }).click();
  await expect(agent).toBeVisible(); await expect(page.getByRole('article', { name: 'BIL-128 · Plan changes', exact: true })).toBeVisible();
  expect((await read(page)).links).toEqual(before.links);
  await archiveFromBelow(page, 'Billing experience');
  await archive(page); await deleteFromArchive(page, 'Billing experience');
  // Delete asks inline with the safe choice focused; Escape backs out without deleting.
  const confirmItem = page.getByRole('group', { name: 'Delete permanently', exact: true });
  await expect(confirmItem).toContainText('Delete Billing experience permanently?');
  await expect(confirmItem.getByRole('button', { name: 'Keep', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(confirmItem).toHaveCount(0);
  expect((await read(page)).nodes.some(node => node.title === 'Billing experience')).toBe(true);
  await deleteFromArchive(page, 'Billing experience');
  await capture(page, 'archive-delete-confirm.png');
  await confirmItem.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await page.getByRole('button', { name: 'Close archive' }).click();
  await expect(page.getByRole('article', { name: 'Billing experience', exact: true })).toHaveCount(0);
  const withoutBrief = await read(page);
  expect(withoutBrief.links.map(link => link.id)).toEqual(['ticket-agent']);
  expect(withoutBrief.resources.some(resource => resource.id === 'brief-resource')).toBe(false);
  await archiveFromBelow(page, 'Billing redesign', true);
  await archive(page); await deleteFromArchive(page, 'Billing redesign');
  const confirmProject = page.getByRole('group', { name: 'Delete project', exact: true });
  await expect(confirmProject.getByRole('button', { name: 'Keep', exact: true })).toBeFocused();
  await confirmProject.getByRole('button', { name: 'Delete project', exact: true }).click();
  await expect(page.locator('[data-project-outline]')).toHaveCount(0);
  const floating = await read(page);
  expect(floating.nodes.every(node => !node.projectId)).toBe(true);
  expect(floating.resources).toEqual(withoutBrief.resources);
  await page.reload(); await expect(agent).toHaveCount(0);
  expect((await read(page)).nodes).toEqual(floating.nodes);
  await archive(page); await page.getByRole('button', { name: 'Restore Claude · implementation', exact: true }).click();
  await expect(agent).toBeVisible();
});

test('explicit connections remove via pointer or keyboard and undo never replaces a changed link', async ({ visual: { page } }) => {
  const before = await read(page), link = page.locator('.react-flow__edge[data-id="brief-pr"]');
  const point = await link.locator('.react-flow__edge-path').evaluate((path: SVGPathElement) => {
    const p = path.getPointAtLength(path.getTotalLength() / 2), screen = new DOMPoint(p.x, p.y).matrixTransform(path.getScreenCTM()!); return { x: screen.x, y: screen.y };
  });
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Remove connection', exact: true }).click();
  await expect(link).toHaveCount(0);
  expect((await read(page)).nodes).toEqual(before.nodes);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(link).toBeVisible();
  await link.focus(); await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Remove connection', exact: true }).click();
  await expect(link).toHaveCount(0);
  await page.evaluate(async () => {
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: 'changed-link', expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [
      { type: 'link.save', link: { id: 'brief-pr', sourceId: 'brief', targetId: 'agent', kind: 'reference', label: 'Changed elsewhere' } },
    ] });
  });
  await expect(link).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('changed after removal');
  await expect(page.getByRole('alert').getByRole('button', { name: 'Details', exact: true })).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Connection removed' })).toContainText('Billing experience → Plan switcher');
  await expect(page.locator('.workspace-notices')).toHaveScreenshot('map-toasts.png');
  // The earlier routine notice expires without taking the newer conflict with it.
  await expect(page.getByText('Connection removed', { exact: false })).toHaveCount(0, { timeout: 7000 });
  await expect(page.getByRole('alert')).toContainText('changed after removal');
  expect((await read(page)).links.find(link => link.id === 'brief-pr')!.targetId).toBe('agent');
});

test('resize and Mark done never stop a real native session; Undermap stops it and archive actions keep its entry', async ({ visual: { page } }) => {
  await openTerminal(page);
  const id = (await page.locator('.terminal-surface').getAttribute('data-terminal-id'))!;
  const before = (await page.evaluate(id => window.craftingTable.sessionRead(id), id)).session;
  await page.evaluate(async () => {
    const saved = await window.craftingTable.settingsRead();
    await window.craftingTable.settingsWrite({ expectedRevision: saved.revision, value: { ...saved.value, itemMapSizes: { 'terminal.session': { sizes: { large: { width: 300, height: 140 } } } } } });
  });
  await expect(page.locator('.terminal-surface')).toHaveAttribute('data-terminal-id', id);
  await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');
  await page.getByRole('button', { name: 'Back to project' }).click();
  const nodeId = await page.getByRole('article', { name: 'Development terminal', exact: true }).getAttribute('data-item-id');
  await resizeItemOnMap(page, nodeId!, 180, 48);
  expect((await page.evaluate(id => window.craftingTable.sessionRead(id), id)).session).toMatchObject({ id: before.id, state: 'running', pid: before.pid });
  await action(page, 'Development terminal', 'Mark done');
  expect((await page.evaluate(id => window.craftingTable.sessionRead(id), id)).session).toMatchObject({ id: before.id, state: 'running', pid: before.pid });
  await archiveFromBelow(page, 'Development terminal');
  await expect.poll(async () => (await page.evaluate(id => window.craftingTable.sessionRead(id), id)).session.state).toBe('exited');
  await archive(page); await page.getByRole('button', { name: 'Restore Development terminal', exact: true }).click();
  await page.getByRole('button', { name: 'Close archive' }).click();
  // Restored below; archive it again from there.
  await page.getByRole('button', { name: 'Go to Undermap', exact: true }).click();
  await action(page, 'Development terminal', 'Archive');
  await page.getByRole('button', { name: 'Back to the map', exact: true }).click();
  await archive(page); await deleteFromArchive(page, 'Development terminal');
  await page.getByRole('group', { name: 'Delete permanently', exact: true }).getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await page.getByRole('button', { name: 'Close archive' }).click();
  await openDiagnosticSessions(page);
  await page.getByRole('button', { name: 'Ended sessions' }).click();
  await expect(page.locator(`[data-session-id="${id}"]`)).toContainText('exited');
  const after = (await page.evaluate(id => window.craftingTable.sessionRead(id), id)).session;
  expect(after.pid).toBe(before.pid); expect(after.state).toBe('exited');
});
