import { test, expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { resolve } from 'node:path';
import { rolloutFixture } from '../fixtures/rollout.ts';
import { rolloutHarness } from './rollout-harness.ts';

const read = (page: Page) => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
const SHOTS = process.env.ACT_HOVER_LINK_SHOTS;
const shot = (page: Page, name: string) => page.screenshot({ path: SHOTS ? resolve(SHOTS, name) : test.info().outputPath(name) });
const middle = (edge: Locator) => edge.locator('.react-flow__edge-path').evaluate((path: SVGPathElement) => {
  const point = path.getPointAtLength(path.getTotalLength() / 2), matrix = path.getScreenCTM()!;
  return { x: point.x * matrix.a + matrix.e, y: point.y * matrix.d + matrix.f };
});

test('a rollout validation link waits for its rollout or agent to be hovered, selected or open, and can still be removed', async () => {
  test.setTimeout(120_000);
  const h = await rolloutHarness(rolloutFixture(), ['claude'], agent => [
    { type: 'item.add', id: 'rollout', resourceId: 'rollout-r', pluginId: 'github.rollout', title: 'Rollout', projectId: 'project', position: { x: 260, y: 200 }, data: { owner: 'fixture', repo: 'web', runId: 101 } },
    agent('claude', 'Claude · validator', 640),
    { type: 'item.add', id: 'note', resourceId: 'note-r', pluginId: 'workspace.note', title: 'Release notes', projectId: 'project', position: { x: 820, y: 60 }, data: { text: 'Check the release notes.' } },
    { type: 'link.save', link: { id: 'validation', sourceId: 'rollout', targetId: 'claude', kind: 'context', label: 'Validation', reveal: 'hover' } },
    { type: 'link.save', link: { id: 'runbook', sourceId: 'note', targetId: 'rollout', kind: 'reference', label: '' } },
  ]);
  try {
    const { page } = h, edge = page.locator('.react-flow__edge[data-id="validation"]'), runbook = page.locator('.react-flow__edge[data-id="runbook"]');
    const agent = page.locator('[data-item-id="claude"]'), rollout = page.locator('[data-item-id="rollout"]'), away = async () => page.mouse.move(40, 700);
    const concealed = async () => { await expect(edge).toHaveClass(/link-concealed/); await expect(edge).toHaveCSS('opacity', '0'); };
    const shown = async () => { await expect(edge).not.toHaveClass(/link-concealed/); await expect(edge).toHaveCSS('opacity', '1'); };
    await expect(agent).toBeVisible(); await expect(runbook).toHaveCount(1); await away();
    await shot(page, 'normal.png');
    await concealed(); await expect(runbook).toHaveCSS('opacity', '1');

    await agent.hover(); await shown();
    await shot(page, 'hover-agent.png');
    await away(); await concealed();

    // From the rollout along the line: the link stays while the pointer moves onto it, and its menu removes it.
    await rollout.hover(); await shown();
    const box = (await rollout.boundingBox())!, end = await middle(edge);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.move(end.x, end.y, { steps: 16 }); await shown();
    await page.mouse.click(end.x, end.y, { button: 'right' });
    await expect(page.getByRole('menuitem')).toHaveText(['Make blocking', 'Remove connection']);
    await page.getByRole('menuitem', { name: 'Remove connection' }).hover(); await shown();
    await page.keyboard.press('Escape'); await away(); await concealed();

    // Shift-click selects the agent: the link stays while it is selected.
    await page.keyboard.down('Shift'); await agent.click(); await page.keyboard.up('Shift');
    await away(); await shown();
    await page.keyboard.press('Escape'); await concealed();

    // Open, the rollout keeps it drawn behind its view.
    await rollout.click(); await expect(page.locator('.rollout-detail')).toBeVisible(); await away(); await shown();
    await page.getByRole('button', { name: 'Back to project', exact: true }).click(); await away(); await concealed();

    // The keyboard reaches it too: focused from the keyboard, it shows, and Shift+F10 opens its menu.
    await page.keyboard.press('Shift'); await edge.evaluate((element: SVGGElement) => element.focus()); await expect(edge).toHaveCSS('opacity', '1');
    await page.keyboard.press('Shift+F10'); await shown();
    await page.getByRole('menuitem', { name: 'Remove connection' }).click();
    await expect.poll(async () => (await read(page)).links.map(link => link.id)).toEqual(['runbook']);
  } finally { await h.close(); }
});
