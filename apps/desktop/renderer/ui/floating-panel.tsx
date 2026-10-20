import { useLayoutEffect, useRef } from 'react';
import type { CSSProperties, FormEvent, HTMLAttributes, KeyboardEvent, ReactNode } from 'react';
import type { ScreenRect } from '../../../../src/graph/label-placement.ts';
import { placeClear } from './placement.ts';
import { useMovablePanel } from '../use-movable-panel.ts';
import { useOverlayFocus } from './overlay-focus.ts';
import { Button } from './button.tsx';
import { PixelGlyph } from './pixel-glyph.tsx';

/** The shared panel header: drag grip, 15px title, extras, pixel close. */
export function PanelHeader({ title, extras, close, closeLabel, handle }: { title: ReactNode; extras?: ReactNode; close(): void; closeLabel: string; handle: HTMLAttributes<HTMLDivElement> }) {
  return <div className="editor-heading floating-panel-header" {...handle}>
    <PixelGlyph name="grip" className="act-glyph floating-panel-grip" />
    <h2>{title}</h2>{extras}
    <Button variant="icon" className="floating-panel-close" aria-label={closeLabel} onClick={close}><PixelGlyph name="close" /></Button>
  </div>;
}

/** One movable panel: drag grip, 15px title, pixel close, and the shared focus model.
 * Modal panels trap focus and make the map inert; the others only take Escape.
 * With `clear`, the panel opens clear of those endpoints and chrome until the user drags it. */
export function FloatingPanel({ as = 'section', title, label, close, closeLabel, modal = false, returnTo, at, clear, surfaceKey, className, extras, role, style, onSubmit, onKeyDown, children, data }: {
  as?: 'section' | 'form'; title: ReactNode; label: string; close(): void; closeLabel: string; modal?: boolean; returnTo?(): HTMLElement | null;
  at: { x: number; y: number }; clear?: { endpoints: ScreenRect[]; chrome: ScreenRect[]; canvas: { width: number; height: number } }; surfaceKey?: unknown; className: string; extras?: ReactNode; role?: 'dialog'; style?: CSSProperties;
  onSubmit?(event: FormEvent<HTMLFormElement>): void; onKeyDown?(event: KeyboardEvent<HTMLElement>): void; children: ReactNode;
  data?: Record<`data-${string}`, string | boolean | undefined>;
}) {
  const { panel, position, dragging, handle, moveTo } = useMovablePanel(at, surfaceKey);
  const moved = useRef(false); if (dragging) moved.current = true;
  const placement = clear && clear.endpoints.length ? JSON.stringify(clear) : '';
  useLayoutEffect(() => {
    if (!clear || !placement || moved.current || !panel.current) return;
    moveTo(placeClear({ width: panel.current.offsetWidth, height: panel.current.offsetHeight }, clear.endpoints, clear.chrome, clear.canvas));
  }, [placement]);
  const keys = useOverlayFocus(panel, { close, modal, returnTo });
  const Root = as as 'form';
  return <Root ref={panel} className={`inline-editor floating-panel ${className}`} role={role} aria-label={label} aria-modal={modal && role === 'dialog' ? true : undefined}
    data-dragging={dragging} {...data} style={{ ...style, left: Math.round(position.x), top: Math.round(position.y) }} onSubmit={onSubmit}
    onKeyDown={event => { onKeyDown?.(event); keys(event); }}>
    <PanelHeader title={title} extras={extras} close={close} closeLabel={closeLabel} handle={handle} />
    {children}
  </Root>;
}
