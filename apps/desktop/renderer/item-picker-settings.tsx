import { itemChoices, normalizedQuickIds, MAX_QUICK_ITEMS } from '../../../packages/core/item-picker.ts';
import type { PluginDescription } from '../../../src/resource-plugins/describe.client.ts';
import { SettingsSection } from './settings-ui.tsx';

export function ItemPickerSettings({ plugins, selected, change }: { plugins: PluginDescription[]; selected: string[]; change(ids: string[]): void }) {
  const available = itemChoices(plugins); selected = normalizedQuickIds(available, selected);
  const catalog = new Map(available.map(choice => [choice.id, choice]));
  const ordered = [...selected.map(id => catalog.get(id) ?? { id, name: `Unavailable (${id})` }), ...available.filter(choice => !selected.includes(choice.id))];
  const move = (index: number, offset: number) => { const next = [...selected]; [next[index], next[index + offset]] = [next[index + offset], next[index]]; change(next); };
  return <SettingsSection label="New item shortcuts" className="settings-section picker-settings" description={`Choose up to ${MAX_QUICK_ITEMS} types for the first ring, in order. Everything else stays in All.`}>
    {ordered.map(choice => {
      const index = selected.indexOf(choice.id), checked = index >= 0;
      return <div key={choice.id} className="settings-choice"><label><input type="checkbox" checked={checked} disabled={!checked && selected.length >= MAX_QUICK_ITEMS} onChange={event => change(event.target.checked ? [...selected, choice.id] : selected.filter(id => id !== choice.id))} />{choice.name}</label>
        {checked && <span className="settings-choice-order"><span className="settings-count">{index + 1}</span><button type="button" aria-label={`Move ${choice.name} earlier`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button><button type="button" aria-label={`Move ${choice.name} later`} disabled={index === selected.length - 1} onClick={() => move(index, 1)}>↓</button></span>}
      </div>;
    })}
  </SettingsSection>;
}
