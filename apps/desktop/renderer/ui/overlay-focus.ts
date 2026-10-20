import { useLayoutEffect, useRef } from 'react';
import type { KeyboardEvent, RefObject } from 'react';

const FOCUSABLE = 'button:not(:disabled),[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';
const focusables = (element: HTMLElement) => [...element.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(candidate => !candidate.closest('[hidden],[inert]') && candidate.getClientRects().length > 0);

/** Overlay focus model: focus moves in on open, Escape closes, and focus returns to
 * the control that opened it, or `returnTo` when that control re-rendered. A modal overlay also keeps Tab inside and makes the
 * rest of the workspace inert, without a scrim. */
export function useOverlayFocus(panel: RefObject<HTMLElement | null>, { close, modal = false, returnTo }: { close?(): void; modal?: boolean; returnTo?(): HTMLElement | null }) {
  const latest = useRef(close), latestReturn = useRef(returnTo); latest.current = close; latestReturn.current = returnTo;
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const active = element.ownerDocument.activeElement;
    const invoker = active instanceof HTMLElement && active !== element.ownerDocument.body && !element.contains(active) ? active : undefined;
    if (!element.contains(active)) { const items = focusables(element); (items.find(item => !item.closest('.floating-panel-header')) ?? items[0] ?? element).focus({ preventScroll: true }); }
    const inerted = modal ? [...element.parentElement?.children ?? []].filter((sibling): sibling is HTMLElement => sibling instanceof HTMLElement && sibling !== element && !sibling.inert) : [];
    for (const sibling of inerted) sibling.inert = true;
    return () => {
      for (const sibling of inerted) sibling.inert = false;
      const now = element.ownerDocument.activeElement;
      const target = invoker?.isConnected ? invoker : latestReturn.current?.();
      if (target && (!now || now === element.ownerDocument.body || element.contains(now))) target.focus({ preventScroll: true });
    };
  }, [panel, modal]);
  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && latest.current && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); latest.current(); return; }
    if (!modal || event.key !== 'Tab' || !panel.current) return;
    const items = focusables(panel.current), first = items[0], last = items.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && (document.activeElement === first || !panel.current.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
}
