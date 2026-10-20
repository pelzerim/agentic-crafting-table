import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GROW_LINE, grownHeight, wrappedLines } from '../../../packages/core/item-map-sizes.ts';
import type { MapSizePreset } from '../../../src/resource-plugins/types.ts';
import { renderMarkdown } from '../../../src/resource-plugins/markdown-view.ts';
import { formatWhen } from '../../../src/resource-plugins/format-when.ts';
import { applyTextChange, indentList, sourceOffset, taskProgress, toggleChecklist, toggleTask, wrapSelection } from './paper-text.ts';

export const PAPER_SHOWN_LINES = 14, PAPER_EXPANDED_LINES = 28, PAPER_SAVE_MS = 600, PAPER_DRAG_PX = 6, PAPER_FLASH_MS = 1200;
export const PAPER_COLORS = [['mint', 'Mint'], ['sky', 'Sky'], ['lilac', 'Lilac'], ['peach', 'Peach'], ['slate', 'Slate']] as const;
export type PaperMode = 'near' | 'mid' | 'far';
type Grow = NonNullable<MapSizePreset['growLines']>;
export interface PaperActions {
  /** Saves a data patch; with `base`, only while the saved text still equals it. */
  write(patch: Record<string, string>, base?: string): Promise<void>;
  /** Leaving an emptied note removes it without asking. */
  discard(): void;
  /** Esc and ⌘↵ leave the tile focused and selected. */
  done(): void;
  /** Links open through the host's browser URL guard. */
  openUrl(url: string): void;
}

/** A long note expanded in place shows up to 28 lines; past that its text scrolls. */
export function expandedPaperHeight(text: string, width: number) {
  return GROW_LINE.chrome + Math.min(PAPER_EXPANDED_LINES, wrappedLines(text, width)) * GROW_LINE.height;
}

/** Rendered text of a range as the reader sees it: line breaks count as gaps and checkboxes as spaces. */
function rangeText(range: Range) {
  const fragment = range.cloneContents();
  for (const element of fragment.querySelectorAll('br,input')) element.replaceWith(element.localName === 'br' ? '\n' : ' ');
  return fragment.textContent ?? '';
}

/** Light markdown on the idle face: the first line bold, checkboxes clickable, raw HTML inert. */
function renderPaper(face: HTMLElement, text: string) {
  renderMarkdown(face, text, { breaks: true });
  const first = face.firstElementChild;
  if (first && /^H[1-6]$/.test(first.tagName)) first.classList.add('paper-first');
  else if (first?.tagName === 'P') {
    const strong = face.ownerDocument.createElement('strong'), lead: Node[] = [];
    for (const node of first.childNodes) { if (node.nodeName === 'BR') break; lead.push(node); }
    strong.className = 'paper-first'; first.insertBefore(strong, first.firstChild); strong.append(...lead);
  }
  face.querySelectorAll('input').forEach((box, index) => {
    box.disabled = false; box.dataset.task = String(index);
    box.setAttribute('aria-label', box.closest('li')?.textContent?.trim() || 'Checklist item');
  });
}

function caretAt(face: HTMLElement, x: number, y: number) {
  const document = face.ownerDocument;
  const position = document.caretPositionFromPoint?.(x, y);
  const node = position?.offsetNode ?? document.caretRangeFromPoint?.(x, y)?.startContainer, offset = position?.offset ?? document.caretRangeFromPoint?.(x, y)?.startOffset ?? 0;
  if (!node || !face.contains(node)) return undefined;
  const before = document.createRange(), after = document.createRange();
  before.setStart(face, 0); before.setEnd(node, offset);
  after.setStart(node, offset); after.setEnd(face, face.childNodes.length);
  return { prefix: rangeText(before), next: Array.from(rangeText(after)).find(char => !/\s/.test(char)) };
}

/** The note's text is the card face. A click writes where it lands, a drag past 6px
 * moves the tile, and Esc, ⌘↵, blur or zooming out commit; nothing discards a draft.
 * A save made elsewhere while writing holds autosave and offers Compare or Keep mine. */
