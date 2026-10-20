import { test, expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { rolloutFixture } from '../fixtures/rollout.ts';
import { longReport } from '../fixtures/rollout-report.ts';
import { rolloutHarness } from './rollout-harness.ts';

/** The report column of a 900×660 view with the rail open, before the view went flush (green panel inside a 28 px blue inset). */
const BEFORE = { width: 590, height: 417 };
const shot = (view: Locator, name: string) => view.screenshot({ path: `.local/rollout-view-space/${process.env.ROLLOUT_SHOTS ?? 'after'}-${name}.png` });
const size = (locator: Locator) => locator.evaluate(element => { const box = element.getBoundingClientRect(); return { width: Math.round(box.width), height: Math.round(box.height) }; });

/** Surfaces and lines of the frame and the panel inside it, none of which may lean green. */
const greenParts = (page: Page) => page.evaluate(() => {
  const frame = document.querySelector('[data-expanded-item-id]:not([hidden]) .rollout-detail')!.closest<HTMLElement>('[data-expanded-item-id]')!;
  const parts: [string, string][] = [];
  const add = (selector: string, element: Element | null, pseudo?: string) => {
    if (!element) return;
    const style = getComputedStyle(element, pseudo);
    for (const property of ['background-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'] as const) {
      if (property !== 'background-color' && style.getPropertyValue(property.replace('color', 'width')) === '0px') continue;
      parts.push([`${selector}${pseudo ?? ''} ${property}`, style.getPropertyValue(property)]);
    }
  };
  add('frame', frame); add('frame', frame, '::after'); add('frame bar', frame.querySelector('.card-heading'));
  for (const selector of ['.card-detail', '.resource-detail', '.rollout-detail', '.rv-head', '.rv-body', '.rv-rail', '.rv-rail-top', '.rv-toolbar', '.rv-feed', '.rv-card', '.rv-checks', '.rv-check', '.rv-recs li'])
    add(selector, frame.querySelector(selector));
  const green = (value: string) => { const [r, g, b, a = 1] = (value.match(/[\d.]+/g) ?? []).map(Number); return a > 0 && g > b && g >= r; };
  return parts.filter(([, value]) => green(value)).map(([part, value]) => `${part}: ${value}`);
});

async function setup() {
  const providers = rolloutFixture();
  const h = await rolloutHarness(providers, ['claude'], agent => [
    { type: 'item.add', id: 'rollout', resourceId: 'rollout-r', pluginId: 'github.rollout', title: 'Rollout', projectId: 'project', position: { x: 260, y: 200 }, data: { owner: 'fixture', repo: 'web', runId: 101 } },
    agent('claude', 'Claude · validator', 60),
    { type: 'link.save', link: { id: 'rollout-claude', sourceId: 'rollout', targetId: 'claude', kind: 'context', label: '' } },
  ]);
  const { page } = h, view = page.locator('[data-expanded-item-id]:visible'), detail = page.locator('.rollout-detail');
  const open = async () => { if (!await view.count()) await page.locator('[data-item-id="rollout"]').click(); await expect(detail.locator('.rv-rail')).toBeVisible(); };
  const rail = detail.locator('.rv-rail'), feed = detail.locator('.rv-feed'), strip = detail.getByRole('group', { name: 'Jobs, folded' });
  const fold = detail.getByRole('button', { name: 'Fold the jobs rail', exact: true }), unfold = detail.getByRole('button', { name: 'Show the jobs rail', exact: true });
  const saved = () => page.evaluate(() => window.craftingTable.viewRead()).then(state => state.itemViewState?.rollout?.jobsRail);
  return { h, providers, page, view, detail, open, rail, feed, strip, fold, unfold, saved };
}

test('the rollout view runs flush in the blue of its frame, and its jobs rail folds to a status strip', async () => {
  test.setTimeout(150_000);
  const { h, providers, page, view, detail, open, rail, feed, strip, fold, unfold, saved } = await setup();
  try {
    await open();
    await page.evaluate(() => window.craftingTable.runtimeRun({ action: 'rollout.validation' as 'agent.resume', nodeId: 'rollout', arguments: { operation: 'trigger', sourceResourceId: 'rollout-r', value: 'claude', requestId: crypto.randomUUID() } }));
    await expect.poll(() => h.output('claude'), { timeout: 15_000 }).toContain('validationId "V1"');
    await h.report('claude', 'rollout', longReport);
    await expect(detail.locator('.rv-card[aria-label^="V1 · "]')).toHaveAttribute('data-v', 'running');
    // The rail starts folded; opening it is what gets remembered.
    await expect(unfold).toHaveAttribute('aria-expanded', 'false');
    expect(await saved()).toBeUndefined();
    await unfold.click();
    await expect.poll(saved).toBe('open');
    await expect(view).toHaveCSS('width', '900px');
    await shot(view, 'open');

    // F1: no inset, no panel border, no hint footer; frame and panel stay in the blue family.
    const frameBox = (await view.boundingBox())!, panelBox = (await detail.boundingBox())!;
    expect(Math.abs(panelBox.x - frameBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(panelBox.x + panelBox.width - frameBox.x - frameBox.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(panelBox.y + panelBox.height - frameBox.y - frameBox.height)).toBeLessThanOrEqual(1);
    await expect(detail.locator('.rv-status')).toHaveCount(0);
    await expect(detail).not.toContainText('Click a job to filter · Ask an agent to validate');
    expect(await greenParts(page)).toEqual([]);
    const opened = await size(feed);
    expect(opened.width).toBeGreaterThan(BEFORE.width + 40);
    expect(opened.height).toBeGreaterThan(BEFORE.height + 30);

    // The fold button names what it does and whether the rail is open.
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    await fold.click();
    await expect(unfold).toHaveAttribute('aria-expanded', 'false');
    await expect(rail).toHaveJSProperty('offsetWidth', 40);
    await expect(detail.getByRole('list', { name: 'Rollout jobs' })).toBeHidden();
    const glyphs = strip.getByRole('button');
    await expect(glyphs).toHaveText(['', '', '']);
    await expect(glyphs.nth(0)).toHaveAccessibleName('deploy-production / region-a: running');
    await expect(glyphs.nth(1)).toHaveAccessibleName('deploy-production / region-b: queued');
    await expect(glyphs.nth(2)).toHaveAccessibleName('deploy-staging / region-a: done');
    await expect(strip.locator('hr')).toHaveCount(1);
    expect((await size(feed)).width).toBeGreaterThan(opened.width + 180);
    // Folding is view state: the item and its cached read are untouched, so the running validation stays current.
    await expect.poll(saved).toBeUndefined();
    expect((await h.service.control.read()).resources.find(resource => resource.id === 'rollout-r')?.data).toEqual({ owner: 'fixture', repo: 'web', runId: 101 });
    await expect(detail.locator('.rv-card[aria-label^="V1 · "]')).toHaveAttribute('data-v', 'running');
    await expect(detail.locator('.rv-card[aria-label^="V1 · "]')).not.toHaveClass(/stale/);
    await shot(view, 'folded');

    // Hovering names the job; a click filters the timeline exactly like the row did, and the glyph shows it is picked.
    await glyphs.nth(2).hover();
    await expect(detail.locator('.rv-strip-tip')).toBeVisible();
    await expect(detail.locator('.rv-strip-tip')).toHaveText('deploy-staging / region-a');
    await glyphs.nth(2).click();
    await expect(detail.locator('.rv-job-chip')).toHaveText('deploy-staging / region-a');
    await expect(glyphs.nth(2)).toHaveAttribute('aria-pressed', 'true');
    await expect(glyphs.nth(0)).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('Escape');
    await expect(detail.locator('.rv-job-chip')).toHaveCount(0);
    await expect(view).toBeVisible();

    // [ toggles the rail while the view has focus.
    await detail.locator('.rv-verdict').click();
    await page.keyboard.press('[');
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('[');
    await expect(unfold).toHaveAttribute('aria-expanded', 'false');

    // The fold is remembered per rollout across a reload.
    await expect.poll(saved).toBeUndefined();
    await page.reload(); await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('[data-item-id="rollout"], [data-expanded-item-id="rollout"]').first()).toBeVisible();
    await open();
    await expect(unfold).toHaveAttribute('aria-expanded', 'false');
    await expect(rail).toHaveJSProperty('offsetWidth', 40);
    await unfold.click();
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(saved).toBe('open');

    // Below 700 px the rail folds on its own, without saving that; opened there, it stays open.
    const handle = page.getByRole('button', { name: /^Resize view: / }), grip = (await handle.boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2 - 260, grip.y + grip.height / 2, { steps: 12 }); await page.mouse.up();
    await expect.poll(async () => (await size(view)).width).toBeLessThan(700);
    await expect(unfold).toHaveAttribute('aria-expanded', 'false');
    await expect(rail).toHaveJSProperty('offsetWidth', 40);
    expect(await saved()).toBe('open');
    await shot(view, 'narrow');
    await unfold.click();
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    await expect(rail).toHaveJSProperty('offsetWidth', 252);

    // Approval stays reachable with the rail folded: from the feed and from the Actions menu, never from the strip.
    providers.run = { ...providers.run, status: 'waiting' }; providers.jobs = providers.jobs.map((job, index) => index === 2 ? { ...job, status: 'waiting' } : job);
    providers.gates = [{ environment: { id: 7, name: 'production' }, wait_timer: 0, current_user_can_approve: true, reviewers: [{ type: 'Team' }] }];
    await h.tick(); await view.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(detail.locator('.rv-job-approve')).toBeVisible();
    await detail.locator('.rv-verdict').click(); await page.keyboard.press('[');
    await expect(unfold).toHaveAttribute('aria-expanded', 'false');
    await expect(strip.getByRole('button', { name: 'deploy-production / region-b: waiting' })).toBeVisible();
    await expect(strip.locator('.rv-approve')).toHaveCount(0);
    await detail.getByRole('button', { name: 'Go to approval', exact: true }).click();
    const approval = page.getByRole('menu', { name: 'Approve deployment', exact: true });
    await expect(approval).toBeVisible();
    await page.keyboard.press('Escape'); await expect(approval).toHaveCount(0);
    await expect(unfold).toHaveAttribute('aria-expanded', 'false');
    await view.getByRole('button', { name: 'Actions', exact: true }).click();
    await expect(page.getByRole('menu', { name: 'Actions', exact: true }).getByRole('menuitem', { name: 'Approve', exact: true })).toBeEnabled();
    expect(providers.approvals).toHaveLength(0);
  } finally { await h.close(); }
});
