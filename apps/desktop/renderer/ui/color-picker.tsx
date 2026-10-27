import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { COLOR_PAD_HUES, COLOR_PAD_SHADES, colorPadCell, colorPadColor, hexToHsl, isHexColor, parseHexColor } from '../../../../src/graph/colors.ts';
import { PixelGlyph } from './pixel-glyph.tsx';
import './color-picker.css';

/** One preset swatch. `color` is any CSS colour the swatch is drawn in: `#rrggbb`, or a token such as a paper's. */
export interface ColorChoice { id: string; label: string; color: string }
export type ColorPick = { id: string } | { custom: string };

const CUSTOM_ICON = [[0, 0], [4, 1], [8, 2], [2, 3], [6, 4], [10, 5], [1, 6], [5, 2], [9, 3]] as const;

/** Arrow keys walk one row of swatches (and a grid's rows with Up/Down); the focused one is the row's only tab stop. */
function walk(event: ReactKeyboardEvent<HTMLElement>, grid: boolean) {
  const horizontal = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0, vertical = grid ? event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0 : 0;
  if (!horizontal && !vertical) return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(':scope [data-swatch]')], current = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (current < 0) return;
  event.preventDefault(); event.stopPropagation();
  if (horizontal) { buttons[(current + horizontal + buttons.length) % buttons.length]?.focus(); return; }
  const from = buttons[current]!.getBoundingClientRect(), centre = from.left + from.width / 2;
  const rows = [...new Set(buttons.map(button => Math.round(button.getBoundingClientRect().top)))].sort((a, b) => a - b);
  const row = rows[(rows.indexOf(Math.round(from.top)) + vertical + rows.length) % rows.length];
  const target = buttons.filter(button => Math.round(button.getBoundingClientRect().top) === row)
    .sort((a, b) => Math.abs(a.getBoundingClientRect().left + a.offsetWidth / 2 - centre) - Math.abs(b.getBoundingClientRect().left + b.offsetWidth / 2 - centre))[0];
  target?.focus();
}

/** The colour picker every place shares: preset swatches, Your colours and a Custom… pad drawn in pixel cells.
 * `value` is a preset id or a `#rrggbb`. `compact` keeps one row of presets with a More… step, for menus and toolbars.
 * `custom={false}` offers the presets only. A committed custom colour reaches `onChange` and `onRecent`. */
export function ColorPicker({ label, presets, value, recent, onChange, onRecent, compact = false, custom = true }: {
  label: string; presets: readonly ColorChoice[]; value: string | undefined; recent: readonly string[];
  onChange(next: ColorPick): void; onRecent(color: string): void; compact?: boolean; custom?: boolean;
}) {
  const hex = isHexColor(value) ? value.toLowerCase() : undefined;
  const checkedPreset = presets.find(preset => preset.id === value || (hex !== undefined && preset.color.toLowerCase() === hex));
  const customValue = checkedPreset ? undefined : hex, recentChecked = customValue && recent.includes(customValue) ? customValue : undefined;
  const [more, setMore] = useState(false), [padOpen, setPadOpen] = useState(false);
  const [focused, setFocused] = useState<Record<string, number>>({});
  const customButton = useRef<HTMLButtonElement>(null), moreButton = useRef<HTMLButtonElement>(null);
  const extra = custom && (!compact || more);
  const commit = (color: string) => { onRecent(color); onChange({ custom: color }); };
  /** A row's tab stop: the swatch last focused, else the checked one, else the first. */
  const stop = (row: string, checked: number) => focused[row] ?? Math.max(0, checked);
  const swatch = (row: string, index: number, at: number, props: { label: string; color?: string; checked?: boolean; onClick(): void; className?: string; expanded?: boolean; children?: React.ReactNode; button?: React.Ref<HTMLButtonElement> }) =>
    <button key={`${row}:${props.label}`} ref={props.button} type="button" data-swatch className={`color-picker-swatch${props.className ? ` ${props.className}` : ''}`}
      role={props.checked === undefined ? undefined : 'radio'} aria-checked={props.checked} aria-expanded={props.expanded} aria-label={props.label} title={props.label}
      tabIndex={index === at ? 0 : -1} data-row-rest={index === at ? undefined : true}
      style={props.color ? { '--swatch': props.color } as CSSProperties : undefined}
      onFocus={() => setFocused(old => old[row] === index ? old : { ...old, [row]: index })} onClick={props.onClick}>{props.children}</button>;
  const presetStop = stop('presets', presets.findIndex(preset => preset === checkedPreset));
  const recentStop = stop('recent', recent.findIndex(color => color === recentChecked));
  return <div className="color-picker" data-compact={compact || undefined}>
    <div className="color-picker-row" onKeyDown={event => walk(event, !compact)}>
      <span role="radiogroup" aria-label={label} className="color-picker-swatches">
        {presets.map((preset, index) => swatch('presets', index, presetStop, { label: preset.label, color: preset.color, checked: preset === checkedPreset, onClick: () => onChange({ id: preset.id }) }))}
      </span>
      {custom && compact && swatch('presets', presets.length, presetStop, { label: 'More colours', className: 'color-picker-more', expanded: more, button: moreButton,
        onClick: () => { setMore(!more); if (more) setPadOpen(false); }, children: <PixelGlyph name="more" /> })}
      {extra && !compact && customSwatch(presets.length, presetStop)}
    </div>
    {extra && (recent.length > 0 || compact) && <div className="color-picker-row" onKeyDown={event => walk(event, false)}>
      {recent.length > 0 && <span role="radiogroup" aria-label="Your colours" className="color-picker-swatches">
        {recent.map((color, index) => swatch('recent', index, recentStop, { label: `Your colour ${color}`, color, checked: color === recentChecked, onClick: () => commit(color) }))}
      </span>}
      {compact && customSwatch(recent.length, recentStop)}
    </div>}
    {extra && padOpen && <CustomPad start={customValue} close={() => { setPadOpen(false); customButton.current?.focus(); }} apply={color => { setPadOpen(false); commit(color); }} />}
  </div>;

  function customSwatch(index: number, at: number) {
    return swatch(compact ? 'recent' : 'presets', index, at, { label: customValue ? `Custom colour ${customValue}` : 'Custom colour…', className: 'color-picker-custom', button: customButton,
      color: customValue && !recentChecked ? customValue : undefined, expanded: padOpen, onClick: () => setPadOpen(!padOpen),
      children: customValue && !recentChecked ? undefined : <svg viewBox="0 0 12 12" shapeRendering="crispEdges" aria-hidden="true">{CUSTOM_ICON.map(([hue, shade], cell) =>
        <rect key={cell} x={cell % 3 * 4} y={Math.floor(cell / 3) * 4} width={4} height={4} fill={colorPadColor(hue, shade)} />)}</svg> });
  }
}

