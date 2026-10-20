import { memo, useLayoutEffect, useMemo, useRef } from 'react';
import type { Point } from '../../../src/graph/neighborhood.ts';
import { DEFAULT_NEIGHBORHOOD_APPEARANCE, NEIGHBORHOOD_SHADES, neighborhoodCells, neighborhoodPaths } from '../../../src/graph/neighborhood-fill.ts';
import type { NeighborhoodAppearance, NeighborhoodCells } from '../../../src/graph/neighborhood-fill.ts';
import { biomeGrowth, paintGround, withGrowth } from '../../../src/graph/biomes.ts';
import type { Biome, BiomeBitmap, BiomeRect } from '../../../src/graph/biomes.ts';
import { performanceMetrics } from './performance.ts';
import { DEFAULT_PROJECT_COLOR } from '../../../src/graph/project-colors.ts';

type Geometry = ReturnType<typeof neighborhoodPaths> & { grid: NeighborhoodCells };
const sampled = new WeakMap<readonly Point[], { key: string; geometry: Geometry }>();
/** One sampling per enclosure and appearance, shared by a field and its biome ground. */
function fieldGeometry(points: readonly Point[], appearance: NeighborhoodAppearance): Geometry {
  const key = `${appearance.pixelSize}|${appearance.fade}|${appearance.scatter}`, known = sampled.get(points);
  if (known?.key === key) return known.geometry;
  const started = performance.now(), grid = neighborhoodCells(points, appearance), geometry = { ...neighborhoodPaths(grid), grid };
  performanceMetrics.record('map.geometry', performance.now() - started);
  sampled.set(points, { key, geometry }); return geometry;
}
const outline = (points: readonly Point[]) => `M ${points.map(p => `${p.x},${p.y}`).join(' L ')} Z`;
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** `biome` names the ground drawn for this field by `BiomeGround`; the field then paints nothing itself. */
export const NeighborhoodField = memo(function NeighborhoodField({ id, points, appearance = DEFAULT_NEIGHBORHOOD_APPEARANCE, attaching, dragging, color = DEFAULT_PROJECT_COLOR, biome }: {
  id: string; points: Point[]; appearance?: NeighborhoodAppearance; attaching: boolean; dragging: boolean; color?: string; biome?: string;
}) {
  const boundary = outline(points);
  const fill = useMemo(() => fieldGeometry(points, appearance), [boundary, appearance.pixelSize, appearance.fade, appearance.scatter]);
  const paint = useRef<SVGGElement>(null), history = useRef<SVGGElement>(null), previous = useRef<SVGGElement | undefined>(undefined);
  const previousFill = useRef<typeof fill | undefined>(undefined);
  useLayoutEffect(() => {
    if (previousFill.current === fill) return;
    previousFill.current = fill;
    const current = paint.current!, older = history.current!, last = previous.current;
    previous.current = current.cloneNode(true) as SVGGElement;
    if (!last || dragging || still()) return;
    older.append(last);
    const outgoing = last.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-out', fill: 'forwards' });
    const incoming = current.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
    outgoing.onfinish = () => last.remove();
    return () => { outgoing.cancel(); incoming.cancel(); last.remove(); };
  }, [fill, dragging]);
  return <g className="neighborhood-field" data-project-field={id} data-attach-preview={attaching} data-pixel-size={appearance.pixelSize} data-cell-size={fill.cellSize} data-fade={appearance.fade} data-scatter={appearance.scatter} data-biome={biome}>
    <path className="neighborhood-hit-area" data-project-outline={id} data-attach-preview={attaching} d={boundary} aria-hidden="true" />
    <g ref={history} aria-hidden="true" />
    {biome ? <g ref={paint} className="neighborhood-paint" />
      : <g ref={paint} className="neighborhood-paint" data-color={color} style={{ fill: attaching ? `color-mix(in srgb, ${color} 55%, #ffffff)` : color }}>{fill.paths.map((path, i) => <path key={i} data-shade={i} d={path} fillOpacity={NEIGHBORHOOD_SHADES[i]} />)}</g>}
  </g>;
});

/** A biome's ground and growth for one field, baked into a canvas of one pixel per detail unit and
 * scaled by CSS. It is repainted when the enclosure, the appearance or the growth changes, never
 * for the camera. `flat` draws the one flat colour instead, for zooms where detail is too small. */
export const BiomeGround = memo(function BiomeGround({ id, points, appearance, biome, items, flat, attaching, dragging }: {
  id: string; points: Point[]; appearance: NeighborhoodAppearance; biome: Biome; items: readonly BiomeRect[]; flat: boolean; attaching: boolean; dragging: boolean;
}) {
  const boundary = outline(points), { texture } = appearance;
  const geometry = useMemo(() => fieldGeometry(points, appearance), [boundary, appearance.pixelSize, appearance.fade, appearance.scatter]);
  const ground = useMemo(() => {
    const started = performance.now(), bitmap = paintGround(biome, geometry.grid, texture);
    performanceMetrics.record('map.biome', performance.now() - started); return bitmap;
  }, [geometry, biome, texture]);
  const growth = useMemo(() => biomeGrowth(biome, geometry.grid, texture, items), [geometry, biome, texture, items]);
  const grown = growth.map(sprite => `${sprite.column},${sprite.row}`).join(' ');
  const canvas = useRef<HTMLCanvasElement>(null), painted = useRef<BiomeBitmap | undefined>(undefined);
  useLayoutEffect(() => {
    const started = performance.now(), element = canvas.current!, { cellSize, x0, y0, columns, rows } = geometry.grid, replaced = painted.current !== undefined && painted.current !== ground;
    const ghost = replaced && !dragging && !still() && element.width > 0 && element.height > 0 ? element.cloneNode() as HTMLCanvasElement : undefined;
    ghost?.getContext('2d')!.drawImage(element, 0, 0);
    painted.current = ground;
    if (element.width !== ground.width) element.width = ground.width;
    if (element.height !== ground.height) element.height = ground.height;
    Object.assign(element.style, { left: `${x0 * cellSize}px`, top: `${y0 * cellSize}px`, width: `${columns * cellSize}px`, height: `${rows * cellSize}px` });
    const picture = growth.length ? withGrowth(ground, biome, geometry.grid, growth) : ground;
    if (picture.width > 0 && picture.height > 0) element.getContext('2d')!.putImageData(new ImageData(picture.data, picture.width, picture.height), 0, 0);
    performanceMetrics.record('map.biome', performance.now() - started);
    if (!ghost) return;
    ghost.removeAttribute('data-biome-ground'); element.before(ghost);
    const outgoing = ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-out', fill: 'forwards' });
    const incoming = element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
    outgoing.onfinish = () => ghost.remove();
    return () => { outgoing.cancel(); incoming.cancel(); ghost.remove(); };
  }, [ground, grown]);
  return <div className="biome-field" data-biome-field={id} data-biome={biome.id} data-texture={texture} data-growth={growth.length}>
    <canvas ref={canvas} data-biome-ground={id} />
    {(flat || attaching) && <svg shapeRendering="crispEdges" data-biome-flat={flat || undefined} data-attach-preview={attaching || undefined} style={{ fill: !flat ? '#ffffff' : attaching ? `color-mix(in srgb, ${biome.flat} 55%, #ffffff)` : biome.flat }}>
      {geometry.paths.map((path, i) => <path key={i} d={path} fillOpacity={NEIGHBORHOOD_SHADES[i] * (flat ? 1 : .45)} />)}</svg>}
  </div>;
});
