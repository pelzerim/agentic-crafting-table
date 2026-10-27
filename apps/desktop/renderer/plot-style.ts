import type { CSSProperties } from 'react';
import { plotPaint } from '../../../src/graph/plot-palette.ts';
import type { PlotColor } from '../../../src/graph/plots.ts';

/** The plot color tokens of a slot in one neighborhood, or of a custom color, for a plot's patch, sign and dashboard elements. */
export function plotStyle(neighborhoodColor: string | undefined, plotColor: PlotColor | string | undefined): CSSProperties | undefined {
  if (!plotColor) return undefined;
  const { color, tone } = plotPaint(neighborhoodColor, plotColor);
  return { '--act-plot-hue': color, '--act-plot-tone': tone } as CSSProperties;
}