/** The pixel pad: hue across, shade down, plus a `#rrggbb` field. Nothing is chosen until Apply. Esc closes it. */
function CustomPad({ start, apply, close }: { start: string | undefined; apply(color: string): void; close(): void }) {
  const [draft, setDraft] = useState(start ?? colorPadColor(7, 3)), [text, setText] = useState(draft);
  const cell = colorPadCell(draft), parsed = parseHexColor(text);
  const pad = useRef<SVGSVGElement>(null), hue = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { hue.current?.focus(); }, []);
  const choose = (color: string) => { setDraft(color); setText(color); };
  const at = (event: React.PointerEvent<SVGSVGElement>) => {
    const bounds = pad.current!.getBoundingClientRect();
    const column = Math.floor((event.clientX - bounds.left) / bounds.width * COLOR_PAD_HUES), row = Math.floor((event.clientY - bounds.top) / bounds.height * COLOR_PAD_SHADES);
    if (column >= 0 && column < COLOR_PAD_HUES && row >= 0 && row < COLOR_PAD_SHADES) choose(colorPadColor(column, row));
  };
  const keys = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (['Tab', 'Home', 'End', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' '].includes(event.key)) event.stopPropagation();
  };
  const slide = (axis: 'hue' | 'light') => (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0;
    const edge = event.key === 'Home' ? 'min' : event.key === 'End' ? 'max' : undefined;
    if (!step && !edge) return;
    event.preventDefault();
    if (axis === 'hue') choose(colorPadColor(edge === 'min' ? 0 : edge === 'max' ? COLOR_PAD_HUES - 1 : (cell.hue + step + COLOR_PAD_HUES) % COLOR_PAD_HUES, cell.shade));
    else choose(colorPadColor(cell.hue, edge === 'min' ? COLOR_PAD_SHADES - 1 : edge === 'max' ? 0 : Math.max(0, Math.min(COLOR_PAD_SHADES - 1, cell.shade - step))));
  };
  const [h, , l] = hexToHsl(draft);
  return <div className="color-picker-pad" role="group" aria-label="Custom colour" onKeyDown={keys}>
    <div className="color-picker-cells">
      <svg ref={pad} viewBox={`0 0 ${COLOR_PAD_HUES} ${COLOR_PAD_SHADES}`} shapeRendering="crispEdges" aria-hidden="true"
        onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); at(event); }} onPointerMove={event => { if (event.buttons) at(event); }}>
        {Array.from({ length: COLOR_PAD_HUES * COLOR_PAD_SHADES }, (_, index) => { const column = index % COLOR_PAD_HUES, row = Math.floor(index / COLOR_PAD_HUES);
          return <rect key={index} x={column} y={row} width={1} height={1} fill={colorPadColor(column, row)} />; })}
        <rect className="color-picker-cell-mark" x={cell.hue + .1} y={cell.shade + .1} width={.8} height={.8} />
        <rect className="color-picker-cell-mark" data-inner x={cell.hue + .25} y={cell.shade + .25} width={.5} height={.5} />
      </svg>
      <div ref={hue} role="slider" tabIndex={0} className="color-picker-axis" aria-label="Hue" aria-valuemin={0} aria-valuemax={COLOR_PAD_HUES - 1} aria-valuenow={cell.hue} aria-valuetext={`${Math.round(h)}°`} onKeyDown={slide('hue')} />
      <div role="slider" tabIndex={0} className="color-picker-axis" aria-label="Lightness" aria-orientation="vertical" aria-valuemin={0} aria-valuemax={COLOR_PAD_SHADES - 1} aria-valuenow={COLOR_PAD_SHADES - 1 - cell.shade} aria-valuetext={`${Math.round(l * 100)}%`} onKeyDown={slide('light')} />
    </div>
    <div className="color-picker-entry">
      <i className="color-picker-preview" aria-hidden="true" style={{ '--swatch': parsed ?? draft } as CSSProperties} />
      <input type="text" aria-label="Hex colour" spellCheck={false} maxLength={7} value={text} aria-invalid={parsed ? undefined : true}
        onChange={event => { setText(event.target.value); const next = parseHexColor(event.target.value); if (next) setDraft(next); }}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (parsed) apply(parsed); } }} />
      <button type="button" className="color-picker-apply" disabled={!parsed} onClick={() => { if (parsed) apply(parsed); }}>Apply</button>
    </div>
  </div>;
}
