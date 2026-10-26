import { expect, _electron as electron } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test, capture, scrollbarArgs } from './visual-fixture.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import type { WorkspaceCommand } from '../../packages/core/control.ts';
import { stateSchema } from '../../packages/core/control.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { SqliteStore } from '../../packages/workspace-service/sqlite-store.ts';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';

const read = (page: Page) => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
/** Applies as the user. A background write (plots, titles) can take the revision first, so a conflict is retried on a fresh read. */
const apply = (page: Page, commands: WorkspaceCommand[]) => page.evaluate(async (commands: unknown[]) => {
  for (let attempt = 0; ; attempt++) {
    const { state } = await window.craftingTable.workspaceRead();
    try { await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'test' }, commands: commands as never }); return; }
    catch (error) { if (attempt >= 4 || !String((error as Error).message).includes('Revision conflict')) throw error; }
  }
}, commands as unknown[]);
const mutedAt = async (page: Page) => (await read(page)).nodes.find(node => node.id === 'billing')!.mutedAt;
const cover = (page: Page) => page.locator('[data-mute-cover="billing"]');
const plate = (page: Page) => page.locator('[data-project-label="billing"]');
const card = (page: Page) => page.getByRole('article', { name: 'Plan switcher', exact: true });
/** A second, unmuted project with one item that needs me. */
const docs: WorkspaceCommand[] = [
  { type: 'project.create', id: 'docs', title: 'Docs site', summary: '', position: { x: 1700, y: 300 } },
  { type: 'item.add', id: 'quickstart', resourceId: 'quickstart-resource', pluginId: 'github.pull-request', title: 'Quickstart rewrite', data: { owner: 'example', repo: 'docs', number: 7 }, projectId: 'docs', position: { x: 1700, y: 300 } },
  { type: 'node.update', id: 'quickstart', attention: 'review' },
];
/** A point of the cover that nothing else is drawn over, nearest its middle. */
const coverPoint = (page: Page) => page.evaluate(() => {
  const hit = document.querySelector('[data-mute-cover="billing"] .mute-hit')!, box = hit.getBoundingClientRect(), found: { x: number; y: number; d: number }[] = [];
  const cx = (Math.max(box.left, 0) + Math.min(box.right, innerWidth)) / 2, cy = (Math.max(box.top, 0) + Math.min(box.bottom, innerHeight)) / 2;
  for (let y = Math.max(box.top, 0) + 10; y < Math.min(box.bottom, innerHeight); y += 12) for (let x = Math.max(box.left, 0) + 10; x < Math.min(box.right, innerWidth); x += 12)
    if (document.elementFromPoint(x, y) === hit) found.push({ x, y, d: Math.hypot(x - cx, y - cy) });
  if (!found.length) throw new Error('The cover is not reachable');
  return found.sort((a, b) => a.d - b.d)[0];
});
const away = (page: Page) => page.mouse.move(4, 4);

