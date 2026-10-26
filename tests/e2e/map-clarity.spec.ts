import { test, expect, _electron as electron } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { SqliteStore } from '../../packages/workspace-service/sqlite-store.ts';
import { stateSchema } from '../../packages/core/control.ts';
import type { AppSettings } from '../../packages/core/settings.ts';
import { photoLibraryProject } from '../fixtures/photo-library-project.ts';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { resize, scrollbarArgs } from './visual-fixture.ts';

type Launch = { state?: () => unknown; view?: { x: number; y: number; zoom: number }; settings?: (value: AppSettings) => AppSettings; reducedMotion?: 'reduce' | 'no-preference'; size?: { width: number; height: number } };
const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())), 250)));
const computed = (page: Page, selector: string, property: string) => page.locator(selector).first().evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property);

/** Two sparse linked items in a small project. */
function sparseProject(kind: 'reference' | 'blocks' | 'context' = 'reference') {
  return stateSchema.parse({ version: 1, revision: 0, todos: [], view: {},
    nodes: [
      { id: 'project', title: 'Billing redesign', position: { x: 500, y: 300 } },
      { id: 'pr', resourceId: 'pr-r', projectId: 'project', title: 'Plan switcher', position: { x: 360, y: 300 }, activity: 'idle' },
      { id: 'note', resourceId: 'note-r', projectId: 'project', title: 'Billing experience', position: { x: 700, y: 300 }, activity: 'idle' },
    ],
    resources: [
      { id: 'pr-r', pluginId: 'github.pull-request', schemaVersion: 1, title: 'Plan switcher', data: { owner: 'example', repo: 'billing', number: 48 } },
      { id: 'note-r', pluginId: 'workspace.note', schemaVersion: 1, title: 'Billing experience', data: { text: 'Notes', display: 'note' } },
    ],
    links: [{ id: 'pr-note', sourceId: 'pr', targetId: 'note', kind }] });
}

