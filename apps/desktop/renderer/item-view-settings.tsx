import type { ReactNode } from 'react';
import { itemViewProfiles } from '../../../packages/core/item-views.ts';
import type { ItemViewSizes } from '../../../packages/core/item-views.ts';
import type { PluginDescription } from '../../../src/resource-plugins/describe.client.ts';
import { configuredMapProfile, mapSizeLimits } from '../../../packages/core/item-map-sizes.ts';
import type { ItemMapSizes } from '../../../packages/core/item-map-sizes.ts';
import { ITEM_SIZES } from '../../../src/graph/graph.ts';
import { AdvancedDisclosure, NumberField, SettingRow, SettingsPage, SettingsSection, useRowControl } from './settings-ui.tsx';
import { PluginSettings } from './plugin-settings.tsx';
import type { JsonObject } from '../../../src/resource-plugins/types.ts';

const title = (size: string) => size[0].toUpperCase() + size.slice(1);

function DefaultSize({ value, choices, change }: { value: string; choices: string[]; change(value: string): void }) {
  return <select {...useRowControl()} value={value} onChange={event => change(event.target.value)}>{choices.map(size => <option key={size} value={size}>{title(size)}</option>)}</select>;
}

export function ItemViewSettings({ plugins, sizes, change, mapSizes, changeMap, claude, codex, pullRequest, pluginSettings, changePluginSettings, disconnected, selected, advanced, toggleAdvanced }: { plugins: PluginDescription[]; /** A provider's name while it has no connected account. */ disconnected(providerId?: string): string | undefined; sizes: ItemViewSizes; change(value: ItemViewSizes): void; mapSizes: ItemMapSizes; changeMap(value: ItemMapSizes): void; claude: ReactNode; codex: ReactNode; pullRequest: ReactNode; pluginSettings: Readonly<Record<string, JsonObject>>; changePluginSettings(owner: string, value: JsonObject): void; selected: string; advanced: Set<string>; toggleAdvanced(id: string): void }) {
  const profiles = plugins.flatMap(plugin => itemViewProfiles(plugin).map(profile => ({ ...profile, plugin }))).sort((a, b) => a.name.localeCompare(b.name));
  return <>{profiles.map(profile => {
    const value = sizes[profile.key] ?? profile, expands = profile.mode !== 'inline' && profile.mode !== 'browser';
    const map = configuredMapProfile(profile.plugin, profile.key, mapSizes), base = configuredMapProfile(profile.plugin, profile.key);
    const choices = ITEM_SIZES.filter(size => map.sizes[size]);
    const saved = mapSizes[profile.key] ?? { sizes: {} };
    const view = (axis: 'width' | 'height', input: number) => change({ ...sizes, [profile.key]: { width: value.width, height: value.height, [axis]: input } });
    return <SettingsPage key={profile.key} id={profile.key} crumb="Items" title={profile.name} hidden={selected !== profile.key}
      description={<span className="item-purpose">{profile.plugin.settingsHelp?.replaceAll('{name}', profile.name) ?? `Use ${profile.name} to keep related work on the map. Open the item to view its content and connect it to other items for context.`}</span>}>
      <div role="group" aria-label={`${profile.name} settings`}>
        {profile.key === 'github.pull-request' && pullRequest}
        {profile.key === 'agent.session:claude' && claude}
        {profile.key === 'agent.session:codex' && codex}
        {profile.plugin.settingsSections?.map(section => <PluginSettings key={section.owner} section={section} value={pluginSettings[section.owner]} change={value => changePluginSettings(section.owner, value)} disconnected={disconnected(profile.plugin.connectionProvider)} />)}
        <AdvancedDisclosure open={advanced.has(profile.key)} toggle={() => toggleAdvanced(profile.key)} count={(expands ? 2 : 0) + (choices.length > 1 ? 1 : 0) + choices.length * 2}>
          {expands ? <SettingsSection label={profile.mode === 'card' ? 'Expanded card' : 'Expanded view'} description={profile.mode === 'card' ? 'Grows near the note on the map, leaving the surrounding neighborhood visible.' : undefined}>
            <SettingRow label="Size" description="In screen pixels; shrinks to fit your window. Map positions stay fixed."
              meta={sizes[profile.key] ? <>Changed · <button type="button" className="settings-quiet" onClick={() => { const next = { ...sizes }; delete next[profile.key]; change(next); }}>Reset view size</button></> : `Default ${profile.width} × ${profile.height}`}>
              <span className="settings-pair">
                <NumberField aria-label="Width" unit="w" min={profile.minWidth ?? 320} max="2560" required value={value.width} onChange={event => view('width', Number(event.target.value))} />×
                <NumberField aria-label="Height" unit="h" min="240" max="1600" required value={value.height} onChange={event => view('height', Number(event.target.value))} />
              </span>
            </SettingRow>
          </SettingsSection> : <SettingsSection label="Expanded view" bare description={profile.mode === 'inline' ? 'Edited directly on the map; this item never opens an expanded view.' : 'Opens in the browser, so there is no expanded view to size.'}>{null}</SettingsSection>}
          <SettingsSection label="Map bubble" aria-label={`${profile.name} map sizes`} description="Each size belongs to this item type, in map pixels. Growing a bubble makes room around it."
            action={<button type="button" className="settings-quiet" onClick={() => { const next = { ...mapSizes }; delete next[profile.key]; changeMap(next); }}>Reset map sizes</button>}>
            {choices.length === 1 ? <SettingRow label={`${title(choices[0])} only`} description={map.sizes[choices[0]]!.description} />
              : <SettingRow label="Default map size" description="The size new items of this type start with."><DefaultSize value={map.defaultSize} choices={choices} change={size => changeMap({ ...mapSizes, [profile.key]: { ...saved, defaultSize: size as typeof map.defaultSize } })} /></SettingRow>}
            {choices.map(size => {
              const preset = map.sizes[size]!, limits = mapSizeLimits(base.sizes[size]!), draft = saved.sizes[size] ?? preset;
              const resize = (axis: 'width' | 'height', input: number) => changeMap({ ...mapSizes, [profile.key]: { ...saved, sizes: { ...saved.sizes, [size]: { width: draft.width, height: draft.height, [axis]: input } } } });
              return <SettingRow key={size} label={title(size)} description={preset.description} meta={`Width ${limits.minWidth}–${limits.maxWidth} · height ${limits.minHeight}–${limits.maxHeight}`}>
                <span className="settings-pair">
                  <NumberField aria-label={`${title(size)} width`} unit="w" required min={limits.minWidth} max={limits.maxWidth} value={Number.isFinite(draft.width) ? draft.width : ''} onChange={event => resize('width', event.target.valueAsNumber)} />×
                  <NumberField aria-label={`${title(size)} height`} unit="h" required min={limits.minHeight} max={limits.maxHeight} value={Number.isFinite(draft.height) ? draft.height : ''} onChange={event => resize('height', event.target.valueAsNumber)} />
                </span>
              </SettingRow>;
            })}
          </SettingsSection>
        </AdvancedDisclosure>
      </div>
    </SettingsPage>;
  })}</>;
}
