import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Point } from '../../../src/graph/neighborhood.ts';
import { outlineDistance } from '../../../src/graph/neighborhood.ts';
import { DEFAULT_NEIGHBORHOOD_APPEARANCE, NEIGHBORHOOD_SHADES, neighborhoodFill } from '../../../src/graph/neighborhood-fill.ts';
import type { NeighborhoodAppearance } from '../../../src/graph/neighborhood-fill.ts';

/** Intent timings (MAP-25), kept under reduced motion: a pointer that only crosses a muted
 * project never opens it, the cover counts as parted `part` ms after it began to open, and
 * it stays open for `hold` ms after the pointer leaves. `drag` px of travel is not a click. */
export const MUTE_PEEK = { dwell: 180, part: 220, hold: 320, located: 4000, drag: 4 } as const;
export interface MutePeek { id: string; parted: boolean }
type Timer = ReturnType<typeof setTimeout>;

/** Which muted project's cover is drawn back. The pointer over the project, keyboard focus on
 * its plate and a Show on map request each ask for it; it closes once none does. */
export function useMutePeek(muted: ReadonlySet<string>) {
  const [peek, setPeek] = useState<MutePeek>();
  const state = useRef<{ pointer?: string; focus?: string; located?: string; shown?: string; pending?: string; dwell?: Timer; part?: Timer; hold?: Timer; release?: Timer }>({});
  const api = useMemo(() => {
    const s = state.current;
    const hide = () => { clearTimeout(s.part); clearTimeout(s.hold); s.hold = undefined; s.shown = undefined; setPeek(undefined); };
    const show = (id: string) => {
      clearTimeout(s.part); clearTimeout(s.hold); s.hold = undefined; s.shown = id; setPeek({ id, parted: false });
      s.part = setTimeout(() => setPeek(current => current?.id === id ? { id, parted: true } : current), MUTE_PEEK.part);
    };
    const reconcile = () => {
      const wanted = s.pointer ?? s.focus ?? s.located;
      if (wanted !== s.pending) { clearTimeout(s.dwell); s.pending = undefined; }
      if (wanted === s.shown) { clearTimeout(s.hold); s.hold = undefined; return; }
      if (wanted && !s.pending) { s.pending = wanted; s.dwell = setTimeout(() => { s.pending = undefined; show(wanted); }, MUTE_PEEK.dwell); }
      if (s.shown && !s.hold) s.hold = setTimeout(hide, MUTE_PEEK.hold);
    };
    return {
      /** Pointer over the cover with no button held; ignored behind a menu or an unfocused window. */
      enter(id: string, buttons: number) {
        if (s.pointer === id) return;
        if (buttons || !document.hasFocus() || document.querySelector('.canvas-menu,[role="menu"]')) return;
        s.pointer = id; reconcile();
      },
      leave(id: string) { if (s.pointer === id) { s.pointer = undefined; reconcile(); } },
      /** A press before the cover opened is a pan or a stray click, not a wish to look inside. */
      press(id: string) { if (s.shown !== id && s.pointer === id) { s.pointer = undefined; reconcile(); } },
      focus(id: string | undefined) { if (s.focus !== id) { s.focus = id; reconcile(); } },
      /** Show on map flew here: look for a moment without the pointer. */
      locate(id: string) {
        clearTimeout(s.release); s.located = id; reconcile();
        s.release = setTimeout(() => { if (s.located === id) { s.located = undefined; reconcile(); } }, MUTE_PEEK.located);
      },
      close() { clearTimeout(s.dwell); clearTimeout(s.release); s.pointer = s.focus = s.located = s.pending = undefined; hide(); },
    };
  }, []);
  useEffect(() => { if (state.current.shown && !muted.has(state.current.shown)) api.close(); }, [muted, api]);
  useEffect(() => {
    window.addEventListener('blur', api.close);
    return () => { window.removeEventListener('blur', api.close); const s = state.current; for (const timer of [s.dwell, s.part, s.hold, s.release]) clearTimeout(timer); };
  }, [api]);
  return { peek: peek && muted.has(peek.id) ? peek : undefined, ...api };
}

export interface MuteCoverShape { id: string; points: Point[]; boxes: readonly { x: number; y: number; width: number; height: number; paper: boolean }[] }
export interface MuteCoverHandlers {
  enter(id: string, event: React.PointerEvent): void; leave(id: string): void; down(id: string, event: React.PointerEvent): void;
  click(id: string, event: React.MouseEvent): void; menu(id: string, event: React.MouseEvent): void;
}

