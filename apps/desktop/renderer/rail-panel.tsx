import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, FormEventHandler, KeyboardEventHandler, FocusEventHandler, PointerEventHandler, ReactNode, Ref, PointerEvent as ReactPointerEvent } from 'react';
import { RAIL, railSlot } from './tool-rail.tsx';
import type { RailSlot } from './tool-rail.tsx';
import { RailDwell, useRailTool } from './rail-state.ts';
import { PixelGlyph } from './ui/pixel-glyph.tsx';
import { Button } from './ui/button.tsx';

export interface PanelSize { width?: number; height?: number }
/** Every sheet opens at the same place: right of the rail, level with its top edge. */
export const SHEET_ORIGIN = { x: RAIL.left + RAIL.padding * 2 + RAIL.slot + 8, y: RAIL.top } as const;
const EDITABLE = 'input:not([type=checkbox]), textarea, select, [contenteditable=true]';
export const PANEL_LIMITS = { minWidth: 260, maxWidth: 900, minHeight: 160, maxHeight: 1000 } as const;

/** A rail tool: its icon sits in a hotbar slot and its sheet opens beside the rail.
 * The owner decides when it is open or pinned; the panel draws it, keeps the sheet
 * inside the window and lets the user resize it. Every sheet closes the same way: the
 * X at its top right, or a right click on the sheet that no field or row of its own takes. */
