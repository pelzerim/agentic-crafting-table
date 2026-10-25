import { NotificationSettings } from './notification-settings.tsx';
import { AdvancedDisclosure, DefaultMeta, InlineConfirm, NumberField, SettingRow, SettingsPage, SettingsSection, SliderField, Switch, TextField, useRowControl } from './settings-ui.tsx';
import { DirectoryField, useDirectoryChoices } from './ui/directory-field.tsx';
import type { RowStatus } from './settings-ui.tsx';
import { DEFAULT_BELOW_ANIMATION, DEFAULT_TERMINAL_SCROLLBACK, TERMINAL_SCROLLBACK_CHOICES, notificationSettingsSchema, settingsSchema } from '../../../packages/core/settings.ts';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AppInfo } from '../bridge.ts';
import { LARGE_ITEM_WIDTH } from '../../../src/graph/footprints.ts';
import type { SettingsSnapshot } from '../../../packages/core/settings.ts';
import type { AppSettings } from '../../../packages/core/settings.ts';
import { REVIEW_AGENTS } from '../../../src/pull-requests/review-agents.ts';
import { STANDUP_ENABLED } from '../../../packages/core/standup.ts';
import { UPDATE_COMMAND } from '../../../packages/core/updates.ts';
import type { UpdateStatus } from '../../../packages/core/updates.ts';
import { Button } from './ui/button.tsx';
import { claudePermissionSettings } from '../../../packages/core/claude-settings.ts';
import { PanelHeader } from './ui/floating-panel.tsx';
import { ErrorNotice } from './ui/notice.tsx';
import { Segmented } from './ui/segmented.tsx';
import { useOverlayFocus } from './ui/overlay-focus.ts';
import { useMovablePanel } from './use-movable-panel.ts';
import { PerformanceDiagnostics } from './performance-diagnostics.tsx';
import type { ProviderDescription } from '../../../packages/core/connections.ts';
import { ItemPickerSettings } from './item-picker-settings.tsx';
import { MenuOrderSettings } from './menu-order-settings.tsx';
import type { PluginDescription } from '../../../src/resource-plugins/describe.client.ts';
import { ProviderSettings } from './provider-settings.tsx';
import { itemViewProfiles } from '../../../packages/core/item-views.ts';
import { SettingsTree } from './settings-tree.tsx';
import { draftChanges } from './settings-changes.ts';
import { ItemViewSettings } from './item-view-settings.tsx';
import { pluginSettingsPages } from './plugin-settings.tsx';
import { SessionManager } from './session-manager.tsx';
import { RecordingStorage } from './recording-storage.tsx';
import { PluginsPage } from './plugin-manager.tsx';
import type { PluginInstallRequest } from './plugin-manager.tsx';
import { LocalDiagnostics, SupportReport } from './local-diagnostics.tsx';
import { DEFAULT_NEIGHBORHOOD_APPEARANCE } from '../../../src/graph/neighborhood-fill.ts';
import { DASHBOARD_ZOOM_RANGE, DEFAULT_MAP_DASHBOARDS } from '../../../src/graph/project-dashboard.ts';
import type { DashboardSections } from '../../../src/graph/project-dashboard.ts';

const SUMMARY_DEFAULTS = settingsSchema.parse({}).summaries, TERMINAL_DEFAULTS = settingsSchema.parse({}).terminal;
function ScrollbackSelect({ value, change }: { value: AppSettings['terminal']['scrollback']; change(value: AppSettings['terminal']['scrollback']): void }) {
  return <select {...useRowControl()} value={value} onChange={event => change(Number(event.target.value) as AppSettings['terminal']['scrollback'])}>
    {TERMINAL_SCROLLBACK_CHOICES.map(lines => <option key={lines} value={lines}>{lines.toLocaleString('en-US')} lines</option>)}
  </select>;
}
function LaunchArguments({ value, change }: { value: string; change(value: string): void }) {
  return <textarea {...useRowControl()} rows={5} value={value} placeholder={'--effort\nhigh\n--verbose'} onChange={event => change(event.target.value)} />;
}
const DASHBOARD_SECTION_CHOICES: [keyof DashboardSections, string][] = [['needsYou', 'Needs me'], ['working', 'Working'], ['todos', 'To-dos'], ['plots', 'Plots'], ['pipelines', 'Pull requests'], ['tallies', 'Tickets']];
const percent = (value: number) => `${Math.round(value * 100)}%`, pixels = (value: number) => `${value} px`;

