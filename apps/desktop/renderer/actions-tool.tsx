import { useEffect, useRef, useState } from 'react';
import type { MenuAction } from '../../../packages/core/context-menu.ts';
import { CanvasMenu } from './canvas-menu.tsx';
import { ItemIcon } from './icons.tsx';
import { RAIL, railSlot } from './tool-rail.tsx';
import { shortcutKey, useWorkspaceShortcuts } from './shortcuts.ts';

const ACTIONS: MenuAction[] = [{ id: 'standup-report', label: 'Standup report…' }];

/** The rail's Actions slot: a menu of one-off actions on the whole table, drawn with the item menu. */
export function ActionsTool({ open, setOpen, standup }: { open: boolean; setOpen(open: boolean): void; standup(): void }) {
  const slot = railSlot('actions'), root = useRef<HTMLDivElement>(null);
  const [menuKey, setMenuKey] = useState(0);
  useWorkspaceShortcuts({ 'rail.actions': () => { setMenuKey(key => key + 1); setOpen(!open); } });
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { const target = event.target as Element | null; if (!target?.closest('.canvas-context') && !root.current?.contains(target)) setOpen(false); };
    window.addEventListener('pointerdown', outside, true);
    return () => window.removeEventListener('pointerdown', outside, true);
  }, [open]);
  return <>
    <div ref={root} className="rail-panel rail-actions" style={{ left: slot.x, top: slot.y }}>
      <button type="button" className="rail-panel-toggle" aria-label="Table actions" title="Actions" aria-haspopup="menu" aria-expanded={open} aria-keyshortcuts={shortcutKey('rail.actions')}
        onClick={() => { setMenuKey(key => key + 1); setOpen(!open); }}><ItemIcon icon="sparkles" /></button>
    </div>
    {open && <CanvasMenu key={menuKey} label="Table actions" screen={{ x: slot.x + RAIL.slot + 12, y: slot.y }} actions={ACTIONS}
      act={action => { setOpen(false); if (action.id === 'standup-report') standup(); }}
      close={() => { setOpen(false); root.current?.querySelector('button')?.focus(); }} />}
  </>;
}
