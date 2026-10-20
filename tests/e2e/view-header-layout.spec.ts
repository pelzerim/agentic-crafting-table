import { test, expect, _electron as electron } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { githubFixture, pullFixture } from '../fixtures/github.ts';
import { scrollbarArgs, resize } from './visual-fixture.ts';

const TITLE = 'chore(billing): delete the legacy invoice export page';
const WIDTHS = [1400, 1100, 900, 700, 560] as const;

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };

async function viewWidth(page: Page, view: Locator, width: number) {
  const handle = page.getByRole('button', { name: `Resize view: ${TITLE}`, exact: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = (await view.boundingBox())!.width;
    if (Math.abs(current - width) < 1) return;
    const grip = (await handle.boundingBox())!, x = grip.x + grip.width / 2, y = grip.y + grip.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + width - current, y, { steps: 10 }); await page.mouse.up();
  }
  expect((await view.boundingBox())!.width).toBeCloseTo(width, 0);
}

async function geometry(view: Locator) {
  return view.evaluate(element => {
    const box = (node: Element | null | undefined): Box | null => {
      if (!node || !(node as HTMLElement).checkVisibility({ visibilityProperty: true })) return null;
      const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const heading = element.querySelector('.card-heading')!;
    const actions = [...heading.querySelectorAll('.view-actions button')].filter(button => (button as HTMLElement).checkVisibility({ visibilityProperty: true }));
    const blocked = heading.querySelector('.blocked-chips');
    return {
      view: box(element)!, heading: box(heading)!,
      icon: box(heading.querySelector('.item-glyph')), title: box(heading.querySelector('.card-label strong')),
      blocked: box(blocked), blockedChips: [...(blocked?.querySelectorAll('button[title^="Go to"]') ?? [])].map(box).filter(Boolean) as Box[],
      blockedSummary: box(blocked?.querySelector('.blocked-summary')), blockedSummaryText: blocked?.querySelector('.blocked-summary')?.textContent ?? '',
      blockedSummaryClipped: (() => {
        const summary = blocked?.querySelector('.blocked-summary'); if (!summary || !blocked) return true;
        return summary.scrollWidth > summary.clientWidth + 1 || summary.getBoundingClientRect().right > blocked.getBoundingClientRect().right + .5;
      })(),
      actions: actions.map(button => ({ name: button.getAttribute('aria-label') ?? button.textContent ?? '', box: box(button)!, primary: button.hasAttribute('data-primary') })),
      hiddenActions: [...heading.querySelectorAll('.view-actions button')].filter(button => button.hasAttribute('data-view-overflow')).map(button => button.getAttribute('aria-label') ?? button.textContent ?? ''),
      more: box(heading.querySelector('.view-more')), open: box(heading.querySelector('.view-open')), refresh: box(heading.querySelector('.view-refresh')), seen: box(heading.querySelector('.item-seen')), close: box(heading.querySelector('.item-close')),
      chip: box(heading.querySelector('.view-chip')), meta: box(heading.querySelector('.view-meta')), freshness: box(heading.querySelector('.view-freshness')),
      overflowing: [...heading.querySelectorAll('*')].filter(node => {
        const b = box(node); return b && b.width > 0 && (b.left < element.getBoundingClientRect().left - .5 || b.right > element.getBoundingClientRect().right + .5);
      }).map(node => node.className || node.tagName),
    };
  });
}

test('the frame bar keeps identity and controls on one row and status on a second row at every width', async () => {
  const blockers = [
    { ...structuredClone(pullFixture), id: 77, number: 77, title: '[show] refactor: move the card renderer into the shared presentation module' },
    { ...structuredClone(pullFixture), id: 78, number: 78, title: 'feat(cards): keep the new card renderer behind the settings flag' },
  ];
  const directory = await mkdtemp(join(tmpdir(), 'craft-view-header-')), providers = githubFixture(blockers);
  providers.pull.title = TITLE;
  const service = await startWorkspaceService(directory, undefined, undefined, providers);
  await service.control.dispatch({ commandId: 'add', expectedRevision: 0, actor: { kind: 'user', id: 'test' }, commands: [
    { type: 'item.add', id: 'blocker-a', resourceId: 'blocker-a-resource', pluginId: 'github.pull-request', title: blockers[0].title, position: { x: 200, y: 200 }, data: { owner: 'fixture', repo: 'billing', number: 77 } },
    { type: 'item.add', id: 'blocker-b', resourceId: 'blocker-b-resource', pluginId: 'github.pull-request', title: blockers[1].title, position: { x: 200, y: 420 }, data: { owner: 'fixture', repo: 'billing', number: 78 } },
    { type: 'item.add', id: 'pr', resourceId: 'pr-resource', pluginId: 'github.pull-request', title: TITLE, position: { x: 700, y: 300 }, data: { owner: 'fixture', repo: 'billing', number: 42 } },
    { type: 'link.save', link: { id: 'blocks-a', sourceId: 'blocker-a', targetId: 'pr', kind: 'blocks', label: '' } },
    { type: 'link.save', link: { id: 'blocks-b', sourceId: 'blocker-b', targetId: 'pr', kind: 'blocks', label: '' } },
    { type: 'attention.set', id: 'pr', source: 'review', reason: 'review', eventId: 'layout' },
  ] });
  await service.resources.poll();
  const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory, TZ: 'UTC' } });
  try {
    const page = await app.firstWindow();
    await resize(app, page, 1600, 1000);
    await expect(page.getByText('Desktop connected')).toBeVisible();
    await page.evaluate(async () => {
      const current = await window.craftingTable.settingsRead();
      await window.craftingTable.settingsWrite({ expectedRevision: current.revision, value: { ...current.value, plugins: { ...current.value.plugins, 'github.pull-request': { ...current.value.plugins['github.pull-request'], showShip: true } } } });
    });
    await page.locator('[data-item-id="pr"]').click();
    const view = page.locator('[data-expanded-item-id="pr"].expanded');
    await expect(view.locator('.view-header .view-chip')).toHaveText('Open', { timeout: 20_000 });
    await expect(view.locator('.pr-show-ship')).toBeEnabled();
    const heading = view.locator('.card-heading');
    await heading.focus();
    for (let step = 0; step < 40 && (await view.boundingBox())!.x > 160; step++) await page.keyboard.press('Shift+ArrowLeft');

    for (const width of WIDTHS) {
      await viewWidth(page, view, width);
      await page.mouse.move(4, 4);
      await expect.poll(async () => (await geometry(view)).overflowing).toEqual([]);
      const g = await geometry(view);
      await view.screenshot({ path: test.info().outputPath(`view-header-${width}.png`) });

      const controls = [...g.actions.map(action => action.box), g.more, g.open, g.refresh, g.seen, g.close].filter(Boolean) as Box[];
      expect(g.open && g.refresh && g.seen && g.close, `↗, ↻, Mark seen and close at ${width}`).toBeTruthy();
      expect(g.refresh!.right, `Mark seen after ↻ at ${width}`).toBeLessThanOrEqual(g.seen!.left);
      expect(g.close!.left - g.seen!.right, `Mark seen beside close at ${width}`).toBeGreaterThanOrEqual(0);
      expect(g.close!.left - g.seen!.right, `Mark seen beside close at ${width}`).toBeLessThanOrEqual(10);
      expect(Math.abs(g.seen!.width - g.close!.width), `Mark seen sized like close at ${width}`).toBeLessThanOrEqual(1);
      expect(g.hiddenActions, `Mark seen never folds at ${width}`).not.toContain('Mark seen');
      const row = g.close!, center = (b: Box) => b.top + b.height / 2;
      for (const control of controls) {
        expect(Math.abs(control.top - row.top), `control top at ${width}`).toBeLessThanOrEqual(2);
        expect(Math.abs(control.height - row.height), `control height at ${width}`).toBeLessThanOrEqual(1);
      }
      for (const part of [g.icon, g.title, g.blocked]) {
        expect(part, `row 1 part at ${width}`).toBeTruthy();
        expect(Math.abs(center(part!) - center(row)), `row 1 centre at ${width}`).toBeLessThanOrEqual(2);
      }
      const rowBottom = Math.max(...controls.map(control => control.bottom));
      for (const part of [g.chip, g.meta, g.freshness]) {
        expect(part, `row 2 part at ${width}`).toBeTruthy();
        expect(part!.top, `row 2 below row 1 at ${width}`).toBeGreaterThanOrEqual(rowBottom);
        expect(Math.abs(center(part!) - center(g.chip!)), `row 2 centre at ${width}`).toBeLessThanOrEqual(2);
      }
      expect(Math.abs(g.freshness!.right - g.close!.right), `freshness right-aligned at ${width}`).toBeLessThanOrEqual(2);
      expect(g.meta!.right).toBeLessThanOrEqual(g.freshness!.left);
      expect(g.title!.right).toBeLessThanOrEqual(g.blocked!.left + 1);
      expect(g.blocked!.right).toBeLessThanOrEqual(controls[0].left);
      expect(g.actions, `every action sits in the Actions menu at ${width}`).toEqual([]);

      if (width >= 900) {
        expect(g.blockedChips, `blocked chips at ${width}`).toHaveLength(2); expect(g.blockedSummary).toBeNull();
        for (const chip of g.blockedChips) expect(chip.width, `blocked chip width at ${width}`).toBeGreaterThan(48);
      } else {
        expect(g.blockedChips, `blocked chips at ${width}`).toHaveLength(0); expect(g.blockedSummaryText).toBe('Blocked · 2');
        expect(g.blockedSummaryClipped, `blocked summary clipped at ${width}`).toBe(false);
      }
      expect(g.more, `Actions menu at ${width}`).toBeTruthy(); expect(g.hiddenActions).toEqual(['Review', 'Review loop', 'Show/Ship', 'Merge', 'Auto deploy', 'Convert to draft', 'Close…']);
      if (g.more) {
        const more = view.getByRole('button', { name: 'Actions', exact: true });
        await more.click();
        const menu = page.getByRole('menu', { name: 'Actions', exact: true });
        await expect(menu.getByRole('menuitem')).toHaveText(g.hiddenActions.map(name => new RegExp(`^${name.replace(/[/]/g, '\\/')}`)));
        await expect(menu.getByRole('menuitem', { name: 'Mark seen' })).toHaveCount(0);
        await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0); await expect(more).toBeFocused();
      }
    }

    await viewWidth(page, view, 560);
    await view.getByRole('button', { name: 'Actions', exact: true }).click();
    const hidden = (await geometry(view)).hiddenActions, last = hidden[hidden.length - 1];
    await page.getByRole('menu', { name: 'Actions', exact: true }).getByRole('menuitem', { name: last, exact: true }).click();
    const choices = page.locator('.resource-choice-menu');
    await expect(choices).toBeVisible();
    const placed = (await choices.boundingBox())!, more = (await view.locator('.view-more').boundingBox())!;
    expect(placed.y).toBeGreaterThanOrEqual(more.y + more.height);
    expect(placed.x).toBeLessThan(more.x + more.width);
    await page.keyboard.press('Escape'); await expect(choices).toHaveCount(0);

    await viewWidth(page, view, 1400);
    await expect(view.locator('.view-more')).toBeVisible();
    await expect(view.locator('[data-view-overflow]')).toHaveCount(7);
    await view.locator('.card-heading > .item-seen').click();
    await expect(view.locator('.item-seen')).toHaveCount(0);
    await expect.poll(async () => (await geometry(view)).overflowing).toEqual([]);
    const after = await geometry(view);
    expect(after.refresh!.right).toBeLessThanOrEqual(after.close!.left);
    expect(Math.abs(after.freshness!.right - after.close!.right)).toBeLessThanOrEqual(2);
  } finally {
    await app.close(); await service.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
