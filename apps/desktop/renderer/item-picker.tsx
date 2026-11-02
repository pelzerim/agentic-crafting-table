import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { groundRingChoices, itemChoiceLayers } from '../../../packages/core/item-picker.ts';
import type { ItemChoice } from '../../../packages/core/item-picker.ts';
import type { MenuAction, MenuActionId } from '../../../packages/core/context-menu.ts';
import { usePickerMotion } from './picker-motion.ts';
import { ItemIcon } from './icons.tsx';

export const PICKER_SIZE = { width: 392, height: 336 };
/** A ring with menu entries holds up to ten choices; the wider oval keeps them from touching at the top and bottom. */
export const WIDE_PICKER_SIZE = { width: 456, height: 336 };
const RING_RADIUS = 136, WIDE_RING_RADIUS = 168;
const PAGE_SIZE = 8;

/** A bounded ring stays reachable even with many third-party item types. */
export function ItemPicker({ choices, quickIds, panel, select, close, ground, act }: {
  choices: ItemChoice[]; quickIds: string[]; panel: RefObject<HTMLFormElement | null>; select(id: string): void; close(): void;
  /** The ground's menu entries, joined to the quick ring after All (MAP-31). */
  ground?: readonly MenuAction[]; act?(id: MenuActionId): void;
}) {
  const [all, setAll] = useState(false), [page, setPage] = useState(0);
  const [previewId, setPreviewId] = useState<string>();
  const keyboardIntent = useRef(false);
  const { quick, remaining } = itemChoiceLayers(choices, quickIds);
  const pages = Math.max(1, Math.ceil(remaining.length / PAGE_SIZE));
  const pageIndex = Math.min(page, pages - 1);
  const hasMore = remaining.some(choice => choice.id !== 'project');
  const visible: ItemChoice[] = all ? remaining.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE) : [...quick, ...(hasMore ? [{ id: '__all', name: 'All', icon: 'grid' }] : []), ...groundRingChoices(ground ?? [], quick)];
  const size = ground ? WIDE_PICKER_SIZE : PICKER_SIZE, radius = ground ? WIDE_RING_RADIUS : RING_RADIUS;
  const preview = visible.find(choice => choice.id === previewId && choice.id !== '__all');
  const seed = useRef<HTMLDivElement>(null), ring = useRef<HTMLDivElement>(null);
  usePickerMotion(seed, ring, JSON.stringify([all, pageIndex, visible.map(choice => choice.id)]));
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const latest = useRef({ all, close, choices, select }); latest.current = { all, close, choices, select };
  const back = () => { if (latest.current.all) { setAll(false); setPage(0); } else latest.current.close(); };
  useEffect(() => {
    const dismiss = (event: MouseEvent) => { event.preventDefault(); event.stopImmediatePropagation(); back(); };
    const keyboard = (event: KeyboardEvent) => {
      keyboardIntent.current = true;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); back(); return; }
      const hotkey = !event.metaKey && !event.ctrlKey && !event.altKey && !event.repeat && latest.current.choices.find(choice => choice.hotkey && choice.hotkey === event.key.toLowerCase());
      if (hotkey) { event.preventDefault(); event.stopImmediatePropagation(); latest.current.select(hotkey.id); }
    };
    const outside = (event: PointerEvent) => { if (event.button === 0 && !panel.current?.contains(event.target as Node)) latest.current.close(); };
    const pointer = (event: PointerEvent) => {
      keyboardIntent.current = false;
      setPreviewId((event.target as Element).closest<HTMLElement>('.picker-choice')?.dataset.choiceId);
    };
    window.addEventListener('contextmenu', dismiss, true); window.addEventListener('keydown', keyboard, true); window.addEventListener('pointerdown', outside, true); window.addEventListener('pointermove', pointer, true);
    return () => { window.removeEventListener('contextmenu', dismiss, true); window.removeEventListener('keydown', keyboard, true); window.removeEventListener('pointerdown', outside, true); window.removeEventListener('pointermove', pointer, true); };
  }, [panel]);
  // Initial focus makes the ring usable without making an implicit selection.
  useEffect(() => { keyboardIntent.current = false; setPreviewId(undefined); buttons.current[0]?.focus(); }, [all, pageIndex]);
  return <>
    <div ref={seed} className={`picker-center tone-${preview?.tone ?? 'neutral'}`} data-preview={Boolean(preview)} data-preview-choice={preview?.id ?? ''} data-size={preview?.size ?? 'medium'} aria-hidden="true">
      {preview && <div className="picker-preview-content" key={preview.id}><ItemIcon icon={preview.icon} brand={preview.brand} tint={preview.tint} /><span>{preview.shortLabel ?? preview.name}</span></div>}
    </div>
    {all && remaining.length === 0 && <p className="picker-empty" role="status">No other item types.</p>}
    {all && pages > 1 && <div className="picker-pages"><button type="button" aria-label="Previous item types" disabled={pageIndex === 0} onClick={() => setPage(pageIndex - 1)}>‹</button><small>{pageIndex + 1} / {pages}</small><button type="button" aria-label="Next item types" disabled={pageIndex === pages - 1} onClick={() => setPage(pageIndex + 1)}>›</button></div>}
    <div ref={ring} className="picker-ring" role="group" aria-label={all ? 'All other item types' : 'Quick item types'}>{visible.map((choice, index) => {
      const angle = -Math.PI / 2 + index * Math.PI * 2 / visible.length;
      return <button key={choice.id} data-choice-id={choice.id} ref={element => { buttons.current[index] = element; }} type="button" aria-label={choice.name} aria-keyshortcuts={choice.hotkey?.toUpperCase()} title={choice.hotkey ? `${choice.name} (${choice.hotkey.toUpperCase()})` : choice.name} className={`picker-choice tone-${choice.tone ?? 'neutral'}`}
        style={{ left: size.width / 2 + Math.cos(angle) * radius, top: size.height / 2 + Math.sin(angle) * RING_RADIUS }}
        onPointerEnter={() => { keyboardIntent.current = false; setPreviewId(choice.id); }} onPointerLeave={() => setPreviewId(undefined)}
        onFocus={() => { if (keyboardIntent.current) setPreviewId(choice.id); }} onBlur={() => setPreviewId(undefined)}
        onClick={() => choice.id === '__all' ? setAll(true) : choice.menuAction ? act?.(choice.id as MenuActionId) : select(choice.id)} onKeyDown={event => {
          const offset = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0;
          if (offset || event.key === 'Home' || event.key === 'End') { event.preventDefault(); event.stopPropagation(); buttons.current[event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : (index + offset + visible.length) % visible.length]?.focus(); }
        }}><ItemIcon icon={choice.icon} brand={choice.brand} tint={choice.tint} /><span>{choice.shortLabel ?? choice.name}</span></button>;
    })}</div>
  </>;
}
