import { test, expect, _electron as electron } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { SqliteStore } from '../../packages/workspace-service/sqlite-store.ts';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { plotProject } from '../fixtures/plot-project.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { resize, scrollbarArgs } from './visual-fixture.ts';
import { colorPadColor } from '../../src/graph/colors.ts';
import { signTone } from '../../src/graph/plot-palette.ts';
import { PROJECT_COLORS } from '../../src/graph/project-colors.ts';

const rgb = (hex: string) => `rgb(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
const read = (page: Page) => page.evaluate(() => window.craftingTable.workspaceRead());
const colorsForm = (page: Page) => page.locator('form.inline-editor');
const recentColors = (page: Page) => page.evaluate(async () => (await window.craftingTable.settingsRead()).value.recentColors);

async function launch(run: (page: Page) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-color-picker-')), store = new SqliteStore(join(directory, 'workspace.sqlite'));
  try { await store.update(() => plotProject()); await store.writeView('desktop', { camera: { x: 80, y: 70, zoom: .8 } }); } finally { store.close(); }
  const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1', '--disable-lcd-text', '--force-color-profile=srgb', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory, SHELL: '/bin/sh', TZ: 'UTC' } });
  try {
    const page = await app.firstWindow();
    await page.route(/^https?:\/\//, route => route.abort());
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
    await resize(app, page, 1440, 900);
    await expect(page.getByText('Desktop connected')).toBeVisible();
    await run(page);
  } finally {
    await exitWithoutShutdown(app);
    const client = await connectWorkspace(directory).catch(() => undefined);
    if (client) { const ended = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await ended; client.close(); }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test('one colour picker: project presets and custom colours by pad and hex, shared as Your colours in the plot menu and the note tools', async () => {
  test.setTimeout(120_000);
  await launch(async page => {
    // Project editor: a preset, then a custom colour from the pad, then one typed as hex.
    await page.getByRole('button', { name: 'Project options: Photos' }).click();
    await page.getByRole('menuitem', { name: 'Project settings…', exact: true }).click();
    const form = colorsForm(page), colors = page.getByRole('radiogroup', { name: 'Neighborhood color', exact: true });
    await expect(colors.getByRole('radio')).toHaveCount(PROJECT_COLORS.length);
    await expect(colors.getByRole('radio', { name: 'Grass', exact: true })).toHaveAttribute('aria-checked', 'true');
    await colors.getByRole('radio', { name: 'Emerald', exact: true }).click();
    await expect(colors.getByRole('radio', { name: 'Emerald', exact: true })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: 'Custom colour…', exact: true }).click();
    const pad = page.getByRole('group', { name: 'Custom colour' });
    await expect(pad.getByRole('slider', { name: 'Hue' })).toBeFocused();
    const start = await pad.getByRole('slider', { name: 'Hue' }).getAttribute('aria-valuenow'), shade = 7 - Number(await pad.getByRole('slider', { name: 'Lightness' }).getAttribute('aria-valuenow'));
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
    const hue = (Number(start) + 2) % 12, picked = colorPadColor(hue, shade);
    await expect(pad.getByRole('textbox', { name: 'Hex colour' })).toHaveValue(picked);
    await page.keyboard.press('Escape');
    await expect(pad).toHaveCount(0);
    await expect(form).toBeVisible();
    await page.getByRole('button', { name: 'Custom colour…', exact: true }).click();
    await pad.getByRole('slider', { name: 'Hue' }).press('ArrowRight'); await pad.getByRole('slider', { name: 'Hue' }).press('ArrowRight');
    await pad.getByRole('button', { name: 'Apply' }).click();
    await expect(pad).toHaveCount(0);
    await expect(colors.getByRole('radio', { checked: true })).toHaveCount(0);
    await expect(page.getByRole('radiogroup', { name: 'Your colours' }).getByRole('radio', { name: `Your colour ${picked}` })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: `Custom colour ${picked}` }).click();
    await pad.getByRole('textbox', { name: 'Hex colour' }).fill('#36C');
    await expect(pad.getByRole('button', { name: 'Apply' })).toBeEnabled();
    await pad.getByRole('textbox', { name: 'Hex colour' }).fill('#3366zz');
    await expect(pad.getByRole('textbox', { name: 'Hex colour' })).toHaveAttribute('aria-invalid', 'true');
    await expect(pad.getByRole('button', { name: 'Apply' })).toBeDisabled();
    await pad.getByRole('textbox', { name: 'Hex colour' }).fill('#3366CC');
    await page.locator('.project-color-picker').screenshot({ path: 'test-results/color-picker-project.png' });
    await pad.getByRole('textbox', { name: 'Hex colour' }).press('Enter');
    await expect(form).toBeVisible();
    expect(await page.getByRole('radiogroup', { name: 'Your colours' }).getByRole('radio').evaluateAll(radios => radios.map(radio => [radio.getAttribute('aria-label'), radio.getAttribute('aria-checked')])))
      .toEqual([['Your colour #3366cc', 'true'], [`Your colour ${picked}`, 'false']]);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect.poll(async () => (await read(page)).state.nodes.find(node => node.id === 'photos')?.color).toBe('#3366cc');
    await expect.poll(() => recentColors(page)).toEqual(['#3366cc', picked]);

    // Plot sign menu: the six slots, Your colours behind More, a custom colour typed in tints the patch and sign.
    const billing = page.locator('[data-plot-sign]').filter({ hasText: 'Billing · 4 items' });
    await billing.getByRole('button').click({ button: 'right' });
    await expect(page.getByRole('radiogroup', { name: 'Color' }).getByRole('radio')).toHaveCount(6);
    await page.getByRole('menuitem', { name: 'Name automatically' }).focus(); await page.keyboard.press('ArrowDown');
    for (let step = 0; step < 6; step++) await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('button', { name: 'More colours' })).toBeFocused();
    await page.keyboard.press('Enter');
    const menuRecent = page.getByRole('menu').getByRole('radiogroup', { name: 'Your colours' });
    await expect(menuRecent.getByRole('radio')).toHaveCount(2);
    await expect(menuRecent.getByRole('radio').first()).toHaveAccessibleName('Your colour #3366cc');
    await page.getByRole('menu').getByRole('button', { name: 'Custom colour…' }).click();
    await expect(pad.getByRole('slider', { name: 'Hue' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(pad).toHaveCount(0);
    await expect(page.getByRole('menu')).toHaveCount(1);
    await page.getByRole('menu').getByRole('button', { name: 'Custom colour…' }).click();
    await pad.getByRole('textbox', { name: 'Hex colour' }).fill('#d0306a');
    await page.getByRole('menu').screenshot({ path: 'test-results/color-picker-plot-menu.png' });
    await pad.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(billing).toHaveAttribute('data-plot-color', '#d0306a');
    const paint = await billing.evaluate(element => {
      const id = element.getAttribute('data-plot-sign')!, patch = document.querySelector(`[data-plot-patch="${id}"] path`)!;
      return { fill: getComputedStyle(patch).fill, sprout: getComputedStyle(element.querySelector('.plot-sign-button>svg')!).color };
    });
    expect(paint).toEqual({ fill: rgb('#d0306a'), sprout: rgb(signTone('#d0306a')) });
    await expect.poll(() => recentColors(page)).toEqual(['#d0306a', '#3366cc', picked]);
    await billing.getByRole('button').click({ button: 'right' });
    await expect(page.getByRole('radiogroup', { name: 'Color' }).getByRole('radio', { checked: true })).toHaveCount(0);
    await page.getByRole('menuitemradio', { name: /^Automatic · / }).click();
    await expect(billing).not.toHaveAttribute('data-plot-color', '#d0306a');

    // Note tools: ten papers, Your colours behind More, a custom paper tints the note.
    const ideas = page.locator('[data-item-id="thumb-note"]');
    await ideas.locator('.paper-face').click();
    await expect(page.getByRole('textbox', { name: 'Note text' })).toBeFocused();
    const tools = page.locator('.paper-tools');
    await expect(tools.getByRole('radiogroup', { name: 'Paper' }).getByRole('radio')).toHaveCount(10);
    await tools.getByRole('radio', { name: 'Moss', exact: true }).click();
    await expect(ideas).toHaveAttribute('data-paper', 'moss');
    await tools.getByRole('button', { name: 'More colours' }).click();
    await expect(tools.getByRole('radiogroup', { name: 'Your colours' }).getByRole('radio')).toHaveCount(3);
    await tools.getByRole('button', { name: 'Custom colour…' }).click();
    await page.screenshot({ path: 'test-results/color-picker-paper.png', clip: (await ideas.boundingBox().then(box => ({ x: box!.x - 8, y: box!.y - 8, width: 420, height: 360 }))) });
    await pad.getByRole('textbox', { name: 'Hex colour' }).fill('#24387a');
    await pad.getByRole('button', { name: 'Apply' }).click();
    await expect(ideas).toHaveAttribute('data-paper', '#24387a');
    await expect(ideas).toHaveAttribute('data-paper-tone', 'dark');
    expect(await ideas.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(rgb('#24387a'));
    await expect.poll(async () => (await read(page)).state.resources.find(resource => resource.id === 'thumb-note-r')?.data.paper).toBe('#24387a');
    await expect.poll(() => recentColors(page)).toEqual(['#24387a', '#d0306a', '#3366cc', picked]);
  });
});
