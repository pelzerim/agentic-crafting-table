import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { PixelGlyph } from './pixel-glyph.tsx';
import { matchOptions } from './item-options.ts';
import type { ComboOption } from './item-options.ts';

/** Searchable pixel dropdown: type to filter, grouped choices with icons, Enter picks, Escape closes the list only. */
export function PixelCombobox<T extends ComboOption>({ label, caption, value, options, change, placeholder = 'Choose…', icon, disabled, autoFocus, defaultOpen = false, emptyLabel = 'Nothing matches', onActive }: {
  label: string; caption?: string; value: string; options: readonly T[]; change(value: string): void; placeholder?: string;
  icon?(option: T): ReactNode; disabled?: boolean; autoFocus?: boolean; defaultOpen?: boolean; emptyLabel?: string; onActive?(value: string | undefined): void;
}) {
  const id = useId(), input = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(defaultOpen), [query, setQuery] = useState(''), [active, setActive] = useState<string>();
  const selected = options.find(option => option.value === value);
  const shown = useMemo(() => matchOptions(options, query), [options, query]);
  const activeOption = shown.find(option => option.value === active) ?? shown[0];
  useEffect(() => { if (open) onActive?.(activeOption?.value); else onActive?.(undefined); }, [open, activeOption?.value]);
  useEffect(() => { if (open && activeOption) list.current?.querySelector(`[data-value="${CSS.escape(activeOption.value)}"]`)?.scrollIntoView({ block: 'nearest' }); }, [open, activeOption?.value]);
  const pick = (option: T) => { change(option.value); setOpen(false); setQuery(''); };
  const move = (step: number) => {
    if (!shown.length) return;
    const index = shown.indexOf(activeOption!);
    setActive(shown[(index + step + shown.length) % shown.length].value); setOpen(true);
  };
  const groups: [string | undefined, T[]][] = [];
  for (const option of shown) { const last = groups.at(-1); if (last && last[0] === option.group) last[1].push(option); else groups.push([option.group, [option]]); }
  return <div className="act-combobox" data-open={open || undefined}>
    {caption && <span className="act-combobox-caption" aria-hidden="true" onClick={() => input.current?.focus()}>{caption}</span>}
    <div className="act-combobox-field">
      {selected && !open && icon ? <span className="act-combobox-icon">{icon(selected)}</span> : <PixelGlyph name="search" />}
      <input ref={input} role="combobox" aria-label={label} aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list"
        aria-activedescendant={open && activeOption ? `${id}-${activeOption.value}` : undefined} autoFocus={autoFocus} disabled={disabled}
        placeholder={selected ? selected.label : placeholder} value={open ? query : selected?.label ?? ''}
        onClick={() => setOpen(true)} onBlur={() => { setOpen(false); setQuery(''); }}
        onChange={event => { setQuery(event.target.value); setActive(undefined); setOpen(true); }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); move(event.key === 'ArrowDown' ? 1 : -1); }
          else if (event.key === 'Enter' && open && activeOption) { event.preventDefault(); pick(activeOption); }
          else if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); setQuery(''); }
        }} />
      <PixelGlyph name="chevron" className="act-glyph act-combobox-chevron" />
    </div>
    {open && <div ref={list} className="act-combobox-list" id={`${id}-list`} role="listbox" aria-label={label} onMouseDown={event => event.preventDefault()}>
      {!shown.length && <p className="act-combobox-empty">{emptyLabel}</p>}
      {groups.map(([group, members], index) => <div key={`${group ?? ''}:${index}`} role="group" aria-label={group}>
        {group && <div className="act-combobox-group" aria-hidden="true">{group}<span>{members.length}</span></div>}
        {members.map(option => <div key={option.value} id={`${id}-${option.value}`} data-value={option.value} role="option" aria-selected={option.value === value}
          data-active={option === activeOption || undefined} className="act-combobox-option" onPointerEnter={() => setActive(option.value)} onClick={() => pick(option)}>
          {icon && <span className="act-combobox-icon">{icon(option)}</span>}<span className="act-combobox-label">{option.label}</span>{option.meta && <small>{option.meta}</small>}
        </div>)}
      </div>)}
    </div>}
  </div>;
}
