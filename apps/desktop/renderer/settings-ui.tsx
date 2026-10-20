import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, FieldsetHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { settingsEntryId, settingsPageId } from './settings-tree.tsx';
import type { ProviderSetupStep } from '../../../packages/core/connections.ts';
import './settings.css';

export type StatusTone = 'ok' | 'pending' | 'error';
export interface RowStatus { tone: StatusTone; text: string }

const RowContext = createContext<{ id: string; describedBy: string; report(field: string, message: string): void } | undefined>(undefined);
/** Wires any native control to its row label and description. */
export const useRowControl = () => { const row = useContext(RowContext); return row ? { id: row.id, 'aria-describedby': row.describedBy } : {}; };

export function SettingsPage({ id, title, crumb, description, meta, note, hidden, children }: { id: string; title: string; crumb?: string; description?: ReactNode; meta?: ReactNode; note?: ReactNode; hidden: boolean; children?: ReactNode }) {
  return <section className="settings-page" role="region" id={settingsPageId(id)} aria-labelledby={settingsEntryId(id)} data-settings-section={id} hidden={hidden}>
    <header className="settings-page-header"><div>{crumb && <small>{crumb}</small>}<h3>{title}</h3>{description && <p className="settings-page-description">{description}</p>}</div>{meta && <span className="settings-page-meta">{meta}</span>}</header>
    {note && <Note>{note}</Note>}
    {children}
  </section>;
}

export function SettingsSection({ label, description, action, bare, children, ...fieldset }: { label: string; description?: ReactNode; action?: ReactNode; bare?: boolean; children: ReactNode } & FieldsetHTMLAttributes<HTMLFieldSetElement>) {
  return <fieldset className="settings-section" {...fieldset}>
    <legend>{label}</legend>{action && <div className="settings-section-action">{action}</div>}
    {description && <p className="settings-section-description">{description}</p>}
    {bare ? children : <div className="settings-card">{children}</div>}
  </fieldset>;
}

export function SettingRow({ label, description, meta, status, immediate, dependent, disabled, stack, children }: {
  label: ReactNode; description?: ReactNode; meta?: ReactNode; status?: RowStatus; immediate?: boolean;
  dependent?: boolean; disabled?: boolean; stack?: boolean; children?: ReactNode;
}) {
  const id = useId(), describedBy = `${id}-about`, [errors, setErrors] = useState<Record<string, string>>({});
  const report = useCallback((field: string, message: string) => setErrors(old => (old[field] ?? '') === message ? old : { ...old, [field]: message }), []);
  const error = Object.values(errors).find(Boolean);
  return <RowContext.Provider value={{ id, describedBy, report }}>
    <div className="setting-row" data-invalid={error ? true : undefined} data-dependent={dependent || undefined} data-disabled={disabled || undefined} data-stack={stack || undefined}>
      <div className="setting-row-text">
        <label className="setting-row-label" htmlFor={id}>{label}{immediate && <span className="settings-chip" data-tone="pending">Immediate</span>}</label>
        <div id={describedBy}>
          {description && <p className="setting-row-description">{description}</p>}
          {(meta || status) && <p className="setting-row-meta">{meta}{meta && status && ' · '}{status && <span role="status" data-tone={status.tone}>{status.text}</span>}</p>}
          {error && <p className="setting-row-range">{error}</p>}
        </div>
      </div>
      {children !== undefined && <div className="setting-row-control">{children}</div>}
    </div>
  </RowContext.Provider>;
}

/** A behaviour toggle: a native checkbox exposed as a switch. */
export function Switch({ checked, change, ...input }: { checked: boolean; change(value: boolean): void } & Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'role' | 'checked' | 'onChange'>) {
  return <input type="checkbox" role="switch" className="settings-switch" {...useRowControl()} {...input} checked={checked} onChange={event => change(event.target.checked)} />;
}

/** Checks its range when it loses focus or Save rejects it, and reports it in the row's meta line. */
export function NumberField({ unit, ...input }: { unit?: string } & Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const row = useContext(RowContext), key = useId(), { min, max } = input, suffix = unit && !/^[wh]$/.test(unit) ? ` ${unit}` : '';
  const message = `${input['aria-label'] ? `${input['aria-label']}: use` : 'Use'} ${min !== undefined && max !== undefined ? `${min}–${max}` : min !== undefined ? `${min} or more` : 'a number'}${suffix}`;
  const check = (field: HTMLInputElement) => row?.report(key, field.validity.valid ? '' : message);
  const flagged = useRef(false);
  return <span className="settings-field settings-number"><input type="number" {...useRowControl()} {...input}
    onBlur={event => { flagged.current = true; check(event.currentTarget); input.onBlur?.(event); }}
    onInvalid={event => { flagged.current = true; check(event.currentTarget); input.onInvalid?.(event); }}
    onInput={event => { if (flagged.current) check(event.currentTarget); input.onInput?.(event); }} />{unit && <span className="settings-unit" aria-hidden="true">{unit}</span>}</span>;
}

