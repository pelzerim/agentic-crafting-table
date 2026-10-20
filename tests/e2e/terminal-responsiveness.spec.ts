import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { test, openTerminal } from './visual-fixture.ts';

for (const renderer of ['auto', 'dom'] as const) test(`closing a populated ${renderer} terminal returns a responsive map without restarting its session`, async ({ visual: { page } }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  if (renderer === 'dom') await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
      return type === 'webgl2' ? null : original.apply(this, [type, ...args] as any);
    } as typeof original;
  });
  await openTerminal(page, true);
  const surface = page.locator('.terminal-content .terminal-surface');
  const id = (await surface.getAttribute('data-terminal-id'))!, mount = await surface.getAttribute('data-mount-id');
  const pid = (await page.evaluate(id => window.craftingTable.sessionRead(id), id)).session.pid;
  const mode = await surface.locator('.terminal-host').getAttribute('data-terminal-renderer');
  const cdp = process.env.ACT_PROFILE_CLOSE ? await page.context().newCDPSession(page) : undefined;
  await cdp?.send('Profiler.enable'); await cdp?.send('Profiler.start');
  const samples: number[][] = [];
  for (let pass = 0; pass < 3; pass++) {
    const frames = await page.evaluate(async () => {
      const frames: number[] = []; let previous = performance.now(), done = false;
      const tick = (time: number) => { frames.push(time - previous); previous = time; if (!done) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      // Include the close handler/commit itself and the whole transition. The
      // normal diagnostics change observers here and can miss this exact stall.
      (document.querySelector('.item-view:not([hidden]) .item-close') as HTMLButtonElement).click();
      await new Promise(resolve => setTimeout(resolve, 700)); done = true;
      return frames;
    });
    samples.push(frames);
    await writeFile(testInfo.outputPath('close-frames.json'), JSON.stringify({ renderer: mode, samples }));
    if (cdp && pass === 0) await writeFile(testInfo.outputPath('close-profile.json'), JSON.stringify(await cdp.send('Profiler.stop')));
    expect(Math.max(...frames)).toBeLessThan(100);
    expect(frames.length).toBeGreaterThan(15);
    await expect(page.locator('.map-area')).toHaveAttribute('data-focus', '');
    await expect(page.locator('.item-view:not([hidden])')).toHaveCount(0);
    await expect(surface.locator('.terminal-host')).toHaveAttribute('data-terminal-renderer', 'dom');
    await page.getByRole('article', { name: 'Development terminal', exact: true }).click();
    await expect(surface).toHaveAttribute('data-mount-id', mount!);
    await expect(page.locator('.xterm-accessibility-tree')).toContainText('Repeated terminal output');
    expect((await page.evaluate(id => window.craftingTable.sessionRead(id), id)).session.pid).toBe(pid);
    await page.locator('.item-view:not([hidden]) > article').evaluate(async element => {
      await Promise.all(element.getAnimations().map(animation => animation.finished));
    });
  }
  await testInfo.attach('close-performance', { path: testInfo.outputPath('close-frames.json'), contentType: 'application/json' });
});
