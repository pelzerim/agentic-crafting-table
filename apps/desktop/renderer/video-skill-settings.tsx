import { useEffect, useState } from 'react';
import type { AppSettings } from '../../../packages/core/settings.ts';
import type { ProjectSkillCatalog } from '../../../packages/core/skills.ts';
import { AGENT_PROVIDER_IDS } from '../../../packages/core/settings.ts';
import { providerLabels } from '../../../src/agents/display-names.ts';
import { PixelCombobox } from './ui/combobox.tsx';
import { SettingRow, SettingsSection } from './settings-ui.tsx';

const BUILT_IN = 'built-in:video';

/** Settings → Agents: what makes Explain in video's videos, the built-in video maker unless one of your own skills is chosen. */
export function VideoSkillSettings({ value, enabled, cwd, visible, change }: { value: AppSettings['videoSkill']; enabled: AppSettings['agentProviders']; cwd: string; visible: boolean; change(value: AppSettings['videoSkill']): void }) {
  const [catalog, setCatalog] = useState<ProjectSkillCatalog>(), [loading, setLoading] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false; setCatalog(undefined); setError('');
    if (!visible) return;
    setLoading(true);
    void window.craftingTable.projectSkills({ provider: value.provider, ...(cwd ? { cwd } : {}) }).then(result => { if (!cancelled) setCatalog(result); })
      .catch(error => { if (!cancelled) setError(error.message); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [visible, value.provider, cwd]);
  const skills = (catalog?.skills ?? []).filter(skill => !skill.unavailable || skill.id === value.skillId);
  const saved = value.skillId && !skills.some(skill => skill.id === value.skillId) ? [{ id: value.skillId, name: value.name }] : [];
  const options = [{ id: BUILT_IN, name: 'Built-in' }, ...saved, ...skills];
  const off = !enabled[value.provider];
  return <SettingsSection label="Explain in video" description="Right-click a pull request for Explain in video, or an agent session for Explain what you built in video. An agent makes a short narrated video and adds it to the map. The first time, it asks you before downloading the tools it needs.">
    <SettingRow stack label="Agent" description={off ? `${providerLabels[value.provider]} is turned off, so the pull request entry is hidden until it is on again.` : 'Makes a pull request’s video. A session makes its own.'}>
      {/* Every provider is listed, so a saved one that is turned off stays chosen instead of being replaced. */}
      <PixelCombobox label="Video agent" value={value.provider} options={AGENT_PROVIDER_IDS.map(id => ({ value: id, label: enabled[id] ? providerLabels[id] : `${providerLabels[id]} (turned off)` }))}
        change={next => { const id = AGENT_PROVIDER_IDS.find(each => each === next); if (id && id !== value.provider) change({ provider: id, skillId: '', name: '' }); }} />
    </SettingRow>
    <SettingRow stack label="Video maker" description={loading ? 'Finding your skills…' : error ? `Your own skills could not be listed. ${error}` : 'Built-in needs no setup. One of your own skills gets the pull request’s link instead.'}
      meta={value.skillId ? <button type="button" className="settings-quiet" onClick={() => change({ ...value, skillId: '', name: '' })}>Clear</button> : undefined}>
      <PixelCombobox label="Video maker" value={value.skillId || BUILT_IN} options={options.map(skill => ({ value: skill.id, label: skill.name }))}
        change={id => change(id === BUILT_IN ? { ...value, skillId: '', name: '' } : { ...value, skillId: id, name: options.find(skill => skill.id === id)?.name ?? '' })} />
    </SettingRow>
  </SettingsSection>;
}
