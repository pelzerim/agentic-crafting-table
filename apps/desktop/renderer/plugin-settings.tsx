import { fieldDefaults } from '../../../src/resource-plugins/define.ts';
import type { PluginDescription } from '../../../src/resource-plugins/describe.client.ts';
import type { JsonObject, ResourceField } from '../../../src/resource-plugins/types.ts';
import type { PluginSettingsPages } from './settings-changes.ts';
import { NumberField, SettingRow, SettingsSection, Switch, TextField, useRowControl } from './settings-ui.tsx';

export type PluginSettingsSection = NonNullable<PluginDescription['settingsSections']>[number];

/** Each package's settings section, by owner, with the page that shows it. */
export function pluginSettingsPages(plugins: readonly PluginDescription[]): PluginSettingsPages {
  return Object.fromEntries(plugins.flatMap(plugin => (plugin.settingsSections ?? []).map(section => [section.owner, { page: plugin.id, defaults: fieldDefaults(section.fields) }])));
}

function Select({ field, value, change, disabled }: { field: ResourceField; value: string; change(value: string): void; disabled?: boolean }) {
  return <select {...useRowControl()} disabled={disabled} value={value} onChange={event => change(event.target.value)}>
    {(field.options ?? []).map(option => <option key={option} value={option}>{field.optionLabels?.[option] ?? option}</option>)}
  </select>;
}
function TextArea({ field, value, change, disabled }: { field: ResourceField; value: string; change(value: string): void; disabled?: boolean }) {
  return <textarea {...useRowControl()} disabled={disabled} rows={field.rows ?? 4} value={value} placeholder={field.placeholder} required={field.required} onChange={event => change(event.target.value)} />;
}

/** Any of the field's options, kept in declared order. */
function Choices({ field, value, change, disabled }: { field: ResourceField; value: readonly string[]; change(value: string[]): void; disabled?: boolean }) {
  const options = field.options ?? [];
  return <div {...useRowControl()} className="settings-choices" role="group" aria-label={field.label}>
    {options.map(option => <label key={option}><input type="checkbox" disabled={disabled} checked={value.includes(option)}
      onChange={event => change(options.filter(entry => entry === option ? event.target.checked : value.includes(entry)))} />{field.optionLabels?.[option] ?? option}</label>)}
  </div>;
}

function Field({ field, value, change, disabled }: { field: ResourceField; value: JsonObject[string] | undefined; change(value: JsonObject[string]): void; /** Its `enabledBy` switch is off. */ disabled?: boolean }) {
  const label = (option: string) => field.optionLabels?.[option] ?? option;
  const meta = field.default === undefined ? undefined : field.kind === 'boolean' ? `${field.default ? 'On' : 'Off'} by default`
    : typeof field.default === 'object' ? field.default.length === field.options?.length ? 'All on by default' : `Default ${field.default.map(label).join(', ') || 'none'}`
    : `Default ${(field.kind === 'select' ? label(String(field.default)) : String(field.default)) || 'empty'}`;
  const row = { label: field.label, description: field.description, meta, ...(field.enabledBy ? { dependent: true, disabled } : {}) };
  if (field.kind === 'boolean') return <SettingRow {...row}><Switch disabled={disabled} checked={value === true} change={change} /></SettingRow>;
  if (field.kind === 'number') return <SettingRow {...row}>
    <NumberField aria-label={field.label} disabled={disabled} min={field.min} max={field.max} step={field.integer ? 1 : 'any'} required={field.required} value={typeof value === 'number' ? value : ''} onChange={event => change(event.target.valueAsNumber)} />
  </SettingRow>;
  if (field.kind === 'select') return <SettingRow {...row}><Select field={field} disabled={disabled} value={String(value ?? '')} change={change} /></SettingRow>;
  if (field.kind === 'multiselect') {
    const chosen = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
    return <SettingRow stack {...row} status={!disabled && !chosen.length && field.emptyHint ? { tone: 'pending', text: field.emptyHint } : undefined}><Choices field={field} disabled={disabled} value={chosen} change={change} /></SettingRow>;
  }
  return <SettingRow stack {...row}>
    {field.multiline ? <TextArea field={field} disabled={disabled} value={String(value ?? '')} change={change} />
      : <TextField disabled={disabled} value={String(value ?? '')} placeholder={field.placeholder} required={field.required} pattern={field.pattern} inputMode={field.kind === 'url' ? 'url' : undefined} onChange={event => change(event.target.value)} />}
  </SettingRow>;
}

/** Declared package settings, rendered from their fields; no item type needs its own page code. */
export function PluginSettings({ section, value, change, disconnected }: { section: PluginSettingsSection; value: JsonObject | undefined; change(value: JsonObject): void; /** Name of the account provider this section needs while it has no connected account. */ disconnected?: string }) {
  const current = { ...fieldDefaults(section.fields), ...value };
  return <SettingsSection label={section.label} description={section.description}>
    {disconnected && section.connectionHint && <SettingRow label={`${disconnected} is not connected`} description={section.connectionHint} />}
    {Object.entries(section.fields).map(([key, field]) => <Field key={key} field={field} value={current[key]} disabled={field.enabledBy !== undefined && current[field.enabledBy] !== true} change={next => change({ ...current, [key]: next })} />)}
  </SettingsSection>;
}
