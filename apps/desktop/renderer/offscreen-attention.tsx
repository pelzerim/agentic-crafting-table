import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AttentionTier } from '../../../src/graph/attention.ts';
import { offscreenBoxes, offscreenMarks } from '../../../src/graph/offscreen-attention.ts';
import type { MapCamera, OffscreenBox, OffscreenMark } from '../../../src/graph/offscreen-attention.ts';

export interface WaitingBox extends OffscreenBox { title: string; tier: AttentionTier; label: string }

/** Chrome the marks go around. The tool rail is not here: it moves the left edge itself. */
const CHROME = '.zoom-markers,.map-locator,.project-column-panel,.rail-panel[data-open=true]>.rail-panel-sheet,.workspace-notices>*';
/** Panels open without the camera moving, so while a mark shows it looks again this often. */
const RECHECK_MS = 250;

/** MAP-31: solid circles on the edge of the view, one per direction in which waiting items lie outside it. */
export function OffscreenAttention({ boxes, camera, screen, go }: {
  boxes: readonly WaitingBox[]; camera: MapCamera; screen: { width: number; height: number }; go(box: WaitingBox): void;
}) {
  const [marks, setMarks] = useState<OffscreenMark<WaitingBox>[]>([]), layer = useRef<HTMLDivElement>(null), place = useRef(() => {});
  const offscreen = offscreenBoxes(boxes, camera, screen), key = (list: typeof marks) => JSON.stringify(list.map(mark => [mark.spot, mark.tier, mark.boxes.map(box => box.id)]));
  // Chrome is measured after layout, and the marks change before the frame paints.
  place.current = () => {
    const canvas = layer.current?.parentElement?.getBoundingClientRect();
    if (!canvas) return;
    const rail = document.querySelector('.tool-rail')?.getBoundingClientRect(), left = Math.max(0, rail ? rail.right - canvas.x : 0);
    const chrome = offscreen.length ? [...document.querySelectorAll(CHROME)].map(node => node.getBoundingClientRect()).filter(rect => rect.width > 0).map(rect => ({ x: rect.x - canvas.x, y: rect.y - canvas.y, width: rect.width, height: rect.height })) : [];
    const next = offscreenMarks(offscreen, camera, { x: left, y: 0, width: screen.width - left, height: screen.height }, chrome);
    setMarks(old => key(old) === key(next) ? old : next);
  };
  useLayoutEffect(() => place.current());
  const shown = offscreen.length > 0;
  useEffect(() => { if (!shown) return; const timer = setInterval(() => place.current(), RECHECK_MS); return () => clearInterval(timer); }, [shown]);
  return <div ref={layer} className="offscreen-attention-layer">{marks.map(({ spot, boxes, tier }) => {
    const nearest = boxes[0], more = boxes.length > 1;
    return <button key={nearest.id} type="button" className="offscreen-attention" data-tier={tier} data-offscreen-target={nearest.id} style={{ left: spot.x, top: spot.y }} onClick={() => go(nearest)}
      aria-label={more ? `Show the nearest of ${boxes.length} waiting items on map: ${nearest.title}` : `Show ${nearest.title} on map`}
      title={more ? `${boxes.length} waiting this way · nearest: ${nearest.title}` : `${nearest.title} · ${nearest.label}`}>{more ? boxes.length > 9 ? '9+' : boxes.length : null}</button>;
  })}</div>;
}
