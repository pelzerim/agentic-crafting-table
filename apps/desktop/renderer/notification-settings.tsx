import { useEffect, useState } from 'react';
import type { NotificationPreferences } from '../notifications.ts';
import type { PluginDescription } from '../../../src/resource-plugins/describe.client.ts';
import { SettingRow, SettingsPage, SettingsSection, Switch, useRowControl } from './settings-ui.tsx';
import type { RowStatus } from './settings-ui.tsx';

function ModeSelect({ value, change }: { value: NotificationPreferences['mode']; change(value: NotificationPreferences['mode']): void }) {
  return <select {...useRowControl()} value={value} onChange={event => change(event.target.value as NotificationPreferences['mode'])}>
    <option value="background">When ACT is in the background</option><option value="always">Always</option><option value="off">Off</option>
  </select>;
}

function ReminderSelect({ value, change }: { value: NotificationPreferences['reminders']; change(value: NotificationPreferences['reminders']): void }) {
  return <select {...useRowControl()} value={value} onChange={event => change(event.target.value as NotificationPreferences['reminders'])}>
    <option value="sound">Notify with sound</option><option value="silent">Notify silently</option><option value="app">In the app only</option>
  </select>;
}

/** The one place that decides, per item type, whether opening an item marks its Needs me entry seen. */
function SeenOnOpen({ plugins, selected, change }: { plugins: PluginDescription[]; selected: string[]; change(ids: string[]): void }) {
  const types = [...plugins].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)), known = new Set(types.map(type => type.id));
  return <SettingsSection label="Opening an item marks it seen" description="For the checked types, opening an item or its web page removes it from Needs me, like Mark seen. Updates that arrive while it is open stay in Needs me."
    action={<><button type="button" className="settings-quiet" onClick={() => change([...selected, ...types.map(type => type.id).filter(id => !selected.includes(id))])}>All</button>{' · '}<button type="button" className="settings-quiet" onClick={() => change(selected.filter(id => !known.has(id)))}>None</button></>}>
    {types.map(type => <div key={type.id} className="settings-choice"><label><input type="checkbox" checked={selected.includes(type.id)} onChange={event => change(event.target.checked ? [...selected, type.id] : selected.filter(id => id !== type.id))} />{type.name}</label></div>)}
  </SettingsSection>;
}

export function NotificationSettings({ value, change, hidden, plugins }: { value: NotificationPreferences; change(value: NotificationPreferences): void; hidden: boolean; plugins: PluginDescription[] }) {
  const [delivery, setDelivery] = useState(''), [test, setTest] = useState<RowStatus>(), [testing, setTesting] = useState(false);
  useEffect(() => { let active = true; void window.craftingTable.notificationStatus().then(status => { if (active && status.error) setDelivery(status.error); }).catch(() => {}); return () => { active = false; }; }, []);
  const off = value.mode === 'off';
  return <SettingsPage id="Notifications" title="Notifications" description="Needs me has three tiers: Asking me (something is stopped until you act), My turn (work waits on you) and Finished (for your information). Asking me and My turn are counted and can appear as macOS notifications; click one to open ACT at its item." hidden={hidden}>
    <SettingsSection label="macOS notifications">
      <SettingRow label="Show notifications" description="macOS permissions and Focus still decide whether banners and sounds appear." status={delivery ? { tone: 'error', text: delivery } : undefined}><ModeSelect value={value.mode} change={mode => change({ ...value, mode })} /></SettingRow>
      <SettingRow dependent disabled={off} label="Needs me updates" description="New Asking me and My turn items."><Switch disabled={off} checked={value.needsMe} change={needsMe => change({ ...value, needsMe })} /></SettingRow>
      <SettingRow label="Reminders" description="A notification when a reminder comes due, also while ACT is in front. The rail slot and the sheet always show it."><ReminderSelect value={value.reminders} change={reminders => change({ ...value, reminders })} /></SettingRow>
      <SettingRow dependent disabled={off} label="Completion announcements" description="Recovery and other bottom-left notices as macOS notifications. Finished work itself appears as a banner only when it is counted below."><Switch disabled={off} checked={value.announcements} change={announcements => change({ ...value, announcements })} /></SettingRow>
      <SettingRow dependent disabled={off} label="Play a sound"><Switch disabled={off} checked={value.sound} change={sound => change({ ...value, sound })} /></SettingRow>
      <SettingRow label="Dock badge" description="Show the Needs me number (Asking me and My turn) on the app icon."><Switch checked={value.dockBadge} change={dockBadge => change({ ...value, dockBadge })} /></SettingRow>
    </SettingsSection>
    <SettingsSection label="Finished work" description="Finished turns and approvals are always listed in Needs me, in their own group with a dim dot, until you mark them seen.">
      <SettingRow label="Also count finished work" description="Adds Finished to the Needs me number on the rail, the Dock badge and dashboards, and lets it raise a macOS notification. Off by default: finished work only shows its quiet notice at the bottom left of the map."><Switch checked={value.countFinished} change={countFinished => change({ ...value, countFinished })} /></SettingRow>
    </SettingsSection>
    <SeenOnOpen plugins={plugins} selected={value.seenOnOpen} change={seenOnOpen => change({ ...value, seenOnOpen })} />
    <SettingsSection label="Test">
      <SettingRow label="Test notification" immediate description="Sends one notification now, even when notifications are off." status={test}>
        <button type="button" disabled={testing} onClick={async () => {
          setTesting(true); setTest({ tone: 'pending', text: 'Sending…' });
          try { const result = await window.craftingTable.notificationTest(); setTest(result.error ? { tone: 'error', text: result.error } : result.supported ? { tone: 'ok', text: 'Test requested. If no banner appears, check System Settings → Notifications → Agentic Crafting Table.' } : { tone: 'error', text: 'Native notifications are unavailable on this system.' }); }
          catch { setTest({ tone: 'error', text: 'Could not request a test notification.' }); } finally { setTesting(false); }
        }}>Send test notification</button>
      </SettingRow>
    </SettingsSection>
  </SettingsPage>;
}
