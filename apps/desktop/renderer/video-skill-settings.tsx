import { useEffect, useState } from 'react';
import type { AppSettings } from '../../../packages/core/settings.ts';
import type { ProjectSkillCatalog } from '../../../packages/core/skills.ts';
import { AGENT_PROVIDER_IDS } from '../../../packages/core/settings.ts';
import { providerLabels } from '../../../src/agents/display-names.ts';
import { SelectField } from './inline-editor.tsx';
import { SettingRow, SettingsSection } from './settings-ui.tsx';

/** Settings → Agents: the installed skill Explain in video runs, listed from the default working directory like the skill picker. */
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
  const options = [...saved, ...skills];
  return <SettingsSection label="Explain in video" description="While a skill is chosen, a pull request’s right-click menu offers Explain in video and an agent session’s offers Explain what you built in video. The skill makes the video; the agent adds the MP4 to the map.">
    <SettingRow stack label="Video skill" description={`Listed from ${cwd ? 'the default working directory' : 'your most recent folder'}. A session uses the skill of the same name in its own folder.`} meta={value.skillId ? undefined : 'Not set'}>
      {/* Every provider is listed, so a saved one that is turned off stays chosen instead of being replaced. */}
      <SelectField searchable name="provider" values={{ provider: value.provider }} field={{ label: 'Video skill provider', kind: 'select', options: [...AGENT_PROVIDER_IDS],
        optionLabels: Object.fromEntries(AGENT_PROVIDER_IDS.map(id => [id, enabled[id] ? providerLabels[id] : `${providerLabels[id]} (turned off)`])) }}
        change={(_, next) => { const id = AGENT_PROVIDER_IDS.find(each => each === next); if (id && id !== value.provider) change({ provider: id, skillId: '', name: '' }); }} />
      <SelectField key={`${value.provider}:${options.map(skill => skill.id).join('\n')}`} searchable name="skillId" values={{ skillId: value.skillId }}
        field={{ label: 'Video skill', kind: 'select', options: options.map(skill => skill.id), optionLabels: Object.fromEntries(options.map(skill => [skill.id, skill.name])) }}
        change={(_, id) => change({ ...value, skillId: id, name: options.find(skill => skill.id === id)?.name ?? '' })} />
      {loading && <small>Finding skills…</small>}
      {error && <small>{error}</small>}
      {catalog && !skills.length && <small>No installed skills in this folder.</small>}
      {value.skillId && !enabled[value.provider] && <small>{providerLabels[value.provider]} is turned off, so the pull request entry is hidden until it is on again.</small>}
      {value.skillId && <button type="button" className="settings-quiet" onClick={() => change({ ...value, skillId: '', name: '' })}>Clear</button>}
    </SettingRow>
  </SettingsSection>;
}
