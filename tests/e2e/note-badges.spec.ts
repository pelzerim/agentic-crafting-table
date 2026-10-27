import { expect, type Page } from '@playwright/test';
import { test } from './visual-fixture.ts';

const apply = (page: Page, commands: Record<string, unknown>[]) => page.evaluate(async commands => {
  const { state } = await window.craftingTable.workspaceRead();
  await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), actor: { kind: 'user', id: 'test' }, expectedRevision: state.revision, commands: commands as never });
}, commands);
const note = (id: string, text: string, display?: string) => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'workspace.note', title: text, data: { text, ...(display ? { display } : {}) }, projectId: 'billing', position: { x: 820, y: 560 } });
const link = (id: string, sourceId: string, targetId: string) => ({ type: 'link.save', link: { id, sourceId, targetId, kind: 'reference', label: '' } });
const update = (id: string, text: string, display?: string) => ({ type: 'item.update', id, data: { text, ...(display ? { display } : {}) } });

test('a short note connected to items becomes a badge on each; longer text, Show as note or no connection keep it paper', async ({ visual: { page } }) => {
  await apply(page, [note('s2', 'S2'), link('s2-pr', 's2', 'pr'), link('s2-ticket', 'ticket', 's2')]);
  const pr = page.locator('.react-flow__node[data-id="pr"]'), ticket = page.locator('.react-flow__node[data-id="ticket"]');
  await expect(pr.locator('.card-badge')).toHaveText('S2');
  await expect(ticket.locator('.card-badge')).toHaveText('S2');
  await expect(pr.getByRole('button', { name: 'Badge S2 on Plan switcher', exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Plan switcher, badges S2', exact: true })).toBeVisible();
  await expect(page.locator('.react-flow__node[data-id="s2"]')).toHaveCount(0);
  await expect(page.locator('.react-flow__edge[data-id="s2-pr"], [data-testid="rf__edge-s2-pr"]')).toHaveCount(0);
  await expect(pr.locator('.card-badge')).toHaveAttribute('data-paper', 'mint');

  await apply(page, [update('s2', 'ask Alex first')]);
  await expect(pr.locator('.card-badge')).toHaveCount(0);
  await expect(page.locator('.react-flow__node[data-id="s2"]')).toHaveCount(1);
  await apply(page, [update('s2', 'customer escalation', 'badge')]);
  await expect(pr.locator('.card-badge')).toHaveText('customer escalation');
  await apply(page, [update('s2', 'S2', 'note')]);
  await expect(pr.locator('.card-badge')).toHaveCount(0);
  await apply(page, [update('s2', 'S2'), note('loose', 'v1.4')]);
  await expect(pr.locator('.card-badge')).toHaveText('S2');
  await expect(page.locator('.react-flow__node[data-id="loose"]')).toHaveCount(1);
});

test('clicking a badge opens its note to edit, right-clicking opens its note menu, and far out it is a pip', async ({ visual: { page } }) => {
  await apply(page, [note('s2', 'S2'), link('s2-pr', 's2', 'pr')]);
  const tab = page.getByRole('button', { name: 'Badge S2 on Plan switcher', exact: true });
  await tab.click();
  const form = page.getByRole('form', { name: 'Edit note' });
  await expect(form.getByRole('textbox', { name: 'Text' })).toHaveValue('S2');
  await expect(form.getByRole('radiogroup', { name: 'Paper' }).getByRole('radio', { name: 'Mint', exact: true })).toHaveAttribute('aria-checked', 'true');
  await form.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(form).toHaveCount(0);
  await tab.click({ button: 'right' });
  await expect(page.getByRole('menu', { name: 'Context actions' }).getByRole('menuitem', { name: 'Send to Undermap', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.mouse.move(640, 400);
  for (let step = 0; step < 12 && (await page.locator('.map-area').getAttribute('data-level')) !== 'overview'; step++) { await page.keyboard.down('Control'); await page.mouse.wheel(0, 400); await page.keyboard.up('Control'); await page.waitForTimeout(60); }
  await expect(page.locator('.map-area')).toHaveAttribute('data-level', 'overview');
  const far = page.locator('.react-flow__node[data-id="pr"] .card-badges');
  if (await far.count()) { await expect(far).toHaveAttribute('data-far', 'true'); await expect(far.locator('.card-badge')).toHaveText(''); }
});

test('Needs me and dashboard rows show an item\'s badges beside its name', async ({ visual: { page } }) => {
  await apply(page, [note('s2', 'S2'), link('s2-pr', 's2', 'pr')]);
  await page.getByRole('button', { name: /Needs me/ }).first().click();
  const row = page.locator('.attention-entry').filter({ hasText: 'Plan switcher' });
  await expect(row.locator('.badge-chip')).toHaveText('S2');
  await page.keyboard.press('Escape');
  await page.getByRole('slider', { name: 'Map zoom' }).fill('0.4');
  const dashboard = page.locator('.project-dashboard').filter({ hasText: 'Plan switcher' });
  await expect(dashboard.locator('.dashboard-row').filter({ hasText: 'Plan switcher' }).locator('.badge-chip')).toHaveText('S2');
});

test('a badge\'s menu sets its colour, which is its note\'s paper, and turns it back into a note or into a badge', async ({ visual: { page } }) => {
  await apply(page, [note('s2', 'S2'), link('s2-pr', 's2', 'pr')]);
  const pr = page.locator('.react-flow__node[data-id="pr"]'), menu = page.getByRole('menu', { name: 'Context actions' }), showAs = page.getByRole('menu', { name: 'Show as' });
  const tab = pr.getByRole('button', { name: 'Badge S2 on Plan switcher', exact: true });
  await tab.click({ button: 'right' });
  await expect(menu.getByRole('radio', { name: 'Mint', exact: true })).toHaveAttribute('aria-checked', 'true');
  await menu.getByRole('radio', { name: 'Sky', exact: true }).click();
  await expect(pr.locator('.card-badge')).toHaveAttribute('data-paper', 'sky');

  await tab.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Show as', exact: true }).hover();
  await expect(showAs.getByRole('menuitemradio', { name: 'Badge', exact: true })).toHaveAttribute('aria-checked', 'true');
  await showAs.getByRole('menuitemradio', { name: 'Note', exact: true }).click();
  const paper = page.locator('.react-flow__node[data-id="s2"]');
  await expect(paper).toHaveCount(1);
  await expect(pr.locator('.card-badge')).toHaveCount(0);
  await expect(paper.locator('.paper-card')).toHaveAttribute('data-paper', 'sky');

  await paper.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Show as', exact: true }).hover();
  await showAs.getByRole('menuitemradio', { name: 'Badge', exact: true }).click();
  await expect(pr.locator('.card-badge')).toHaveText('S2');

  await tab.click();
  const form = page.getByRole('form', { name: 'Edit note' });
  await expect(form.getByRole('textbox', { name: 'Text' })).toHaveValue('S2');
  await expect(form.getByLabel('Show as')).toHaveCount(0);
});
