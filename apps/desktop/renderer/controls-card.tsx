import { useEffect, useRef } from 'react';
import { shortcutGroups } from './shortcuts.ts';
import { PixelGlyph } from './ui/pixel-glyph.tsx';

/** Every workspace key, listed from the shortcut registry. */
export function ControlsCard({ close }: { close(): void }) {
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    card.current?.querySelector<HTMLElement>('.controls-close')?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); close(); } };
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('keydown', escape); previous?.focus?.(); };
  }, []);
  return <section ref={card} className="controls-card" role="dialog" aria-label="Controls">
    <header><h2>Controls</h2><button type="button" className="controls-close" aria-label="Close controls" onClick={close}><PixelGlyph name="close" /></button></header>
    <div className="controls-groups">{shortcutGroups().map(({ group, rows }) => <section key={group} aria-label={group}>
      <h3>{group}</h3>
      <dl>{rows.map(row => <div key={row.id}><dt>{row.label}</dt><dd><kbd>{row.key}</kbd></dd></div>)}</dl>
    </section>)}</div>
    <p>Keys pause while you type in a field or terminal.</p>
  </section>;
}
