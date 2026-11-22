import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { TERMINAL_THEMES } from '../../apps/desktop/renderer/terminal-theme.ts';

async function launch(appearance: string | undefined, run: (app: ElectronApplication, page: Page, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-appearance-'));
  const { ACT_TEST_APPEARANCE: _inherited, ...inherited } = process.env;
  const app = await electron.launch({ args: ['.'], env: { ...inherited, SHELL: '/bin/sh', ACT_TEST_DATA_DIR: directory, ...(appearance ? { ACT_TEST_APPEARANCE: appearance } : {}) } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('Desktop connected')).toBeVisible();
    await run(app, page, directory);
  } finally {
    await exitWithoutShutdown(app);
    for (const connect of [() => connectWorkspace(directory), () => connectSupervisor(join(directory, 'runtime'))]) {
      const client = await connect().catch(() => undefined);
      if (client) { const disconnected = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await disconnected; client.close(); }
    }
    await rm(directory, { recursive: true, force: true });
  }
}
type Rgb = [number, number, number];
const hex = (value: string): Rgb => [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16)) as Rgb;
const luminance = (rgb: Rgb) => { const [r, g, b] = rgb.map(v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a: Rgb, b: Rgb) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
const near = (a: Rgb, b: Rgb, tolerance = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance);
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
/** Each fixture row, by its label: the styles Claude Code uses for secondary text, white bars and reverse video. */
const ROWS = { white: 'Ran 3 shell commands', dimWhite: 'Interrupted · What should Claude do instead?', highlight: '> open a pr for this', dim: 'recap: dim text in the default colour',
  hint: 'hint in bright black', brightWhite: 'bright white text', whiteBar: 'black on white', brightWhiteBar: 'black on bright white', reverse: 'reverse video', reverseWhite: 'reverse white' } as const;

type Painted = { ground: Rgb; ink: number };
/** Light: every row reaches the minimum contrast (half for dim text), on the background its style asks for. */
function expectLightRows(rows: Record<keyof typeof ROWS, Painted>) {
  const theme = TERMINAL_THEMES.light;
  const grounds: Record<keyof typeof ROWS, string> = { white: theme.background!, dimWhite: theme.background!, highlight: theme.brightBlack!, dim: theme.background!, hint: theme.background!,
    brightWhite: theme.background!, whiteBar: theme.white!, brightWhiteBar: theme.brightWhite!, reverse: theme.foreground!, reverseWhite: theme.white! };
  for (const [key, { ground, ink }] of Object.entries(rows) as [keyof typeof ROWS, Painted][]) {
    expect(near(ground, hex(grounds[key])), `${ROWS[key]} background`).toBe(true);
    expect(ink, `${ROWS[key]} contrast`).toBeGreaterThanOrEqual(key === 'dim' || key === 'dimWhite' ? 2.25 : 4.5);
  }
}

/** Prints the ANSI fixture through the test's /bin/sh, after the session takes input. */
async function printFixture(page: Page) {
  await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(`${quote(process.execPath)} ${quote(resolve('tests/fixtures/light-terminal.mjs'))}\n`);
  await expect(page.locator('.xterm-accessibility-tree')).toContainText('Light terminal fixture ready');
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
}

/** The DOM renderer's painted colours for each label: text composited on its background. */
async function domColours(page: Page, background: string) {
  await expect(page.locator('.terminal-host')).toHaveAttribute('data-terminal-renderer', 'dom');
  await expect(page.locator('.terminal-surface .xterm-rows')).toContainText(ROWS.reverseWhite);
  const raw = await page.locator('.terminal-surface .xterm-rows').evaluate((rows, labels) => Object.fromEntries(Object.entries(labels).map(([key, label]) => {
    const span = [...rows.querySelectorAll('span')].find(span => span.textContent!.trim() === label);
    if (!span) throw new Error(`No cell shows ${label}`);
    const style = getComputedStyle(span);
    return [key, { color: style.color, background: style.backgroundColor }];
  })), ROWS);
  const parse = (css: string) => css.match(/[\d.]+/g)!.map(Number);
  return Object.fromEntries(Object.entries(raw).map(([key, { color, background: bg }]) => {
    const [br, bgG, bb, ba = 1] = parse(bg), ground: Rgb = ba ? [br, bgG, bb] : hex(background);
    const [r, g, b, a = 1] = parse(color), text = [r, g, b].map((v, i) => Math.round(v * a + ground[i] * (1 - a))) as Rgb;
    return [key, { text, ground, ink: contrast(text, ground) }];
  })) as Record<keyof typeof ROWS, Painted & { text: Rgb }>;
}

/** The WebGL renderer's pixels for each label: its most common colour (the cell background) and the strongest ink on it. */
async function webglColours(page: Page) {
  const screen = page.locator('.terminal-surface .xterm-screen'), id = (await page.locator('.terminal-surface').getAttribute('data-terminal-id'))!;
  const { cols } = (await page.evaluate(id => window.craftingTable.sessionRead(id), id)).session;
  const png = (await screen.screenshot()).toString('base64');
  const raw = await page.evaluate(async ({ png, labels, cols }) => {
    const lines = [...document.querySelectorAll('.terminal-surface .xterm-accessibility-tree > div')].map(row => row.textContent ?? '');
    const image = await createImageBitmap(new Blob([Uint8Array.from(atob(png), c => c.charCodeAt(0))], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(image.width, image.height), context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const cellW = image.width / cols, cellH = image.height / lines.length;
    return Object.fromEntries(Object.entries(labels).map(([key, label]) => {
      const row = lines.findIndex(line => line.includes(label)), col = lines[row].indexOf(label);
      const x = Math.round(col * cellW), y = Math.round(row * cellH), w = Math.round(label.length * cellW), h = Math.round(cellH);
      const { data } = context.getImageData(x, y, w, h), pixels: number[][] = [], counts = new Map<string, number>();
      for (let i = 0; i < data.length; i += 4) { const p = [data[i], data[i + 1], data[i + 2]]; pixels.push(p); counts.set(p.join(), (counts.get(p.join()) ?? 0) + 1); }
      const ground = [...counts].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number);
      return [key, { ground, pixels }];
    }));
  }, { png, labels: ROWS, cols });
  return Object.fromEntries(Object.entries(raw).map(([key, { ground, pixels }]) => {
    const ink = pixels.reduce((best, pixel) => Math.max(best, contrast(pixel as Rgb, ground as Rgb)), 1);
    return [key, { ground: ground as Rgb, ink }];
  })) as Record<keyof typeof ROWS, Painted>;
}
/** Playwright emulates prefers-color-scheme: light, so these also show the page ignores it. */
const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);
const token = (page: Page, name: string) => page.evaluate(name => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), name);

