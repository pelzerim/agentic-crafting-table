import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TerminalLink } from './terminal-links.ts';

export function TerminalLinkMenu({ link, close }: { link: TerminalLink; close(focus?: boolean): void }) {
  const menu = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useLayoutEffect(() => {
    const element = menu.current!;
    const place = () => {
      element.style.left = `${Math.max(8, Math.min(link.x, window.innerWidth - element.offsetWidth - 8))}px`;
      element.style.top = `${Math.max(8, Math.min(link.y, window.innerHeight - element.offsetHeight - 8))}px`;
    };
    place(); element.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: MouseEvent) => {
      if (element.contains(event.target as Node)) return;
      if (event.type === 'contextmenu') { event.preventDefault(); event.stopPropagation(); }
      close(false);
    };
    const away = () => close(false);
    const resize = new ResizeObserver(place); resize.observe(element);
    window.addEventListener('resize', place); window.addEventListener('blur', away);
    document.addEventListener('pointerdown', outside, true); document.addEventListener('contextmenu', outside, true);
    return () => { resize.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('blur', away); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('contextmenu', outside, true); };
  }, [link]);
  const action = async (run: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await run(); close(true); }
    catch { setError('Could not complete this action. Try again.'); setBusy(false); }
  };
  return createPortal(<div ref={menu} role="menu" aria-label="Terminal link" data-shortcuts="off" className="terminal-link-menu"
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); close(true); }}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); close(true); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }}>
    <p className="terminal-link-destination" title={link.url}>{link.url}</p>
    <button role="menuitem" disabled={busy} onClick={() => { void action(() => window.craftingTable.copyUrl(link.url)); }}>Copy link</button>
    <button role="menuitem" disabled={busy} onClick={() => { void action(() => window.craftingTable.openUrl(link.url)); }}>Open in browser</button>
    {error && <p role="alert">{error}</p>}
  </div>, document.body);
}
