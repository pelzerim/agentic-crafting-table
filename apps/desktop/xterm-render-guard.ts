import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Plugin } from 'esbuild';

/** xterm 6.0.0 DomRenderer.handleResize/handleSelectionChanged render directly,
 * even when RenderService's IntersectionObserver has paused hidden terminals.
 * WidthCache cannot cache zero-width hidden glyphs, causing thousands of forced
 * layouts. Guard that one render entry; the public refresh on activation paints
 * its unchanged buffer. No installed dependency is modified. Review/remove this
 * workaround on upgrade; fail closed if the pinned upstream bytes change.
 * Upstream source: @xterm/xterm/src/browser/renderer/dom/DomRenderer.ts (MIT). */
export function guardHiddenXterm(source: string) {
  if (createHash('sha256').update(source).digest('hex') !== 'b336ec65a086c056d4804b3d4c2347da5663d3f23c3f25be866467bd8857ad59') {
    throw new Error('Review the hidden xterm render guard for this dependency version before building.');
  }
  const marker = 'renderRows(e,i){let r=this._bufferService.buffer,';
  if (source.split(marker).length !== 2) throw new Error('Expected one xterm DOM render entry.');
  return source.replace(marker, 'renderRows(e,i){if(!this._element.getClientRects().length)return;let r=this._bufferService.buffer,');
}
export const hiddenXtermGuard: Plugin = {
  name: 'xterm-hidden-render-guard',
  setup(build) {
    build.onLoad({ filter: /[/\\]@xterm[/\\]xterm[/\\]lib[/\\]xterm\.mjs$/ }, async args => ({ contents: guardHiddenXterm(await readFile(args.path, 'utf8')), loader: 'js' }));
  },
};
