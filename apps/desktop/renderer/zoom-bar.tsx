import type { CSSProperties } from 'react';
import { ZOOM_LEVELS, neighborhoodZoom } from '../../../src/graph/spatial.ts';
import { ItemIcon } from './icons.tsx';
import { shortcutKey } from './shortcuts.ts';

const at = (zoom: number) => `${100 * (zoom - ZOOM_LEVELS.min) / (ZOOM_LEVELS.max - ZOOM_LEVELS.min)}%`;
const percent = (zoom: number) => `${Math.round(zoom * 100)}%`;

/** A pixel slider with a live percentage that resets to 100% on click (− / + / 0
 * stay keyboard shortcuts), and a glyph under each tier threshold: dashboards or (with dashboards off) icons,
 * and close cards. */
export function ZoomBar({ zoom, dashboards, zoomTo }: {
  zoom: number; dashboards: { enabled: boolean; belowZoom: number };
  zoomTo(zoom: number): void;
}) {
  const tiers = [
    ...(dashboards.enabled ? [{ tier: 'board', zoom: dashboards.belowZoom, title: `${percent(dashboards.belowZoom)} · Dashboards below` }] : []),
    ...(dashboards.enabled ? [] : [{ tier: 'icon', zoom: ZOOM_LEVELS.neighborhood, title: `${percent(ZOOM_LEVELS.neighborhood)} · Icons below` }]),
    { tier: 'card', zoom: ZOOM_LEVELS.close, title: `${percent(ZOOM_LEVELS.close)} · Close cards above` },
  ];
  const neighborhood = neighborhoodZoom(dashboards);
  return <div className="zoom-markers">
    <div className="zoom-track">
      <input aria-label="Map zoom" aria-valuetext={percent(zoom)} type="range" min={ZOOM_LEVELS.min} max={ZOOM_LEVELS.max} step=".01" value={zoom} style={{ '--zoom-fill': at(zoom) } as CSSProperties} onChange={event => zoomTo(Number(event.target.value))} />
      {[neighborhood, ZOOM_LEVELS.close].map(mark => <i key={mark} data-zoom-threshold={mark} style={{ left: at(mark) }} />)}
      {dashboards.enabled && <i className="dashboard-threshold" data-dashboard-threshold={dashboards.belowZoom} role="img" aria-label={`Dashboards below ${percent(dashboards.belowZoom)}`} title={`Dashboards below ${percent(dashboards.belowZoom)}`} style={{ left: at(dashboards.belowZoom) }} />}
      {tiers.map(tier => <span key={tier.tier} className="zoom-tick-label" data-tier={tier.tier} title={tier.title} style={{ left: at(tier.zoom) }}><ItemIcon icon={`tier-${tier.tier}`} size={8} /></span>)}
    </div>
    <button type="button" className="zoom-readout" aria-label="Reset zoom to 100%" title={`Reset to 100% · ${shortcutKey('map.zoomReset')}`} onClick={() => zoomTo(1)}>{percent(zoom)}</button>
  </div>;
}