async function launch(options: Launch, run: (page: Page) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-map-clarity-')), store = new SqliteStore(join(directory, 'workspace.sqlite'));
  try {
    await store.update(() => (options.state ?? photoLibraryProject)() as ReturnType<typeof photoLibraryProject>);
    await store.writeView('desktop', { camera: options.view ?? { x: -1000, y: -380, zoom: .85 } });
    const settings = store.readSettings(), value = { ...settings.value, mapCorner: 'atlas' as const, mapDashboards: { ...settings.value.mapDashboards, enabled: false } };
    store.writeSettings({ expectedRevision: settings.revision, value: options.settings ? options.settings(value) : value });
  } finally { store.close(); }
  const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1', '--disable-lcd-text', '--force-color-profile=srgb', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory, SHELL: '/bin/sh', TZ: 'UTC' } });
  try {
    const page = await app.firstWindow();
    await page.route(/^https?:\/\//, route => route.abort());
    await page.emulateMedia({ reducedMotion: options.reducedMotion ?? 'reduce', colorScheme: 'dark' });
    await resize(app, page, options.size?.width ?? 1600, options.size?.height ?? 900);
    await expect(page.getByText('Desktop connected')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await settle(page);
    await run(page);
  } finally {
    await exitWithoutShutdown(app);
    const client = await connectWorkspace(directory).catch(() => undefined);
    if (client) { const ended = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await ended; client.close(); }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test('MAP-10: resting links are 2px link ink and inspected links 2.5px active ink', async () => {
  await launch({ state: sparseProject, view: { x: 0, y: 100, zoom: 1 } }, async page => {
    const path = '.react-flow__edge[data-id="pr-note"] .react-flow__edge-path';
    expect(await computed(page, path, 'stroke')).toBe('rgb(159, 181, 164)');
    expect(await computed(page, path, 'stroke-width')).toBe('2px');
    await page.locator('[data-item-id="pr"]').hover();
    await expect.poll(() => computed(page, path, 'stroke')).toBe('rgb(225, 234, 226)');
    expect(await computed(page, path, 'stroke-width')).toBe('2.5px');
  });
});

test('MAP-10: the dashed link to an agent session is thinner than other links, at rest and inspected', async () => {
  await launch({ state: () => sparseProject('context'), view: { x: 0, y: 100, zoom: 1 } }, async page => {
    const path = '.react-flow__edge[data-id="pr-note"] .react-flow__edge-path';
    expect(await computed(page, path, 'stroke-width')).toBe('1px');
    expect(await computed(page, path, 'stroke-dasharray')).not.toBe('none');
    await page.locator('[data-item-id="pr"]').hover();
    await expect.poll(() => computed(page, path, 'stroke-width')).toBe('1.5px');
  });
});

test('MAP-02: selection is a solid light outline and blocking links are solid with a chevron', async () => {
  await launch({ state: () => sparseProject('blocks'), view: { x: 0, y: 100, zoom: 1 } }, async page => {
    const edge = '.react-flow__edge[data-id="pr-note"]';
    expect(await computed(page, `${edge} .react-flow__edge-path`, 'stroke-dasharray')).toBe('none');
    await expect(page.locator(`${edge} .blocks-chevron`)).toHaveCount(1);
    await page.locator('[data-item-id="pr"]').click({ modifiers: ['Shift'] });
    const outline = '.map-selection rect[data-selected-id="pr"]';
    await expect(page.locator(outline)).toHaveCount(1);
    expect(await computed(page, outline, 'stroke-dasharray')).toBe('none');
    expect(await computed(page, outline, 'stroke')).toBe('rgb(225, 234, 226)');
  });
});

test('MAP-03: a done card keeps its size and opacity, drops the working rim and shows a check unless Needs me is unread', async () => {
  const state = () => {
    const base = sparseProject(), done = new Date().toISOString();
    return stateSchema.parse({ ...base,
      nodes: [...base.nodes.map(node => node.id === 'pr' ? { ...node, completedAt: done, attention: 'review' } : node),
        { id: 'agent', resourceId: 'agent-r', projectId: 'project', title: 'Finished agent', position: { x: 520, y: 480 }, activity: 'working', summary: 'Updating the plan', completedAt: done }],
      resources: [...base.resources, { id: 'agent-r', pluginId: 'agent.session', schemaVersion: 1, title: 'Finished agent', data: { sessionId: 'static-agent', provider: 'claude' } }] });
  };
  await launch({ state, view: { x: 0, y: 0, zoom: 1 } }, async page => {
    const agent = page.locator('[data-item-id="agent"]'), pr = page.locator('[data-item-id="pr"]');
    await expect(agent).toHaveAttribute('data-completed', 'true');
    expect(await agent.evaluate(element => getComputedStyle(element).opacity)).toBe('1');
    await expect(page.locator('.react-flow__node:has(> [data-item-id="agent"]) .working-mark')).toHaveCount(0);
    await expect(agent.getByRole('img', { name: 'Done' })).toBeVisible();
    await expect(agent.locator('.card-summary')).toHaveText('Working · Updating the plan');
    await expect(pr.locator('.attention-indicator')).toHaveCount(1);
    await expect(pr.getByRole('img', { name: 'Done' })).toHaveCount(0);
  });
});

test('MAP-06: the project header leads with a colour swatch and a larger name, with options right after it', async () => {
  await launch({ state: sparseProject, view: { x: 0, y: 100, zoom: 1 } }, async page => {
    const header = page.locator('[data-project-label="project"]'), name = header.locator('strong');
    await expect(name).toHaveText('Billing redesign');
    expect(parseFloat(await name.evaluate(element => getComputedStyle(element).fontSize))).toBeGreaterThan(13);
    const swatch = await header.locator('.project-swatch').evaluate(element => getComputedStyle(element).backgroundColor);
    const field = await page.locator('[data-project-field="project"] .neighborhood-paint').first().evaluate(element => getComputedStyle(element).fill);
    expect(swatch).toBe(field);
    const text = (await name.boundingBox())!, options = (await header.getByRole('button', { name: 'Project options: Billing redesign' }).boundingBox())!;
    expect(options.x - (text.x + text.width)).toBeLessThanOrEqual(12);
  });
});

test('MAP-16: the canvas carries no React Flow corner credit; Settings → General credits it under About', async () => {
  await launch({ state: sparseProject, view: { x: 0, y: 100, zoom: 1 } }, async page => {
    await expect(page.locator('.react-flow__attribution')).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('treeitem', { name: 'General', exact: true }).click();
    const about = page.getByRole('group', { name: 'About' });
    await expect(about).toContainText('React Flow');
    await expect(about).toContainText('MIT');
  });
});

test('MAP-08: a note shows its whole text on paper instead of a truncated title', async () => {
  const state = () => {
    const base = sparseProject();
    return stateSchema.parse({ ...base, nodes: base.nodes.map(node => node.id === 'note' ? { ...node, title: 'API compatibility review for the billing plans' } : node),
      resources: base.resources.map(resource => resource.id === 'note-r' ? { ...resource, data: { text: 'API compatibility review for the billing plans' } } : resource) });
  };
  await launch({ state, view: { x: 0, y: 100, zoom: 1 } }, async page => {
    const card = page.locator('[data-item-id="note"]'), face = card.locator('.paper-face');
    await expect(face).toHaveText('API compatibility review for the billing plans');
    const bounds = (await card.boundingBox())!, box = (await face.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height);
    expect(await face.evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true);
  });
});

test('MAP-09: cards use the square pixel panel shape with a stepped edge, like the menus and Atlas', async () => {
  await launch({ state: sparseProject, view: { x: 0, y: 100, zoom: 1 } }, async page => {
    const shape = await page.locator('.map-locator.atlas').evaluate(element => getComputedStyle(element).clipPath);
    for (const id of ['pr', 'note']) {
      const card = page.locator(`[data-item-id="${id}"]`);
      await expect(card).toHaveCSS('border-radius', '0px');
      expect(await card.evaluate(element => getComputedStyle(element).clipPath)).toBe(shape);
      expect(await card.evaluate(element => getComputedStyle(element, '::after').webkitMaskBoxImageSource)).toContain('svg');
    }
    await page.locator('[data-item-id="pr"]').click({ button: 'right' });
    expect(await page.locator('.canvas-menu').evaluate(element => getComputedStyle(element).clipPath)).toBe(shape);
  });
});

test('MAP-11: the connect handle straddles the card edge outside its content; the resize grip shows on hover and selection', async () => {
  await launch({ state: sparseProject, view: { x: 0, y: 100, zoom: 1 } }, async page => {
    const card = page.locator('[data-item-id="pr"]'), handle = card.getByRole('button', { name: /^Connect / }), grip = card.getByRole('button', { name: /^Resize / });
    await expect(handle).toHaveCSS('opacity', '0');
    await expect(grip).toHaveCSS('opacity', '0');
    await card.hover();
    await expect(handle).toHaveCSS('opacity', '1');
    await expect(grip).toHaveCSS('opacity', '1');
    const box = (await card.boundingBox())!, target = (await handle.boundingBox())!, text = (await card.locator('.card-label').boundingBox())!;
    const plus = await handle.evaluate(element => { const style = getComputedStyle(element, '::before'), rect = element.getBoundingClientRect(), inset = parseFloat(style.top); return { x: rect.x + inset, y: rect.y + inset, width: parseFloat(style.width), height: parseFloat(style.height) }; });
    expect(plus.width).toBe(16);
    expect(plus.x).toBeLessThan(box.x + box.width); expect(plus.x + plus.width).toBeGreaterThan(box.x + box.width);
    expect(Math.abs(plus.y + plus.height / 2 - (box.y + box.height / 2))).toBeLessThanOrEqual(1);
    expect(text.x + text.width).toBeLessThanOrEqual(plus.x);
    const hit = (x: number, y: number) => page.evaluate(point => document.elementFromPoint(point.x, point.y)?.closest('button')?.getAttribute('aria-label'), { x, y });
    expect(target.width).toBeGreaterThanOrEqual(28); expect(target.height).toBeGreaterThanOrEqual(28);
    for (const [x, y] of [[target.x + 1, target.y + 1], [target.x + target.width - 1, target.y + 1], [target.x + 1, target.y + target.height - 1], [target.x + target.width - 1, target.y + target.height - 1]]) expect(await hit(x, y)).toBe('Connect Plan switcher');
    const corner = (await grip.boundingBox())!;
    expect(corner.width).toBeGreaterThanOrEqual(24); expect(corner.height).toBeGreaterThanOrEqual(24);
    expect((await grip.locator('svg').boundingBox())!.width).toBe(12);
    for (const [x, y] of [[corner.x + 1, corner.y + 1], [corner.x + corner.width - 6, corner.y + corner.height - 6], [corner.x + 1, corner.y + corner.height - 6]]) expect(await hit(x, y)).toBe('Resize Plan switcher');
    expect(await grip.evaluate(element => getComputedStyle(element).color)).toBe('rgb(191, 206, 194)');
    await card.click({ modifiers: ['Shift'] });
    await page.mouse.move(5, 5);
    await expect(grip).toHaveCSS('opacity', '1');
    await expect(handle).toHaveCSS('opacity', '0');
  });
});

test('MAP-07: a partly visible neighbour gets a one-line faded plate with only its Needs me count', async () => {
  const state = () => {
    const base = sparseProject();
    return stateSchema.parse({ ...base,
      nodes: [...base.nodes, { id: 'other', title: 'Payments', position: { x: 1850, y: 300 } },
        { id: 'other-pr', resourceId: 'other-pr-r', projectId: 'other', title: 'Refund flow', position: { x: 1850, y: 300 }, activity: 'working', attention: 'review' }],
      resources: [...base.resources, { id: 'other-pr-r', pluginId: 'github.pull-request', schemaVersion: 1, title: 'Refund flow', data: { owner: 'example', repo: 'payments', number: 7 } }] });
  };
  await launch({ state, view: { x: 0, y: 100, zoom: 1 } }, async page => {
    const main = page.locator('[data-project-label="project"]'), edge = page.locator('[data-project-label="other"]');
    await expect(main.getByRole('button', { name: 'Project options: Billing redesign' })).toBeVisible();
    await expect(edge).toHaveAttribute('data-edge', 'true');
    await expect(edge.getByRole('button', { name: /Project options/ })).toHaveCount(0);
    await expect(edge).toHaveCSS('opacity', '0.7');
    await expect(edge.locator('.project-counts')).toHaveText('1', { useInnerText: true });
    await expect(edge.locator('.project-counts .tier-mark')).toHaveAttribute('data-tier', 'turn');
    const name = (await edge.locator('strong').boundingBox())!, count = (await edge.locator('.project-counts').boundingBox())!;
    expect(Math.abs(name.y + name.height / 2 - (count.y + count.height / 2))).toBeLessThan(4);
    await page.getByRole('slider', { name: 'Map zoom' }).fill('0.5');
    await expect(page.locator('[data-project-label="other"]')).not.toHaveAttribute('data-edge', 'true');
  });
});

test('MAP-12: an item menu opens at the pointer but never covers the card’s title row', async () => {
  await launch({ state: sparseProject, view: { x: 0, y: 100, zoom: 1 }, size: { width: 1600, height: 700 } }, async page => {
    const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    for (const id of ['pr', 'note']) {
      const card = page.locator(`[data-item-id="${id}"]`), title = (await card.locator(':is(.card-heading,.paper-face)').boundingBox())!;
      await page.mouse.click(title.x + 20, title.y + title.height / 2, { button: 'right' });
      const menu = page.locator('.canvas-menu');
      await expect(menu).toBeVisible();
      expect(overlaps((await menu.boundingBox())!, title), id).toBe(false);
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
    }
  });
});

test('MAP-17: a project dashboard is centred in its field by default', async () => {
  await launch({ state: sparseProject, view: { x: 300, y: 150, zoom: .4 }, settings: value => ({ ...value, mapDashboards: { ...value.mapDashboards, enabled: true, belowZoom: .65, placement: 'center' } }) }, async page => {
    const board = page.locator('[data-dashboard="project"]'), field = (await page.locator('[data-project-outline="project"]').boundingBox())!;
    await expect(board).toBeVisible();
    const box = (await board.boundingBox())!;
    expect(Math.abs(box.y + box.height / 2 - (field.y + field.height / 2))).toBeLessThanOrEqual(2);
    expect(box.y).toBeGreaterThan(Math.max(12, field.y + 16) + 2);
  });
});

test('MAP-17: Settings pins project dashboards to the top of their field and saves the choice', async () => {
  await launch({ state: sparseProject, view: { x: 300, y: 150, zoom: .4 }, settings: value => ({ ...value, mapDashboards: { ...value.mapDashboards, enabled: true, belowZoom: .65, placement: 'center' } }) }, async page => {
    const board = page.locator('[data-dashboard="project"]'), field = (await page.locator('[data-project-outline="project"]').boundingBox())!;
    await expect(board).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('treeitem', { name: 'Map', exact: true }).click();
    const placement = page.getByRole('radiogroup', { name: 'Dashboard placement' });
    await expect(placement.getByRole('radio', { name: 'Centre' })).toHaveAttribute('aria-checked', 'true');
    await placement.getByRole('radio', { name: 'Top' }).click();
    await expect(placement.getByRole('radio', { name: 'Top' })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
    await expect.poll(async () => (await page.evaluate(() => window.craftingTable.settingsRead())).value.mapDashboards.placement).toBe('top');
    await expect.poll(async () => Math.abs((await board.boundingBox())!.y - Math.max(12, field.y + 16))).toBeLessThanOrEqual(2);
    const box = (await board.boundingBox())!;
    expect(box.y + box.height).toBeLessThan(field.y + field.height);
  });
});

/** One project with sixteen links among eight notes, one of them blocking. */
function denseProject() {
  const notes = Array.from({ length: 8 }, (_, index) => ({ id: `n${index}`, x: 300 + (index % 4) * 260, y: 250 + Math.floor(index / 4) * 220 }));
  const links = notes.flatMap((note, index) => [notes[(index + 1) % 8], notes[(index + 3) % 8]].map(other => ({ id: `${note.id}-${other.id}`, sourceId: note.id, targetId: other.id, kind: 'reference' })));
  links[0] = { ...links[0], kind: 'blocks' };
  return stateSchema.parse({ version: 1, revision: 0, todos: [], view: {},
    nodes: [{ id: 'project', title: 'Dense', position: { x: 700, y: 360 } },
      ...notes.map(note => ({ id: note.id, resourceId: `${note.id}-r`, projectId: 'project', title: `Note ${note.id}`, position: { x: note.x, y: note.y }, activity: 'idle' }))],
    resources: notes.map(note => ({ id: `${note.id}-r`, pluginId: 'workspace.note', schemaVersion: 1, title: `Note ${note.id}`, data: { text: '' } })),
    links });
}

test('MAP-01: links in a dense project rest at 35%; the hovered or selected item’s links and blocking links stay full strength', async () => {
  await launch({ state: denseProject, view: { x: 0, y: 0, zoom: .9 }, settings: value => ({ ...value, hideImpliedLinks: false }) }, async page => {
    const opacity = async (id: string) => {
      const path = `.react-flow__edge[data-id="${id}"] .react-flow__edge-path`;
      return String(Math.round(parseFloat(await computed(page, path, 'opacity')) * parseFloat(await computed(page, path, 'stroke-opacity')) * 100) / 100);
    };
    await expect(page.locator('.explicit-edge')).toHaveCount(16);
    expect(await opacity('n1-n2')).toBe('0.35');
    expect(await opacity('n0-n1')).toBe('1');
    await page.locator('[data-item-id="n1"]').hover();
    await expect.poll(() => opacity('n1-n2')).toBe('1');
    expect(await opacity('n2-n3')).toBe('0.2');
    await page.mouse.move(5, 5);
    await expect.poll(() => opacity('n1-n2')).toBe('0.35');
    await page.locator('[data-item-id="n2"]').click({ modifiers: ['Shift'] });
    await page.mouse.move(5, 5);
    await expect.poll(() => opacity('n2-n3')).toBe('1');
    expect(await opacity('n1-n2')).toBe('1');
    expect(await opacity('n4-n5')).toBe('0.35');
  });
  // Implied links (LINK-06) do not count: the eight notes keep the blocking line and six reference lines, at full strength.
  await launch({ state: denseProject, view: { x: 0, y: 0, zoom: .9 } }, async page => {
    await expect(page.locator('.explicit-edge:not(.link-concealed)')).toHaveCount(7);
    await expect(page.locator('.explicit-edge.connection-resting')).toHaveCount(0);
  });
  await launch({ state: sparseProject, view: { x: 0, y: 100, zoom: 1 } }, async page => {
    for (const property of ['opacity', 'stroke-opacity']) expect(await computed(page, '.react-flow__edge[data-id="pr-note"] .react-flow__edge-path', property)).toBe('1');
  });
});