test('muting from the project menu covers the project and silences its counts, badge and Needs me rows', async ({ visual: { app, page } }) => {
  await apply(page, docs);
  const needs = page.locator('.needs-me-button'), badge = () => app.evaluate(({ app }) => app.getBadgeCount());
  await expect(needs).toHaveAccessibleName('Needs me: 3'); await expect.poll(badge).toBe(3);
  const before = (await read(page)).nodes.filter(node => node.projectId === 'billing');
  await page.getByRole('button', { name: 'Project options: Billing redesign' }).click();
  await expect(page.getByRole('menuitem').filter({ hasText: /Mute project|Undermap/ })).toHaveText(['Mute project (Needs me: 2)', 'Send project to Undermap']);
  await page.getByRole('menuitem', { name: 'Mute project (Needs me: 2)', exact: true }).click();

  await expect(cover(page)).toHaveCount(1);
  await expect(plate(page)).toHaveAttribute('data-muted', 'true');
  await expect(plate(page)).toHaveAccessibleName('Billing redesign, muted');
  await expect(plate(page)).toContainText('Muted'); await expect(plate(page)).not.toContainText('asking'); await expect(plate(page).locator('.project-counts')).toHaveCount(0);
  await expect(plate(page).getByRole('button', { name: 'Project options: Billing redesign' })).toBeVisible();
  // The real cards, their Needs me tiles and the working rim are not painted under the cover.
  await expect(card(page)).toBeHidden(); await expect(page.locator('[data-item-id="agent"] > .working-mark')).toBeHidden(); await expect(page.locator('[data-item-id="agent"] .attention-indicator')).toBeHidden();
  await expect(page.locator('.react-flow__node.muted-member')).toHaveCount(4);
  // Display only: nothing is acknowledged or stopped.
  const after = await read(page);
  expect(after.nodes.find(node => node.id === 'billing')!.mutedAt).toEqual(expect.any(String));
  expect(after.nodes.filter(node => node.projectId === 'billing')).toEqual(before);

  await expect(needs).toHaveAccessibleName('Needs me: 1'); await expect.poll(badge).toBe(1);
  await needs.click();
  const list = page.getByRole('dialog', { name: 'Needs me', exact: true });
  await expect(list.getByRole('button', { name: 'Open Quickstart rewrite', exact: true })).toBeVisible();
  const toggle = list.getByRole('button', { name: 'Muted · 2' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(list.getByRole('button', { name: 'Open Claude · implementation', exact: true })).toHaveCount(0);
  await expect(list.locator('.attention-row')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/mute-needs-me-collapsed.png' });
  await toggle.click();
  await expect(list.getByRole('button', { name: 'Open Claude · implementation', exact: true })).toBeVisible();
  await expect(list.getByRole('button', { name: 'Dismiss Plan switcher from Needs me', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/mute-needs-me-expanded.png' });
  await expect(needs).toHaveAccessibleName('Needs me: 1');
  // The Atlas keeps the dim hull with a moon and draws none of its item marks.
  await expect(page.locator('.map-locator [data-atlas-muted="billing"]')).toHaveCount(1);
  await expect(page.locator('.map-locator [data-locator-id="agent"]')).toHaveCount(0);
  await expect(page.locator('.map-locator [data-locator-id="quickstart"]')).toHaveCount(1);
  // Show on map flies there and looks under the cover for a moment; it never unmutes.
  await list.getByRole('button', { name: 'Go to Plan switcher on map', exact: true }).click();
  await expect(cover(page)).toHaveAttribute('data-peek', 'true'); await expect(card(page)).toBeVisible();
  expect(await mutedAt(page)).toEqual(expect.any(String)); await expect(needs).toHaveAccessibleName('Needs me: 1');
  // Muting the last counted project leaves the quiet button and no badge.
  await apply(page, [{ type: 'project.mute', id: 'docs', muted: true }]);
  await expect(page.locator('.needs-me-quiet')).toBeVisible(); await expect.poll(badge).toBe(0);
  await expect(list.getByRole('button', { name: 'Muted · 3' })).toBeVisible();
  await expect(list).toContainText('Nothing needs me.');
});

test('a passing pointer never opens a muted project; a dwell reveals the real cards and leaving covers them again', async ({ visual: { page } }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'dark' });
  await apply(page, [{ type: 'project.mute', id: 'billing', muted: true }]);
  await expect(cover(page)).toHaveCount(1); await expect(card(page)).toBeHidden();
  const point = await coverPoint(page);
  // Fast pass: across the project and out within the dwell.
  await away(page); await page.mouse.move(point.x, point.y, { steps: 3 }); await page.waitForTimeout(60); await expect(cover(page)).not.toHaveAttribute('data-peek', /.*/);
  await away(page); await page.waitForTimeout(500);
  await expect(cover(page)).not.toHaveAttribute('data-peek', /.*/); await expect(card(page)).toBeHidden();
  // Dwell: the whole cover draws back and what shows is the truth.
  await page.mouse.move(point.x, point.y, { steps: 3 });
  await expect(cover(page)).toHaveAttribute('data-peek', 'true');
  await expect(card(page)).toBeVisible(); await expect(page.locator('[data-item-id="agent"] .attention-indicator')).toBeVisible(); await expect(page.locator('[data-item-id="agent"] > .working-mark')).toBeVisible();
  await expect.poll(() => cover(page).evaluate(element => getComputedStyle(element).opacity)).toBe('0');
  await expect(cover(page)).toHaveAttribute('data-parted', 'true');
  await page.screenshot({ path: 'test-results/mute-revealed.png' });
  // Peeking changes no count and mutes nothing less.
  await expect(plate(page)).toContainText('Muted'); await expect(page.locator('.needs-me-quiet')).toBeVisible(); expect(await mutedAt(page)).toEqual(expect.any(String));
  // Look, don't touch: the cover still takes the pointer.
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.classList.contains('mute-hit'), point)).toBe(true);
  // One short linear fade, and nothing that loops.
  const motion = await cover(page).evaluate(element => { const style = getComputedStyle(element);
    return { duration: parseFloat(style.transitionDuration), timing: style.transitionTimingFunction, property: style.transitionProperty,
      looping: element.getAnimations({ subtree: true }).some(animation => animation.effect?.getComputedTiming().iterations === Infinity) }; });
  expect(motion.duration).toBeGreaterThan(0); expect(motion.duration).toBeLessThanOrEqual(.15); expect(motion.timing).toBe('linear'); expect(motion.property).toBe('opacity'); expect(motion.looping).toBe(false);
  await away(page);
  await expect(cover(page)).toHaveAttribute('data-peek', 'true'); // Held briefly, so a slip off the edge does not flicker.
  await expect(cover(page)).not.toHaveAttribute('data-peek', /.*/);
  await expect(card(page)).toBeHidden();
});

test('a click unmutes only once the cover has parted: never before, on a pan or on a right click', async ({ visual: { page } }) => {
  await apply(page, [{ type: 'project.mute', id: 'billing', muted: true }]);
  await expect(cover(page)).toHaveCount(1);
  let point = await coverPoint(page);
  // A fly-by click lands before the cover opened.
  await away(page); await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(700);
  expect(await mutedAt(page)).toEqual(expect.any(String)); await expect(cover(page)).not.toHaveAttribute('data-peek', /.*/);
  // Dragging across it pans the map and unmutes nothing, parted or not.
  const camera = () => page.locator('.react-flow__viewport').getAttribute('style');
  const start = await camera();
  await page.mouse.move(point.x + 2, point.y + 2); await expect(cover(page)).toHaveAttribute('data-parted', 'true');
  await page.mouse.down(); await page.mouse.move(point.x - 80, point.y - 30, { steps: 8 }); await page.mouse.up();
  await expect.poll(camera).not.toBe(start);
  await page.waitForTimeout(200); expect(await mutedAt(page)).toEqual(expect.any(String));
  // A right click first only closes the open Needs me panel; the next opens the project's menu instead.
  await page.locator('.needs-me-quiet').click(); await expect(page.getByRole('dialog', { name: 'Needs me', exact: true })).toBeVisible();
  point = await coverPoint(page);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await expect(page.getByRole('dialog', { name: 'Needs me', exact: true })).toHaveCount(0); await expect(page.getByRole('menuitem')).toHaveCount(0);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Unmute project', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /^Mute project/ })).toHaveCount(0);
  expect(await mutedAt(page)).toEqual(expect.any(String));
  await page.keyboard.press('Escape'); await expect(page.getByRole('menuitem')).toHaveCount(0);
  // A plain click on the parted cover unmutes, says how many wait and offers Undo.
  await away(page); point = await coverPoint(page);
  await page.mouse.move(point.x, point.y, { steps: 2 }); await expect(cover(page)).toHaveAttribute('data-parted', 'true');
  await page.mouse.click(point.x, point.y);
  await expect.poll(() => mutedAt(page)).toBeUndefined();
  await expect(cover(page)).toHaveCount(0); await expect(card(page)).toBeVisible();
  await expect(plate(page)).toContainText('1 asking · 1 my turn'); await expect(page.locator('.needs-me-button')).toHaveAccessibleName('Needs me: 2');
  const notice = page.locator('.act-toast', { hasText: 'Billing redesign unmuted' });
  await expect(notice).toContainText('Needs me: 2');
  await notice.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => mutedAt(page)).toEqual(expect.any(String));
  await expect(cover(page)).toHaveCount(1); await expect(notice).toHaveCount(0);
});

test('the plate chip, the menu, Enter and Shift+M unmute; keyboard focus on the plate reveals', async ({ visual: { page } }) => {
  const mute = () => apply(page, [{ type: 'project.mute', id: 'billing', muted: true }]);
  await mute(); await expect(cover(page)).toHaveCount(1);
  const chip = plate(page).getByRole('button', { name: 'Unmute Billing redesign', exact: true });
  await expect(chip.locator('.project-muted-state')).toBeVisible(); await expect(chip.locator('.project-muted-action')).toBeHidden(); await chip.hover(); await expect(chip.locator('.project-muted-action')).toBeVisible(); await expect(chip.locator('.project-muted-state')).toBeHidden();
  await chip.click(); await expect.poll(() => mutedAt(page)).toBeUndefined(); await expect(cover(page)).toHaveCount(0);
  await mute(); await expect(cover(page)).toHaveCount(1);
  await page.getByRole('button', { name: 'Project options: Billing redesign' }).click();
  await page.getByRole('menuitem', { name: 'Unmute project', exact: true }).click();
  await expect.poll(() => mutedAt(page)).toBeUndefined();
  // Right click on an unmuted neighbourhood offers Mute too.
  await expect(page.getByRole('menu')).toHaveCount(0); await expect(page.locator('.mute-cover')).toHaveCount(0);
  let empty = { x: 0, y: 0 };
  await expect(async () => { empty = await page.evaluate(() => { const box = document.querySelector('[data-project-outline="billing"]')!.getBoundingClientRect(), cx = box.left + box.width / 2, cy = box.top + box.height / 2;
    for (let d = 0; d < 200; d += 8) for (const [x, y] of [[cx + d, cy], [cx - d, cy], [cx, cy + d], [cx, cy - d]]) if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y };
    throw new Error('No empty neighbourhood'); }); }).toPass({ timeout: 5000 });
  await page.mouse.click(empty.x, empty.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Mute project (Needs me: 2)', exact: true }).click();
  await expect.poll(() => mutedAt(page)).toEqual(expect.any(String)); await expect(cover(page)).toHaveCount(1);
  // Keyboard: focus on the plate draws the cover back; Enter unmutes; Shift+M toggles.
  await away(page);
  const node = page.locator('.react-flow__node[data-id="billing"]');
  await node.focus(); await page.keyboard.press('Shift');
  await expect(cover(page)).toHaveAttribute('data-peek', 'true'); await expect(card(page)).toBeVisible();
  await page.keyboard.press('Enter');
  await expect.poll(() => mutedAt(page)).toBeUndefined(); await expect(cover(page)).toHaveCount(0);
  await node.focus(); await page.keyboard.press('Shift+M');
  await expect.poll(() => mutedAt(page)).toEqual(expect.any(String)); await expect(cover(page)).toHaveCount(1);
  await page.keyboard.press('Shift+M');
  await expect.poll(() => mutedAt(page)).toBeUndefined();
  await expect(page.locator('.map-locator')).toBeVisible(); await expect(page.locator('.atlas-overview')).toHaveCount(0); // Shift+M is not the overview's M.
});

test('an item dragged onto a muted project lands under its cover; Undermap draws no cover and returns it muted', async ({ visual: { page } }) => {
  await apply(page, [...docs, { type: 'node.move', id: 'docs', position: { x: 1500, y: 300 } }, { type: 'project.mute', id: 'billing', muted: true }]);
  await expect(cover(page)).toHaveCount(1);
  const moving = page.getByRole('article', { name: 'Quickstart rewrite', exact: true }), from = (await moving.boundingBox())!, to = await coverPoint(page);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  // Accepted without opening: the hull lights under the closed cover and the held card stays in hand.
  await expect(page.locator('.attachment-preview')).toHaveText('Move to Billing redesign');
  await expect(cover(page)).toHaveAttribute('data-attach', 'true'); await expect(cover(page)).not.toHaveAttribute('data-peek', /.*/);
  await expect(moving).toBeVisible();
  await page.mouse.up();
  await expect.poll(async () => (await read(page)).nodes.find(node => node.id === 'quickstart')!.projectId).toBe('billing');
  await expect(moving).toBeHidden(); await expect(page.locator('.react-flow__node.muted-member')).toHaveCount(5);
  await expect(page.locator('.needs-me-quiet')).toBeVisible(); // Its Needs me went quiet with it.
  expect(await mutedAt(page)).toEqual(expect.any(String));
  // Moved out again, it shows as it now is.
  await apply(page, [{ type: 'node.attach', id: 'quickstart', projectId: 'docs' }, { type: 'node.move', id: 'quickstart', position: { x: 1500, y: 300 } }]);
  await expect(moving).toBeVisible(); await expect(page.locator('.needs-me-button')).toHaveAccessibleName('Needs me: 1');
  // Undermap is where stored things are looked at: no cover there, and it comes back muted.
  await apply(page, [{ type: 'node.below', id: 'billing' }]);
  await expect(cover(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Go to Undermap', exact: true }).click();
  await expect(page.locator('.map-area')).toHaveAttribute('data-layer', 'below');
  await expect(card(page)).toBeVisible(); await expect(page.locator('.mute-cover')).toHaveCount(0); await expect(plate(page)).not.toContainText('Muted');
  await plate(page).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Bring back to map', exact: true })).toBeVisible(); await expect(page.getByRole('menuitem', { name: /mute/i })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Bring back to map', exact: true }).click();
  await page.getByRole('button', { name: 'Back to the map', exact: true }).click();
  await expect(page.locator('.map-area')).toHaveAttribute('data-layer', 'map');
  await expect(cover(page)).toHaveCount(1); await expect(plate(page)).toContainText('Muted');
});

test('with reduced motion the cover has no transition or animation and still honours the dwell', async ({ visual: { page } }) => {
  await apply(page, [{ type: 'project.mute', id: 'billing', muted: true }]);
  await expect(cover(page)).toHaveCount(1);
  const style = () => cover(page).evaluate(element => { const computed = getComputedStyle(element); return { transition: computed.transitionDuration, animation: computed.animationName, running: element.getAnimations({ subtree: true }).length }; });
  expect(await style()).toEqual({ transition: '0s', animation: 'none', running: 0 });
  const point = await coverPoint(page);
  await away(page); await page.mouse.move(point.x, point.y, { steps: 2 }); await page.waitForTimeout(60);
  await expect(cover(page)).not.toHaveAttribute('data-peek', /.*/);
  await expect(cover(page)).toHaveAttribute('data-peek', 'true');
  expect(await cover(page).evaluate(element => getComputedStyle(element).opacity)).toBe('0'); // Instant.
  expect(await style()).toEqual({ transition: '0s', animation: 'none', running: 0 });
  await expect(card(page)).toBeVisible();
  // Unmuting leaves no fading ghost behind.
  await apply(page, [{ type: 'project.mute', id: 'billing', muted: false }]);
  await expect(page.locator('.mute-cover')).toHaveCount(0);
});

test('a muted project is still muted after the desktop restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-mute-restart-'));
  const store = new SqliteStore(join(directory, 'workspace.sqlite'));
  try {
    await store.update(state => stateSchema.parse({ ...state, nodes: [
      { id: 'billing', title: 'Billing redesign', position: { x: 300, y: 300 } },
      { id: 'pr', resourceId: 'pr-resource', projectId: 'billing', title: 'Plan switcher', position: { x: 760, y: 300 }, attention: 'review' },
      { id: 'floating', resourceId: 'floating-resource', title: 'Quickstart rewrite', position: { x: 1500, y: 300 }, attention: 'review' },
    ], resources: [
      { id: 'pr-resource', pluginId: 'github.pull-request', schemaVersion: 1, title: 'Plan switcher', data: { owner: 'example', repo: 'billing', number: 48 } },
      { id: 'floating-resource', pluginId: 'github.pull-request', schemaVersion: 1, title: 'Quickstart rewrite', data: { owner: 'example', repo: 'docs', number: 7 } },
    ] }));
    await store.writeView('desktop', { camera: { x: 140, y: 100, zoom: .7 } });
  } finally { store.close(); }
  const launch = async () => {
    const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory, SHELL: '/bin/sh', TZ: 'UTC', LANG: 'en_US.UTF-8' } });
    const page = await app.firstWindow();
    await page.route(/^https?:\/\//, route => route.abort());
    await expect(page.getByText('Desktop connected')).toBeVisible();
    return { app, page };
  };
  let running = await launch();
  try {
    await expect(running.page.locator('.needs-me-button')).toHaveAccessibleName('Needs me: 2');
    await running.page.getByRole('button', { name: 'Project options: Billing redesign' }).click();
    await running.page.getByRole('menuitem', { name: 'Mute project (Needs me: 1)', exact: true }).click();
    await expect(cover(running.page)).toHaveCount(1);
    await exitWithoutShutdown(running.app);
    running = await launch();
    const { app, page } = running;
    await expect(cover(page)).toHaveCount(1);
    await expect(plate(page)).toContainText('Muted'); await expect(card(page)).toBeHidden();
    await expect(page.locator('.needs-me-button')).toHaveAccessibleName('Needs me: 1');
    await expect.poll(() => app.evaluate(({ app }) => app.getBadgeCount())).toBe(1);
    expect((await read(page)).nodes.find(node => node.id === 'billing')!.mutedAt).toEqual(expect.any(String));
  } finally {
    await exitWithoutShutdown(running.app);
    for (const connect of [() => connectWorkspace(directory), () => connectSupervisor(join(directory, 'runtime'))]) {
      const client = await connect().catch(() => undefined);
      if (client) { try { const stopped = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await stopped; } finally { client.close(); } }
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('muted project baselines: near, mid and far zoom', async ({ visual: { page } }) => {
  await apply(page, [...docs,
    { type: 'item.add', id: 'note', resourceId: 'note-resource', pluginId: 'workspace.note', title: 'Note', data: { text: 'Ask about proration' }, projectId: 'billing', position: { x: 660, y: 600 } },
    { type: 'link.save', link: { id: 'cross', sourceId: 'pr', targetId: 'quickstart', kind: 'reference', label: '' } },
    { type: 'project.mute', id: 'billing', muted: true }]);
  await expect(cover(page)).toHaveCount(1);
  const zoom = async (value: number) => {
    await page.getByRole('slider', { name: 'Map zoom' }).evaluate((input, value) => { const element = input as HTMLInputElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, String(value)); element.dispatchEvent(new Event('input', { bubbles: true })); }, value);
    await expect(page.locator('.map-area')).toHaveAttribute('data-zoom', String(value));
  };
  await capture(page, 'mute-project-mid.png');
  await zoom(1); await capture(page, 'mute-project-near.png');
  await zoom(.3); await expect(page.locator('[data-dashboard="billing"]')).toHaveAttribute('data-muted', '');
  await expect(page.locator('[data-dashboard="billing"]')).toContainText('Muted'); await expect(page.locator('[data-dashboard="billing"]')).toContainText('5 items');
  await expect(page.locator('[data-dashboard="billing"]')).not.toContainText(/need|working/i);
  await expect(page.locator('[data-dashboard="docs"]')).toContainText('1 my turn');
  await capture(page, 'mute-project-far.png');
});

test('the to-do list leaves out the to-dos of a muted project until it is unmuted', async ({ visual: { page } }) => {
  await apply(page, [...docs,
    { type: 'todo.save', todo: { id: 'docs-todo', title: 'Publish quickstart', completed: false, nodeIds: ['quickstart'] } },
    { type: 'todo.save', todo: { id: 'billing-todo', title: 'Ship plan switcher', completed: false, nodeIds: ['pr'] } },
    { type: 'todo.save', todo: { id: 'docs-later', title: 'Proofread quickstart', completed: false, nodeIds: ['quickstart'] } },
    { type: 'project.mute', id: 'billing', muted: true }]);
  await page.getByRole('button', { name: 'Keep to-dos open', exact: true }).click();
  const list = page.getByRole('form', { name: 'To-dos', exact: true }), next = list.getByRole('region', { name: 'Next', exact: true });
  await expect(next.locator('.todo-row .todo-row-title')).toHaveText(['Publish quickstart', 'Proofread quickstart']);
  // Alt+arrow steps over the hidden row, so every press shows.
  await list.locator('[data-todo-id="docs-later"]').focus(); await page.keyboard.press('Alt+ArrowUp');
  await expect(next.locator('.todo-row .todo-row-title')).toHaveText(['Proofread quickstart', 'Publish quickstart']);
  await list.getByRole('button', { name: 'Group by project', exact: true }).click();
  await expect(list.getByRole('group', { name: 'Docs site in Next', exact: true }).locator('.todo-row')).toHaveCount(2);
  await expect(list.getByRole('group', { name: 'Billing redesign in Next', exact: true })).toHaveCount(0);
  await apply(page, [{ type: 'project.mute', id: 'billing', muted: false }]);
  await expect(list.getByRole('group', { name: 'Billing redesign in Next', exact: true }).locator('.todo-row')).toHaveCount(1);
  await list.getByRole('button', { name: 'Group by project', exact: true }).click();
  await expect(next.locator('.todo-row')).toHaveCount(3);
});
