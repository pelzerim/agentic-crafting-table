import { Fragment, memo } from 'react';
import type { MirrorArea } from '../../../src/graph/undermap.ts';

const number = (count: number) => count.toLocaleString('en-US');

/** The divider lines of the Undermap's mirror layout (MAP-18): one per month and area, part of the layer.
 * A closed month's line opens or closes it; a month cut by the area's budget ends in a "+N more" row. */
export const UndermapMonths = memo(function UndermapMonths({ areas, toggle }: { areas: readonly MirrorArea[]; toggle(areaId: string, month: string): void }) {
  return <div className="undermap-months">{areas.map(area => area.months.map(month => {
    const id = `${area.id}:${month.key}`;
    const text = <><span className="undermap-month-label">{month.label} · {number(month.count)}</span><span className="undermap-month-range">{month.range}</span></>;
    return <Fragment key={id}>
      <div className="undermap-month" data-undermap-month={id} data-open={month.open} data-count={month.count} data-world-y={month.y} style={{ left: area.left, top: month.y, width: area.width }}>
        {month.toggle === 'line'
          ? <button type="button" className="nodrag nopan" aria-expanded={month.open} aria-label={`${month.label}, ${number(month.count)} ${month.count === 1 ? 'item' : 'items'}, ${area.title}`} title={month.open ? 'Close this month' : 'Show this month’s items'}
            onClick={event => { event.stopPropagation(); toggle(area.id, month.key); }} onDoubleClick={event => event.stopPropagation()}>{text}<span className="undermap-month-disclosure" aria-hidden="true">{month.open ? '▾' : '▸'}</span></button>
          : text}
      </div>
      {month.toggle === 'more' && <button type="button" className="undermap-more nodrag nopan" data-undermap-more={area.id} aria-expanded={month.expanded} style={{ left: area.left, top: month.moreY }}
        onClick={event => { event.stopPropagation(); toggle(area.id, month.key); }} onDoubleClick={event => event.stopPropagation()}>
        {month.expanded ? `Show the newest ${number(month.fit)} ▾` : `+${number(month.more)} more ▸`}</button>}
    </Fragment>;
  }))}</div>;
});

const PLATE_MONTHS = 6;
/** Below the dashboard zoom an area is one plate: the project, how much lies below, and its newest months. */
export const UndermapPlates = memo(function UndermapPlates({ areas, zoom, color, open, menu }: { areas: readonly MirrorArea[]; zoom: number; color(areaId: string): string; open(areaId: string): void; menu(event: React.MouseEvent, areaId: string): void }) {
  return <div className="undermap-plates">{areas.map(area => {
    const rest = area.months.slice(PLATE_MONTHS);
    return <div key={area.id} className="undermap-plate nopan" data-undermap-plate={area.id} onContextMenu={event => menu(event, area.id)}
      style={{ left: area.x, top: area.top, transform: `translateX(-50%) scale(${1 / zoom})`, '--project-color': color(area.id) } as React.CSSProperties}>
      <button type="button" className="undermap-plate-title nodrag" title={`Zoom to ${area.title}`} onClick={event => { event.stopPropagation(); open(area.id); }}>
        <i aria-hidden="true" /><strong>{area.title} · {number(area.count)} below</strong></button>
      {area.months.length > 0 && <ul>{area.months.slice(0, PLATE_MONTHS).map(month => <li key={month.key}><span>{month.label}</span><b>{number(month.count)}</b></li>)}</ul>}
      {rest.length > 0 && <p>+{rest.length} earlier {rest.length === 1 ? 'month' : 'months'} · {number(rest.reduce((sum, month) => sum + month.count, 0))}</p>}
    </div>;
  })}</div>;
});
