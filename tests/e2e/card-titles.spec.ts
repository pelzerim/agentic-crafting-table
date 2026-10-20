import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test, capture } from './visual-fixture.ts';
import type { WorkspaceCommand } from '../../packages/core/control.ts';

const LONG = 'Rework the subscription plan switcher so proration, credits and invoices stay predictable across every billing cycle and currency';
async function apply(page: Page, commands: WorkspaceCommand[]) {
  await page.evaluate(async input => {
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'title-fixture' }, commands: JSON.parse(input) });
  }, JSON.stringify(commands));
}
type Card = { id: string; plugin: string; data: Record<string, unknown>; size?: 'small' | 'medium' | 'large'; title?: string; summary?: string };
const cards: Card[] = [
  { id: 'artifact', plugin: 'claude.artifact', data: { artifactId: 'a1' } },
  { id: 'artifact-medium', plugin: 'claude.artifact', data: { artifactId: 'a2' }, size: 'medium' },
  { id: 'pr-large', plugin: 'github.pull-request', data: { owner: 'example', repo: 'billing', number: 8 }, size: 'large', summary: 'Checks passed on the last push; two reviewers approved the change and one comment is waiting for an answer' },
  { id: 'pr-medium', plugin: 'github.pull-request', data: { owner: 'example', repo: 'billing', number: 7 }, size: 'medium', summary: 'PR #7 · Ready for review' },
  { id: 'notion-medium', plugin: 'notion.page', data: { pageId: '22222222222222222222222222222222' }, size: 'medium' },
  { id: 'web-medium', plugin: 'web.link', data: { url: 'https://example.test/guide' }, size: 'medium' },
  { id: 'bookmark-medium', plugin: 'web.bookmark', data: { url: 'https://example.test/notes' }, size: 'medium' },
  { id: 'web-short', plugin: 'web.link', data: { url: 'https://example.test/short' }, size: 'medium', title: 'Release guide' },
];
const fixture = async (page: Page) => {
  await apply(page, cards.map((card, index) => ({ type: 'item.add', id: card.id, resourceId: `${card.id}-r`, pluginId: card.plugin, title: card.title ?? `${card.id} ${LONG}`, data: card.data, position: { x: 290 + (index % 4) * 280, y: 900 + Math.floor(index / 4) * 190 } }) as WorkspaceCommand));
  await apply(page, cards.flatMap(card => [...card.size ? [{ type: 'node.resize', id: card.id, size: card.size }] : [], ...card.summary ? [{ type: 'node.update', id: card.id, summary: card.summary }] : []]) as WorkspaceCommand[]);
  await page.getByRole('slider', { name: 'Map zoom' }).fill('1');
  await page.mouse.move(200, 720); await page.mouse.down(); await page.mouse.move(200, 400, { steps: 4 }); await page.mouse.move(200, 120, { steps: 4 }); await page.mouse.up();
  await expect(page.locator('.map-card[data-item-id="web-short"]')).toBeInViewport();
};
/** Rendered title lines, whether text was cut, and every in-flow row's vertical extent inside the card's content box. */
const layout = (page: Page, id: string) => page.locator(`.map-card[data-item-id="${id}"]`).evaluate(card => {
  const strong = card.querySelector<HTMLElement>('.card-label strong')!, style = getComputedStyle(strong), line = parseFloat(style.lineHeight), top = card.getBoundingClientRect().top;
  const rows = [...card.querySelectorAll<HTMLElement>(':scope > :is(.card-heading,.card-summary,.map-size-fields,.indicator-labels)')].map(row => { const box = row.getBoundingClientRect(); return { name: row.className, top: box.top - top, bottom: box.bottom - top }; });
  return { lines: Math.round(strong.offsetHeight / line), clamp: style.webkitLineClamp, cut: strong.scrollHeight > strong.clientHeight + 1, rows, inner: card.clientTop + card.clientHeight - parseFloat(getComputedStyle(card).paddingBottom) };
});

test('long titles fill the card height before their ellipsis; summaries and fields keep their room', async ({ visual: { page } }) => {
  await fixture(page);
  for (const id of ['artifact-medium', 'pr-large', 'notion-medium', 'web-medium', 'bookmark-medium']) {
    const fit = await layout(page, id);
    expect(fit.lines, id).toBeGreaterThan(2);
    expect(fit.clamp, id).toBe(String(fit.lines));
    expect(fit.cut, id).toBe(true);
    fit.rows.forEach((row, index) => { expect(row.bottom, `${id} ${row.name}`).toBeLessThanOrEqual(fit.inner + .5); if (index) expect(row.top, `${id} ${row.name}`).toBeGreaterThanOrEqual(fit.rows[index - 1].bottom - .5); });
  }
  const summary = await layout(page, 'pr-large');
  expect(summary.rows.map(row => row.name)).toEqual(['card-heading', 'card-summary', 'map-size-fields']);
  for (const id of ['artifact', 'pr-medium']) expect((await layout(page, id)).lines, id).toBe(2);
  expect((await layout(page, 'web-short')).lines).toBe(1);
  await capture(page, 'card-titles-fill.png');
  await apply(page, [{ type: 'node.resize', id: 'artifact', dimensions: { width: 180, height: 90 } } as WorkspaceCommand]);
  await expect.poll(async () => (await layout(page, 'artifact')).lines).toBe(3);
});

test('cards shrinking between zoom levels keep two-line titles', async ({ visual: { page } }) => {
  await fixture(page);
  await page.getByRole('slider', { name: 'Map zoom' }).fill('0.68');
  const fit = await layout(page, 'pr-large');
  expect(fit.clamp).toBe('2');
  await page.getByRole('slider', { name: 'Map zoom' }).fill('1');
  await expect.poll(async () => (await layout(page, 'pr-large')).lines).toBeGreaterThan(2);
});
