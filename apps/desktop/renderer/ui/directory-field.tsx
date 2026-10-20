import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PixelGlyph } from './pixel-glyph.tsx';
import { Button } from './button.tsx';
import { matchOptions } from './item-options.ts';
import { directoryOptions, splitDirectory } from '../../../../packages/core/working-directories.ts';

const LIST_MIN_WIDTH = 440, LIST_MARGIN = 8;

export interface DirectoryChoices { global: string; recent: string[]; loaded: boolean }

/** The global default and recent launch folders, read once per form. */
export function useDirectoryChoices(): DirectoryChoices {
  const [choices, setChoices] = useState<DirectoryChoices>({ global: '', recent: [], loaded: false });
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.craftingTable.settingsRead().then(snapshot => snapshot.value.defaultWorkingDirectory).catch(() => ''),
      window.craftingTable.recentDirectories().catch(() => []),
    ]).then(([global, recent]) => { if (!cancelled) setChoices({ global, recent, loaded: true }); });
    return () => { cancelled = true; };
  }, []);
  return choices;
}

/** A typed path with the project default, global default and recent folders as suggestions, plus the native folder picker. */
export function DirectoryField({ label, value, change, project, choices, required, autoFocus, disabled, error, inputId, describedBy }: {
  inputId?: string; describedBy?: string; label: string; value: string; change(value: string): void; project?: string; choices: DirectoryChoices;
  required?: boolean; autoFocus?: boolean; disabled?: boolean; error?(message: string): void;
}) {
  const id = useId(), list = useRef<HTMLDivElement>(null), field = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  const showTail = () => { const element = input.current; if (element && document.activeElement !== element) element.scrollLeft = element.scrollWidth; };
  useLayoutEffect(showTail, [value]);
  const [open, setOpen] = useState(false), [query, setQuery] = useState<string>(), [active, setActive] = useState<string>();
  const options = useMemo(() => directoryOptions({ project, global: choices.global, recent: choices.recent }), [project, choices.global, choices.recent]);
  const shown = useMemo(() => matchOptions(options, query ?? ''), [options, query]);
  const activeOption = shown.find(option => option.value === active);
  const index = activeOption ? shown.indexOf(activeOption) : -1;
  const listed = open && (shown.length > 0 || !query);
  const [anchor, setAnchor] = useState<{ top: number; left: number; width: number }>();
  useLayoutEffect(() => {
    if (!listed) return;
    list.current?.showPopover();
    const place = () => {
      const box = field.current!.getBoundingClientRect(), width = Math.min(Math.max(box.width, LIST_MIN_WIDTH), innerWidth - 2 * LIST_MARGIN);
      setAnchor({ top: box.bottom + 4, left: Math.max(LIST_MARGIN, Math.min(box.left, innerWidth - LIST_MARGIN - width)), width });
    };
    place(); addEventListener('scroll', place, true); addEventListener('resize', place);
    return () => { removeEventListener('scroll', place, true); removeEventListener('resize', place); };
  }, [listed]);
  useEffect(() => { if (open && activeOption) list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' }); }, [open, index]);
  const close = () => { setOpen(false); setQuery(undefined); setActive(undefined); };
  const pick = (path: string) => { change(path); close(); };
  const move = (step: number) => {
    setOpen(true);
    if (shown.length) setActive(current => {
      const at = shown.findIndex(option => option.value === current);
      return shown[at < 0 ? (step > 0 ? 0 : shown.length - 1) : (at + step + shown.length) % shown.length].value;
    });
  };
  const groups: [string, typeof shown][] = [];
  for (const option of shown) { const last = groups.at(-1); if (last && last[0] === option.group) last[1].push(option); else groups.push([option.group, [option]]); }
  return <div className="act-combobox act-directory-field" data-open={listed || undefined}>
    <div className="act-directory-row">
      <div className="act-combobox-field" ref={field}>
        <PixelGlyph name="folder" size={12} />
        <input ref={input} id={inputId} aria-describedby={describedBy} role="combobox" aria-label={label} aria-expanded={listed} aria-controls={`${id}-list`} aria-autocomplete="list"
          aria-activedescendant={listed && activeOption ? `${id}-${index}` : undefined} autoFocus={autoFocus} disabled={disabled} required={required}
          placeholder={options.length ? 'Type a path or choose a folder' : '/path/to/folder'} spellCheck={false} value={value}
          onClick={() => setOpen(true)} onBlur={() => { close(); showTail(); }}
          onChange={event => { change(event.target.value); setQuery(event.target.value); setActive(undefined); setOpen(true); }}
          onKeyDown={event => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); move(event.key === 'ArrowDown' ? 1 : -1); }
            else if (event.key === 'Enter' && open && activeOption) { event.preventDefault(); pick(activeOption.value); }
            else if (event.key === 'Escape' && listed) { event.preventDefault(); event.stopPropagation(); close(); }
          }} />
        <PixelGlyph name="chevron" className="act-glyph act-combobox-chevron" />
      </div>
      <Button size="sm" disabled={disabled} onClick={() => { void window.craftingTable.chooseDirectory().then(path => { if (path) change(path); }).catch(failure => error?.((failure as Error).message)); }}>Choose folder…</Button>
    </div>
    {listed && <div ref={list} popover="manual" className="act-combobox-list" id={`${id}-list`} role="listbox" aria-label={`${label} suggestions`} style={anchor} onMouseDown={event => event.preventDefault()}>
      {!shown.length && <p className="act-combobox-empty">Folders you launch from appear here</p>}
      {groups.map(([group, members]) => <div key={group} role="group" aria-label={group}>
        <div className="act-combobox-group" aria-hidden="true">{group}<span>{members.length}</span></div>
        {members.map(option => { const at = shown.indexOf(option), path = splitDirectory(option.label); return <div key={option.value} id={`${id}-${at}`} data-index={at} role="option" aria-label={option.value} aria-selected={option.value === value}
          data-active={option === activeOption || undefined} className="act-combobox-option" title={option.value} onPointerEnter={() => setActive(option.value)} onClick={event => { event.preventDefault(); pick(option.value); }}>
          <span className="act-combobox-label act-directory-path">{path.parent && <span className="act-directory-parent"><bdi>{path.parent}</bdi></span>}<span className="act-directory-name">{path.name}</span></span>
        </div>; })}
      </div>)}
    </div>}
  </div>;
}
