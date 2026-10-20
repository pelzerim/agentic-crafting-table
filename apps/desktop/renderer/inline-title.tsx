import { useEffect, useId, useRef, useState } from 'react';

/** Shared in-place editor. The idle label remains a draggable map surface. */
export function InlineTitle({ title, save, onEditingChange, className = '' }: {
  title: string; save(title: string): Promise<void>; onEditingChange?(editing: boolean): void; className?: string;
}) {
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(title), [error, setError] = useState(''), [pending, setPending] = useState(false);
  const input = useRef<HTMLInputElement>(null), base = useRef(title), saving = useRef(false), cancelled = useRef(false);
  const pointer = useRef({ x: 0, y: 0, dragged: false }), callback = useRef(onEditingChange); callback.current = onEditingChange;
  const errorId = useId();
  useEffect(() => { callback.current?.(editing); if (editing) { input.current?.focus(); input.current?.select(); } return () => { if (editing) callback.current?.(false); }; }, [editing]);
  const begin = () => { base.current = title; cancelled.current = false; setDraft(title); setError(''); setEditing(true); };
  const commit = async () => {
    if (saving.current || cancelled.current) return;
    const value = draft.trim();
    if (!value || value.length > 500) { setError('Use 1–500 characters.'); return; }
    if (title !== base.current) { setError('Title changed elsewhere. Cancel and reopen to edit it.'); return; }
    if (value === title) { setEditing(false); return; }
    saving.current = true; setPending(true); setError('');
    try { await save(value); setEditing(false); }
    catch (error) { setError((error as Error).message); }
    finally { saving.current = false; setPending(false); }
  };
  if (!editing) return <span className={`inline-title ${className}`} data-inline-title role="button" tabIndex={0} title={title} aria-label={`Edit ${title}`}
    onPointerDown={event => { pointer.current = { x: event.clientX, y: event.clientY, dragged: false }; }}
    onPointerMove={event => { if (Math.hypot(event.clientX - pointer.current.x, event.clientY - pointer.current.y) >= 6) pointer.current.dragged = true; }}
    onClick={event => { event.stopPropagation(); if (!pointer.current.dragged || event.detail === 0) begin(); }}
    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); begin(); } }}>{title}</span>;
  return <span className={`inline-title-editor nodrag nopan nowheel ${className}`} data-inline-title onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
    <input ref={input} aria-label="Edit title" aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} title={error || undefined} value={draft} disabled={pending} maxLength={500}
      onChange={event => { setDraft(event.target.value); setError(''); }} onBlur={() => { void commit(); }} onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Enter') { event.preventDefault(); void commit(); }
        if (event.key === 'Escape' && !pending) { event.preventDefault(); cancelled.current = true; setEditing(false); }
      }} />
    {error && <span id={errorId} className="inline-title-error" role="alert" title={error}>{error}</span>}
  </span>;
}
