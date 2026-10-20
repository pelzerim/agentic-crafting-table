import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function quit(app: ElectronApplication) {
  const closed = app.waitForEvent('close');
  await app.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); });
  await closed;
}

test('native window position and size survive immediate quit/relaunch while background tests stay hidden', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-window-reopen-'));
  const launch = () => electron.launch({ args: ['.', '--renderer-spike'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  let app = await launch();
  try {
    await app.firstWindow();
    const bounds = await app.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows()[0], area = screen.getPrimaryDisplay().workArea;
      window.setBounds({ x: area.x + 35, y: area.y + 45, width: 940, height: 640 });
      return window.getBounds();
    });
    // Quit before the 250 ms debounce: close must flush the final native bounds.
    await quit(app);
    expect(JSON.parse(await readFile(join(directory, 'window-state.json'), 'utf8')).bounds).toEqual(bounds);
    app = await launch(); await app.firstWindow();
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())).toEqual(bounds);
    if (process.env.ACT_TEST_SHOW_WINDOW !== '1') expect(await app.evaluate(({ BrowserWindow, app }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return { visible: window.isVisible(), focused: window.isFocused(), dockVisible: app.dock?.isVisible() ?? false };
    })).toEqual({ visible: false, focused: false, dockVisible: false });
  } finally {
    await app.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('invalid and disconnected-display preferences still open a reachable native window', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-window-fallback-'));
  try {
    for (const contents of ['{broken', JSON.stringify({ version: 1, bounds: { x: -99999, y: -99999, width: 5000, height: 4000 }, displayId: -999, maximized: true })]) {
      await writeFile(join(directory, 'window-state.json'), contents);
      const app = await electron.launch({ args: ['.', '--renderer-spike'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
      try {
        await app.firstWindow();
        const state = await app.evaluate(({ BrowserWindow, screen }) => {
          const window = BrowserWindow.getAllWindows()[0];
          return { bounds: window.getNormalBounds(), area: screen.getPrimaryDisplay().workArea, visible: window.isVisible(), focusable: window.isFocusable() };
        });
        expect(state.bounds.x).toBeGreaterThanOrEqual(state.area.x); expect(state.bounds.y).toBeGreaterThanOrEqual(state.area.y);
        expect(state.bounds.x + state.bounds.width).toBeLessThanOrEqual(state.area.x + state.area.width);
        expect(state.bounds.y + state.bounds.height).toBeLessThanOrEqual(state.area.y + state.area.height);
        if (process.env.ACT_TEST_SHOW_WINDOW !== '1') { expect(state.visible).toBe(false); expect(state.focusable).toBe(false); }
      } finally { await app.close(); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
