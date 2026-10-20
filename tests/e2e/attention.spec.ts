import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test, capture } from './visual-fixture.ts';
import type { WorkspaceCommand } from '../../packages/core/control.ts';
import { resizeItemOnMap } from './resize-item.ts';
import { grazeSteps } from '../../apps/desktop/renderer/grazing.ts';

const read = (page: Page) => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
async function apply(page: Page, commands: WorkspaceCommand[]) {
  await page.evaluate(async encoded => { const commands = JSON.parse(encoded) as WorkspaceCommand[]; const { state } = await window.craftingTable.workspaceRead(); await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'provider', id: 'attention-fixture' }, commands }); }, JSON.stringify(commands));
}

test('needs me previews summaries and highlights map/minimap on hover and keyboard focus without marking read', async ({ visual: { page } }) => {
  await page.getByRole('button', { name: 'Needs me: 2', exact: true }).click();
  const list = page.getByRole('dialog', { name: 'Needs me', exact: true });
  const entry = list.getByRole('button', { name: 'Open Claude · implementation', exact: true });
  const go = list.getByRole('button', { name: 'Go to Claude · implementation on map', exact: true });
  const marker = page.locator('[data-map-highlight="agent"]');
  const miniature = page.locator('[data-locator-id="agent"]');
  const camera = () => page.locator('.react-flow__viewport').getAttribute('style');
  const before = await read(page), beforeCamera = await camera();
  await expect(entry.locator('.attention-summary')).toHaveText('Updating the plan switcher');
  // Row actions are labelled and sit inside the row's card.
  const seen = list.getByRole('button', { name: 'Dismiss Claude · implementation from Needs me', exact: true });
  await expect(seen).toHaveText('Seen'); await expect(go).toHaveText('Map'); await expect(go).toHaveAttribute('title', 'Show on map');
  const card = (await entry.boundingBox())!;
  for (const action of [seen, go]) {
    const box = (await action.boundingBox())!;
    expect(box.x).toBeGreaterThan(card.x); expect(box.x + box.width).toBeLessThan(card.x + card.width);
    expect(box.y).toBeGreaterThan(card.y); expect(box.y + box.height).toBeLessThan(card.y + card.height);
  }
  // The sheet opens right of the rail, level with its top; a summary never repeats the reason above it.
  const rail = (await page.locator('.tool-rail').boundingBox())!, box = (await list.boundingBox())!;
  expect(box.x).toBe(rail.x + rail.width + 8); expect(box.y).toBe(rail.y);
  const pr = list.getByRole('button', { name: 'Open Plan switcher', exact: true });
  await expect(pr.locator('.attention-summary')).toHaveText('PR #48');
  await entry.hover();
  await expect(list).not.toHaveAttribute('data-occluded');
  await expect(marker).toBeVisible(); await expect(miniature).toHaveAttribute('data-highlighted', 'true');
  await expect(page.locator('.map-locator .locator-highlight')).toHaveCSS('stroke', 'rgb(232, 189, 114)');
  await expect(page).toHaveScreenshot('needs-me-highlight.png');
  expect(await camera()).toBe(beforeCamera); expect(await read(page)).toEqual(before);
  await page.mouse.move(4, 4);
  await expect(marker).toHaveCount(0); await expect(miniature).not.toHaveAttribute('data-highlighted');
  await page.keyboard.press('Tab'); await go.focus();
  await expect(marker).toBeVisible(); await expect(miniature).toHaveAttribute('data-highlighted', 'true');
  await page.getByRole('button', { name: 'Close needs me', exact: true }).focus();
  await expect(marker).toHaveCount(0);
  await go.hover(); await expect(marker).toBeVisible();
  await apply(page, [{ type: 'node.update', id: 'agent', summary: 'Waiting for the downgrade timing decision.' }]);
  await expect(entry.locator('.attention-summary')).toHaveText('Waiting for the downgrade timing decision.');
  await expect(marker).toBeVisible();
  await go.click();
  await expect(list).toBeVisible(); await expect(page.locator('.map-area')).toHaveAttribute('data-focus', '');
  await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', '1');
  const center = await page.locator('[data-item-id="agent"]').boundingBox(), canvas = (await page.locator('.map-area').boundingBox())!;
  expect(center!.x + center!.width / 2).toBeCloseTo(canvas.x + canvas.width / 2, 0);
  expect(center!.y + center!.height / 2).toBeCloseTo(canvas.y + canvas.height / 2, 0);
  const located = (await read(page)).nodes.find(node => node.id === 'agent')!;
  expect(located.attentionSeenVersion).toBe(before.nodes.find(node => node.id === 'agent')!.attentionSeenVersion);
  expect(located.position).toEqual(before.nodes.find(node => node.id === 'agent')!.position);
  await expect(page.getByRole('button', { name: 'Needs me: 2', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close needs me', exact: true }).click();
  await expect(marker).toHaveCount(0); await expect(miniature).not.toHaveAttribute('data-highlighted');
  await page.getByRole('button', { name: 'Needs me: 2', exact: true }).click();
  await expect(marker).toHaveCount(0);
  await entry.hover(); await expect(marker).toBeVisible();
  await apply(page, [{ type: 'node.archive', id: 'agent' }]);
  await expect(entry).toHaveCount(0); await expect(marker).toHaveCount(0);
  await expect(page.locator('.map-locator .locator-highlight')).toHaveCount(0);
});

test('a hovered row whose card sits under the Needs me sheet pulses its minimap box instead', async ({ visual: { page } }) => {
  await apply(page, [{ type: 'node.move', id: 'pr', position: { x: 60, y: 260 } }]);
  await page.getByRole('button', { name: 'Needs me: 2', exact: true }).click();
  const list = page.getByRole('dialog', { name: 'Needs me', exact: true });
  await list.getByRole('button', { name: 'Open Plan switcher', exact: true }).hover();
  await expect(page.locator('[data-locator-id="pr"]')).toHaveAttribute('data-highlighted', 'true');
  await expect(list).toHaveAttribute('data-occluded', 'true');
  await list.getByRole('button', { name: 'Open Claude · implementation', exact: true }).hover();
  await expect(list).not.toHaveAttribute('data-occluded');
});

test('needs me highlights aliases together, handles missing summaries and goes to an offscreen item without opening it', async ({ visual: { page } }) => {
  const resource = (await read(page)).resources.find(resource => resource.id === 'pr-resource')!;
  await apply(page, [
    { type: 'item.create', id: 'z-pr-alias', resource, position: { x: 3200, y: 1600 } },
    { type: 'node.update', id: 'agent', summary: '' },
    { type: 'node.move', id: 'agent', position: { x: -2200, y: -1100 } },
  ]);
  await page.getByRole('button', { name: 'Needs me: 2', exact: true }).click();
  const list = page.getByRole('dialog', { name: 'Needs me', exact: true });
  await list.getByRole('button', { name: 'Open Plan switcher', exact: true }).hover();
  await expect(page.locator('[data-map-highlight]')).toHaveCount(2);
  await expect(page.locator('[data-locator-id][data-highlighted=true]')).toHaveCount(2);
  await expect(list.getByRole('button', { name: 'Open Claude · implementation', exact: true }).locator('.attention-summary')).toHaveCount(0);
  await list.getByRole('button', { name: 'Go to Claude · implementation on map', exact: true }).click();
  await expect(page.locator('[data-map-highlight]')).toHaveCount(1);
  await expect(page.locator('[data-map-highlight="agent"]')).toBeVisible();
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', '');
  const bounds = (await page.locator('[data-item-id="agent"]').boundingBox())!;
  expect(bounds.x).toBeGreaterThan(0); expect(bounds.x + bounds.width).toBeLessThan(1280);
  expect(bounds.y).toBeGreaterThan(0); expect(bounds.y + bounds.height).toBeLessThan(800);
  await expect(page.getByRole('button', { name: 'Needs me: 2', exact: true })).toBeVisible();
  await list.getByRole('button', { name: 'Dismiss Claude · implementation from Needs me', exact: true }).click();
  await expect(page.locator('[data-map-highlight]')).toHaveCount(0);
  await expect(page.locator('.map-locator .locator-highlight')).toHaveCount(0);
});

test('opening an item keeps it in Needs me; manual dismissals preserve input and new events resurface', async ({ visual: { page } }) => {
  await apply(page, [{ type: 'node.update', id: 'agent', attention: 'input', attentionNote: 'Agent asked a question' }]);
  await expect(page.getByRole('article', { name: 'Claude · implementation', exact: true }).getByRole('img', { name: 'Asking me: Agent asked a question', exact: true })).toBeVisible();
  const needs = page.getByRole('button', { name: 'Needs me: 2', exact: true }); await needs.click();
  const list = page.getByRole('dialog', { name: 'Needs me', exact: true });
  await expect(list.getByRole('button', { name: 'Open Claude · implementation', exact: true }).locator('.attention-reason')).toHaveText('Agent asked a question');
  await expect(list).toContainText('Ready for your review');
  await capture(page, 'needs-me.png');
  const before = await read(page);
  await page.getByRole('button', { name: 'Open Claude · implementation', exact: true }).click();
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'agent');
  await expect(page.getByRole('button', { name: 'Needs me: 2', exact: true })).toBeVisible();
  const viewed = (await read(page)).nodes.find(node => node.id === 'agent')!;
  expect(viewed.attention).toBe('input'); expect(viewed.activity).toBe(before.nodes.find(node => node.id === 'agent')!.activity);
  expect(viewed.attentionSeenVersion).toBe(before.nodes.find(node => node.id === 'agent')!.attentionSeenVersion);
  await page.getByRole('button', { name: 'Back to project', exact: true }).click();
  // Card click and keyboard Enter open the full view without acknowledging either.
  await page.getByRole('article', { name: 'Plan switcher', exact: true }).click();
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'pr');
  await page.getByRole('button', { name: 'Back to project', exact: true }).click();
  await page.locator('.react-flow__node[data-id="agent"]').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'agent');
  await page.getByRole('button', { name: 'Back to project', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Needs me: 2', exact: true })).toBeVisible();
  expect((await read(page)).nodes.map(node => [node.id, node.attentionSeenVersion])).toEqual(before.nodes.map(node => [node.id, node.attentionSeenVersion]));
  await page.getByRole('button', { name: 'Needs me: 2', exact: true }).click();
  await page.getByRole('button', { name: 'Dismiss Claude · implementation from Needs me', exact: true }).click();
  await expect(list.getByRole('button', { name: 'Open Claude · implementation', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Dismiss Plan switcher from Needs me', exact: true }).click();
  await expect(list).toContainText('Nothing needs me.');
  expect((await read(page)).nodes.find(node => node.id === 'pr')!.attention).toBe('review');
  await page.reload();
  await expect(page.getByRole('button', { name: /^Needs me:/ })).toHaveCount(0);
  await apply(page, [{ type: 'node.update', id: 'pr', attention: 'review' }]);
  await expect(page.getByRole('button', { name: /^Needs me:/ })).toHaveCount(0);
  await apply(page, [{ type: 'node.complete', id: 'agent' }, { type: 'node.update', id: 'agent', attention: 'error' }]);
  const one = page.getByRole('button', { name: 'Needs me: 1', exact: true });
  await one.click(); await expect(list).toContainText('Action required'); await expect(list).toContainText('Marked done');
  await page.getByRole('button', { name: 'Close needs me', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Claude · implementation', exact: true }).getByRole('img', { name: 'Asking me: Action required', exact: true })).toBeVisible();
  await apply(page, [{ type: 'node.archive', id: 'billing' }]);
  await expect(page.getByRole('button', { name: /^Needs me:/ })).toHaveCount(0);
  await apply(page, [{ type: 'node.restore', id: 'billing' }]);
  await expect(one).toBeVisible();
  await page.reload(); await expect(one).toBeVisible();
  await apply(page, [{ type: 'node.update', id: 'agent', attention: 'none' }, { type: 'node.update', id: 'pr', attention: 'none' }]);
  await expect(page.getByRole('button', { name: /^Needs me:/ })).toHaveCount(0);
  expect((await read(page)).nodes.find(node => node.id === 'agent')!.completedAt).toBeTruthy();
});

test('needs me stays as a neutral control and keeps seen notifications under Earlier', async ({ visual: { page } }) => {
  const list = page.getByRole('dialog', { name: 'Needs me', exact: true }), earlier = list.getByRole('group', { name: 'Earlier', exact: true });
  const rows = earlier.locator('.attention-row');
  await apply(page, [{ type: 'attention.set', id: 'pr', source: 'review', reason: 'review', note: 'Review requested' }]);
  await page.getByRole('button', { name: 'Needs me: 2', exact: true }).click();
  await expect(list.getByRole('button', { name: 'Open Plan switcher', exact: true })).toBeVisible(); await expect(earlier).toHaveCount(0);
  await list.getByRole('button', { name: 'Dismiss Plan switcher from Needs me', exact: true }).click();
  const plan = earlier.getByRole('button', { name: 'Open earlier Plan switcher', exact: true });
  await expect(plan.locator('span')).toHaveText('· Review requested'); await expect(plan).toContainText(/Seen /);
  await expect(plan).toHaveAttribute('title', /^Billing redesign · Raised .* · Seen /);
  expect((await plan.boundingBox())!.height).toBeLessThanOrEqual(32);
  await expect(list.getByRole('button', { name: 'Open Claude · implementation', exact: true })).toBeVisible();
  await page.mouse.move(4, 4);
  await expect(page).toHaveScreenshot('needs-me-earlier.png', { mask: [page.locator('.attention-time')] });
  await list.getByRole('button', { name: 'Dismiss Claude · implementation from Needs me', exact: true }).click();
  const quiet = page.getByRole('button', { name: 'Needs me', exact: true }), settings = page.getByRole('button', { name: 'Settings', exact: true });
  await expect(quiet).toBeVisible(); await expect(page.getByRole('button', { name: /^Needs me:/ })).toHaveCount(0);
  const look = (button: typeof quiet) => button.evaluate(element => { const style = getComputedStyle(element); return [style.color, style.backgroundColor, style.borderColor, style.fontSize, style.padding, element.getBoundingClientRect().height]; });
  expect(await look(quiet)).toEqual(await look(settings));
  await expect(rows).toHaveCount(2); await expect(rows.first()).toContainText('Claude · implementation');
  await page.getByRole('button', { name: 'Close needs me', exact: true }).click();
  await expect(page.locator('.tool-rail')).toHaveScreenshot('needs-me-quiet.png');
  await quiet.click();
  await plan.click();
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'pr');
  await page.getByRole('button', { name: 'Back to project', exact: true }).click();
  const acknowledge = async (id: string) => apply(page, [{ type: 'attention.acknowledge', id, versions: { [id]: (await read(page)).nodes.find(node => node.id === id)!.attentionVersion! } }]);
  // Earlier keeps one entry per item: repeated cycles of the ticket collapse into its latest.
  for (let turn = 1; turn <= 3; turn++) {
    await apply(page, [{ type: 'attention.set', id: 'ticket', source: 'provider', reason: 'comment', eventId: `comment-${turn}` }]); await acknowledge('ticket');
  }
  const notes = Array.from({ length: 11 }, (_, i) => `note-${i + 1}`);
  await apply(page, notes.map((id, i) => ({ type: 'item.add' as const, id, resourceId: `${id}-r`, pluginId: 'workspace.note', title: `Note ${i + 1}`, data: { text: 'x' }, projectId: 'billing', position: { x: 2000 + i * 120, y: 2000 } })));
  for (const id of notes) { await apply(page, [{ type: 'attention.set', id, source: 'completion', reason: 'finished', eventId: 'done' }]); await acknowledge(id); }
  await quiet.click();
  // Compact rows leave the page-end row in view, so the next page loads without scrolling.
  await expect(rows.first()).toContainText('Note 11'); await expect(rows).toHaveCount(14); await expect(earlier.locator('.attention-more')).toHaveCount(0);
  await list.locator('.rail-panel-body').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(rows).toHaveCount(14); await expect(rows.last()).toContainText('Plan switcher');
  await expect(earlier.getByRole('button', { name: 'Open earlier BIL-128 · Plan changes', exact: true })).toHaveCount(1);
  // An item that needs you again leaves Earlier while it is active.
  await apply(page, [{ type: 'attention.set', id: 'ticket', source: 'provider', reason: 'comment', eventId: 'comment-4' }]);
  await expect(earlier.getByRole('button', { name: 'Open earlier BIL-128 · Plan changes', exact: true })).toHaveCount(0);
  await acknowledge('ticket');
  await expect(earlier.getByRole('button', { name: 'Open earlier BIL-128 · Plan changes', exact: true })).toHaveCount(1);
  await list.locator('.rail-panel-body').evaluate(element => { element.scrollTop = element.scrollHeight; }); await expect(rows).toHaveCount(14);
  await apply(page, [{ type: 'node.archive', id: 'pr' }]);
  await expect(earlier.getByRole('button', { name: 'Open earlier Plan switcher', exact: true })).toContainText('Archived');
  await earlier.getByRole('button', { name: 'Open earlier Plan switcher', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('archived or unavailable');
  await apply(page, [{ type: 'node.archive', id: 'ticket' }, { type: 'node.delete', id: 'ticket' }]);
  const gone = earlier.getByRole('button', { name: 'Open earlier BIL-128 · Plan changes', exact: true });
  await expect(gone).toContainText('Deleted · no longer on your table'); await expect(gone).toBeDisabled();
  await page.reload();
  await page.getByRole('button', { name: 'Needs me', exact: true }).click();
  await expect(rows).toHaveCount(14);
});

test('completion notices stack, expire without marking read, open items, and never replay on reload', async ({ visual: { page } }) => {
  await apply(page, [{ type: 'node.update', id: 'agent', activity: 'idle', attention: 'none' }, { type: 'node.update', id: 'pr', attention: 'none' }]);
  const finish = (id: string, eventId: string, note?: string): WorkspaceCommand => ({ type: 'attention.set', id, source: 'completion', reason: 'finished', eventId, ...(note ? { note } : {}) });
  await apply(page, [finish('agent', 'turn-one', 'Agent finished'), finish('pr', 'review-one')]);
  const first = page.getByRole('status', { name: 'Claude · implementation finished', exact: true });
  const second = page.getByRole('status', { name: 'Plan switcher finished', exact: true });
  await expect(first).toBeVisible(); await expect(second).toBeVisible();
  await expect(first).toContainText('Agent finished'); await expect(second).toContainText('Finished · ready to view');
  // Finished work is listed in Needs me without being counted.
  await expect(page.getByRole('button', { name: 'Needs me', exact: true })).toHaveAttribute('title', 'Needs me · 2 finished');
  const a = (await first.boundingBox())!, b = (await second.boundingBox())!;
  expect(a.x).toBeLessThan(50); expect(a.y + a.height).toBeLessThan(b.y);
  await capture(page, 'completion-notices.png');
  await first.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'agent');
  await expect(page.getByRole('button', { name: 'Needs me', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Needs me', exact: true }).click();
  await page.getByRole('button', { name: 'Dismiss Claude · implementation from Needs me', exact: true }).click();
  await page.getByRole('button', { name: 'Close needs me', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Needs me', exact: true })).toHaveAttribute('title', 'Needs me · 1 finished');
  await expect(second).toHaveCount(0, { timeout: 7000 });
  await expect(page.getByRole('button', { name: 'Needs me', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Needs me', exact: true })).toBeVisible();
  await expect(page.locator('.act-toast')).toHaveCount(0);
  await apply(page, [finish('agent', 'turn-one')]);
  await expect(page.locator('.act-toast')).toHaveCount(0);
  await apply(page, [finish('agent', 'turn-two')]);
  await expect(first).toBeVisible();
  await expect(page.getByRole('button', { name: 'Needs me', exact: true })).toHaveAttribute('title', 'Needs me · 2 finished');
});


/** Far-zoom item cues show below the dashboard threshold, or in the icon band while dashboards are off. */
const dashboardsBelow = (page: Page, belowZoom: number, enabled = true) => page.evaluate(async ({ belowZoom, enabled }) => {
  const saved = await window.craftingTable.settingsRead();
  await window.craftingTable.settingsWrite({ expectedRevision: saved.revision, value: { ...saved.value, mapDashboards: { ...saved.value.mapDashboards, enabled, belowZoom, placement: 'center' } } });
}, { belowZoom, enabled });

test('overview attention has a minimum screen size and a non-color cue without motion', async ({ visual: { page } }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // The icon band exists only while dashboards are off; with them on, items stay cards down to the threshold.
  await dashboardsBelow(page, .45, false);
  await page.getByRole('slider', { name: 'Map zoom' }).fill('0.5');
  await expect(page.locator('.map-area')).toHaveAttribute('data-level', 'overview');
  await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', '0.5');
  const marker = page.getByRole('article', { name: 'Claude · implementation', exact: true }).getByRole('img', { name: 'Asking me: Waiting for your input' });
  await expect(marker.locator('.tier-mark')).toHaveAttribute('data-glyph', 'asking');
  const bounds = (await marker.boundingBox())!; expect(bounds.width).toBeGreaterThanOrEqual(8); expect(bounds.height).toBeGreaterThanOrEqual(8);
  await expect(marker).toHaveCSS('animation-name', 'none');
  await expect(page.locator('[data-project-label="billing"] .project-counts')).toContainText('1 asking · 1 my turn');
  await expect(page.locator('[data-project-label="billing"] .project-counts .tier-mark')).toHaveCount(2);
  await dashboardsBelow(page, .45);
  await page.getByRole('slider', { name: 'Map zoom' }).focus(); await page.keyboard.press('Home');
  await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', '0.2');
  const dashboard = page.locator('[data-dashboard="billing"]');
  await expect(dashboard.locator('h4[data-section="needs"], .dashboard-tiers')).toContainText(/Needs me · 2|1 asking · 1 my turn/);
  await expect(dashboard.locator('.tier-mark').first()).toHaveAttribute('data-glyph', 'asking');
  await capture(page, 'needs-me-overview.png');
});

/** A card's working mark is drawn inside the card, on its bottom edge. */
const workingMark = (page: Page, id = 'agent') => page.locator(`[data-item-id="${id}"] > .working-mark`);
/** The colour a value resolves to inside a card, in the form computed styles report it. */
const resolved = (page: Page, id: string, value: string) => page.locator(`[data-item-id="${id}"]`).evaluate((card, value) => { const probe = document.createElement('i'); probe.style.color = value; card.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; }, value);
/** The mark sits on the inside of the card's bottom edge and inside its width; `reached` lists whatever the card says or shows that reaches into its band.
 * `cut` is a card zoomed out so far that its own bottom edge already cuts its last line: nothing can stay clear of that. */
const grazesClear = (page: Page, id = 'agent') => page.locator(`[data-item-id="${id}"]`).evaluate(element => {
  const card = element.getBoundingClientRect(), mark = element.querySelector(':scope > .working-mark')!.getBoundingClientRect(), scale = card.width / (element as HTMLElement).offsetWidth;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), range = document.createRange(), said: [string, { left: number; right: number; bottom: number }][] = [];
  // A line counts down to where its clipping ancestors still show it: a clamped summary hides its later lines.
  while (walker.nextNode()) {
    range.selectNodeContents(walker.currentNode);
    for (const rect of range.getClientRects()) {
      let bottom = rect.bottom;
      for (let parent = walker.currentNode.parentElement!; parent !== element; parent = parent.parentElement!) if (getComputedStyle(parent).overflowY !== 'visible') bottom = Math.min(bottom, parent.getBoundingClientRect().bottom);
      if (rect.width && bottom - rect.top > 1) said.push([walker.currentNode.textContent!, { left: rect.left, right: rect.right, bottom }]);
    }
  }
  for (const glyph of element.querySelectorAll('.item-glyph,.tier-mark,.status-glyph')) said.push([glyph.getAttribute('class')!, glyph.getBoundingClientRect()]);
  const provider = element.querySelector('.brand-claude')?.getBoundingClientRect();
  return { inside: mark.left >= card.left + 8 * scale && mark.right <= card.right - 8 * scale, onEdge: Math.abs(card.bottom - scale - mark.bottom) < .6, height: Math.round(mark.height / scale),
    cut: said.some(([, rect]) => rect.bottom > card.bottom - scale + .6),
    reached: said.filter(([, rect]) => rect.bottom > mark.top + .6 && rect.bottom <= card.bottom - scale + .6 && rect.right > mark.left && rect.left < mark.right).map(([name, rect]) => `${name} by ${((rect.bottom - mark.top) / scale).toFixed(1)}px`),
    provider: !provider || provider.left >= card.left - .1 && provider.right <= card.right + .1 && provider.top >= card.top - .1 && provider.bottom <= card.bottom + .1 };
});

test('the working grass follows every size and zoom, retains attention and clears when idle', async ({ visual: { page } }) => {
  const card = page.locator('[data-item-id="agent"]'), mark = workingMark(page);
  await dashboardsBelow(page, .45);
  await page.getByRole('slider', { name: 'Map zoom' }).fill('1');
  await expect(mark).toBeVisible(); await expect(mark).toHaveAccessibleName('Working');
  // The card needs me, so its second line says why; the grass and the sheep say it works.
  await expect(card.locator('.card-summary')).toHaveText('Waiting for your input · Updating the plan switcher');
  expect(await mark.locator('i').first().evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  await expect(page.locator('.working-border,.working-indicator,.working-pip')).toHaveCount(0);
  const original = (await read(page)).nodes.find(node => node.id === 'agent')!;
  // The sheep walks an 8px band on the bottom edge that no text, icon or shape reaches: every agent size has it at
  // full zoom. Zooming out tightens a card until a title or summary line reaches the band; it then keeps the tufts,
  // 4px, with a glint. Either way nothing the card says is covered.
  const seen = new Set<string>();
  for (const mapSize of ['small', 'medium', 'large'] as const) {
    await apply(page, [{ type: 'node.resize', id: 'agent', size: mapSize }]);
    for (const zoom of ['1', '0.6', '0.5', '0.46']) {
      await page.getByRole('slider', { name: 'Map zoom' }).fill(zoom);
      await expect(card).toHaveAttribute('data-map-size', mapSize);
      await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', zoom);
      await expect(mark, `${mapSize} at ${zoom}`).toHaveAttribute('data-variant', zoom === '1' ? 'graze' : /^(graze|glint)$/);
      const variant = await mark.getAttribute('data-variant'); seen.add(variant!);
      await expect.poll(() => grazesClear(page), `${mapSize} at ${zoom}`).toMatchObject({ inside: true, onEdge: true, height: variant === 'graze' ? 8 : 4, reached: [], provider: true });
      if ((await grazesClear(page)).cut) { expect(zoom).not.toBe('1'); expect(variant).toBe('glint'); }
      await expect(card.getByRole('img', { name: /^Asking me/ })).toBeVisible();
    }
  }
  expect([...seen].sort()).toEqual(['glint', 'graze']);
  await page.getByRole('slider', { name: 'Map zoom' }).fill('1');
  await resizeItemOnMap(page, 'agent', 312, 146);
  const resized = (await card.boundingBox())!, track = (await mark.boundingBox())!;
  expect(track.width).toBeCloseTo(resized.width - 18, 1); expect(track.y + track.height + 1).toBeCloseTo(resized.y + resized.height, 1);
  // 147 two-pixel steps of track, less the sheep's own seven.
  expect(await mark.locator('i').first().evaluate(element => getComputedStyle(element).getPropertyValue('--graze-steps'))).toBe('141');
  const workingBounds = await card.boundingBox();
  const workingPosition = (await read(page)).nodes.find(node => node.id === 'agent')!.position;
  await apply(page, [{ type: 'node.update', id: 'agent', activity: 'idle' }]);
  await expect(mark).toHaveCount(0); await expect(card.locator('.working-label')).toHaveCount(0);
  await expect(card).not.toHaveClass(/working-card/);
  await expect(card.getByRole('img', { name: /^Asking me/ })).toBeVisible();
  expect(await card.boundingBox()).toEqual(workingBounds);
  expect((await read(page)).nodes.find(node => node.id === 'agent')!.position).toEqual(workingPosition);
  expect((await read(page)).nodes.find(node => node.id === 'agent')!.projectId).toEqual(original.projectId);
  await apply(page, [{ type: 'node.update', id: 'agent', activity: 'working', summary: '', attention: 'none' }]);
  await expect(mark).toBeVisible(); await expect(card.locator('.card-summary')).toHaveText('Working');
  await expect(card.getByRole('img', { name: /^(Asking me|My turn|Finished)/ })).toHaveCount(0);
  await page.mouse.move(4, 4);
  const box = (await card.boundingBox())!;
  await expect(page).toHaveScreenshot('working-agent.png', { clip: { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 24 } });
});

test('the sheep walks in steps without shifting content or rerendering, and stands still in full view and reduced motion', async ({ visual: { page } }) => {
  await apply(page, [{ type: 'node.update', id: 'agent', attention: 'none' }]);
  await page.getByRole('slider', { name: 'Map zoom' }).fill('1');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const card = page.locator('[data-item-id="agent"]'), mark = workingMark(page);
  await expect(mark).toHaveAttribute('data-variant', 'graze');
  const at = () => mark.locator('i').first().evaluate(element => { const style = getComputedStyle(element); return ['--graze-x', '--graze-face', '--graze-leg'].map(name => style.getPropertyValue(name)).join(' '); });
  const play = () => mark.locator('i').first().evaluate(element => [...new Set(getComputedStyle(element).animationPlayState.split(', '))].join());
  const original = await at();
  const bounds = await card.boundingBox(), heading = await card.locator('.card-heading').boundingBox();
  const state = await read(page);
  await page.evaluate(() => window.craftingPerformance.reset());
  await expect.poll(at).not.toBe(original);
  // Three stepped animations on the mark itself: the walk there and back, the turn at each end, the legs.
  const steps = Number(await mark.locator('i').first().evaluate(element => getComputedStyle(element).getPropertyValue('--graze-steps')));
  expect(steps).toBeGreaterThan(40);
  const animations = await mark.locator('i').first().evaluate(element => element.getAnimations({ subtree: true }).map(animation => { const timing = animation.effect!.getTiming(); return { name: (animation as CSSAnimation).animationName, duration: Math.round(Number(timing.duration)), direction: timing.direction }; }));
  expect(animations).toEqual([
    { name: 'graze-walk', duration: steps * 250, direction: 'alternate' },
    { name: 'graze-face', duration: steps * 500, direction: 'normal' },
    { name: 'graze-leg', duration: 333, direction: 'normal' }]);
  expect(await mark.locator('i').first().evaluate(element => getComputedStyle(element).animationTimingFunction)).toBe(`steps(${steps}), steps(2), steps(2)`);
  // Seek without pausing: a scripted pause would take over from the stylesheet's play state.
  const seek = (time: number) => mark.locator('i').first().evaluate((element, time) => { for (const animation of element.getAnimations()) animation.currentTime = time; const style = getComputedStyle(element); return { x: style.getPropertyValue('--graze-x'), face: style.getPropertyValue('--graze-face'), sheep: getComputedStyle(element, '::after').maskPosition, bite: getComputedStyle(element, '::before').maskPosition }; }, time);
  // Two pixels every 250 ms: about 8 px a second, and the bite travels with the sheep.
  const walk = [];
  for (let step = 0; step < 8; step++) {
    walk.push(await seek(step * 250 + 100));
    expect(await card.boundingBox()).toEqual(bounds);
    expect(await card.locator('.card-heading').boundingBox()).toEqual(heading);
  }
  expect(walk.map(place => place.x)).toEqual(['0px', '2px', '4px', '6px', '8px', '10px', '12px', '14px']);
  expect(new Set(walk.map(place => place.sheep)).size).toBe(8); expect(new Set(walk.map(place => place.bite)).size).toBe(8);
  expect(new Set(walk.map(place => place.face))).toEqual(new Set(['0']));
  // At the far end it turns and comes back the way it went.
  const end = await seek(steps * 250 - 100), turned = await seek(steps * 250 + 100), back = await seek(steps * 250 + 350);
  expect(end).toMatchObject({ x: `${(steps - 1) * 2}px`, face: '0' }); expect(turned).toMatchObject({ x: `${(steps - 1) * 2}px`, face: '1' }); expect(back).toMatchObject({ x: `${(steps - 2) * 2}px`, face: '1' });
  expect(turned.sheep).not.toBe(end.sheep); expect(turned.bite).not.toBe(end.bite);
  const metrics = await page.evaluate(() => window.craftingPerformance.snapshot());
  expect(metrics.metrics['map.card-render'].count).toBe(0);
  await card.click();
  const expanded = page.locator('[data-expanded-item-id="agent"]');
  await expect(expanded).toBeVisible();
  await expect(expanded.locator('.working-mark')).toHaveCount(0);
  expect(await play()).toBe('paused');
  const paused = await at();
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 450)));
  expect(await at()).toBe(paused);
  await page.getByRole('button', { name: 'Back to project' }).click();
  // The card's own mark never left the map; it runs again as soon as the view closes.
  await expect(mark).toBeVisible();
  await expect.poll(play).toBe('running');
  await expect.poll(at).not.toBe(paused);
  await expect(expanded).toBeHidden();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // Still: the tufts and a sheep standing a little way in, with the grass around it eaten.
  expect(await mark.locator('i').first().evaluate(element => [getComputedStyle(element).animationName, element.getAnimations({ subtree: true }).length, getComputedStyle(element).getPropertyValue('--graze-x'), getComputedStyle(element, '::after').maskImage.includes('data:image/svg+xml'), getComputedStyle(element, '::before').maskImage.includes('data:image/svg+xml')])).toEqual(['none', 0, '24px', true, true]);
  await expect(card.locator('.working-label')).toBeVisible();
  expect((await read(page)).nodes).toEqual(state.nodes);
});

test('a working item keeps one sheep per busy helper in its own paddock, capped by its width, and says how many', async ({ visual: { page } }) => {
  await page.getByRole('slider', { name: 'Map zoom' }).fill('1');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await apply(page, [{ type: 'node.update', id: 'agent', attention: 'none', summary: 'Tests' }, { type: 'node.update', id: 'pr', activity: 'working' }]);
  const card = page.locator('[data-item-id="agent"]'), mark = workingMark(page), paddocks = mark.locator('> i');
  const flock = () => paddocks.evaluateAll(items => items.map(item => { const style = getComputedStyle(item), box = item.getBoundingClientRect(); return { left: Math.round(box.left), width: Math.round(box.width), x: style.getPropertyValue('--graze-x'), delay: style.animationDelay.split(', ')[0], sheep: getComputedStyle(item, '::after').maskImage.includes('data:image/svg+xml'), bite: getComputedStyle(item, '::before').maskImage.split('data:image/svg+xml').length - 1, tufts: getComputedStyle(item, '::before').maskPosition.split(',')[0] }; }));
  // No helpers: one sheep, as on every item that is not a Claude session with subagents.
  await expect(paddocks).toHaveCount(1); await expect(mark).toHaveAccessibleName('Working'); await expect(card).not.toHaveAttribute('title');
  await expect(workingMark(page, 'pr').locator('> i')).toHaveCount(1);
  await apply(page, [{ type: 'node.update', id: 'agent', helpers: 1 }]);
  await expect(paddocks).toHaveCount(2); await expect(mark).toHaveAccessibleName('Working, 1 subagent');
  await apply(page, [{ type: 'node.update', id: 'agent', helpers: 2 }]);
  await expect(paddocks).toHaveCount(3); await expect(mark).toHaveAccessibleName('Working, 2 subagents'); await expect(card).toHaveAttribute('title', 'Working, 2 subagents');
  await expect(mark).toHaveAttribute('data-variant', 'graze');
  // A 240px card has 222px of edge, 111 pixels: three paddocks of 37 pixels. Each has its own sheep,
  // its own bite and its own lead, and the tuft tile carries on across them.
  const three = await flock(), box = (await mark.boundingBox())!;
  expect(three.map(paddock => paddock.width)).toEqual([74, 74, 74]);
  expect(three.map(paddock => paddock.left - Math.round(box.x))).toEqual([0, 74, 148]);
  expect(three.map(paddock => [paddock.sheep, paddock.bite, paddock.tufts])).toEqual([[true, 2, '0px 0px'], [true, 2, '-74px 0px'], [true, 2, '-148px 0px']]);
  expect(await paddocks.first().evaluate(element => getComputedStyle(element).getPropertyValue('--graze-steps'))).toBe('31');
  expect(new Set(three.map(paddock => paddock.delay)).size).toBe(3);
  // Out of step: at one moment the three stand at different places, each inside its own paddock.
  await expect.poll(async () => new Set((await flock()).map(paddock => paddock.x)).size).toBeGreaterThan(1);
  for (const paddock of await flock()) expect(parseFloat(paddock.x) + 14).toBeLessThanOrEqual(74);
  // More helpers than the edge has 44px paddocks for: five sheep on this card, and the words keep the real number.
  await apply(page, [{ type: 'node.update', id: 'agent', helpers: 9 }]);
  await expect(paddocks).toHaveCount(5); await expect(mark).toHaveAccessibleName('Working, 9 subagents'); await expect(card).toHaveAttribute('title', 'Working, 9 subagents');
  expect((await flock()).map(paddock => paddock.width)).toEqual([44, 44, 44, 44, 46]);
  expect(await grazesClear(page)).toMatchObject({ inside: true, onEdge: true, height: 8, reached: [] });
  // Still: the same number of sheep, standing.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect((await flock()).map(paddock => [paddock.x, paddock.sheep])).toEqual([['24px', true], ['18px', true], ['12px', true], ['6px', true], ['0px', true]]);
  expect(await mark.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
  await page.mouse.move(4, 4);
  const bounds = (await card.boundingBox())!;
  await expect(page).toHaveScreenshot('working-flock.png', { clip: { x: bounds.x - 8, y: bounds.y - 8, width: bounds.width + 16, height: bounds.height + 16 } });
  // The count belongs to working: an item that stops working loses it with its mark.
  await apply(page, [{ type: 'node.update', id: 'agent', activity: 'idle' }]);
  await expect(mark).toHaveCount(0); await expect(card).not.toHaveAttribute('title');
  expect((await read(page)).nodes.find(node => node.id === 'agent')!.helpers).toBeUndefined();
  await apply(page, [{ type: 'node.update', id: 'agent', activity: 'working' }]);
  await expect(paddocks).toHaveCount(1);
});

test('while an item only waits on its helpers its own sheep sleeps and theirs graze; with its turn active all graze', async ({ visual: { page } }) => {
  await page.getByRole('slider', { name: 'Map zoom' }).fill('1');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const card = page.locator('[data-item-id="agent"]'), mark = workingMark(page), paddocks = mark.locator('> i');
  const flock = () => paddocks.evaluateAll(items => items.map(item => { const style = getComputedStyle(item), sheep = getComputedStyle(item, '::after'), grass = getComputedStyle(item, '::before');
    return { names: style.animationName, x: style.getPropertyValue('--graze-x'), doze: style.getPropertyValue('--graze-doze'), lying: sheep.maskImage.split('data:image/svg+xml').length - 1 === 2, height: sheep.height, zed: sheep.maskSize.split(',')[0].trim(), bitten: grass.maskImage.split('data:image/svg+xml').length - 1 === 2 }; }));
  // Its own turn is active: it works alongside two subagents and all three graze.
  await apply(page, [{ type: 'node.update', id: 'agent', attention: 'none', summary: 'Claude is working', helpers: 2 }]);
  await expect(paddocks).toHaveCount(3); await expect(mark).toHaveAttribute('data-pose', 'graze'); await expect(mark).toHaveAccessibleName('Working, 2 subagents');
  expect((await flock()).map(paddock => [paddock.names, paddock.lying, paddock.bitten])).toEqual(Array(3).fill(['graze-walk, graze-face, graze-leg', false, true]));
  // Its turn has ended and it waits on them: the first sheep lies down on whole grass, the other two graze on.
  await apply(page, [{ type: 'node.update', id: 'agent', summary: 'Waiting on 2 subagents', helpers: 2, waiting: true }]);
  await expect(mark).toHaveAttribute('data-pose', 'asleep'); await expect(paddocks).toHaveCount(3);
  await expect(mark).toHaveAccessibleName('Working, waiting on 2 subagents'); await expect(card).toHaveAttribute('title', 'Working, waiting on 2 subagents');
  const asleep = await flock();
  expect(asleep.map(paddock => [paddock.names, paddock.lying, paddock.bitten])).toEqual([['graze-doze', true, false], ['graze-walk, graze-face, graze-leg', false, true], ['graze-walk, graze-face, graze-leg', false, true]]);
  expect([asleep[0].x, asleep[0].height]).toEqual(['8px', '12px']);
  // The z: there for the first half of every three seconds, rising 2px a step, then gone.
  const doze = (time: number) => paddocks.first().evaluate((item, time) => { for (const animation of item.getAnimations()) animation.currentTime = time; const sheep = getComputedStyle(item, '::after'); return [sheep.maskSize.split(',')[0].trim(), sheep.maskPosition.split(',')[0].trim()]; }, time);
  expect([await doze(100), await doze(600), await doze(1_100), await doze(1_600), await doze(2_900)]).toEqual([['4px 6px', '22px 4px'], ['4px 6px', '24px 2px'], ['4px 6px', '26px 0px'], ['0px 6px', '28px -2px'], ['0px 6px', '32px -6px']]);
  const sleeping = (await card.boundingBox())!, first = await page.screenshot({ clip: sleeping });
  await expect.poll(async () => (await page.screenshot({ clip: sleeping })).equals(first)).toBe(false);
  expect(await grazesClear(page)).toMatchObject({ inside: true, onEdge: true, height: 8, reached: [] });
  // One helper left: still asleep, with one sheep grazing beside it.
  await apply(page, [{ type: 'node.update', id: 'agent', summary: 'Waiting on 1 subagent', helpers: 1 }]);
  await expect(paddocks).toHaveCount(2); await expect(mark).toHaveAttribute('data-pose', 'asleep'); await expect(mark).toHaveAccessibleName('Working, waiting on 1 subagent');
  expect((await flock()).map(paddock => paddock.lying)).toEqual([true, false]);
  // More helpers than paddocks: the sleeping one is never the one left out.
  await apply(page, [{ type: 'node.update', id: 'agent', helpers: 9 }]);
  await expect(paddocks).toHaveCount(5); await expect(mark).toHaveAccessibleName('Working, waiting on 9 subagents');
  expect((await flock()).map(paddock => paddock.lying)).toEqual([true, false, false, false, false]);
  // Still: the lying sheep without its z, the others standing.
  await apply(page, [{ type: 'node.update', id: 'agent', summary: 'Waiting on 2 subagents', helpers: 2 }]);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect((await flock()).map(paddock => [paddock.names, paddock.lying, paddock.zed, paddock.x])).toEqual([['none', true, '0px 6px', '8px'], ['none', false, '14px 48px', '18px'], ['none', false, '14px 48px', '12px']]);
  await page.mouse.move(4, 4);
  const bounds = (await card.boundingBox())!;
  await expect(page).toHaveScreenshot('working-lead-asleep.png', { clip: { x: bounds.x - 8, y: bounds.y - 8, width: bounds.width + 16, height: bounds.height + 16 } });
  // Waking to read a result, and losing the last helper, both end the sleep.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await apply(page, [{ type: 'node.update', id: 'agent', waiting: false }]);
  await expect(mark).toHaveAttribute('data-pose', 'graze'); await expect(mark).toHaveAccessibleName('Working, 2 subagents');
  await apply(page, [{ type: 'node.update', id: 'agent', waiting: true }]); await expect(mark).toHaveAttribute('data-pose', 'asleep');
  await apply(page, [{ type: 'node.update', id: 'agent', helpers: 0 }]);
  await expect(paddocks).toHaveCount(1); await expect(mark).toHaveAttribute('data-pose', 'graze'); await expect(mark).toHaveAccessibleName('Working');
  expect((await read(page)).nodes.find(node => node.id === 'agent')!.waiting).toBeUndefined();
});

test('every working card grows grass in its own colour, a card too small for the sheep glints, and Undermap stands still', async ({ visual: { page } }) => {
  await page.getByRole('slider', { name: 'Map zoom' }).fill('1');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await apply(page, [{ type: 'node.update', id: 'pr', activity: 'working' }, { type: 'node.update', id: 'ticket', activity: 'working' }, { type: 'node.update', id: 'brief', activity: 'working' },
    { type: 'item.add', id: 'memo', resourceId: 'memo-resource', pluginId: 'workspace.note', data: { text: 'Rollout order\nBackfill first' }, projectId: 'billing', position: { x: 660, y: 620 } }, { type: 'node.update', id: 'memo', activity: 'working' },
    { type: 'item.add', id: 'slate', resourceId: 'slate-resource', pluginId: 'workspace.note', data: { text: 'Open questions', paper: 'slate' }, projectId: 'billing', position: { x: 900, y: 640 } }, { type: 'node.update', id: 'slate', activity: 'working' }]);
  const tufts = (id: string) => workingMark(page, id).locator('i').first().evaluate(element => getComputedStyle(element, '::before').backgroundImage);
  const sheep = (id: string) => workingMark(page, id).locator('i').first().evaluate(element => getComputedStyle(element, '::after').backgroundImage);
  const frame = (id: string) => page.locator(`[data-item-id="${id}"]`).evaluate(element => getComputedStyle(element, '::after').backgroundColor);
  // Item cards: the tufts are the card's type tone, the colour its hovered edge uses. Amber is the frame's alone.
  const tones = new Set<string>(), amber = [await resolved(page, 'agent', 'var(--act-attention)'), await resolved(page, 'agent', 'var(--act-attention-asking)')];
  for (const id of ['agent', 'pr', 'ticket']) {
    await expect(workingMark(page, id)).toHaveAttribute('data-variant', 'graze');
    const tone = await resolved(page, id, 'var(--tone)'); tones.add(tone);
    expect(await tufts(id)).toContain(tone);
    for (const colour of amber) { expect(await tufts(id)).not.toContain(colour); expect(await sheep(id)).not.toContain(colour); }
    expect(await grazesClear(page, id)).toMatchObject({ inside: true, onEdge: true, reached: [] });
  }
  expect(tones.size).toBeGreaterThan(1);
  // The agent needs me: its frame is amber, its grass is not, and both show.
  expect(amber).toContain(await frame('agent'));
  // The sheep is the mint part: brightest mint with a darker head.
  expect(await sheep('agent')).toContain(await resolved(page, 'agent', 'var(--act-working-sheep)')); expect(await sheep('agent')).toContain(await resolved(page, 'agent', 'var(--act-working-sheep-head)'));
  expect(await sheep('pr')).toBe(await sheep('agent'));
  // Notes: the tufts are the paper's own edge colour, and on a light paper the sheep is dark so it shows.
  for (const id of ['memo', 'slate']) {
    await expect(workingMark(page, id)).toHaveAttribute('data-variant', 'graze');
    expect(await tufts(id)).toContain(await frame(id));
    expect(await grazesClear(page, id)).toMatchObject({ inside: true, onEdge: true, reached: [] });
  }
  expect(await tufts('memo')).not.toBe(await tufts('slate'));
  expect(await sheep('memo')).not.toBe(await sheep('agent')); expect(await sheep('slate')).toBe(await sheep('agent'));
  // Long titles and summaries still leave the band free on every size these types have.
  const long = 'Rewriting the proration engine so that upgrades and downgrades in one period merge into a single invoice line';
  for (const id of ['pr', 'ticket']) for (const size of ['small', 'medium'] as const) {
    await apply(page, [{ type: 'node.update', id, title: 'A deliberately long title that wants to wrap onto several lines', summary: long }, { type: 'node.resize', id, size }]);
    await expect(page.locator(`[data-item-id="${id}"]`)).toHaveAttribute('data-map-size', size);
    await expect.poll(() => grazesClear(page, id)).toMatchObject({ inside: true, onEdge: true, height: 8, reached: [] });
  }
  // Too narrow, too low or tiny for a sheep, or text that reaches into its band: the tufts stay and a glint steps through
  // them. No built-in type is that small at full zoom (the size rule is unit-tested), so a taller label takes the room here.
  const glint = (id: string) => workingMark(page, id).locator('i').first().evaluate(element => { const style = getComputedStyle(element), after = getComputedStyle(element, '::after'); return { name: style.animationName, timing: style.animationTimingFunction, x: style.getPropertyValue('--graze-x'), mint: after.backgroundColor, masks: after.maskImage.split('url(').length - 1 + (after.maskImage.includes('gradient') ? 1 : 0), tufts: getComputedStyle(element, '::before').maskImage.includes('data:image/svg+xml') }; });
  await page.addStyleTag({ content: '[data-item-id="brief"] .card-label { padding-bottom: 16px; }' });
  const small = async (id: string) => { await apply(page, [{ type: 'node.update', id, summary: `Tight ${Date.now()}` }]); await expect(workingMark(page, id)).toHaveAttribute('data-variant', 'glint'); };
  await small('brief');
  expect(await grazesClear(page, 'brief')).toEqual({ inside: true, onEdge: true, height: 4, cut: false, reached: [], provider: true });
  const first = await glint('brief');
  expect(first).toMatchObject({ name: 'graze-glint', timing: `steps(${grazeSteps('glint', await page.locator('[data-item-id="brief"]').evaluate(card => (card as HTMLElement).offsetWidth))})`, mint: await resolved(page, 'brief', 'var(--act-accent)'), masks: 2, tufts: true });
  await expect.poll(async () => (await glint('brief')).x).not.toBe(first.x);
  await page.mouse.move(4, 4);
  const area = (await page.locator('.map-area').boundingBox())!;
  await expect(page).toHaveScreenshot('working-small-and-tones.png', { clip: area });
  // Undermap shows that an item works without moving anything: tufts and a standing sheep, tufts alone where there is no room.
  for (const title of ['Billing experience', 'Claude · implementation']) { await page.getByRole('article', { name: title, exact: true }).click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Send to Undermap', exact: true }).click(); await expect(page.getByRole('article', { name: title, exact: true })).toHaveCount(0); }
  await page.getByRole('button', { name: 'Go to Undermap', exact: true }).click();
  await expect(page.locator('.map-area')).toHaveAttribute('data-layer', 'below');
  await expect(workingMark(page, 'brief')).toBeVisible(); await small('brief');
  for (const id of ['agent', 'brief']) {
    await expect(workingMark(page, id)).toBeVisible();
    const still = () => workingMark(page, id).locator('i').first().evaluate(element => { const style = getComputedStyle(element), after = getComputedStyle(element, '::after'); return [style.animationName, element.getAnimations({ subtree: true }).length, style.getPropertyValue('--graze-x'), after.content === 'none' ? 'no glint' : after.maskPosition, getComputedStyle(element, '::before').maskImage.includes('data:image/svg+xml')].join('|'); });
    const first = await still(); await page.waitForTimeout(600);
    expect(await still()).toBe(first);
    expect(first.startsWith(id === 'agent' ? 'none|0|24px|' : 'none|0|0px|no glint|')).toBe(true); expect(first.endsWith('|true')).toBe(true);
  }
});

test('Mark seen sits left of the close X, clears Needs me and hides, for agent and provider frames', async ({ visual: { page } }) => {
  const needs = (count: number) => page.getByRole('button', { name: `Needs me: ${count}`, exact: true });
  const seen = page.getByRole('button', { name: 'Mark seen', exact: true }), close = page.getByRole('button', { name: 'Back to project', exact: true });
  await expect(needs(2)).toBeVisible();
  for (const [title, id, left] of [['Claude · implementation', 'agent', 1], ['Plan switcher', 'pr', 0]] as const) {
    await page.getByRole('article', { name: title, exact: true }).click();
    await expect(page.locator('.map-area')).toHaveAttribute('data-focus', id);
    await expect(seen).toBeVisible(); await expect(seen).toHaveAttribute('title', 'Mark seen (remove from Needs me)');
    await expect(needs(left + 1)).toBeVisible();
    const a = (await seen.boundingBox())!, b = (await close.boundingBox())!;
    expect(a.x + a.width, `${id}: left of X`).toBeLessThanOrEqual(b.x + .5);
    expect(b.x - (a.x + a.width), `${id}: next to X`).toBeLessThanOrEqual(10);
    expect(Math.abs(a.y + a.height / 2 - (b.y + b.height / 2)), `${id}: same row`).toBeLessThanOrEqual(1);
    expect(Math.abs(a.width - b.width) + Math.abs(a.height - b.height), `${id}: X-sized`).toBeLessThanOrEqual(1);
    await expect(seen.locator('svg')).toHaveCount(1);
    await page.locator(`[data-expanded-item-id="${id}"] .card-heading`).screenshot({ path: test.info().outputPath(`mark-seen-header-${id}.png`) });
    await seen.click();
    await expect(seen).toHaveCount(0); await expect(close).toBeVisible();
    await expect(left ? needs(left) : page.getByRole('button', { name: 'Needs me', exact: true })).toBeVisible();
    const node = (await read(page)).nodes.find(node => node.id === id)!;
    expect(node.attentionSeenVersion).toBe(node.attentionVersion ?? 0);
    await close.click();
  }
});

test('Mark seen is absent when the open item is not in Needs me and returns with new attention', async ({ visual: { page } }) => {
  await page.getByRole('button', { name: 'Needs me: 2', exact: true }).click();
  await page.getByRole('button', { name: 'Dismiss Plan switcher from Needs me', exact: true }).click();
  await page.getByRole('button', { name: 'Close needs me', exact: true }).click();
  await page.getByRole('article', { name: 'Plan switcher', exact: true }).click();
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'pr');
  await expect(page.getByRole('button', { name: 'Back to project', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark seen', exact: true })).toHaveCount(0);
  await apply(page, [{ type: 'attention.set', id: 'pr', source: 'review', reason: 'review', eventId: 'again' }]);
  await expect(page.getByRole('button', { name: 'Mark seen', exact: true })).toBeVisible();
});

test('attention that arrives for the item I have open in the front window is seen at once, not added to Needs me', async ({ visual: { app, page } }) => {
  const needs = (count: number) => page.getByRole('button', { name: `Needs me: ${count}`, exact: true });
  const seen = page.getByRole('button', { name: 'Mark seen', exact: true });
  const emit = (event: 'blur' | 'focus') => app.evaluate(({ BrowserWindow }, event) => { BrowserWindow.getAllWindows()[0].emit(event); }, event);
  const node = async (id: string) => (await read(page)).nodes.find(node => node.id === id)!;
  await page.getByRole('button', { name: 'Needs me: 2', exact: true }).click();
  await page.getByRole('button', { name: 'Dismiss Plan switcher from Needs me', exact: true }).click();
  await page.getByRole('button', { name: 'Close needs me', exact: true }).click();
  await expect(needs(1)).toBeVisible();
  await emit('focus');
  await page.getByRole('article', { name: 'Plan switcher', exact: true }).click();
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'pr');
  await apply(page, [{ type: 'attention.set', id: 'pr', source: 'review', reason: 'review', eventId: 'while-open' }]);
  await expect.poll(async () => { const pr = await node('pr'); return pr.attentionSeenVersion === (pr.attentionVersion ?? 0); }).toBe(true);
  await expect(seen).toHaveCount(0); await expect(needs(1)).toBeVisible();
  // Something else on the map still lands in Needs me while this item is open.
  await apply(page, [{ type: 'attention.set', id: 'ticket', source: 'comments', reason: 'comment', eventId: 'elsewhere' }]);
  await expect(needs(2)).toBeVisible();
  // With the window in the background the open item is not being looked at.
  await emit('blur');
  await apply(page, [{ type: 'attention.set', id: 'pr', source: 'review', reason: 'review', eventId: 'in-background' }]);
  await expect(needs(3)).toBeVisible(); await expect(seen).toBeVisible();
  // It was already waiting when I came back, so it stays until I mark it.
  await emit('focus'); await page.waitForTimeout(300);
  await expect(needs(3)).toBeVisible();
});

test('a middle click on a card in Needs me opens its web page and marks it seen without opening it in the app', async ({ visual: { app, page } }) => {
  const opened = () => app.evaluate(() => (globalThis as any).openedUrls.slice() as string[]);
  await expect(page.getByRole('button', { name: 'Needs me: 2', exact: true })).toBeVisible();
  await page.getByRole('article', { name: 'Plan switcher', exact: true }).click({ button: 'middle' });
  await expect(page.getByRole('button', { name: 'Needs me: 1', exact: true })).toBeVisible();
  await expect.poll(opened).toEqual(['https://github.com/example/billing/pull/48']);
  await expect(page.locator('.map-area')).not.toHaveAttribute('data-focus', /.+/);
  await page.getByRole('article', { name: 'Plan switcher', exact: true }).click({ button: 'middle' });
  await expect.poll(opened).toHaveLength(2);
  await expect(page.getByRole('button', { name: 'Needs me: 1', exact: true })).toBeVisible();
});

test('a middle click on a Needs me row opens its web page and marks it seen', async ({ visual: { app, page } }) => {
  await page.getByRole('button', { name: 'Needs me: 2', exact: true }).click();
  await page.getByRole('button', { name: 'Open Plan switcher', exact: true }).click({ button: 'middle' });
  await expect(page.getByRole('button', { name: 'Open Plan switcher', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Needs me: 1', exact: true })).toBeVisible();
  await expect.poll(() => app.evaluate(() => (globalThis as any).openedUrls.slice() as string[])).toEqual(['https://github.com/example/billing/pull/48']);
  await expect(page.locator('.map-area')).not.toHaveAttribute('data-focus', /.+/);
});

test('Mark seen uses the Needs me button colours', async ({ visual: { page } }) => {
  await page.getByRole('article', { name: 'Plan switcher', exact: true }).click();
  const seen = page.getByRole('button', { name: 'Mark seen', exact: true });
  await expect(seen).toBeVisible();
  const colours = (selector: string) => page.locator(selector).first().evaluate(element => { const style = getComputedStyle(element); return [style.color, style.backgroundColor, style.borderTopColor]; });
  const token = (name: string) => page.evaluate(name => { const probe = document.createElement('i'); probe.style.color = `var(${name})`; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; }, name);
  // The one Needs me amber on the Needs me fill and edge; the rail slot shares fill and takes its tier's ink.
  expect(await colours('.item-seen')).toEqual([await token('--act-attention'), await token('--act-needs-me-fill'), await token('--act-needs-me-edge')]);
  expect((await colours('.needs-me-button'))[1]).toBe(await token('--act-needs-me-fill'));
  // The open item names its tier and reason beside it.
  await expect(page.locator('.item-needs')).toHaveText('My turn · Ready for your review');
});

test('a middle click inside an open item marks it seen and keeps it open', async ({ visual: { page } }) => {
  const needs = (count: number) => page.getByRole('button', { name: `Needs me: ${count}`, exact: true });
  const seen = page.getByRole('button', { name: 'Mark seen', exact: true });
  for (const [title, id, left] of [['Claude · implementation', 'agent', 1], ['Plan switcher', 'pr', 0]] as const) {
    await page.getByRole('article', { name: title, exact: true }).click();
    await expect(page.locator('.map-area')).toHaveAttribute('data-focus', id);
    await expect(seen).toBeVisible();
    const frame = (await page.locator(`[data-expanded-item-id="${id}"]`).boundingBox())!;
    await page.mouse.click(frame.x + frame.width / 2, frame.y + frame.height / 2, { button: 'middle' });
    await expect(seen).toHaveCount(0);
    if (left) await expect(needs(left)).toBeVisible(); else await expect(page.getByRole('button', { name: /^Needs me: /, exact: false })).toHaveCount(0);
    await expect(page.locator('.map-area')).toHaveAttribute('data-focus', id);
    await page.getByRole('button', { name: 'Back to project', exact: true }).click();
    await expect(page.locator('.map-area')).not.toHaveAttribute('data-focus', /.+/);
  }
});

const markSeenOnOpen = (page: Page, types: string[]) => page.evaluate(async types => {
  const settings = await window.craftingTable.settingsRead();
  await window.craftingTable.settingsWrite({ expectedRevision: settings.revision, value: { ...settings.value, notifications: { ...settings.value.notifications, seenOnOpen: types } } });
}, types);

test('opening marks an item seen only for the types chosen in settings', async ({ visual: { page } }) => {
  const needs = (count: number) => page.getByRole('button', { name: `Needs me: ${count}`, exact: true });
  const seen = page.getByRole('button', { name: 'Mark seen', exact: true }), close = page.getByRole('button', { name: 'Back to project', exact: true });
  const focus = (id: string) => expect(page.locator('.map-area')).toHaveAttribute('data-focus', id);
  await markSeenOnOpen(page, ['github.pull-request', 'removed.plugin-type']);
  // Another type keeps today's behaviour.
  await page.getByRole('article', { name: 'Claude · implementation', exact: true }).click();
  await focus('agent'); await expect(seen).toBeVisible(); await expect(needs(2)).toBeVisible();
  await close.click();
  // Hovering and going to the item on the map are not opening it.
  await page.getByRole('article', { name: 'Plan switcher', exact: true }).hover();
  await needs(2).click();
  await page.getByRole('button', { name: 'Go to Plan switcher on map', exact: true }).click();
  await expect(needs(2)).toBeVisible();
  await page.getByRole('button', { name: 'Open Plan switcher', exact: true }).click();
  await focus('pr');
  await expect(needs(1)).toBeVisible(); await expect(seen).toHaveCount(0);
  const node = (await read(page)).nodes.find(node => node.id === 'pr')!;
  expect(node.attentionSeenVersion).toBe(node.attentionVersion ?? 0); expect(node.attention).toBe('review');
  // Attention that arrives while the item is open waits for an explicit Mark seen.
  await apply(page, [{ type: 'attention.set', id: 'pr', source: 'review', reason: 'review', eventId: 'while-open' }]);
  await expect(needs(2)).toBeVisible(); await expect(seen).toBeVisible();
  await close.click();
  await page.locator('.react-flow__node[data-id="pr"]').focus(); await page.keyboard.press('Enter');
  await focus('pr'); await expect(needs(1)).toBeVisible();
  await close.click();
  await markSeenOnOpen(page, []);
  await apply(page, [{ type: 'attention.set', id: 'pr', source: 'review', reason: 'review', eventId: 'after-off' }]);
  await page.getByRole('article', { name: 'Plan switcher', exact: true }).click();
  await focus('pr'); await expect(seen).toBeVisible(); await expect(needs(2)).toBeVisible();
});

test('opening does not mark an item seen while the window is in the background', async ({ visual: { app, page } }) => {
  const needs = (count: number) => page.getByRole('button', { name: `Needs me: ${count}`, exact: true });
  const close = page.getByRole('button', { name: 'Back to project', exact: true });
  const emit = (event: 'blur' | 'focus') => app.evaluate(({ BrowserWindow }, event) => { BrowserWindow.getAllWindows()[0].emit(event); }, event);
  await markSeenOnOpen(page, ['github.pull-request']);
  await emit('blur');
  await page.locator('.react-flow__node[data-id="pr"]').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'pr');
  await page.waitForTimeout(300); await expect(needs(2)).toBeVisible();
  // Closed before the window returns: nothing was seen.
  await close.click(); await emit('focus');
  await page.waitForTimeout(300); await expect(needs(2)).toBeVisible();
  // A notification click opens the item just before the window gains focus.
  const seen = page.getByRole('button', { name: 'Mark seen', exact: true });
  await emit('blur');
  await page.locator('.react-flow__node[data-id="pr"]').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'pr');
  await expect(seen).toBeVisible();
  await emit('focus');
  await expect(needs(1)).toBeVisible(); await expect(seen).toHaveCount(0);
  await close.click();
  // Attention that arrives between that open and the window's return stays unread.
  await apply(page, [{ type: 'attention.set', id: 'pr', source: 'review', reason: 'review', eventId: 'again' }]);
  await expect(needs(2)).toBeVisible();
  await emit('blur');
  await page.locator('.react-flow__node[data-id="pr"]').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', 'pr');
  await apply(page, [{ type: 'attention.set', id: 'pr', source: 'completion', reason: 'finished', eventId: 'away' }]);
  await emit('focus');
  await page.waitForTimeout(300);
  await expect(needs(2)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark seen', exact: true })).toBeVisible();
});

test('opening the web page of an item marks it seen for a chosen type', async ({ visual: { app, page } }) => {
  await app.evaluate(({ shell }) => { (globalThis as any).openedUrls = []; shell.openExternal = async url => { (globalThis as any).openedUrls.push(url); }; });
  const opened = () => app.evaluate(() => (globalThis as any).openedUrls.length);
  await page.getByRole('article', { name: 'Plan switcher', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open on GitHub', exact: true }).click();
  await expect.poll(opened).toBe(1);
  await page.waitForTimeout(300); await expect(page.getByRole('button', { name: 'Needs me: 2', exact: true })).toBeVisible();
  await markSeenOnOpen(page, ['github.pull-request']);
  await page.getByRole('article', { name: 'Plan switcher', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open on GitHub', exact: true }).click();
  await expect.poll(opened).toBe(2);
  await expect(page.getByRole('button', { name: 'Needs me: 1', exact: true })).toBeVisible();
  await expect(page.locator('.map-area')).toHaveAttribute('data-focus', '');
});
