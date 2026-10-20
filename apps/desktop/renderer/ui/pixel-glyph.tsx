import { PIXEL_GLYPHS, glyphPath } from '../../../../src/resource-plugins/pixel-glyphs.ts';
import type { GlyphName, GlyphSize } from '../../../../src/resource-plugins/pixel-glyphs.ts';

export type { GlyphName, GlyphSize };
const VIEW_BOX: Record<GlyphSize, string> = { 8: '-.5 -.5 9 9', 12: '0 0 12 12' };
const paths = new Map<readonly string[], string>();
const pathOf = (rows: readonly string[]) => paths.get(rows) ?? paths.set(rows, glyphPath(rows)).get(rows)!;

/** Crisp pixel glyph in `currentColor` from the shared set; decorative unless the caller labels its control. */
export function PixelGlyph<Size extends GlyphSize = 8>({ name, size = 8 as Size, className = 'act-glyph' }: { name: GlyphName<Size>; size?: Size; className?: string }) {
  const rows: readonly string[] = (PIXEL_GLYPHS[size] as Record<string, readonly string[]>)[name as string];
  return <svg className={className || undefined} data-glyph={name} aria-hidden="true" viewBox={VIEW_BOX[size]} shapeRendering="crispEdges"><path fill="currentColor" d={pathOf(rows)} /></svg>;
}