export function RailPanel({ slot, label, resizeLabel = `Resize ${label.toLowerCase()}`, className, element = 'div', open, keepMounted = false, close, closeLabel, toggle, heading, children, aside, asideWidth = 0,
  size, defaultWidth, onSize, onResizing, rootRef, sheetRef, sheetClassName, sheetData, role, onPointerEnter, onPointerLeave, onSubmit, onKeyDownCapture, onPointerDownCapture, onBlurCapture, data }: {
  slot: RailSlot; label: string; resizeLabel?: string; className: string; element?: 'div' | 'form'; open: boolean; keepMounted?: boolean; close(): void; closeLabel: string;
  toggle: { label: string; title: string; pressed: boolean; expanded?: boolean; shortcut?: string; className?: string; onClick(): void; onDwell?(): void; icon: ReactNode; badge?: ReactNode };
  heading: ReactNode; children: ReactNode; aside?: ReactNode; asideWidth?: number;
  size: PanelSize; defaultWidth: number; onSize(size: PanelSize): void; onResizing?(active: boolean): void;
  rootRef?: Ref<HTMLElement>; sheetRef?: Ref<HTMLDivElement>; sheetClassName?: string; sheetData?: Record<`data-${string}`, string | boolean | undefined>; role?: 'dialog';
  onPointerEnter?: PointerEventHandler; onPointerLeave?: PointerEventHandler; onSubmit?: FormEventHandler; onKeyDownCapture?: KeyboardEventHandler;
  onPointerDownCapture?: PointerEventHandler; onBlurCapture?: FocusEventHandler; data?: Record<`data-${string}`, string | boolean | undefined>;
}) {
  const position = railSlot(slot), sheet = useRef<HTMLDivElement>(null), [resizing, setResizing] = useState(false), { rail, held } = useRailTool(slot);
  const drag = useRef<{ id: number; x: number; y: number; width: number; height: number; before: PanelSize }>(undefined);
  const dwellAction = useRef(toggle.onDwell); dwellAction.current = toggle.onDwell;
  const [dwell] = useState(() => new RailDwell(() => dwellAction.current?.()));
  useEffect(() => () => dwell.dispose(), [dwell]);
  const mouse = (event: ReactPointerEvent) => event.pointerType === 'mouse' && Boolean(dwellAction.current);
  const setSheet = (element: HTMLDivElement | null) => { sheet.current = element; if (typeof sheetRef === 'function') sheetRef(element); else if (sheetRef) (sheetRef as { current: HTMLDivElement | null }).current = element; };
  const resizingChange = (active: boolean) => { setResizing(active); onResizing?.(active); };
  const fit = (width: number, height: number) => {
    const box = sheet.current!.getBoundingClientRect();
    const maxWidth = Math.max(PANEL_LIMITS.minWidth, Math.min(PANEL_LIMITS.maxWidth, window.innerWidth - box.left - 12 - (aside ? asideWidth : 0)));
    const maxHeight = Math.max(PANEL_LIMITS.minHeight, Math.min(PANEL_LIMITS.maxHeight, window.innerHeight - box.top - 12));
    return { width: Math.round(Math.max(PANEL_LIMITS.minWidth, Math.min(maxWidth, width))), height: Math.round(Math.max(PANEL_LIMITS.minHeight, Math.min(maxHeight, height))) };
  };
  const end = (event: ReactPointerEvent<HTMLButtonElement>, cancel = false) => {
    const start = drag.current; if (!start || start.id !== event.pointerId) return;
    if (cancel) onSize(start.before);
    drag.current = undefined; resizingChange(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const Root = element;
  const style = { left: position.x, top: position.y, '--sheet-x': `${SHEET_ORIGIN.x - position.x}px`, '--sheet-y': `${SHEET_ORIGIN.y - position.y}px`,
    '--panel-width': `${size.width ?? defaultWidth}px`, '--panel-aside': `${aside ? asideWidth : 0}px`, ...(size.height ? { '--panel-height': `${size.height}px` } : {}) } as CSSProperties;
  return <Root ref={rootRef as Ref<never>} className={`rail-panel ${className}`} aria-label={element === 'form' ? label : undefined} data-open={open} data-held={held || undefined} data-sized={Boolean(size.height)} data-resizing={resizing} {...data} style={style}
    onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave} onSubmit={onSubmit} onPointerDownCapture={onPointerDownCapture} onBlurCapture={onBlurCapture}
    onKeyDownCapture={event => {
      if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); onSize(drag.current.before); drag.current = undefined; resizingChange(false); return; }
      onKeyDownCapture?.(event);
    }}>
    <button type="button" className={`rail-panel-toggle ${toggle.className ?? ''}`} aria-label={toggle.label} title={held ? `${toggle.title} · Held open · Right-click to release` : `${toggle.title} · Right-click to hold open`}
      aria-pressed={toggle.pressed} aria-expanded={toggle.expanded ?? open} aria-keyshortcuts={toggle.shortcut} aria-description={held ? 'Held open' : undefined}
      onClick={() => { dwell.click(); toggle.onClick(); }} onPointerEnter={event => { if (mouse(event)) dwell.enter(event.clientX, event.clientY); }}
      onPointerMove={event => { if (mouse(event)) dwell.move(event.clientX, event.clientY); }} onPointerLeave={() => dwell.leave()}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); dwell.click(); rail.hold(slot); }}>
      {toggle.icon}{toggle.badge}{held && <span className="rail-held" aria-hidden="true"><PixelGlyph name="lock" /></span>}
    </button>
    {(open || keepMounted) && <div ref={setSheet} className={sheetClassName ? `rail-panel-sheet ${sheetClassName}` : 'rail-panel-sheet'} {...sheetData} role={role} aria-label={role ? label : undefined} inert={!open}
      onContextMenu={event => {
        if (event.defaultPrevented || !(event.target instanceof Element) || !event.currentTarget.contains(event.target) || event.target.closest(EDITABLE)) return;
        event.preventDefault(); close();
      }}>
      <div className="rail-panel-main">
        <header className="rail-panel-header"><div className="rail-panel-heading">{heading}</div><Button variant="icon" className="rail-panel-close" aria-label={closeLabel} title="Close" onClick={close}><PixelGlyph name="close" /></Button></header>
        <div className="rail-panel-body">{children}</div>
      </div>
      {aside}
      {open && <button type="button" className="rail-panel-resize" aria-label={resizeLabel} title="Drag to resize · Arrow keys adjust · Home resets" onPointerDown={event => {
        if (event.button !== 0) return; event.preventDefault(); event.stopPropagation();
        const box = sheet.current!.getBoundingClientRect();
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, width: box.width - (aside ? asideWidth : 0), height: box.height, before: size };
        event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.focus(); resizingChange(true);
      }} onPointerMove={event => {
        const start = drag.current; if (!start || event.pointerId !== start.id) return;
        event.stopPropagation(); onSize(fit(start.width + event.clientX - start.x, start.height + event.clientY - start.y));
      }} onPointerUp={event => end(event)} onPointerCancel={event => end(event, true)} onLostPointerCapture={event => end(event, true)} onKeyDown={event => {
        if (event.key === 'Home') { event.preventDefault(); onSize({}); return; }
        if (!event.key.startsWith('Arrow')) return; event.preventDefault(); event.stopPropagation();
        const box = sheet.current!.getBoundingClientRect(), step = event.shiftKey ? 40 : 10;
        onSize(fit((size.width ?? box.width - (aside ? asideWidth : 0)) + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0), box.height + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0)));
      }}><svg viewBox="0 0 12 12" aria-hidden="true"><path fill="currentColor" d="M9 1h2v2H9zM6 4h2v2H6zM9 4h2v2H9zM3 7h2v2H3zM6 7h2v2H6zM9 7h2v2H9z" /></svg></button>}
    </div>}
  </Root>;
}