export function PaperFace({ title, text, width, grow, mode, paper, writer, expanded, expand, onHeight, actions }: {
  title: string; text: string; width: number; grow?: Grow; mode: PaperMode; paper: string; writer?: { name: string; at: string }; expanded: boolean; expand(open: boolean): void;
  onHeight(height: number | undefined): void; actions: PaperActions;
}) {
  const [conflict, setConflict] = useState<string>(), [comparing, setComparing] = useState(false), [flash, setFlash] = useState(false);
  const conflictRef = useRef(conflict); conflictRef.current = conflict;
  const sent = useRef(new Set<string>()), writtenAt = useRef(writer?.at);
  const [editing, setEditing] = useState(false), [error, setError] = useState(''), [shown, setShown] = useState<string>();
  const [host, setHost] = useState<HTMLElement | null>(null), [overflow, setOverflow] = useState(false), [height, setHeight] = useState(0);
  const editor = useRef<HTMLTextAreaElement>(null), face = useRef<HTMLDivElement>(null), tools = useRef<HTMLDivElement>(null);
  const saved = useRef(text), caret = useRef<number>(undefined), timer = useRef<ReturnType<typeof setTimeout>>(undefined), queue = useRef(Promise.resolve());
  const active = useRef(false), pointer = useRef({ x: 0, y: 0, moved: false }), latest = useRef({ actions, onHeight }); latest.current = { actions, onHeight };
  const display = shown ?? text;
  useEffect(() => {
    if (!active.current) saved.current = text;
    else if (text !== saved.current && !sent.current.has(text)) setConflict(text);
    if (shown !== undefined && text === shown) setShown(undefined);
  }, [text]);
  useEffect(() => {
    const previous = writtenAt.current; writtenAt.current = writer?.at;
    if (!previous || !writer || writer.at === previous || active.current) return;
    setFlash(true); const timer = setTimeout(() => setFlash(false), PAPER_FLASH_MS); return () => clearTimeout(timer);
  }, [writer?.at]);
  const measure = (value: string) => {
    const next = grow ? grownHeight(grow, { [grow.field]: value }, width) : undefined;
    setOverflow(Boolean(grow && wrappedLines(value, width) > grow.max)); setHeight(next ?? 0); latest.current.onHeight(next);
  };
  const save = (value: string) => {
    queue.current = queue.current.then(async () => {
      if (conflictRef.current !== undefined || value === saved.current || !value.trim()) return;
      sent.current.add(value);
      try { await latest.current.actions.write({ text: value }, saved.current); saved.current = value; setError(''); }
      catch (failure) {
        const { code, theirs } = failure as { code?: string; theirs?: string };
        if (code === 'NOTE_CONFLICT' && theirs !== undefined) setConflict(theirs);
        else setError((failure as Error).message || 'This note could not be saved.');
      }
    });
    return queue.current;
  };
  const begin = (at?: number) => {
    if (active.current || mode !== 'near') return;
    active.current = true; caret.current = at; saved.current = text; sent.current.clear(); setError(''); setShown(undefined); setConflict(undefined); setComparing(false);
    setHost(face.current?.closest<HTMLElement>('.react-flow__node') ?? null); setEditing(true); measure(text);
  };
  const finish = (how: 'done' | 'leave') => {
    const element = editor.current;
    if (!active.current || !element || conflictRef.current !== undefined) return;
    active.current = false; clearTimeout(timer.current);
    const value = element.value;
    setEditing(false); latest.current.onHeight(undefined);
    if (!value.trim()) { latest.current.actions.discard(); return; }
    if (value !== saved.current) setShown(value);
    void save(value).then(() => setShown(current => current === value && saved.current !== value ? current : undefined));
    if (how === 'done') latest.current.actions.done();
  };
  useLayoutEffect(() => {
    const element = editor.current;
    if (!editing || !element) return;
    element.focus({ preventScroll: true });
    const at = caret.current ?? element.value.length; element.setSelectionRange(at, at);
  }, [editing]);
  useEffect(() => { if (editing && mode !== 'near') finish('leave'); }, [mode]);
  useLayoutEffect(() => { if (editing && editor.current) measure(editor.current.value); }, [width]);
  useLayoutEffect(() => { if (!editing && mode !== 'mid' && face.current) renderPaper(face.current, display); }, [display, editing, mode]);
  useEffect(() => () => { if (active.current && editor.current?.value.trim()) void save(editor.current.value); clearTimeout(timer.current); }, []);
  const leaving = (next: EventTarget | null) => {
    if (next instanceof Node && (editor.current?.contains(next) || tools.current?.contains(next))) return;
    if (!document.hasFocus()) return;
    const grip = next instanceof Element && host?.contains(next) ? next.closest<HTMLElement>('.item-resize-handle') : null;
    if (grip) { resizing(grip); return; }
    finish('leave');
  };
  /** Resizing the tile is not leaving it: writing goes on after the grip is released, and ends only when focus moves on from the grip. */
  const resizing = (grip: HTMLElement) => {
    const stop = () => { window.removeEventListener('pointerup', release, true); grip.removeEventListener('blur', away); };
    const release = () => { stop(); setTimeout(() => { if (active.current) editor.current?.focus({ preventScroll: true }); }); };
    const away = (event: FocusEvent) => { stop(); leaving(event.relatedTarget); };
    window.addEventListener('pointerup', release, true); grip.addEventListener('blur', away);
  };
  const keepMine = () => {
    const element = editor.current;
    saved.current = conflictRef.current ?? saved.current; conflictRef.current = undefined; setConflict(undefined); setComparing(false);
    if (element) { element.focus({ preventScroll: true }); void save(element.value); }
  };
  const useTheirs = () => {
    const element = editor.current, theirs = conflictRef.current;
    if (!element || theirs === undefined) return;
    saved.current = theirs; conflictRef.current = undefined; setConflict(undefined); setComparing(false);
    applyTextChange(element, { from: 0, to: element.value.length, insert: theirs, start: theirs.length, end: theirs.length });
  };
  const change = (value: string) => { measure(value); clearTimeout(timer.current); timer.current = setTimeout(() => void save(value), PAPER_SAVE_MS); };
  const lines = wrappedLines(display, width), hidden = lines - PAPER_SHOWN_LINES;
  if (mode === 'mid' && !editing) {
    const tasks = taskProgress(display), count = display.split(/\r?\n/).length;
    return <>
      <span className="paper-tape" aria-hidden="true" />
      <span className="paper-fold" aria-hidden="true" />
      <div key="mid" className="paper-mid"><strong className="paper-mid-title">{title}</strong>
        <span className="paper-progress">{tasks.total ? <><i role="meter" aria-label="Checklist" aria-valuemin={0} aria-valuemax={tasks.total} aria-valuenow={tasks.done}><b style={{ width: `${tasks.done / tasks.total * 100}%` }} /></i>{tasks.done}/{tasks.total}</>
          : `${count} ${count === 1 ? 'line' : 'lines'}`}</span></div>
    </>;
  }
  return <>
    <span className="paper-tape" aria-hidden="true" data-flash={flash || undefined} />
    <span className="paper-fold" aria-hidden="true" />
    {editing ? <textarea ref={editor} className={`paper-editor nodrag nopan${overflow ? ' nowheel' : ''}`} aria-label="Note text" defaultValue={text} spellCheck
      onInput={event => change(event.currentTarget.value)} onBlur={event => leaving(event.relatedTarget)}
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        const element = event.currentTarget, { value, selectionStart: start, selectionEnd: end } = element, command = event.metaKey || event.ctrlKey;
        if (event.key === 'Escape' || (event.key === 'Enter' && command)) { event.preventDefault(); finish('done'); return; }
        const edit = command && !event.shiftKey && !event.altKey && ['b', 'i'].includes(event.key.toLowerCase()) ? wrapSelection(value, start, end, event.key.toLowerCase() === 'b' ? '**' : '_')
          : command && event.shiftKey && event.code === 'Digit7' ? toggleChecklist(value, start, end)
          : event.key === 'Tab' && !command && !event.altKey ? indentList(value, start, end, event.shiftKey) : undefined;
        if (edit) { event.preventDefault(); applyTextChange(element, edit); }
      }} />
    : <div key="face" ref={face} className={`paper-face${expanded ? ' nowheel' : ''}`} data-paper-face data-faded={hidden > 0 && !expanded || undefined} data-scrolls={expanded || undefined}
      onPointerDown={event => { pointer.current = { x: event.clientX, y: event.clientY, moved: false }; }}
      onPointerMove={event => { if (Math.hypot(event.clientX - pointer.current.x, event.clientY - pointer.current.y) >= PAPER_DRAG_PX) pointer.current.moved = true; }}
      onClick={event => {
        const target = event.target as Element, box = target.closest<HTMLInputElement>('input[data-task]'), link = target.closest<HTMLAnchorElement>('a[href]');
        if (box) {
          event.preventDefault(); event.stopPropagation();
          const next = toggleTask(display, Number(box.dataset.task));
          setShown(next);
          void latest.current.actions.write({ text: next }, display).catch(failure => { setShown(undefined); setError((failure as Error).message); });
          return;
        }
        if (link) { event.preventDefault(); event.stopPropagation(); latest.current.actions.openUrl(link.href); return; }
        if (target.closest('button')) return;
        event.stopPropagation();
        if (event.detail === 0) { begin(); return; }
        if (pointer.current.moved) return;
        const at = caretAt(event.currentTarget, event.clientX, event.clientY);
        begin(at ? sourceOffset(text, at.prefix, at.next) : undefined);
      }} />}
    {!editing && hidden > 0 && <button type="button" className="paper-more nodrag nopan" aria-expanded={expanded}
      onClick={event => { event.stopPropagation(); expand(!expanded); }}>{expanded ? 'Show less' : `+ ${hidden} ${hidden === 1 ? 'line' : 'lines'}`}</button>}
    {writer && !editing && <span className="paper-byline" title={formatWhen(writer.at, 'full')}>{writer.name} · {formatWhen(writer.at)}</span>}
    {error && <span className="paper-error" role="alert">{error}</span>}
    {editing && host && createPortal(<div ref={tools} className="paper-overlay nodrag nopan" onBlur={event => leaving(event.relatedTarget)}
      onPointerDown={event => { event.stopPropagation(); if (!(event.target as Element).closest('button')) event.preventDefault(); }}>
      {conflict !== undefined && <div className="paper-conflict" role="group" aria-label="Note changed elsewhere">
        <span>{writer?.name ?? 'Someone'} changed this note</span>
        <button type="button" aria-expanded={comparing} onPointerDown={event => event.preventDefault()} onClick={() => setComparing(!comparing)}>Compare</button>
        <button type="button" onPointerDown={event => event.preventDefault()} onClick={keepMine}>Keep mine</button>
      </div>}
      {conflict !== undefined && comparing && <section className="paper-compare" aria-label="Saved version" style={{ top: height + 50 }}>
        <p>{conflict}</p>
        <button type="button" onPointerDown={event => event.preventDefault()} onClick={useTheirs}>Use saved version</button>
      </section>}
      <div className="paper-tools" role="toolbar" aria-label="Note" style={{ top: height + 8 }}>
      <span role="radiogroup" aria-label="Paper">{PAPER_COLORS.map(([id, label]) => <button key={id} type="button" role="radio" aria-checked={paper === id} aria-label={label} title={label} className="paper-swatch" data-paper={id}
        onPointerDown={event => event.preventDefault()} onClick={() => { void latest.current.actions.write({ paper: id }).catch(failure => setError((failure as Error).message)); }} />)}</span>
      <button type="button" className="paper-list" onPointerDown={event => event.preventDefault()} onClick={() => { const element = editor.current; if (element) applyTextChange(element, toggleChecklist(element.value, element.selectionStart, element.selectionEnd)); }}>List</button>
      <span className="paper-hint"><kbd>Esc</kbd> done</span>
    </div></div>, host)}
  </>;
}
