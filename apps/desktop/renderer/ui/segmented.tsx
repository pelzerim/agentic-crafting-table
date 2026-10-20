import { useId } from 'react';

/** Two or three exclusive choices; the selected one's help line sits underneath. */
export function Segmented<T extends string>({ label, value, options, change, disabled }: { label: string; value: T; options: readonly { value: T; label: string; help?: string }[]; change(value: T): void; disabled?: boolean }) {
  const help = useId(), current = options.find(option => option.value === value);
  return <div className="act-segmented-field">
    <div className="act-segmented" role="radiogroup" aria-label={label} aria-describedby={current?.help ? help : undefined}>
      {options.map(option => <button key={option.value} type="button" role="radio" aria-checked={option.value === value} tabIndex={option.value === value ? 0 : -1} disabled={disabled}
        onClick={() => change(option.value)} onKeyDown={event => {
          const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
          if (!step) return;
          event.preventDefault();
          const next = options[(options.indexOf(option) + step + options.length) % options.length];
          change(next.value); (event.currentTarget.parentElement?.querySelector(`[data-value="${next.value}"]`) as HTMLElement | null)?.focus();
        }} data-value={option.value}>{option.label}</button>)}
    </div>
    {current?.help && <small id={help} className="act-segmented-help">{current.help}</small>}
  </div>;
}
