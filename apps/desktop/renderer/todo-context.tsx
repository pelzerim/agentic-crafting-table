import { useEffect, useId, useRef, useState } from 'react';
import { TODO_CONTEXT_LIMIT } from '../../../src/graph/todos.ts';
import type { TodoContext } from '../../../src/graph/todos.ts';
import { formatWhen } from '../../../src/resource-plugins/format-when.ts';

export type TodoContextMode = 'view' | 'edit' | 'confirm';
const writer = (context: TodoContext) => context.by ? context.by.kind === 'user' ? 'you' : context.by.title ?? (context.by.kind === 'agent' ? 'an agent' : 'the app') : undefined;
/** Who wrote a context and when, as far as it is recorded; never the text. */
export function contextCredit(context: TodoContext, separator: string, now = Date.now()): string {
  const who = writer(context), when = formatWhen(context.at, 'relative', now);
  return [who ? `written by ${who}` : when ? 'written' : '', when].filter(Boolean).join(who ? separator : ' ');
}

/** A to-do's context under its row (TODO-11): plain text, edited and cleared in place. */
export function TodoContextPanel({ title, context, mode, setMode, save, close, pending }: {
  title: string; context?: TodoContext; mode: TodoContextMode; setMode(mode: TodoContextMode): void;
  /** Resolves false when the write failed; the draft stays. */
  save(text: string): Promise<boolean>; close(): void; pending: boolean;
}) {
  const [draft, setDraft] = useState(context?.text ?? ''), editor = useRef<HTMLTextAreaElement>(null), confirm = useRef<HTMLButtonElement>(null), counter = useId();
  useEffect(() => {
    if (mode === 'edit') { setDraft(context?.text ?? ''); editor.current?.focus(); }
    if (mode === 'confirm') confirm.current?.focus();
  }, [mode]);
  const leave = () => { if (context) setMode('view'); else close(); };
  const commit = async () => {
    const text = draft.trim();
    if (text === (context?.text ?? '')) { leave(); return; }
    if (await save(text)) { if (text) setMode('view'); else close(); }
  };
  if (mode === 'edit') return <div className="todo-context" role="group" aria-label={`Context for ${title}`} data-todo-context-editor>
    <textarea ref={editor} aria-label={`Context for ${title}`} aria-describedby={counter} value={draft} maxLength={TODO_CONTEXT_LIMIT} disabled={pending} rows={5}
      placeholder="Reasoning, links and next steps for whoever picks this up" onChange={event => setDraft(event.target.value)} onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Escape' && !pending) { event.preventDefault(); leave(); }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void commit(); }
      }} />
    <div className="todo-context-actions">
      <span id={counter} className="todo-context-meta">{draft.length.toLocaleString('en-US')} / {TODO_CONTEXT_LIMIT.toLocaleString('en-US')}</span>
      <button type="button" disabled={pending} title="Save · Cmd/Ctrl+Enter" onClick={() => { void commit(); }}>Save</button>
      <button type="button" disabled={pending} title="Cancel · Escape" onClick={leave}>Cancel</button>
    </div>
  </div>;
  if (!context) return null;
  return <div className="todo-context" role="group" aria-label={`Context for ${title}`}>
    <div className="todo-context-text" tabIndex={0}>{context.text}</div>
    {mode === 'confirm' ? <div className="todo-context-actions">
      <span className="todo-context-meta">Clear this context?</span>
      <button type="button" ref={confirm} disabled={pending} data-destructive onClick={() => { void save('').then(done => { if (done) close(); }); }}>Clear context</button>
      <button type="button" disabled={pending} onClick={() => setMode('view')}>Keep</button>
    </div> : <div className="todo-context-actions">
      <span className="todo-context-meta" title={formatWhen(context.at, 'full')}>{contextCredit(context, ' · ')}</span>
      <button type="button" disabled={pending} onClick={() => setMode('edit')}>Edit</button>
      <button type="button" disabled={pending} onClick={() => setMode('confirm')}>Clear</button>
    </div>}
  </div>;
}
