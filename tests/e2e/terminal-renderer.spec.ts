import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { test, openTerminal, terminalResized, captureTerminal, resize } from './visual-fixture.ts';

test('GPU terminal renders with WebGL and survives hidden views and context loss', async ({ visual: { app, page } }, testInfo) => {
  const capable = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return Boolean(gl);
  });
  test.skip(!capable, 'This runner has no WebGL2; fallback cases still run.');
  await openTerminal(page);
  const surface = page.locator('.terminal-content .terminal-surface'), host = surface.locator('.terminal-host');
  await expect(host).toHaveAttribute('data-terminal-renderer', 'webgl');
  const gpu = await host.locator('.xterm-screen canvas').evaluateAll(canvases => {
    const gl = canvases.map(canvas => (canvas as HTMLCanvasElement).getContext('webgl2')).find(Boolean)!;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return { version: gl.getParameter(gl.VERSION), renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
  });
  const reportPath = testInfo.outputPath('gpu-renderer.json');
  await writeFile(reportPath, JSON.stringify({ ...gpu, features: await app.evaluate(({ app }) => app.getGPUFeatureStatus()) }, null, 2));
  await testInfo.attach('gpu-renderer', { path: reportPath, contentType: 'application/json' });
  expect(gpu.version).toContain('WebGL 2.0');
  await terminalResized(page);
  const mount = await surface.getAttribute('data-mount-id'), id = (await surface.getAttribute('data-terminal-id'))!;
  const pid = (await page.evaluate(id => window.craftingTable.sessionRead(id), id)).session.pid;
  const graph = (await page.evaluate(() => window.craftingTable.workspaceRead())).state;
  await page.getByRole('button', { name: 'Back to project' }).click();
  await expect(host).toHaveAttribute('data-terminal-renderer', 'dom');
  await expect(host.locator('.xterm-screen canvas')).toHaveCount(0);
  await page.getByRole('article', { name: 'Development terminal' }).click();
  await expect(host).toHaveAttribute('data-terminal-renderer', 'webgl');
  await expect(surface).toHaveAttribute('data-mount-id', mount!);
  await expect(page.getByRole('button', { name: 'History', exact: true })).toHaveCount(0);
  const lost = await host.locator('.xterm-screen canvas').evaluateAll(canvases => {
    const gl = canvases.map(canvas => (canvas as HTMLCanvasElement).getContext('webgl2')).find(Boolean)!;
    const extension = gl.getExtension('WEBGL_lose_context');
    extension?.loseContext();
    return Boolean(extension);
  });
  expect(lost).toBe(true);
  // The official addon waits three seconds for recovery before reporting loss.
  await expect(host).toHaveAttribute('data-terminal-renderer', 'dom', { timeout: 8000 });
  await expect(host.locator('.xterm-rows')).toContainText('Billing workspace');
  await expect(host.locator('.xterm-screen canvas')).toHaveCount(0);
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Control++');
  await terminalResized(page);
  await page.getByRole('button', { name: 'Back to project' }).click();
  await page.getByRole('article', { name: 'Development terminal' }).click();
  await expect(host).toHaveAttribute('data-terminal-renderer', 'dom');
  await expect(surface).toHaveAttribute('data-mount-id', mount!);
  expect((await page.evaluate(id => window.craftingTable.sessionRead(id), id)).session.pid).toBe(pid);
  expect((await page.evaluate(() => window.craftingTable.workspaceRead())).state).toEqual(graph);
});

for (const failure of ['unavailable', 'throws']) test(`terminal remains usable when WebGL ${failure}`, async ({ visual: { app, page } }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  // Only the isolated fixture's renderer is changed; no GPU flags or host settings.
  await page.evaluate(failure => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
      if (type === 'webgl2') {
        if (failure === 'throws') throw new Error('Fixture: GPU initialization failed');
        return null;
      }
      return Reflect.apply(original, this, [type, ...args]);
    } as typeof original;
  }, failure);
  await openTerminal(page);
  await expect(page.locator('.terminal-host')).toHaveAttribute('data-terminal-renderer', 'dom');
  await expect(page.locator('.xterm-rows')).toContainText('Billing workspace');
  await captureTerminal(page, 'terminal-expanded.png');
  if (failure === 'unavailable') {
    await resize(app, page, 900, 640); await terminalResized(page);
    await captureTerminal(page, 'terminal-narrow.png');
  }
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Control++');
  await terminalResized(page);
  await page.getByRole('button', { name: 'Stop session', exact: true }).click();
  await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'exited');
  await expect(page.locator('.xterm-rows')).toContainText('Last terminal row');
  expect(errors).toEqual([]);
});
