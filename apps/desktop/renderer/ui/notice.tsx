import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from './button.tsx';
import { PixelGlyph } from './pixel-glyph.tsx';
import type { GlyphName } from './pixel-glyph.tsx';
import { humanError } from './error-copy.ts';

export type NoticeTone = 'done' | 'unblocked' | 'undo' | 'error' | 'recovery' | 'info';
const GLYPH: Record<NoticeTone, GlyphName> = { done: 'check', unblocked: 'bang', undo: 'undo', error: 'alert', recovery: 'info', info: 'info' };

function Details({ text }: { text: string }) {
  const [open, setOpen] = useState(false), id = useId();
  return <>
    <Button variant="quiet" size="sm" className="act-details-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>Details</Button>
    <pre id={id} className="act-details" hidden={!open}>{text}</pre>
  </>;
}

/** Map-level outcome in the notice corner: one glyph, one action, one close. Only errors interrupt. */
export function Toast({ tone, title, detail, label, action, dismiss, dismissLabel, details }: {
  tone: NoticeTone; title: ReactNode; detail?: ReactNode; label?: string;
  action?: { label: string; run(): void }; dismiss?(): void; dismissLabel?: string; details?: string;
}) {
  return <aside className="act-toast" data-tone={tone} role={tone === 'error' ? 'alert' : 'status'} aria-label={label}>
    <span className="act-toast-glyph"><PixelGlyph name={GLYPH[tone]} /></span>
    <span className="act-toast-text"><strong>{title}</strong>{detail && <small>{detail}</small>}</span>
    {action && <Button size="sm" onClick={action.run}>{action.label}</Button>}
    {details && <Details text={details} />}
    {dismiss && <Button variant="icon" size="sm" className="act-toast-close" aria-label={dismissLabel ?? 'Dismiss'} onClick={dismiss}><PixelGlyph name="close" /></Button>}
  </aside>;
}

/** A failure next to its cause, in human copy; raw provider or IPC text stays behind Details. */
export function ErrorNotice({ message }: { message: string }) {
  const { message: text, details } = humanError(message);
  return <Notice tone="error" details={details}>{text}</Notice>;
}

/** Inline status next to the control that caused it; raw text stays behind Details. */
export function Notice({ tone, children, details }: { tone: 'error' | 'pending' | 'ok' | 'info'; children: ReactNode; details?: string }) {
  return <div className="act-notice" data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
    <PixelGlyph name={tone === 'error' ? 'alert' : tone === 'ok' ? 'check' : tone === 'pending' ? 'bang' : 'info'} />
    <span>{children}</span>
    {details && details !== children && <Details text={details} />}
  </div>;
}
