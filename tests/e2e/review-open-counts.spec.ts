import { expect, type Page } from '@playwright/test';
import { test } from './visual-fixture.ts';

const TITLE = 'Review of the plan switcher';
const card = (page: Page) => page.getByRole('article', { name: TITLE, exact: true });
const counts = (page: Page) => card(page).locator('.card-counts');
const useCounts = (page: Page, on: boolean) => page.evaluate(async on => {
  const saved = await window.craftingTable.settingsRead();
  await window.craftingTable.settingsWrite({ expectedRevision: saved.revision, value: { ...saved.value, reviewOpenCounts: on } });
}, on);
const setOpen = (page: Page, open: { tone: string; count: number }[]) => page.evaluate(async open => {
  const { state } = await window.craftingTable.workspaceRead(), resource = state.resources.find(record => record.id === 'review-resource')!;
  await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' },
    commands: [{ type: 'item.update', id: 'review', data: { ...resource.data, findings: { ...(resource.data.findings as object), open } } }] as never });
}, open);

test.beforeEach(async ({ visual: { page } }) => {
  await page.evaluate(async title => {
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [
      { type: 'item.create', id: 'review', projectId: 'billing', position: { x: 300, y: 660 }, resource: { id: 'review-resource', pluginId: 'code.review', schemaVersion: 1, title,
        data: { provider: 'claude', model: 'opus', sourcePrId: 'pr', sessionId: 'fixture-only', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
          findings: { sessionId: 'fixture-only', format: 'findings', summary: '4 findings\nNone sent yet', counts: '4 findings', progress: 'None sent yet', pips: [], mix: [], urgent: true,
            open: [{ tone: 'critical', count: 2 }, { tone: 'high', count: 1 }, { tone: 'question', count: 1 }] } } } },
    ] as never });
  }, TITLE);
  await expect(card(page)).toBeVisible();
});

test('open finding counts are off by default and turned on in Settings → Map', async ({ visual: { page } }) => {
  await expect(counts(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('treeitem', { name: 'Map', exact: true }).click();
  await page.getByRole('switch', { name: 'Open findings on review cards' }).click();
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect.poll(() => page.evaluate(async () => (await window.craftingTable.settingsRead()).value.reviewOpenCounts)).toBe(true);
});

test('a review card shows one coloured number per severity still open, and a quiet check once all are dealt with', async ({ visual: { page } }) => {
  await useCounts(page, true);
  await expect(counts(page).locator('[data-tone]')).toHaveText(['2', '1', '1']);
  expect(await counts(page).locator('[data-tone]').evaluateAll(marks => marks.map(mark => mark.getAttribute('data-tone')))).toEqual(['critical', 'high', 'question']);
  await expect(counts(page)).toHaveAttribute('aria-label', '2 critical, 1 high, 1 question open');
  const [critical, high] = await counts(page).locator('[data-tone]').evaluateAll(marks => marks.map(mark => getComputedStyle(mark).color));
  expect(critical).not.toBe(high);
  await card(page).screenshot({ path: test.info().outputPath('review-open-counts-small.png') });

  await page.evaluate(async () => {
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'node.resize', id: 'review', size: 'medium' }] as never });
  });
  await expect(counts(page).locator('[data-tone]')).toHaveText(['2', '1', '1']);
  await card(page).screenshot({ path: test.info().outputPath('review-open-counts-medium.png') });

  await setOpen(page, [{ tone: 'high', count: 1 }]);
  await expect(counts(page).locator('[data-tone]')).toHaveText(['1']);

  await setOpen(page, []);
  await expect(counts(page).locator('[data-tone]')).toHaveCount(0);
  await expect(counts(page)).toHaveAttribute('aria-label', 'Nothing open');
  await expect(counts(page).locator('svg')).toHaveCount(1);
  await card(page).screenshot({ path: test.info().outputPath('review-open-counts-done.png') });

  await useCounts(page, false);
  await expect(counts(page)).toHaveCount(0);
});