test('a test launch is dark whatever the machine uses', async () => {
  await launch(undefined, async (app, page) => {
    expect(await theme(page)).toBe('dark');
    expect(await token(page, '--act-bg')).toBe('#141a17');
    expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark');
  });
});

test('the light theme reaches tokens, the window and the terminal, and Settings saves the choice', async () => {
  await launch('light', async (app, page, directory) => {
    expect(await theme(page)).toBe('light');
    expect(await token(page, '--act-bg')).toBe('#eef2ee');
    expect(await token(page, '--act-ink')).toBe('#17231b');
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase())).toBe('#eef2ee');

    await page.evaluate(async cwd => {
      const id = crypto.randomUUID();
      await window.craftingTable.resourceCreate({ requestId: id, nodeId: crypto.randomUUID(), resourceId: crypto.randomUUID(), expectedRevision: 0,
        pluginId: 'terminal.session', title: 'Light terminal', position: { x: 250, y: 230 }, data: { cwd } });
    }, directory);
    await page.getByRole('article', { name: 'Light terminal' }).click();
    await expect(page.locator('.terminal-surface')).toHaveAttribute('data-terminal-theme', 'light');
    await expect(page.locator('.terminal-surface')).toHaveAttribute('data-terminal-contrast', '4.5');
    await printFixture(page);
    await page.locator('.terminal-surface').screenshot({ path: 'test-results/pr/light-terminal-agent-text.png' });
    if (await page.locator('.terminal-host').getAttribute('data-terminal-renderer') === 'webgl') {
      expectLightRows(await webglColours(page));
    }
    await page.keyboard.press('Escape');

    expect((await page.evaluate(() => window.craftingTable.settingsRead())).value.appearance).toBe('system');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('treeitem', { name: 'General', exact: true }).click();
    const colours = dialog.getByRole('radiogroup', { name: 'Colours' });
    await expect(colours.getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'true');
    await colours.getByRole('radio', { name: 'Dark' }).click();
    await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect((await page.evaluate(() => window.craftingTable.settingsRead())).value.appearance).toBe('dark');
    await expect.poll(() => theme(page)).toBe('dark');
    await expect(page.locator('.terminal-surface')).toHaveAttribute('data-terminal-theme', 'dark');
    await expect(page.locator('.terminal-surface')).toHaveAttribute('data-terminal-contrast', '1');
  });
});