export function TextField(input: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return <input className="settings-text" {...useRowControl()} {...input} />;
}

export function SliderField({ value, min, max, step, defaultValue, format, change, ...input }: { value: number; min: number; max: number; step: number; defaultValue: number; format(value: number): string; change(value: number): void } & Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'min' | 'max' | 'step' | 'defaultValue' | 'onChange'>) {
  const at = (point: number) => `calc(5px + (100% - 10px) * ${(point - min) / (max - min)})`;
  return <span className="settings-slider" style={{ '--slider-fill': at(value) } as CSSProperties}>
    <span className="settings-slider-track"><input type="range" {...useRowControl()} {...input} min={min} max={max} step={step} value={value} onChange={event => change(Number(event.target.value))} /><i aria-hidden="true" style={{ left: at(defaultValue) }} /></span>
    <output>{format(value)}</output>
  </span>;
}

export function Segmented<T extends string>({ label, value, options, change }: { label: string; value: T; options: { value: T; label: string; name?: string; count?: number }[]; change(value: T): void }) {
  return <div className="settings-segmented" role="group" aria-label={label}>{options.map(option => <button type="button" key={option.value} aria-pressed={value === option.value} aria-label={option.name} onClick={() => change(option.value)}>
    {option.label}{option.count !== undefined && <span className="settings-count">{option.count}</span>}
  </button>)}</div>;
}

/** Shows the default in the meta line, or a reset once the value differs from it. */
export function DefaultMeta({ value, fallback, format = String, note, reset }: { value: unknown; fallback: number; format?(value: number): string; note?: string; reset?(): void }) {
  if (reset && value !== fallback) return <>Changed · <button type="button" className="settings-quiet" onClick={reset}>Reset to {format(fallback)}</button></>;
  return <>Default {format(fallback)}{note && ` · ${note}`}</>;
}

export function Note({ children }: { children: ReactNode }) { return <p className="settings-note"><span>{children}</span></p>; }

export function Chip({ tone, children }: { tone?: StatusTone | 'neutral'; children: ReactNode }) { return <span className="settings-chip" data-tone={tone ?? 'neutral'}>{children}</span>; }

export function AdvancedDisclosure({ open, toggle, count, children }: { open: boolean; toggle(): void; count: number; children: ReactNode }) {
  const id = useId();
  return <div className="settings-advanced">
    <button type="button" className="settings-advanced-toggle" aria-expanded={open} aria-controls={id} onClick={toggle}>Advanced settings<span className="settings-count"> · {count}</span></button>
    <div id={id} data-advanced hidden={!open}>{children}</div>
  </div>;
}

/** Replaces a destructive action with Keep/confirm; focus starts on Keep and Escape cancels. */
export function InlineConfirm({ message, confirm, cancel, confirmLabel, keepLabel = 'Keep', busy }: { message: ReactNode; confirm(): void; cancel(): void; confirmLabel: string; keepLabel?: string; busy?: boolean }) {
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => { keep.current?.focus(); }, []);
  return <div className="settings-confirm" role="group" aria-label={confirmLabel} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); } }}>
    <p>{message}</p>
    <span className="settings-confirm-actions"><button type="button" ref={keep} disabled={busy} onClick={cancel}>{keepLabel}</button><button type="button" className="settings-danger" data-solid disabled={busy} aria-busy={busy || undefined} onClick={confirm}>{confirmLabel}</button></span>
  </div>;
}

export function SettingsList({ label, children }: { label: string; children: ReactNode }) { return <div className="settings-card settings-list" role="list" aria-label={label}>{children}</div>; }

export function ListItem({ icon, title, chip, meta, actions, children, ...data }: { icon?: ReactNode; title: ReactNode; chip?: ReactNode; meta?: ReactNode; actions?: ReactNode; children?: ReactNode } & { [key: `data-${string}`]: string }) {
  return <div className="settings-list-item" role="listitem" data-has-icon={icon ? true : undefined} {...data}>
    {icon && <span className="settings-list-icon" aria-hidden="true">{icon}</span>}
    <div className="settings-list-text"><div className="settings-list-title"><strong>{title}</strong>{chip}</div>{meta && <div className="settings-list-meta">{meta}</div>}</div>
    {actions && <div className="settings-list-actions">{actions}</div>}
    {children && <div className="settings-list-extra">{children}</div>}
  </div>;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="settings-empty" role="listitem"><b>{title}</b>{children && <span>{children}</span>}</div>;
}

export function SetupSteps({ steps }: { steps: ProviderSetupStep[] }) {
  const [copied, setCopied] = useState('');
  return <ol className="settings-steps">{steps.map((step, index) => <li key={index}>{step.text}
    {step.command && <span className="settings-code"><code>{step.command}</code><button type="button" aria-label={`Copy command for step ${index + 1}`} onClick={async () => { await navigator.clipboard.writeText(step.command!).catch(() => {}); setCopied(step.command!); }}>{copied === step.command ? 'Copied' : 'Copy'}</button></span>}
  </li>)}</ol>;
}
