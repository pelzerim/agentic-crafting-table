import type { CSSProperties } from 'react';
import { plotSwatch } from '../../../src/graph/plot-palette.ts';
import type { PlotColor } from '../../../src/graph/plots.ts';

/** The plot color tokens of a slot in one neighborhood, for a plot's patch, sign and dashboard elements. */
export function plotStyle(neighborhoodColor: string | undefined, slot: PlotColor | undefined): CSSProperties | undefined {
  if (!slot) return undefined;
  const { color, tone } = plotSwatch(neighborhoodColor, slot);
  return { '--act-plot-hue': color, '--act-plot-tone': tone } as CSSProperties;
}