export function Settings({ close, providers, plugins, openArchive, clearOverlaps, nodeTitles, initialSessionView, sessionRequestId, installRequest, initialSection, updates: updatesProp }: { nodeTitles: Map<string, string>; initialSessionView?: 'active' | 'archived'; sessionRequestId?: number; installRequest?: PluginInstallRequest; initialSection?: string; updates?: { status?: UpdateStatus; check(): Promise<unknown> }; close(): void; providers: ProviderDescription[]; plugins: PluginDescription[]; openArchive(): void; clearOverlaps(): Promise<void> }) {
  const [saved, setSaved] = useState<SettingsSnapshot>(), [remote, setRemote] = useState(true), [awake, setAwake] = useState(false);
  const [notifications, setNotifications] = useState(notificationSettingsSchema.parse({}));
  const [autoMode, setAutoMode] = useState(true);
  const [terminal, setTerminal] = useState(TERMINAL_DEFAULTS), [assistive, setAssistive] = useState(false);
  useEffect(() => {
    let mounted = true;
    const off = window.craftingTable.onAssistiveTechnology(enabled => { if (mounted) setAssistive(enabled); });
    window.craftingTable.assistiveTechnology().then(enabled => { if (mounted) setAssistive(enabled); }).catch(() => {});
    return () => { mounted = false; off(); };
  }, []);
  const [appInfo, setAppInfo] = useState<AppInfo>(), [infoError, setInfoError] = useState('');
  const [checkingUpdates, setCheckingUpdates] = useState(false), [updateCheck, setUpdateCheck] = useState(true), updates = updatesProp?.status;
  const checkUpdates = () => { setCheckingUpdates(true); updatesProp?.check().catch(() => {}).finally(() => setCheckingUpdates(false)); };
  useEffect(() => { let mounted = true; window.craftingTable.appInfo().then(info => { if (mounted) setAppInfo(info); }).catch(error => { if (mounted) setInfoError(String(error)); }); return () => { mounted = false; }; }, []);
  const sections = ['Connections', 'Items', 'Map', 'Notifications', 'AI features', 'General', 'Plugins', 'Data & diagnostics'] as const;
  const [section, setSection] = useState<string>(installRequest ? 'Plugins' : initialSessionView ? 'Data & diagnostics' : initialSection ?? 'Connections');
  useEffect(() => { if (initialSessionView) setSection('Data & diagnostics'); }, [initialSessionView, sessionRequestId]);
  useEffect(() => { if (installRequest) setSection('Plugins'); }, [installRequest?.id]);
  const [expanded, setExpanded] = useState(new Set<string>());
  const content = useRef<HTMLDivElement>(null);
  const invalidField = useRef<HTMLInputElement | undefined>(undefined);
  const profiles = useMemo(() => plugins.flatMap(itemViewProfiles).sort((a, b) => a.name.localeCompare(b.name)), [plugins]);
  const entries = useMemo(() => sections.map(name => ({ id: name, label: name, ...(name === 'Items' ? { children: profiles.map(profile => ({ id: profile.key, label: profile.name })) } : {}) })), [profiles]);
  const selectSection = (id: string) => {
    setSection(id); setDiscarding(false);
    if (matchMedia('(max-width: 860px)').matches && id !== 'Items' && !profiles.some(profile => profile.key === id)) setExpanded(old => { const next = new Set(old); next.delete('Items'); return next; });
    if (id === 'Items' || profiles.some(profile => profile.key === id)) setExpanded(old => new Set([...old, 'Items']));
  };
  const toggleSection = (id: string) => {
    setExpanded(old => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  };
  const [advanced, setAdvanced] = useState(new Set<string>());
  const openAdvanced = (id: string) => setAdvanced(old => old.has(id) ? old : new Set([...old, id]));
  const toggleAdvanced = (id: string) => setAdvanced(old => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const [belowAnimation, setBelowAnimation] = useState<AppSettings['belowAnimation']>({ ...DEFAULT_BELOW_ANIMATION });
  const [mapDashboards, setMapDashboards] = useState<AppSettings['mapDashboards']>({ ...DEFAULT_MAP_DASHBOARDS });
  const [undermapLayout, setUndermapLayout] = useState<AppSettings['undermapLayout']>('mirror');
  const [workingMark, setWorkingMark] = useState<AppSettings['workingMark']>({ animal: 'sheep', helpers: 'kits' });
  useEffect(() => { content.current?.scrollTo(0, 0); }, [section]);
  useEffect(() => {
    const field = invalidField.current;
    if (field && field.closest<HTMLElement>('[data-settings-section]')?.dataset.settingsSection === section) {
      invalidField.current = undefined;
      field.focus(); field.reportValidity();
    }
  }, [section, advanced]);
  const [itemMapSizes, setItemMapSizes] = useState<AppSettings['itemMapSizes']>({});
  const [conversation, setConversation] = useState<AppSettings['pullRequestConversation']>({ comments: true, threads: true, reviewBodies: true, bots: false, activity: false });
  const [warnBeforeClosing, setWarnBeforeClosing] = useState(true), [doubleClickOpensWeb, setDoubleClickOpensWeb] = useState(false), [snapToGrid, setSnapToGrid] = useState(false), [itemDelete, setItemDelete] = useState(false), [autoReview, setAutoReview] = useState<AppSettings['autoReview']>({ enabled: false, agents: ['claude'] }), [mapPlots, setMapPlots] = useState(true), [hideImpliedLinks, setHideImpliedLinks] = useState(true);
  const [itemViews, setItemViews] = useState<AppSettings['itemViews']>({});
  const [pluginSettings, setPluginSettings] = useState<AppSettings['plugins']>({}), pluginPages = useMemo(() => pluginSettingsPages(plugins), [plugins]);
  const [quickIds, setQuickIds] = useState<string[]>([]), [menus, setMenus] = useState<AppSettings['menus']>({ order: {}, layout: {}, hidden: {} });
  const [defaultDirectory, setDefaultDirectory] = useState(''), directories = useDirectoryChoices();
  const [padding, setPadding] = useState(String(LARGE_ITEM_WIDTH));
  const [neighborhood, setNeighborhood] = useState({ ...DEFAULT_NEIGHBORHOOD_APPEARANCE });
  const [summaries, setSummaries] = useState<AppSettings['summaries']>();
  const [diagnostics, setDiagnostics] = useState<AppSettings['diagnostics']>();
  const [argumentsText, setArgumentsText] = useState(''), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const [repairing, setRepairing] = useState(false), [confirmRepair, setConfirmRepair] = useState(false), [mapStatus, setMapStatus] = useState<RowStatus>();
  const { panel, position, dragging, handle } = useMovablePanel({ x: Math.max(20, innerWidth / 2 - 410), y: 80 });
  useEffect(() => {
    let mounted = true;
    window.craftingTable.settingsRead().then(snapshot => {
      if (!mounted) return;
      setWarnBeforeClosing(snapshot.value.warnBeforeClosing); setConversation(snapshot.value.pullRequestConversation); setDiagnostics(snapshot.value.diagnostics); setItemViews(snapshot.value.itemViews); setItemMapSizes(snapshot.value.itemMapSizes); setPluginSettings(snapshot.value.plugins);
      setNeighborhood(snapshot.value.neighborhoodAppearance); setBelowAnimation(snapshot.value.belowAnimation); setUndermapLayout(snapshot.value.undermapLayout); setWorkingMark(snapshot.value.workingMark); setMapDashboards(snapshot.value.mapDashboards); setMapPlots(snapshot.value.mapPlots); setHideImpliedLinks(snapshot.value.hideImpliedLinks); setDoubleClickOpensWeb(snapshot.value.doubleClickOpensWeb); setSnapToGrid(snapshot.value.snapToGrid); setItemDelete(snapshot.value.itemDelete); setAutoReview(snapshot.value.autoReview); setTerminal(snapshot.value.terminal);
      setAutoMode(snapshot.value.claude.autoMode); setNotifications(snapshot.value.notifications);
      setQuickIds(snapshot.value.quickItemTypes); setMenus(snapshot.value.menus); setDefaultDirectory(snapshot.value.defaultWorkingDirectory); setSummaries(snapshot.value.summaries); setPadding(String(snapshot.value.neighborhoodPadding)); setSaved(snapshot); setRemote(snapshot.value.claude.remoteControl); setAwake(snapshot.value.keepAwake); setUpdateCheck(snapshot.value.updates.check); setArgumentsText(snapshot.value.claude.arguments.join('\n'));
    }).catch(error => { if (mounted) setError(error.message); });
    return () => { mounted = false; };
  }, []);
  const limited = Boolean(summaries && (summaries.enabled || summaries.agentTitles || summaries.attachTitles || summaries.plotNames || (STANDUP_ENABLED && summaries.standupDigests)));
  const claude = { remoteControl: remote, autoMode, arguments: argumentsText.split(/\r?\n/).map(value => value.trim()).filter(Boolean) };
  const permission = claudePermissionSettings(claude);
  const draft = saved && { ...saved.value, notifications, warnBeforeClosing, pullRequestConversation: conversation, itemViews, itemMapSizes, menus, plugins: pluginSettings, diagnostics: diagnostics!, quickItemTypes: quickIds, defaultWorkingDirectory: defaultDirectory.trim(), summaries: summaries!, neighborhoodPadding: Number(padding), neighborhoodAppearance: neighborhood, belowAnimation, undermapLayout, workingMark, mapDashboards, mapPlots, hideImpliedLinks, doubleClickOpensWeb, snapToGrid, itemDelete, autoReview, terminal, keepAwake: awake, claude, updates: { check: updateCheck } };
  const changes = useMemo(() => saved ? draftChanges(saved.value, draft!, pluginPages) : [], [saved, JSON.stringify(draft)]);
  const dirty = changes.length > 0, [discarding, setDiscarding] = useState(false);
  const requestClose = () => { if (dirty) setDiscarding(true); else close(); };
  const overlayKeys = useOverlayFocus(panel, { close: requestClose, modal: true });
  const [invalid, setInvalid] = useState<string[]>([]);
  useLayoutEffect(() => {
    const pages = [...(panel.current?.querySelectorAll<HTMLInputElement>('input, select, textarea') ?? [])].filter(field => !field.disabled && !field.validity.valid)
      .map(field => field.closest<HTMLElement>('[data-settings-section]')?.dataset.settingsSection ?? '');
    setInvalid(old => old.join('\n') === pages.join('\n') ? old : pages);
  });
  const label = (id: string) => profiles.find(profile => profile.key === id)?.name ?? id;
  const named = (ids: string[]) => [...new Set(ids.filter(Boolean))].map(label).join(', ');
  const marked = (id: string) => invalid.includes(id) ? 'invalid' as const : changes.includes(id) ? 'dirty' as const : undefined;
  const tree = entries.map(entry => ({ ...entry, marker: marked(entry.id) ?? (entry.children && !expanded.has(entry.id) ? entry.children.map(child => marked(child.id)).find(Boolean) : undefined), children: entry.children?.map(child => ({ ...child, marker: marked(child.id) })) }));
  return <form onInvalid={event => {
    const field = event.target as HTMLInputElement, pane = field.closest<HTMLElement>('[data-settings-section]');
    const collapsed = field.closest<HTMLElement>('[data-advanced]')?.hidden;
    if (pane && (pane.hidden || collapsed)) {
      if (collapsed) openAdvanced(pane.dataset.settingsSection!);
      event.preventDefault();
      if (!invalidField.current && pane) { invalidField.current = field; selectSection(pane.dataset.settingsSection!); }
    }
  }} className="inline-editor floating-panel settings-editor" role="dialog" aria-modal="true" aria-label="Settings" ref={panel} data-dragging={dragging} style={{ left: position.x, top: position.y }} onKeyDown={overlayKeys} onSubmit={async event => {
    event.preventDefault(); if (!saved || saving) return;
    setSaving(true); setError('');
    try {
      await window.craftingTable.settingsWrite({ expectedRevision: saved.revision, value: draft! });
      close();
    } catch (error) { setError((error as Error).message); } finally { setSaving(false); }
  }}>
    <PanelHeader title="Settings" close={requestClose} closeLabel="Close settings" handle={handle} />
    {!saved ? <p>{error || 'Loading settings…'}</p> : <>
      <div className="settings-layout">
      <SettingsTree entries={tree} selected={section} expanded={expanded} select={selectSection} toggle={toggleSection} />
      <div className="settings-content" ref={content}>
      <ProviderSettings hidden={section !== 'Connections'} providers={providers} connections={saved.value.connections} applied={snapshot => setSaved(previous => previous && {
        revision: snapshot.revision === previous.revision + 1 ? snapshot.revision : previous.revision, value: { ...previous.value, connections: snapshot.value.connections } })} />
      <SettingsPage id="Items" title="Items" description="Choose which item types come first when you create an item and how each type’s right-click menu is ordered. Select a type in the sidebar to configure its sizes and options." hidden={section !== 'Items'}>
        <ItemPickerSettings plugins={plugins} selected={quickIds} change={setQuickIds} />
        <MenuOrderSettings plugins={plugins} value={menus} change={setMenus} />
        <SettingsSection label="Working directory" description="New agents, terminals and skill runs start in their project’s folder. Without one, they use this default, then your most recent folder.">
          <SettingRow stack label="Default working directory" description="Must be an existing folder. Working directory fields also offer your 10 most recent folders." meta={defaultDirectory ? undefined : 'Not set'}>
            <RowDirectoryField label="Default working directory" value={defaultDirectory} change={setDefaultDirectory} choices={directories} error={setError} />
            {defaultDirectory && <button type="button" className="settings-quiet" onClick={() => setDefaultDirectory('')}>Clear</button>}
          </SettingRow>
        </SettingsSection>
      </SettingsPage>
      <ItemViewSettings advanced={advanced} toggleAdvanced={toggleAdvanced} mapSizes={itemMapSizes} changeMap={setItemMapSizes} selected={section} plugins={plugins} sizes={itemViews} change={setItemViews}
        disconnected={providerId => providerId && !saved.value.connections.some(connection => connection.providerId === providerId && connection.enabled) ? providers.find(provider => provider.id === providerId)?.name : undefined}
        pluginSettings={pluginSettings} changePluginSettings={(owner, value) => setPluginSettings(current => ({ ...current, [owner]: value }))}
        pullRequest={<><SettingsSection label="Automatic reviews" description="Pull requests that land on the map after this is turned on get one review from each chosen agent, drafts included. Closed and merged pull requests, and those already on the map, are left alone.">
          <SettingRow label="Review new pull requests" meta="Off by default"><Switch checked={autoReview.enabled} change={enabled => setAutoReview({ ...autoReview, enabled })} /></SettingRow>
          {REVIEW_AGENTS.map(agent => <div key={agent.id} className="settings-choice"><label><input type="checkbox" disabled={!autoReview.enabled} checked={autoReview.agents.includes(agent.id)}
            onChange={event => setAutoReview({ ...autoReview, agents: REVIEW_AGENTS.map(known => known.id).filter(id => id === agent.id ? event.target.checked : autoReview.agents.includes(id)) })} />{agent.name}</label></div>)}
        </SettingsSection><SettingsSection label="Conversation" description="What appears in pull request conversations. Approval and check status sync regardless.">
          {([['comments', 'Human discussion comments'], ['threads', 'Code comments and thread replies'], ['reviewBodies', 'Written review comments'], ['bots', 'Include bots and GitHub Actions'], ['activity', 'Approvals and other review activity without comments']] as const).map(([key, label]) =>
            <div key={key} className="settings-choice"><label><input type="checkbox" checked={conversation[key]} onChange={event => setConversation({ ...conversation, [key]: event.target.checked })} />{label}</label></div>)}
        </SettingsSection></>}
        claude={<SettingsSection label="Session launch" description="Applies to the next new or resumed session.">
          <SettingRow label="Auto mode" description="Claude checks actions automatically to reduce permission prompts. Off uses manual approval." meta={permission.override ? `Custom permission mode: ${permission.override}. Changing Auto mode replaces this override.` : 'On by default'}>
            <Switch checked={permission.mode === 'auto'} change={checked => { setAutoMode(checked); setArgumentsText(permission.arguments.join('\n')); }} />
          </SettingRow>
          <SettingRow label="Remote Control" description="Connect from Claude on your phone or browser. Claude handles sign-in and any first-time confirmation." meta="On by default"><Switch checked={remote} change={setRemote} /></SettingRow>
          <SettingRow stack label="Additional launch arguments" description="One argument per line. Session identity and table synchronization are managed automatically.">
            <LaunchArguments value={argumentsText} change={setArgumentsText} />
          </SettingRow>
        </SettingsSection>}
        codex={<SettingsSection label="Session launch"><SettingRow label="Model" description="Chosen when you start or continue a Codex session." /></SettingsSection>} />
      <SettingsPage id="Map" title="Map" description="How projects look and behave on the map. Item positions stay fixed." hidden={section !== 'Map'}>
        <SettingsSection label="Project dashboards">
          <SettingRow label="Show project dashboards when zoomed out" description="Each project shows what needs me, working agents and its to-dos instead of its items. Choose its sections below."><Switch checked={mapDashboards.enabled} change={enabled => setMapDashboards({ ...mapDashboards, enabled })} /></SettingRow>
          <SettingRow dependent disabled={!mapDashboards.enabled} label="Show below" meta={<DefaultMeta value={mapDashboards.belowZoom} fallback={DEFAULT_MAP_DASHBOARDS.belowZoom} format={percent} note="the zoom bar marks it" />}>
            <SliderField aria-label="Dashboard zoom threshold" min={DASHBOARD_ZOOM_RANGE.min} max={DASHBOARD_ZOOM_RANGE.max} step={0.05} defaultValue={DEFAULT_MAP_DASHBOARDS.belowZoom} format={percent} disabled={!mapDashboards.enabled} value={mapDashboards.belowZoom} change={belowZoom => setMapDashboards({ ...mapDashboards, belowZoom })} />
          </SettingRow>
          <SettingRow dependent disabled={!mapDashboards.enabled} label="Placement" meta="Default Centre">
            <Segmented label="Dashboard placement" value={mapDashboards.placement} disabled={!mapDashboards.enabled} change={placement => setMapDashboards({ ...mapDashboards, placement })} options={[
              { value: 'center', label: 'Centre', help: 'In the middle of the project’s area.' },
              { value: 'top', label: 'Top', help: 'Pinned to the top of the project’s area.' },
            ]} />
          </SettingRow>
        </SettingsSection>
        <SettingsSection label="Dashboard sections" disabled={!mapDashboards.enabled} description="What each project dashboard lists. Pull requests and tickets are off by default; with Needs you off, the header still counts what needs you.">
          {DASHBOARD_SECTION_CHOICES.map(([key, label]) =>
            <div key={key} className="settings-choice"><label><input type="checkbox" checked={mapDashboards.sections[key]} onChange={event => setMapDashboards({ ...mapDashboards, sections: { ...mapDashboards.sections, [key]: event.target.checked } })} />{label}</label></div>)}
        </SettingsSection>
        <SettingsSection label="Plots">
          <SettingRow label="Show plots" description="Three or more items that sit close together in a project get a lighter patch and a signpost. A project’s ··· menu turns them off for that project." meta="On by default"><Switch checked={mapPlots} change={setMapPlots} /></SettingRow>
        </SettingsSection>
        <SettingsSection label="Connections">
          <SettingRow label="Hide implied connections" description="When A connects to B and B to C, the line from A straight to C is left out until you point at or select A or C. It stays saved and still gives context; blocking lines are hidden only by other blocking lines." meta="On by default"><Switch checked={hideImpliedLinks} change={setHideImpliedLinks} /></SettingRow>
        </SettingsSection>
        <SettingsSection label="Working">
          <SettingRow label="Working animal" description="Who walks the bottom edge of a card while its agent works, and shows when it waits for you." meta="Default Sheep">
            <Segmented label="Working animal" value={workingMark.animal} change={animal => setWorkingMark({ ...workingMark, animal })} options={[
              { value: 'sheep', label: 'Sheep', help: 'Grazes the tufts; sheared while the agent compacts.' },
              { value: 'raccoon', label: 'Raccoon', help: 'Forages the tufts; washes its paws while the agent compacts.' },
            ]} />
          </SettingRow>
          {workingMark.animal === 'raccoon' && <SettingRow dependent label="Helpers" description="Each busy subagent adds one more raccoon." meta="Default Kits">
            <Segmented label="Raccoon helpers" value={workingMark.helpers} change={helpers => setWorkingMark({ ...workingMark, helpers })} options={[
              { value: 'kits', label: 'Kits', help: 'Smaller than the lead, so a busy card stays uncluttered.' },
              { value: 'same', label: 'Same size', help: 'Every raccoon as big as the lead.' },
            ]} />
          </SettingRow>}
        </SettingsSection>
        <SettingsSection label="Opening items">
          <SettingRow label="Double-click opens the item on the web" description="Double-clicking a pull request, ticket or other item with a web page opens that page in your browser. Other items open as usual." meta="Off by default"><Switch checked={doubleClickOpensWeb} change={setDoubleClickOpensWeb} /></SettingRow>
        </SettingsSection>
        <SettingsSection label="Placing items">
          <SettingRow label="Snap to grid" description="An item you drop, nudge with the arrow keys, or that the table places lands with its centre on an invisible 48 px grid, so connections run straight or at even angles. Items already on the map stay where they are until moved." meta="Off by default"><Switch checked={snapToGrid} change={setSnapToGrid} /></SettingRow>
        </SettingsSection>
        <SettingsSection label="Removing items">
          <SettingRow label="Delete in item menus" description="An item's right-click menu ends in Delete…, which removes the item from the map and the archive for good after you confirm. Provider data and sessions are kept. Without it, items leave through Archive." meta="Off by default"><Switch checked={itemDelete} change={setItemDelete} /></SettingRow>
        </SettingsSection>
        <SettingsSection label="Undermap layout">
          <SettingRow label="Undermap layout" description="Mirror keeps every project in its place below the map and sorts what you sent there by month. Classic shows items where they were put when they were sent; nothing is lost by switching." meta="Default Mirror">
            <Segmented label="Undermap layout" value={undermapLayout} change={layout => setUndermapLayout(layout)} options={[
              { value: 'mirror', label: 'Mirror', help: 'Each project’s items lie under the project, grouped by month.' },
              { value: 'classic', label: 'Classic', help: 'Items lie where they were placed when sent; you can drag them.' },
            ]} />
          </SettingRow>
        </SettingsSection>
        <SettingsSection label="Neighborhoods">
          <SettingRow label="Neighborhood padding" description="Space around each project’s items." meta={<DefaultMeta value={Number(padding)} fallback={LARGE_ITEM_WIDTH} format={pixels} note="one large item width" reset={() => setPadding(String(LARGE_ITEM_WIDTH))} />}>
            <NumberField unit="px" min="0" step="any" required value={padding} onChange={event => setPadding(event.target.value)} />
          </SettingRow>
          <SettingRow label="Neighborhood style" description="Biomes give each preset colour its own ground and things growing at its edge. A project with a custom colour stays plain." meta="Default Biomes">
            <Segmented label="Neighborhood style" value={neighborhood.style} change={style => setNeighborhood({ ...neighborhood, style })} options={[
              { value: 'biome', label: 'Biomes', help: 'Grass is grassland, Diamond is tundra, Gold is desert.' },
              { value: 'plain', label: 'Plain colour', help: 'One colour per neighborhood, as before biomes.' },
            ]} />
          </SettingRow>
          <SettingRow dependent disabled={neighborhood.style !== 'biome'} label="Texture" description="How strongly the ground shows, and how much grows on it." meta="Default Quiet">
            <Segmented label="Texture" value={neighborhood.texture} disabled={neighborhood.style !== 'biome'} change={texture => setNeighborhood({ ...neighborhood, texture })} options={[
              { value: 'quiet', label: 'Quiet', help: 'Close to one colour; growth only at the edge.' },
              { value: 'medium', label: 'Medium', help: 'A clearer ground and a little growth in the open.' },
              { value: 'full', label: 'Full', help: 'The whole texture and the most growth.' },
            ]} />
          </SettingRow>
          <SettingRow dependent disabled={neighborhood.style !== 'biome'} label="Ground brightness" description="How strongly a biome's ground shows over the map. Higher is closer to the full colours and makes thin links harder to see on snow and sand." meta={<DefaultMeta value={neighborhood.brightness} fallback={DEFAULT_NEIGHBORHOOD_APPEARANCE.brightness} format={value => `${value}%`} />}>
            <SliderField aria-label="Ground brightness" min={10} max={100} step={1} defaultValue={DEFAULT_NEIGHBORHOOD_APPEARANCE.brightness} format={value => `${value}%`} disabled={neighborhood.style !== 'biome'} value={neighborhood.brightness} change={brightness => setNeighborhood({ ...neighborhood, brightness })} />
          </SettingRow>
        </SettingsSection>
        <AdvancedDisclosure open={advanced.has('Map')} toggle={() => toggleAdvanced('Map')} count={5}>
          <SettingsSection label="Neighborhood appearance" action={<button type="button" className="settings-quiet" onClick={() => setNeighborhood({ ...DEFAULT_NEIGHBORHOOD_APPEARANCE })}>Reset appearance</button>}>
            <SettingRow label="Pixel size" description="Size of each block, in map pixels." meta={<DefaultMeta value={neighborhood.pixelSize} fallback={DEFAULT_NEIGHBORHOOD_APPEARANCE.pixelSize} format={pixels} reset={() => setNeighborhood({ ...neighborhood, pixelSize: DEFAULT_NEIGHBORHOOD_APPEARANCE.pixelSize })} />}>
              <NumberField unit="px" min="8" max="96" step="1" required value={Number.isFinite(neighborhood.pixelSize) ? neighborhood.pixelSize : ''} onChange={event => setNeighborhood({ ...neighborhood, pixelSize: event.target.valueAsNumber })} />
            </SettingRow>
            <SettingRow label="Fade distance" description="Width of the four fading bands. Zero gives a solid fill." meta={<DefaultMeta value={neighborhood.fade} fallback={DEFAULT_NEIGHBORHOOD_APPEARANCE.fade} format={pixels} reset={() => setNeighborhood({ ...neighborhood, fade: DEFAULT_NEIGHBORHOOD_APPEARANCE.fade })} />}>
              <NumberField unit="px" min="0" max="480" step="any" required value={Number.isFinite(neighborhood.fade) ? neighborhood.fade : ''} onChange={event => setNeighborhood({ ...neighborhood, fade: event.target.valueAsNumber })} />
            </SettingRow>
            <SettingRow label="Edge scatter" description="Breaks the fading edge into scattered pixels." meta={<DefaultMeta value={neighborhood.scatter} fallback={DEFAULT_NEIGHBORHOOD_APPEARANCE.scatter} format={value => `${value}%`} />}>
              <SliderField aria-label="Edge scatter" min={0} max={100} step={1} defaultValue={DEFAULT_NEIGHBORHOOD_APPEARANCE.scatter} format={value => `${value}%`} value={neighborhood.scatter} change={scatter => setNeighborhood({ ...neighborhood, scatter })} />
            </SettingRow>
          </SettingsSection>
          <SettingsSection label="Undermap">
            <SettingRow label="Animate sending items to Undermap and travelling" description="Reduced motion in macOS always turns this off."><Switch checked={belowAnimation.enabled} change={enabled => setBelowAnimation({ ...belowAnimation, enabled })} /></SettingRow>
            <SettingRow dependent disabled={!belowAnimation.enabled} label="Travel duration" meta={<DefaultMeta value={belowAnimation.durationMs} fallback={DEFAULT_BELOW_ANIMATION.durationMs} format={value => `${value} ms`} note="a single item keeps its own pace" />}>
              <SliderField aria-label="Below animation duration" min={80} max={1500} step={20} defaultValue={DEFAULT_BELOW_ANIMATION.durationMs} format={value => `${value} ms`} disabled={!belowAnimation.enabled} value={belowAnimation.durationMs} change={durationMs => setBelowAnimation({ ...belowAnimation, durationMs })} />
            </SettingRow>
          </SettingsSection>
        </AdvancedDisclosure>
        <SettingsSection label="Map tools">
          <SettingRow label="Archive" description="Browse archived items and projects. Your unsaved changes are kept."><button type="button" onClick={openArchive}>Open archive</button></SettingRow>
          <SettingRow label="Clear overlaps" immediate description="Moves overlapping items apart across the whole map. Items that don’t overlap stay put." status={mapStatus}>
            {!confirmRepair && <button type="button" className="settings-danger" disabled={repairing} onClick={() => setConfirmRepair(true)}>Clear overlaps…</button>}
          </SettingRow>
          {confirmRepair && <InlineConfirm confirmLabel="Clear overlaps" busy={repairing} message="Move overlapping items apart across the whole map? This can’t be undone." cancel={() => setConfirmRepair(false)} confirm={async () => {
            setRepairing(true); setMapStatus(undefined);
            try { await clearOverlaps(); setMapStatus({ tone: 'ok', text: 'Overlaps cleared.' }); } catch (error) { setMapStatus({ tone: 'error', text: (error as Error).message }); } finally { setRepairing(false); setConfirmRepair(false); }
          }} />}
        </SettingsSection>
      </SettingsPage>
      <NotificationSettings value={notifications} change={setNotifications} plugins={plugins} hidden={section !== 'Notifications'} />
      <SettingsPage id="AI features" title="AI features" description="Claude writes short titles and labels from recent item output, using your configured Claude account." note={<><b>Output leaves your machine.</b> Known credentials are redacted, but terminal and agent output can still contain private information. Plot names send item titles and agent summaries only; Slack titles send the attached message.</>} hidden={section !== 'AI features'}>
        {summaries && <>
          <SettingsSection label="Agent titles">
            <SettingRow label="Auto-title agents" description="Names Claude and Codex items with a 2–5 word title after a finished turn, at most every 10 minutes." meta="On by default · renamed items keep your name"><Switch checked={summaries.agentTitles} change={agentTitles => setSummaries({ ...summaries, agentTitles })} /></SettingRow>
          </SettingsSection>
          <SettingsSection label="Slack titles">
            <SettingRow label="Auto-title Slack messages" description="Names a Slack message or thread with a 2–5 word summary once, when it is attached." meta="On by default · renamed items keep your name"><Switch checked={summaries.attachTitles} change={attachTitles => setSummaries({ ...summaries, attachTitles })} /></SettingRow>
          </SettingsSection>
          <SettingsSection label="Plot names">
            <SettingRow label="Name plots" description="Names each plot in 2–4 words from its items’ titles once its items settle, at most every 10 minutes. Off keeps a local name such as “Billing · 4 items”." meta="On by default · renamed plots keep your name"><Switch checked={summaries.plotNames} change={plotNames => setSummaries({ ...summaries, plotNames })} /></SettingRow>
          </SettingsSection>
          {STANDUP_ENABLED && <SettingsSection label="Standup report">
            <SettingRow label="Standup digests" description="Writes a short daily digest of each Claude conversation and pull request with Haiku in the background, and the standup report from them with Sonnet. Conversations are read on this Mac and redacted before they are sent." meta="On by default · off lists stored facts only"><Switch checked={summaries.standupDigests} change={standupDigests => setSummaries({ ...summaries, standupDigests })} /></SettingRow>
            <SettingRow dependent disabled={!summaries.standupDigests} label="Standup report requests" description="A report you ask for may make up to this many requests: one Haiku digest per conversation or pull request day not yet read, and the report itself. It does not use the shared limits below." meta={<DefaultMeta value={summaries.standupRequestsPerReport} fallback={SUMMARY_DEFAULTS.standupRequestsPerReport} reset={() => setSummaries({ ...summaries, standupRequestsPerReport: SUMMARY_DEFAULTS.standupRequestsPerReport })} />}>
              <NumberField unit="per report" disabled={!summaries.standupDigests} min="1" max="500" required value={summaries.standupRequestsPerReport} onChange={event => setSummaries({ ...summaries, standupRequestsPerReport: Number(event.target.value) })} />
            </SettingRow>
          </SettingsSection>}
          <SettingsSection label="Activity summaries">
            <SettingRow label="Summarize agent and terminal activity" description="Turns recent output into a short label on the item." meta="Off by default"><Switch checked={summaries.enabled} change={enabled => setSummaries({ ...summaries, enabled })} /></SettingRow>
            <SettingRow dependent disabled={!summaries.enabled} label="Summary model"><TextField disabled={!summaries.enabled} value={summaries.model} required maxLength={100} onChange={event => setSummaries({ ...summaries, model: event.target.value })} /></SettingRow>
            <SettingRow dependent disabled={!summaries.enabled} label="Seconds between summaries per item" meta={<DefaultMeta value={summaries.intervalSeconds} fallback={SUMMARY_DEFAULTS.intervalSeconds} format={value => `${value} s`} reset={() => setSummaries({ ...summaries, intervalSeconds: SUMMARY_DEFAULTS.intervalSeconds })} />}>
              <NumberField unit="s" disabled={!summaries.enabled} min="30" max="600" required value={summaries.intervalSeconds} onChange={event => setSummaries({ ...summaries, intervalSeconds: Number(event.target.value) })} />
            </SettingRow>
          </SettingsSection>
          <SettingsSection label="Request limits" description="Shared by titles, plot names, summaries and background standup digests across the whole table, and kept across restarts. A standup report you ask for has its own allowance above. Each request is one response with no tools: titles and summaries have a $0.02 CLI budget, a digest $0.05 and a report $0.25; provider charges can differ.">
            <SettingRow disabled={!limited} label="Summary requests per hour" meta={<DefaultMeta value={summaries.requestsPerHour} fallback={SUMMARY_DEFAULTS.requestsPerHour} reset={() => setSummaries({ ...summaries, requestsPerHour: SUMMARY_DEFAULTS.requestsPerHour })} />}>
              <NumberField unit="/h" disabled={!limited} min="1" max="120" required value={summaries.requestsPerHour} onChange={event => setSummaries({ ...summaries, requestsPerHour: Number(event.target.value) })} />
            </SettingRow>
            <SettingRow disabled={!limited} label="Summary requests per day" meta={<DefaultMeta value={summaries.requestsPerDay} fallback={SUMMARY_DEFAULTS.requestsPerDay} reset={() => setSummaries({ ...summaries, requestsPerDay: SUMMARY_DEFAULTS.requestsPerDay })} />}>
              <NumberField unit="/day" disabled={!limited} min="1" max="1000" required value={summaries.requestsPerDay} onChange={event => setSummaries({ ...summaries, requestsPerDay: Number(event.target.value) })} />
            </SettingRow>
          </SettingsSection>
        </>}
      </SettingsPage>
      <SettingsPage id="General" title="General" description="How the app behaves on this Mac." hidden={section !== 'General'}>
        <SettingsSection label="Screen">
          <SettingRow label="Keep screen awake while the app is open" description="Keeps the display on until you turn this off or quit. Manual locking and macOS security settings stay in effect."><Switch checked={awake} change={setAwake} /></SettingRow>
        </SettingsSection>
        <SettingsSection label="Terminals" description="Applies to open terminal and agent views right away after saving.">
          <SettingRow label="Screen reader support for terminals" description="Keeps a copy of the visible terminal text for VoiceOver and other screen readers. It slows down large sessions, so it is off unless you need it."
            meta={assistive ? 'On while VoiceOver is running' : 'Off by default · turns on automatically with VoiceOver'}>
            <Switch checked={terminal.screenReader || assistive} disabled={assistive} change={screenReader => setTerminal({ ...terminal, screenReader })} />
          </SettingRow>
          <SettingRow label="Scrollback lines" description="History each terminal view keeps for scrolling back. Longer history uses more memory and makes large sessions slower to open. The full recording is kept either way."
            meta={<DefaultMeta value={terminal.scrollback} fallback={DEFAULT_TERMINAL_SCROLLBACK} format={lines => `${lines.toLocaleString('en-US')} lines`} />}>
            <ScrollbackSelect value={terminal.scrollback} change={scrollback => setTerminal({ ...terminal, scrollback })} />
          </SettingRow>
        </SettingsSection>
        <SettingsSection label="Closing the app">
          <SettingRow label="Warn before closing with active sessions" description="Closing the window keeps sessions running in the background; reopen it from the Dock. Quit stops them: when this is off, Quit saves and stops running sessions right away. Startup recovery still applies." meta="Off by default"><Switch checked={warnBeforeClosing} change={setWarnBeforeClosing} /></SettingRow>
        </SettingsSection>
        <SettingsSection label="About">
          <SettingRow label="Version" description={updates?.app.available && updates.app.latest ? `${updates.app.latest} is available. In your checkout, quit the app and run ${UPDATE_COMMAND}: it checks out the newest release, builds it and installs it in place.` : `Releases are tags of the public repository. To update, quit the app and run ${UPDATE_COMMAND} in your checkout.`}
            meta={<span className="settings-update-status" role="status">{updateStatusText(appInfo, updates)}</span>}>
            <Button size="sm" onClick={checkUpdates} disabled={checkingUpdates || Boolean(updates?.checking)} aria-busy={checkingUpdates || Boolean(updates?.checking)}>Check now</Button>
          </SettingRow>
          <SettingRow label="Check for updates daily" description="Looks up the newest release tag of the app and of each installed plugin pack once a day and shows a notice when there is a newer one. Nothing is downloaded or installed by it."><Switch checked={updateCheck} change={setUpdateCheck} /></SettingRow>
          <SettingRow label="Map canvas" description="Built with React Flow by xyflow, used under the MIT licence." />
        </SettingsSection>
      </SettingsPage>
      <PluginsPage hidden={section !== 'Plugins'} installRequest={installRequest} />
      <SettingsPage id="Data & diagnostics" title="Data & diagnostics" description="Local sessions, recordings and logs. Support reports never include titles, paths, prompts or output." hidden={section !== 'Data & diagnostics'}
        meta={infoError ? <span role="alert">{infoError}</span> : appInfo && `ACT v${appInfo.version}`}>
        {section === 'Data & diagnostics' && <>
          <SessionManager key={sessionRequestId} nodeTitles={nodeTitles} initialView={initialSessionView} />
          <RecordingStorage />
          <SettingsSection label="Archive"><SettingRow label="Archived items, to-dos, sessions and recordings" description="Archive is the one place to restore or permanently delete them. Your unsaved changes are kept."><button type="button" onClick={openArchive}>Open archive</button></SettingRow></SettingsSection>
        </>}
        {diagnostics && <LocalDiagnostics policy={diagnostics} change={setDiagnostics} />}
        <SettingsSection label="Support"><SupportReport /><PerformanceDiagnostics /></SettingsSection>
      </SettingsPage>
      </div></div>
      {error && <ErrorNotice message={error} />}
      <div className="editor-actions settings-actions">
        {discarding && dirty ? <div className="settings-discard" role="group" aria-label="Discard changes" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setDiscarding(false); } }}>
          <p>Discard {changes.length} {changes.length === 1 ? 'change' : 'changes'}?</p>
          <button type="button" autoFocus onClick={() => setDiscarding(false)}>Keep editing</button><button type="button" className="settings-danger" onClick={close}>Discard</button>
        </div> : <p className="settings-draft" role="status">
          {dirty ? <span data-tone="dirty">{changes.length} unsaved {changes.length === 1 ? 'change' : 'changes'}{named(changes) && ` · ${named(changes)}`}</span> : <span data-tone="clean">No unsaved changes</span>}
          {invalid.length > 0 && <span data-tone="invalid">{invalid.length} {invalid.length === 1 ? 'field needs' : 'fields need'} attention{named(invalid) && ` · ${named(invalid)}`}</span>}
        </p>}
        <button type="button" className="settings-close" onClick={close}>{dirty ? 'Discard' : 'Close'}</button><button type="submit" data-clean={dirty ? undefined : true} disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button>
      </div>
    </>}
  </form>;
}

function RowDirectoryField(props: Omit<Parameters<typeof DirectoryField>[0], 'inputId' | 'describedBy'>) {
  const row = useRowControl();
  return <DirectoryField {...props} inputId={row.id} describedBy={row['aria-describedby']} />;
}

function updateStatusText(appInfo: AppInfo | undefined, updates: UpdateStatus | undefined) {
  const running = appInfo ? `ACT v${appInfo.version}` : 'ACT';
  if (!updates) return running;
  if (updates.checking) return `${running} · checking…`;
  if (updates.app.error) return `${running} · could not check: ${updates.app.error}`;
  if (updates.app.checkedAt === undefined) return `${running} · not checked yet`;
  if (updates.app.available && updates.app.latest) return `${running} · ${updates.app.latest} available`;
  return `${running} · up to date${updates.app.latest ? ` (newest release ${updates.app.latest})` : ''}`;
}