const STAR = 12, CORNER = 4;
function hash(text: string, seed: number) {
  let value = 2166136261 ^ seed;
  for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 16777619);
  value = Math.imul(value ^ value >>> 15, 2246822519); value = Math.imul(value ^ value >>> 13, 3266489917);
  return ((value ^ value >>> 16) >>> 0) / 4294967296;
}
/** A few fixed stars well inside the hull, the same ones every time for a project. */
function stars(id: string, points: readonly Point[], margin: number) {
  const left = Math.min(...points.map(point => point.x)), right = Math.max(...points.map(point => point.x)), top = Math.min(...points.map(point => point.y)), bottom = Math.max(...points.map(point => point.y));
  const wanted = Math.max(5, Math.min(22, Math.round((right - left) * (bottom - top) / 90_000))), paths = ['', ''];
  for (let index = 0, placed = 0; index < wanted * 4 && placed < wanted; index++) {
    const x = Math.round((left + hash(id, index * 2) * (right - left)) / STAR) * STAR, y = Math.round((top + hash(id, index * 2 + 1) * (bottom - top)) / STAR) * STAR;
    if ([[0, 0], [margin, 0], [-margin, 0], [0, margin], [0, -margin]].some(([dx, dy]) => outlineDistance({ x: x + dx, y: y + dy }, points) > 0)) continue;
    paths[hash(id, index + 977) > .6 ? 0 : 1] += `M${x},${y}h${STAR}v${STAR}h${-STAR}z`; placed++;
  }
  return paths;
}
const silhouette = (box: { x: number; y: number; width: number; height: number }) => {
  const x = Math.round(box.x - box.width / 2), y = Math.round(box.y - box.height / 2), w = Math.round(box.width), h = Math.round(box.height), c = Math.min(CORNER, w / 4, h / 4);
  return `M${x + c},${y}h${w - 2 * c}v${c}h${c}v${h - 2 * c}h${-c}v${c}h${-(w - 2 * c)}v${-c}h${-c}v${-(h - 2 * c)}h${c}z`;
};

/** One static layer for a muted project, clipped to its hull by construction: the veil
 * is the field's own pixel bands, the cards are flat silhouettes, and nothing moves.
 * Showing and hiding is an opacity change in CSS; no script runs per frame. */
const MuteCover = memo(function MuteCover({ shape, appearance = DEFAULT_NEIGHBORHOOD_APPEARANCE, state, attaching, leaving, handlers }: {
  shape: MuteCoverShape; appearance?: NeighborhoodAppearance; state: 'closed' | 'open' | 'parted'; attaching: boolean; leaving?: boolean; handlers: MuteCoverHandlers;
}) {
  const { id, points, boxes } = shape, boundary = `M ${points.map(point => `${point.x},${point.y}`).join(' L ')} Z`;
  const fill = useMemo(() => neighborhoodFill(points, appearance), [boundary, appearance.pixelSize, appearance.fade, appearance.scatter]);
  const sky = useMemo(() => stars(id, points, Math.max(appearance.fade, 48)), [id, boundary, appearance.fade]);
  const cards = useMemo(() => [boxes.filter(box => !box.paper).map(silhouette).join(''), boxes.filter(box => box.paper).map(silhouette).join('')], [boxes]);
  return <svg className="mute-cover" data-mute-cover={id} data-peek={state !== 'closed' || undefined} data-parted={state === 'parted' || undefined} data-attach={attaching || undefined} data-leaving={leaving || undefined} shapeRendering="crispEdges" aria-hidden="true">
    <g className="mute-veil">{fill.paths.map((path, shade) => path && <path key={shade} d={path} fillOpacity={NEIGHBORHOOD_SHADES[shade]} />)}</g>
    {cards[0] && <path className="mute-cards" d={cards[0]} />}
    {cards[1] && <path className="mute-notes" d={cards[1]} />}
    {sky[0] && <path className="mute-stars" d={sky[0]} />}
    {sky[1] && <path className="mute-stars" data-dim="" d={sky[1]} />}
    {!leaving && <path className="mute-hit" d={boundary} onPointerEnter={event => handlers.enter(id, event)} onPointerMove={event => handlers.enter(id, event)} onPointerLeave={() => handlers.leave(id)}
      onPointerDown={event => handlers.down(id, event)} onClick={event => handlers.click(id, event)} onContextMenu={event => handlers.menu(id, event)} />}
  </svg>;
});

const FADE_MS = 150;
/** Covers of every muted project on the map. A cover that was just removed fades out once. */
export const MuteCovers = memo(function MuteCovers({ shapes, appearance, peek, attaching, handlers }: {
  shapes: readonly MuteCoverShape[]; appearance?: NeighborhoodAppearance; peek?: MutePeek; attaching?: string; handlers: MuteCoverHandlers;
}) {
  const previous = useRef<readonly MuteCoverShape[]>(shapes), [leaving, setLeaving] = useState<MuteCoverShape[]>([]);
  useEffect(() => {
    const ids = new Set(shapes.map(shape => shape.id)), gone = previous.current.filter(shape => !ids.has(shape.id));
    previous.current = shapes;
    if (!gone.length || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    setLeaving(old => [...old.filter(shape => !ids.has(shape.id)), ...gone]);
    setTimeout(() => setLeaving(old => old.filter(shape => !gone.includes(shape))), FADE_MS);
  }, [shapes]);
  const current = new Set(shapes.map(shape => shape.id));
  return <div className="mute-covers">
    {shapes.map(shape => <MuteCover key={shape.id} shape={shape} appearance={appearance} state={peek?.id === shape.id ? peek.parted ? 'parted' : 'open' : 'closed'} attaching={attaching === shape.id} handlers={handlers} />)}
    {leaving.filter(shape => !current.has(shape.id)).map(shape => <MuteCover key={`leaving:${shape.id}`} shape={shape} appearance={appearance} state="closed" attaching={false} leaving handlers={handlers} />)}
  </div>;
});
