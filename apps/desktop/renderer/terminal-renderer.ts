import type { IDisposable, Terminal } from '@xterm/xterm';
import { performanceMetrics } from './performance.ts';
import { WebglAddon } from '@xterm/addon-webgl';

/** Render only the visible surface on the GPU. Switching renderers preserves
 * xterm's buffer, selection and PTY; failed contexts stay on the DOM fallback. */
export function createTerminalRenderer(terminal: Terminal, changed: (mode: 'webgl' | 'dom') => void) {
  let addon: WebglAddon | undefined, loss: IDisposable | undefined;
  let unavailable = false, disposed = false;
  changed('dom');
  const release = () => {
    loss?.dispose(); loss = undefined;
    const previous = addon; addon = undefined;
    const started = performance.now();
    previous?.dispose();
    if (previous) performanceMetrics.record('terminal.renderer-release', performance.now() - started);
    changed('dom');
  };
  return {
    setActive(active: boolean) {
      if (disposed) return;
      if (!active) { if (addon) release(); return; }
      if (addon || unavailable) return;
      try {
        addon = new WebglAddon();
        loss = addon.onContextLoss(() => { unavailable = true; release(); });
        // Must follow terminal.open(). Chromium chooses the supported backend;
        // do not force a GPU, bypass its blocklist or require WebGL to open a CLI.
        terminal.loadAddon(addon);
        changed('webgl');
      } catch {
        unavailable = true;
        release();
      }
    },
    dispose() { disposed = true; release(); },
  };
}