test('a theme change reaches the open page and terminal without reloading, as when macOS switches on System', async () => {
  await launch('light', async (app, page, directory) => {
    await page.evaluate(async cwd => {
      const id = crypto.randomUUID();
      await window.craftingTable.resourceCreate({ requestId: id, nodeId: crypto.randomUUID(), resourceId: crypto.randomUUID(), expectedRevision: 0,
        pluginId: 'terminal.session', title: 'Switching terminal', position: { x: 250, y: 230 }, data: { cwd } });
    }, directory);
    // The DOM renderer, as on a runner without WebGL2: it paints each cell's colour as a style the test can read.
    await page.evaluate(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
        return type === 'webgl2' ? null : Reflect.apply(original, this, [type, ...args]);
      } as typeof original;
    });
    await page.getByRole('article', { name: 'Switching terminal' }).click();
    const surface = page.locator('.terminal-surface'), mount = await surface.getAttribute('data-mount-id');
    await expect(surface).toHaveAttribute('data-terminal-theme', 'light');
    await expect(surface).toHaveAttribute('data-terminal-contrast', '4.5');
    await printFixture(page);
    const light = await domColours(page, TERMINAL_THEMES.light.background!);
    expectLightRows(light);
    // Reverse video draws the default background as text, which needs no change.
    expect(light.reverse.text).toEqual(hex(TERMINAL_THEMES.light.background!));
    await page.evaluate(() => { (window as unknown as { loaded: boolean }).loaded = true; });

    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; });
    await expect.poll(() => theme(page)).toBe('dark');
    expect(await token(page, '--act-bg')).toBe('#141a17');
    await expect(surface).toHaveAttribute('data-terminal-theme', 'dark');
    await expect(surface).toHaveAttribute('data-terminal-contrast', '1');
    // The rows already on screen repaint in dark colours, which need no contrast help.
    const dark = await domColours(page, TERMINAL_THEMES.dark.background!);
    expect(dark.white.ground).toEqual(hex(TERMINAL_THEMES.dark.background!));
    expect(dark.white.ink).toBeGreaterThanOrEqual(7);
    expect(dark.reverse).toMatchObject({ text: hex(TERMINAL_THEMES.dark.background!), ground: hex(TERMINAL_THEMES.dark.foreground!) });
    expect(await surface.getAttribute('data-mount-id')).toBe(mount);
    expect(await page.evaluate(() => (window as unknown as { loaded?: boolean }).loaded)).toBe(true);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase())).toBe('#141a17');
  });
});
