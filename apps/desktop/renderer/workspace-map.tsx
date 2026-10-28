import { loadResourceChoices, choiceInput } from '../../../src/resource-plugins/choices.ts';
import { TodoOverlay } from './todo-overlay.tsx';
import type { TodoOverlayHandle, TodoUndo } from './todo-overlay.tsx';
import { hiddenPartner, isArchived, isBelow, surfaceBlocker } from '../../../src/graph/archive.ts';
import { ZOOM_LEVELS } from '../../../src/graph/spatial.ts';
import { activeMotion, portalWipe, sinkItem, ITEM_SINK_MS } from './below-transition.ts';
import { PortalArt } from './portal-art.tsx';
import { ToolRail, railSlot } from './tool-rail.tsx';
import { RailContext, RailState } from './rail-state.ts';
import { mergeViewBounds, patchItemViewState, sameViewBounds } from './item-view-bounds.ts';
import type { ItemViewValue, ViewPlace, ViewSize } from './item-view-bounds.ts';
import { GitHubInboxTool } from './github-inbox.tsx';
import { RemindersTool } from './reminders-tool.tsx';
import { undermapColor } from '../../../src/graph/project-colors.ts';
import { ConnectionEditor } from './connection-editor.tsx';
import { ArchiveBrowser } from './archive-browser.tsx';
import type { GraphLink, GraphNode } from '../../../src/graph/graph.ts';
import { automaticLink } from '../../../src/graph/graph.ts';
import { Settings } from './settings.tsx';
import type { PluginInstallRequest } from './plugin-manager.tsx';
import { ActionsTool } from './actions-tool.tsx';
import { StandupPanel } from './standup-panel.tsx';
import { STANDUP_ENABLED } from '../../../packages/core/standup.ts';
import { pendingOffers, useUpdates } from './use-updates.ts';
import { UpdateNotice } from './update-notice.tsx';
import type { ProviderDescription } from '../../../packages/core/connections.ts';
import { seenOnOpen } from '../../../packages/core/settings.ts';
import { applyToLatest } from '../../../packages/core/revision-policy.ts';
import type { OpenContext, SettingsSnapshot } from '../../../packages/core/settings.ts';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { WorkspaceCommand, WorkspaceState, ViewState } from '../../../packages/core/control.ts';
import { viewSchema } from '../../../packages/core/control.ts';
import type { WorkspaceSnapshot } from '../../../packages/workspace-service/protocol.ts';
import { pluginSettingsValues, registryFromDescriptions } from '../../../src/resource-plugins/describe.client.ts';
import { webLinkUrl } from '../../../src/resource-plugins/define.ts';
import type { PluginDescription } from '../../../src/resource-plugins/describe.client.ts';
import type { ResourceChoices, ResourceRecord, MountedResourceView } from '../../../src/resource-plugins/types.ts';
import { installedRenderersReady } from './installed-plugins.ts';
import { createResourceViews } from '../../../src/resource-plugins/catalog.client.ts';
import { patchedData, savedSnapshot } from '../../../src/resource-plugins/views.ts';
import type { ResourcePluginRegistry } from '../../../src/resource-plugins/registry.ts';
import { ProjectMap } from './project-map.tsx';
import { pinNeighborhoodStyle, pinnedNeighborhoodStyle } from '../neighborhood-style-pin.ts';
import type { ProjectMapProps } from './project-map.tsx';
import { InlineEditor } from './inline-editor.tsx';
import { useUrlCandidates } from './use-url-candidates.ts';
import { mountNativeTerminal } from './native-terminal.tsx';
import { RecoveryStatus } from './recovery-status.tsx';
import { CanvasMenu } from './canvas-menu.tsx';
import { contextMenuActions, convertLinkActions, deleteItemAction, enabledMenuGroups, fieldMenuActions, itemEditLabel, itemMenuCustom, itemPlotActions, linkMenuActions, muteProjectAction, moveToProjectAction, sharedContextMenuActions } from '../../../packages/core/context-menu.ts';
import { mapBadges } from '../../../src/graph/badges.ts';
import { moveTargets } from '../../../packages/core/todos.ts';
import type { MenuAction, MenuActionId } from '../../../packages/core/context-menu.ts';
import { NeedsMeTool } from './attention-list.tsx';
import { ItemIcon } from './icons.tsx';
import { ConnectionStatus } from './connection-status.tsx';
import { FirstRunCard } from './first-run.tsx';
import { ResourceActionNotice, useResourceMenuActions } from './resource-menu-actions.tsx';
import { NEEDS_ME, attentionCounts, attentionItems, attentionRestorable } from '../../../src/graph/attention.ts';
import { needsMeIds } from '../../../src/graph/atlas.ts';
import { shareUnchanged } from '../../../src/graph/share-state.ts';
import { belowSummary, layerNodes, presentLayer } from '../../../src/graph/layers.ts';
import type { MapLayer } from '../../../src/graph/layers.ts';
import { splitAttention } from '../../../src/graph/mute.ts';
import { doneArchiveDays, todoEntries as listTodos } from '../../../src/graph/todos.ts';
import { completeTodo } from '../../../packages/core/todos.ts';
import { useNativeAnnouncement } from './use-native-announcement.ts';
import { useNotice } from './use-notice.ts';
import { useAttention } from './use-attention.ts';
import { CompletionNotice } from './completion-notice.tsx';
import { Toast } from './ui/notice.tsx';
import { humanError } from './ui/error-copy.ts';
import { relatedResourceItems } from '../../../packages/core/related-items.ts';
import { FROM_URL } from '../../../packages/core/item-picker.ts';
import { creationConnections } from '../../../packages/core/resource-creation.ts';
import { ErrorBoundary, ErrorScreen, PanelError } from './error-screen.tsx';
import { shortcutKey, useWorkspaceShortcuts } from './shortcuts.ts';
import { ControlsCard } from './controls-card.tsx';
import { UNDERMAP_LOOSE, mirrorLayout, searchUndermap } from '../../../src/graph/undermap.ts';
import type { MirrorLayout, UndermapMatch } from '../../../src/graph/undermap.ts';
import { resolveMapSize, sizeAsDefault } from '../../../packages/core/item-map-sizes.ts';
import { SNAP_PITCH } from '../../../src/graph/snap.ts';
import { LARGE_ITEM_WIDTH } from '../../../src/graph/footprints.ts';
import { UndermapSearch } from './undermap-search.tsx';
import type { UndermapSearchHandle } from './undermap-search.tsx';

type Anchor = Parameters<NonNullable<ProjectMapProps['onContext']>>[0];
type Editor = Anchor & { connectedFromId?: string; initialType?: string; initialUrl?: string; mode: 'menu' | 'create' | 'edit' };
/** A new paper tile shown on the map before its first words; it is saved only once it has text. */
type PaperDraft = { nodeId: string; resourceId: string; linkId: string; pluginId: string; position: { x: number; y: number }; projectId?: string; connectedFromId?: string; data: Record<string, string>;
  /** A size given before the first words; the first save applies it. */
  mapDimensions?: { width: number; height: number } };

/** Opening an item's provider page from the app is the person reading it there; its type may record that. */
const recordOpened = (nodeId: string) => { void window.craftingTable.runtimeRun({ action: 'resource.opened', nodeId, arguments: {} }).catch(() => {}); };

type ItemViewStore = { read(nodeId: string): Readonly<Record<string, ItemViewValue>>; save(nodeId: string, patch: Record<string, ItemViewValue | null>): void };

function PluginDetail({ resource, registry, active, nodeId, onOpen, onShow, onEdit, viewStore }: { resource: ResourceRecord; registry: ResourcePluginRegistry; active: boolean; nodeId: string; onOpen(id: string): void; onShow(id: string): void; onEdit(): void; viewStore: ItemViewStore }) {
  const container = useRef<HTMLDivElement>(null);
  const mounted = useRef<MountedResourceView>(undefined);
  const openRef = useRef(onOpen); openRef.current = onOpen;
  const showRef = useRef(onShow); showRef.current = onShow;
  const editRef = useRef(onEdit); editRef.current = onEdit;
  const views = useMemo(() => createResourceViews(registry), [registry]);
  const identity = views.identity(resource);
  useEffect(() => {
    const view = views.mount('detail', container.current!, resource, {
      editResource: () => editRef.current(),
      saveData: async patch => {
        const { state } = await window.craftingTable.workspaceRead(), record = state.resources.find(candidate => candidate.id === state.nodes.find(node => node.id === nodeId)?.resourceId);
        if (!record) throw new Error('This item is no longer on the map.');
        await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'desktop' }, commands: [{ type: 'item.update', id: nodeId, data: patchedData(record.data, patch) }] });
      },
      viewState: () => viewStore.read(nodeId),
      saveViewState: patch => viewStore.save(nodeId, patch),
      copyUrl: url => window.craftingTable.copyUrl(url),
      observePreferences: listener => {
        let disposed = false, revision = -1;
        const receive = (snapshot: SettingsSnapshot) => { if (disposed || snapshot.revision < revision) return; revision = snapshot.revision; listener(JSON.parse(JSON.stringify(snapshot.value))); };
        const off = window.craftingTable.onSettings(receive);
        void window.craftingTable.settingsRead().then(receive).catch(() => {});
        return () => { disposed = true; off(); };
      },
      observeRelated: listener => {
        let disposed = false, cursor = -1;
        const receive = (snapshot: WorkspaceSnapshot) => { if (disposed || snapshot.cursor < cursor) return; cursor = snapshot.cursor; listener(relatedResourceItems(snapshot.state, nodeId, registry)); };
        const off = window.craftingTable.onWorkspace(receive);
        void window.craftingTable.workspaceRead().then(receive).catch(() => {});
        return () => { disposed = true; off(); };
      },
      observeRework: listener => {
        let disposed = false, cursor = -1, last = '';
        const receive = (snapshot: WorkspaceSnapshot) => {
          if (disposed || snapshot.cursor < cursor) return; cursor = snapshot.cursor;
          const rework = snapshot.state.nodes.find(node => node.id === nodeId)?.rework, by = rework?.by && snapshot.state.nodes.find(node => node.id === rework.by)?.title;
          const value = rework && { note: rework.note, since: rework.since, ...(by ? { by } : {}) }, key = JSON.stringify(value ?? null);
          if (key !== last) { last = key; listener(value); }
        };
        const off = window.craftingTable.onWorkspace(receive);
        void window.craftingTable.workspaceRead().then(receive).catch(() => {});
        return () => { disposed = true; off(); };
      },
      clearRework: async () => {
        const { state } = await window.craftingTable.workspaceRead();
        await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'desktop' }, commands: [{ type: 'node.rework', id: nodeId, note: null }] });
      },
      frameToolbar: () => container.current?.closest('[data-expanded-item-id],[data-item-id]')?.querySelector<HTMLElement>('.item-frame-slot') ?? undefined,
      openUrl: url => { void window.craftingTable.openUrl(url); },
      openResource: id => openRef.current(id), showOnMap: id => showRef.current(id), runAction: async (action, input) => window.craftingTable.runtimeRun({ action: action as 'agent.resume', nodeId, arguments: input ?? {} }) as Promise<any>, attachTerminal: mountNativeTerminal,
    }, (element, presentation) => {
      const content = document.createElement('div');
      if (!presentation.available) { const message = document.createElement('p'); message.textContent = presentation.reason ?? 'Item unavailable'; content.append(message); }
      for (const field of presentation.fields) {
        const row = document.createElement('p'), label = document.createElement('strong'), value = document.createElement('span');
        label.textContent = field.label + ': '; value.textContent = String(field.value ?? '—'); row.append(label, value); content.append(row);
      }
      if (!content.childNodes.length) content.textContent = 'No additional details.';
      element.append(content);
      return { update() {}, dispose() { content.remove(); } };
    });
    mounted.current = view; view.setActive?.(active);
    return () => { view.dispose(); mounted.current = undefined; };
  }, [identity, registry, nodeId]);
  useEffect(() => { mounted.current?.setActive?.(active); }, [active]);
  // Each workspace change the service sends reaches the open view as an update; the view re-reads what it shows.
  useEffect(() => {
    let cursor = -1;
    return window.craftingTable.onWorkspace(snapshot => {
      if (snapshot.cursor <= cursor) return;
      cursor = snapshot.cursor;
      const node = snapshot.state.nodes.find(candidate => candidate.id === nodeId);
      if (node) mounted.current?.update(savedSnapshot(node));
    });
  }, [nodeId]);
  return <div className="resource-detail" ref={container} onClick={event => {
    const link = (event.target as HTMLElement).closest('a');
    if (link) { event.preventDefault(); void window.craftingTable.openUrl(link.href); }
  }} />;
}

const PINNED_NEIGHBORHOOD_STYLE = pinnedNeighborhoodStyle(location.search);

/** The held state plus what lies below, read once each time `open` turns on while the service sends the map layer.
 * What the snapshot holds wins; the Undermap's part is as it was when read. */
function useUndermapWhile(open: boolean, snapshot: WorkspaceSnapshot | undefined): WorkspaceState | undefined {
  const [whole, setWhole] = useState<WorkspaceState>(), layered = snapshot?.layer === 'map' && Boolean(snapshot.layers?.below.items);
  useEffect(() => {
    if (!open || !layered) { setWhole(undefined); return; }
    let current = true;
    void window.craftingTable.workspaceRead().then(read => { if (current) setWhole(read.state); }).catch(() => {});
    return () => { current = false; };
  }, [open, layered]);
  return useMemo(() => {
    const held = snapshot?.state;
    if (!held || !whole || !layered) return held;
    const nodes = new Set(held.nodes.map(node => node.id)), resources = new Set(held.resources.map(resource => resource.id)), links = new Set(held.links.map(link => link.id));
    return { ...held, nodes: [...held.nodes, ...whole.nodes.filter(node => !nodes.has(node.id))], resources: [...held.resources, ...whole.resources.filter(resource => !resources.has(resource.id))], links: [...held.links, ...whole.links.filter(link => !links.has(link.id))] };
  }, [snapshot?.state, whole, layered]);
}

export function WorkspaceMap() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>(), snapshotRef = useRef<WorkspaceSnapshot>(undefined);
  const [settings, setSettings] = useState<SettingsSnapshot>();
  const [providers, setProviders] = useState<ProviderDescription[]>([]);
  const [attentionHighlight, setAttentionHighlight] = useState<string>();
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [menuHighlight, setMenuHighlight] = useState<{ nodes: string[]; links: string[] }>();
  const [rail] = useState(() => new RailState());
  // Needs me is a rail tool; the map only needs to know whether its sheet shows.
  const attentionOpen = useSyncExternalStore(rail.subscribe, rail.snapshot).open === 'attention';
  // Only the Atlas overview gives way to Needs me; the Projects panel stays beside it.
  const atlasCorner = settings?.value.mapCorner === 'atlas';
  useEffect(() => { if (attentionOpen && atlasCorner) setOverviewOpen(false); }, [attentionOpen, atlasCorner]);
  // A right click that reaches the map closes every rail sheet, Needs me included, pinned or not.
  // When it closes a kept sheet that is all it does; the next right click opens the map's menu.
  // A sheet that only peeks from a hover does not hold the menu back.
  useEffect(() => {
    const closePanels = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.map-area')) return;
      const { open, pinned, held } = rail.snapshot();
      if (open && open === pinned && open !== held) { event.preventDefault(); event.stopPropagation(); }
      rail.clear();
    };
    document.addEventListener('contextmenu', closePanels, true);
    return () => document.removeEventListener('contextmenu', closePanels, true);
  }, [rail]);
  // A muted project's rows are held back: the button, the Dock badge and notifications count only the rest.
  const { shown: attention, muted: mutedAttention } = useMemo(() => splitAttention(snapshot?.state.nodes ?? []), [snapshot?.state.nodes]);
  const dockBadge = settings?.value.notifications.dockBadge !== false, countFinished = settings?.value.notifications.countFinished === true;
  // One number everywhere: Asking me + My turn, plus Finished only when the person counts it.
  const counting = useMemo(() => ({ countFinished }), [countFinished]), needsMeCount = useMemo(() => attentionCounts(attention, counting).needsMe, [attention, counting]);
  useEffect(() => { void window.craftingTable.setBadgeCount(dockBadge ? needsMeCount : 0).catch(() => {}); }, [needsMeCount, dockBadge]);
  const highlightedNodes = useMemo(() => attentionOpen ? [...attention, ...mutedAttention].find(item => item.node.id === attentionHighlight)?.aliases.map(node => node.id) : undefined, [attentionOpen, attention, mutedAttention, attentionHighlight]);
  const [plugins, setPlugins] = useState<PluginDescription[]>(), [view, setView] = useState<ViewState>();
  const [capabilities, setCapabilities] = useState<string[]>([]), [settingsOpen, setSettingsOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false), [standupOpen, setStandupOpen] = useState(false);
  const todoOverlay = useRef<TodoOverlayHandle>(null), viewRef = useRef<ViewState>(undefined);
  const [reveal, setReveal] = useState<{ nodeId: string; nonce: number; mode?: 'map'; origin?: 'program'; select?: readonly string[] }>();
  const saveView = (patch: Partial<ViewState>) => { const next = { ...viewRef.current!, ...patch }; viewRef.current = next; setView(next); void window.craftingTable.viewWrite(next).catch(error => setError(error.message)); };
  const [connectionDraft, setConnectionDraft] = useState<{ sourceId: string; screen: { x: number; y: number } }>();
  const [sessionRequestId, setSessionRequestId] = useState(0);
  const [sessionListView, setSessionListView] = useState<'active' | 'archived' | undefined>(undefined);
  const [installRequest, setInstallRequest] = useState<PluginInstallRequest>(), installRequests = useRef(0);
  const [settingsSection, setSettingsSection] = useState<string>();
  const updates = useUpdates(Boolean(snapshot));
  const updateOffers = useMemo(() => pendingOffers(updates.status, view?.dismissedUpdates), [updates.status, view?.dismissedUpdates]);
  const [archiveOpen, setArchiveOpen] = useState(false), [removedLink, setRemovedLink] = useState<GraphLink>();
  const [layer, setLayer] = useState<'map' | 'below'>('map'), layerRef = useRef(layer); layerRef.current = layer;
  const [travelling, setTravelling] = useState(false), [riseCharge, setRiseCharge] = useState(0), [portalHot, setPortalHot] = useState(false);
  const workspace = useRef<HTMLElement>(null), zoomRef = useRef<number>(undefined), entryZoom = useRef<number>(undefined);
  const linkNotice = useNotice(removedLink, true);
  // The Undermap's mirror layout (MAP-18): which month a person opened per area, and the item a search flew to. View state only.
  const [openMonths, setOpenMonths] = useState<Record<string, string>>({}), openMonthsRef = useRef(openMonths); openMonthsRef.current = openMonths;
  const [foundBelow, setFoundBelow] = useState<string>(), undermapSearch = useRef<UndermapSearchHandle>(null);
  useEffect(() => { if (!foundBelow) return; const timer = setTimeout(() => setFoundBelow(undefined), 4000); return () => clearTimeout(timer); }, [foundBelow]);
  const [paperDraft, setPaperDraft] = useState<PaperDraft>(), paperDraftRef = useRef(paperDraft); paperDraftRef.current = paperDraft;
  const [archivedNote, setArchivedNote] = useState<{ id: string; title: string }>(), noteNotice = useNotice(archivedNote, true);
  const [unmuted, setUnmuted] = useState<{ id: string; title: string; needs: number }>(), unmuteNotice = useNotice(unmuted, true);
  const [todoUndo, setTodoUndo] = useState<TodoUndo>(), todoUndoNotice = useNotice(todoUndo, true);
  const [copiedUrls, setCopiedUrls] = useState<{ count: number }>(), copyNotice = useNotice(copiedUrls, true);
  useNativeAnnouncement(removedLink, { title: 'Connection removed', body: 'Return to ACT to undo this change.' });
  const [editor, setEditor] = useState<Editor>(), [error, setError] = useState(''), [connection, setConnection] = useState('connecting');
  const shownError = useMemo(() => error ? humanError(error) : undefined, [error]);
  const retryLoad = useRef(() => {});
  useNativeAnnouncement(error, { title: 'ACT reported a problem', body: 'Open your table for details.' });
  const registry = useMemo(() => registryFromDescriptions(plugins ?? []), [plugins]);
  const resourceMenu = useResourceMenuActions(registry, setError);
  const previewViews = useMemo(() => createResourceViews(registry), [registry]);
  const todoEntries = useMemo(() => snapshot ? listTodos(snapshot.state) : [], [snapshot?.state]);
  const [todoDrag, setTodoDrag] = useState<ProjectMapProps['todoDrag']>();
  const resources = snapshot?.state.resources;
  const openResource = useCallback((id: string) => {
    const found = (nodes: readonly GraphNode[]) => nodes.find(node => node.id === id || node.resourceId === id);
    const node = found(snapshotRef.current?.state.nodes ?? []);
    if (node) revealRef.current(node.id);
    else if (snapshotRef.current?.layer === 'map') void window.craftingTable.workspaceRead().then(whole => { const below = found(whole.state.nodes); if (below) revealRef.current(below.id); }).catch(() => {});
  }, []);
  const revealRef = useRef((nodeId: string, mode?: 'map') => setReveal({ nodeId, nonce: Date.now(), ...(mode ? { mode } : {}) }));
  const motion = activeMotion(settings?.value.belowAnimation);
  /** Travel between the map and the layer below with one shared camera. */
  const travel = useCallback(async (to: 'map' | 'below') => {
    if (layerRef.current === to) return;
    const camera = viewRef.current?.camera;
    if (to === 'below') { entryZoom.current = camera?.zoom; zoomRef.current = camera?.zoom; }
    else if (camera && entryZoom.current && camera.zoom < entryZoom.current) {
      // Rising by zooming out leaves the camera at its minimum; restore the entry zoom around the same center.
      const center = { x: (innerWidth / 2 - camera.x) / camera.zoom, y: (innerHeight / 2 - camera.y) / camera.zoom }, zoom = entryZoom.current;
      const next = { ...viewRef.current!, camera: { x: innerWidth / 2 - center.x * zoom, y: innerHeight / 2 - center.y * zoom, zoom } };
      viewRef.current = next; setView(next); void window.craftingTable.viewWrite(next).catch(error => setError(error.message));
    }
    setEditor(undefined); setRiseCharge(0);
    // The Undermap's items arrive before it is drawn; going up, the map is drawn from what is held and then the rest is let go.
    if (to === 'below') await subscribeLayer('below');
    const duration = activeMotion(settings?.value.belowAnimation);
    if (!duration || !workspace.current) setLayer(to);
    else {
      setTravelling(true);
      try { await portalWipe(workspace.current, to === 'below' ? 'down' : 'up', duration * 1.4, () => setLayer(to)); } finally { setTravelling(false); }
    }
    if (to === 'map') await subscribeLayer('map');
  }, [settings?.value.belowAnimation]);
  const mirrorMode = settings ? settings.value.undermapLayout !== 'classic' : false;
  const itemMapSizes = settings?.value.itemMapSizes, neighborhoodPadding = settings?.value.neighborhoodPadding;
  const savedAppearance = settings?.value.neighborhoodAppearance, neighborhoodAppearance = useMemo(() => savedAppearance && pinNeighborhoodStyle(savedAppearance, PINNED_NEIGHBORHOOD_STYLE), [savedAppearance]);
  /** Where everything below lies in the mirror layout, from the same footprints the map draws. */
  const layoutBelow = useCallback((nodes: readonly GraphNode[], records: readonly ResourceRecord[], open: Readonly<Record<string, string>>) => {
    const byId = new Map(records.map(record => [record.id, record]));
    return mirrorLayout(nodes, { padding: neighborhoodPadding, open, now: Date.now(), size: node => {
      const record = node.resourceId ? byId.get(node.resourceId) : undefined;
      return record ? resolveMapSize(node, record, registry.get(record.pluginId), itemMapSizes) : { width: node.resourceId ? 150 : LARGE_ITEM_WIDTH, height: node.resourceId ? 48 : 112 };
    } });
  }, [registry, itemMapSizes, neighborhoodPadding]);
  const revealNode = useCallback((nodeId: string, mode?: 'map') => {
    // The map layer's snapshot leaves out most of the Undermap: an item there is looked up in the whole workspace, then revealed.
    if (snapshotRef.current?.layer === 'map' && !snapshotRef.current.state.nodes.some(candidate => candidate.id === nodeId)) {
      void window.craftingTable.workspaceRead().then(whole => {
        const node = whole.state.nodes.find(candidate => candidate.id === nodeId);
        if (node && isBelow(node, whole.state.nodes)) void travel('below').then(() => revealRef.current(nodeId, mode));
        else setReveal({ nodeId, nonce: Date.now(), ...(mode ? { mode } : {}) });
      }).catch(error => setError(error.message));
      return;
    }
    const state = snapshotRef.current?.state, node = state?.nodes.find(candidate => candidate.id === nodeId);
    if (node && state) void travel(isBelow(node, state.nodes) ? 'below' : 'map');
    // An item in a closed month has no card: open its month so the reveal finds it.
    if (node && state && mirrorMode && isBelow(node, state.nodes)) {
      const layout = layoutBelow(state.nodes, state.resources, openMonthsRef.current), place = layout.places.get(nodeId);
      if (place && !layout.positions.has(nodeId)) setOpenMonths(old => ({ ...old, [place.areaId]: place.month }));
    }
    setReveal({ nodeId, nonce: Date.now(), ...(mode ? { mode } : {}) });
  }, [travel, mirrorMode, layoutBelow]);
  revealRef.current = revealNode;
  /** Each layer shows its own items; projects below also show their neighborhood as orientation. Hidden items are on no layer. */
  const layerGraph = useMemo(() => {
    const all = snapshot?.state.nodes ?? [], links = snapshot?.state.links ?? [];
    const projectsById = new Map(all.filter(node => !node.resourceId).map(node => [node.id, node]));
    const belowCount = snapshot?.layers?.below.items ?? belowSummary(all).items;
    const sentBelow = (node: GraphNode) => node.belowAt ?? (node.projectId ? projectsById.get(node.projectId)?.belowAt : undefined);
    const dated = <T extends GraphNode & { summary?: string }>(node: T): T => node.resourceId && sentBelow(node) ? { ...node, summary: `⬇ ${new Date(sentBelow(node)!).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}${node.summary ? ` · ${node.summary}` : ''}` } : node;
    // Mirror: positions below are computed, and only the cards the layout shows are given to the map.
    const mirror = layer === 'below' && mirrorMode ? layoutBelow(all, snapshot?.state.resources ?? [], openMonths) : undefined;
    const nodes = mirror ? (() => {
      const areas = new Set(mirror.projects), loose = mirror.areas.find(area => area.loose);
      return [...all.filter(node => !node.resourceId && areas.has(node.id)), ...(loose ? [{ id: UNDERMAP_LOOSE, title: loose.title, position: { x: loose.x, y: loose.top } }] : []),
        ...all.filter(node => mirror.positions.has(node.id)).map(node => dated({ ...node, position: mirror.positions.get(node.id)!, ...(mirror.places.get(node.id)!.areaId === UNDERMAP_LOOSE ? { projectId: UNDERMAP_LOOSE } : {}) }))];
    })() : layer === 'map' ? layerNodes(all, 'map') : layerNodes(all, 'below').map(dated);
    const ids = new Set(nodes.map(node => node.id));
    const draft = layer === 'map' && paperDraft && !ids.has(paperDraft.nodeId) ? [{ id: paperDraft.nodeId, resourceId: paperDraft.resourceId, projectId: paperDraft.projectId, title: 'Note', position: paperDraft.position, mapDimensions: paperDraft.mapDimensions, summary: '', activity: 'unknown' as const, attention: 'none' as const }] : [];
    return { nodes: draft.length ? [...nodes, ...draft] : nodes, links: nodes === all ? links : links.filter(link => ids.has(link.sourceId) && ids.has(link.targetId)), belowCount, mirror };
  }, [snapshot?.state.nodes, snapshot?.state.links, snapshot?.state.resources, snapshot?.layers, layer, paperDraft, mirrorMode, layoutBelow, openMonths]);
  const mirrorBelow: MirrorLayout | undefined = layerGraph.mirror;
  const undermapView = useMemo(() => mirrorBelow && {
    areas: mirrorBelow.areas,
    toggle: (areaId: string, month: string) => setOpenMonths(old => { const { [areaId]: open, ...rest } = old; return open === month ? rest : { ...rest, [areaId]: month }; }),
    collapse: () => { if (!Object.keys(openMonthsRef.current).length) return false; setOpenMonths({}); return true; },
  }, [mirrorBelow]);
  const searchBelow = useCallback((query: string) => mirrorBelow ? searchUndermap(mirrorBelow, snapshotRef.current?.state.nodes ?? [], query, Infinity) : [], [mirrorBelow]);
  const flyBelow = (match: UndermapMatch) => { setEditor(undefined); setFoundBelow(match.id); revealNode(match.id, 'map'); };
  /** Plots exist on the map layer only; hidden plots and projects that turned plots off are left out. */
  const plots = useMemo(() => {
    const value = snapshot?.plots;
    return layer !== 'map' || !value || settings?.value.mapPlots === false ? undefined : value.list.filter(plot => !plot.hidden && !value.hiddenProjects.includes(plot.projectId));
  }, [snapshot?.plots, layer, settings?.value.mapPlots]);
  const summaryKey = JSON.stringify(snapshot?.projectSummaries?.list ?? []);
  const projectSummaries = useMemo(() => new Map((JSON.parse(summaryKey) as { projectId: string; next?: string; status?: string }[]).map(entry => [entry.projectId, { next: entry.next, status: entry.status }])), [summaryKey]);
  const layerResources = useMemo(() => {
    const saved = snapshot?.state.resources ?? [];
    if (!paperDraft || saved.some(resource => resource.id === paperDraft.resourceId)) return saved;
    const plugin = registry.get(paperDraft.pluginId);
    return [...saved, { id: paperDraft.resourceId, pluginId: paperDraft.pluginId, schemaVersion: plugin?.schemaVersion ?? 1, title: 'Note', data: { ...paperDraft.data, [plugin?.appearance?.paper?.textField ?? 'text']: '' } }];
  }, [snapshot?.state.resources, paperDraft, registry]);
  // Short notes connected to items become badges on them (MAP-BADGES); the map gets neither the notes nor their links.
  const badged = useMemo(() => mapBadges(layerGraph.nodes, layerResources, layerGraph.links), [layerGraph.nodes, layerGraph.links, layerResources]);
  // Below the map, zooming out past the minimum rises back up.
  useEffect(() => {
    const element = workspace.current;
    if (layer !== 'below' || !element) return;
    let charge = 0, decay: ReturnType<typeof setTimeout> | undefined;
    const wheel = (event: WheelEvent) => {
      const zoom = Number(element.querySelector('.map-area')?.getAttribute('data-zoom') ?? zoomRef.current ?? 1);
      if (event.deltaY <= 0 || zoom > ZOOM_LEVELS.min + .005 || (event.target as HTMLElement).closest('.map-card[data-expanded], .inline-editor, .rail-panel-sheet')) return;
      charge += event.deltaY; setRiseCharge(Math.min(1, charge / 500));
      clearTimeout(decay); decay = setTimeout(() => { charge = 0; setRiseCharge(0); }, 700);
      if (charge >= 500) { charge = 0; void travel('map'); }
    };
    element.addEventListener('wheel', wheel, { passive: true, capture: true });
    return () => { element.removeEventListener('wheel', wheel, { capture: true }); clearTimeout(decay); };
  }, [layer, travel]);
  /** Item views keep their own layout in the workspace view, beside their saved bounds. */
  const itemViewStore = useRef<ItemViewStore>({
    read: nodeId => viewRef.current?.itemViewState?.[nodeId] ?? {},
    save: (nodeId, patch) => {
      const state = snapshotRef.current?.state; if (!state || !viewRef.current) return;
      saveView({ itemViewState: patchItemViewState(viewRef.current.itemViewState, nodeId, patch, new Set(state.nodes.map(node => node.id))) });
    },
  }).current;
  /** Flies to an item a view just put on the map and selects it, once the workspace that has it is read. */
  const showOnMap = useCallback((nodeId: string) => {
    void window.craftingTable.workspaceRead().then(next => {
      if (!snapshotRef.current || next.cursor >= snapshotRef.current.cursor) { snapshotRef.current = next; setSnapshot(next); }
      setReveal({ nodeId, nonce: Date.now(), mode: 'map', select: [nodeId] });
    }).catch(error => setError(error.message));
  }, []);
  // Reads the resources when called, so a changed record never changes this function and with it every card's context.
  const renderDetail = useCallback<NonNullable<ProjectMapProps['renderDetail']>>((node, active) => {
    const resource = snapshotRef.current?.state.resources.find(resource => resource.id === node.resourceId);
    return resource ? <ErrorBoundary key={resource.id} fallback={(error, reset) => <PanelError error={error} retry={reset} />}><PluginDetail resource={resource} registry={registry} active={active} nodeId={node.id} onOpen={openResource} onShow={showOnMap} viewStore={itemViewStore}
      onEdit={() => setEditor({ mode: 'edit', nodeId: node.id, projectId: node.projectId, position: node.position, screen: { x: innerWidth / 2 - 150, y: 80 } })} /></ErrorBoundary> : <p>{node.summary}</p>;
  }, [registry, openResource, showOnMap]);
  const accept = (incoming: WorkspaceSnapshot) => {
    if (snapshotRef.current && incoming.cursor < snapshotRef.current.cursor) return;
    // A read returns the whole workspace; while the service sends layers, it is held as the layer on screen would receive it.
    const shown = incoming.layer || !snapshotRef.current?.layer ? incoming : { ...incoming, ...presentLayer(incoming.state, layerRef.current), layer: layerRef.current };
    const next = { ...shown, state: shareUnchanged(snapshotRef.current?.state, shown.state) };
    snapshotRef.current = next; setSnapshot(next);
  };
  /** Asks the service for `to`'s snapshots and takes its answer; a lost connection subscribes on that layer when it is back. */
  const subscribeLayer = async (to: MapLayer) => {
    try { const answer = await window.craftingTable.workspaceSubscribe({ layer: to }); if (answer) accept(answer); } catch { /* Resubscribed on reconnect. */ }
  };
  const settingsRef = useRef(settings); settingsRef.current = settings;
  /** One setting per item type decides whether opening marks an item seen; items and plugins have no say. */
  const seenOnOpenFor = useCallback((nodeId: string, context: OpenContext) => {
    const state = snapshotRef.current?.state, resourceId = state?.nodes.find(node => node.id === nodeId)?.resourceId;
    const type = resourceId ? state?.resources.find(resource => resource.id === resourceId)?.pluginId : undefined;
    return seenOnOpen(type, settingsRef.current?.value.notifications ?? { seenOnOpen: [] }, context);
  }, []);
  const { acknowledge, notices, opened, view: viewing, kept, restore } = useAttention(snapshot, accept, setError, seenOnOpenFor);
  // Panels that name items anywhere (Needs me's Earlier, the session list, the standup, the editor) read the Undermap once while open.
  const withUndermap = useUndermapWhile(attentionOpen || settingsOpen || standupOpen || Boolean(editor && editor.mode !== 'menu'), snapshot);
  const withUndermapRef = useRef(withUndermap); withUndermapRef.current = withUndermap;
  const [chromeDocked, setChromeDocked] = useState(false);
  const keep = useMemo(() => { const tier = kept && snapshot ? attentionRestorable(snapshot.state.nodes, kept)?.tier : undefined; return tier ? { id: kept!.id, tier } : undefined; }, [kept, snapshot]);
  useEffect(() => {
    const open = () => { void window.craftingTable.takeNotificationTarget().then(target => { if (target?.nodeId) revealRef.current(target.nodeId); }).catch(() => {}); };
    const off = window.craftingTable.onNotificationOpen(open); open(); return off;
  }, []);
  useEffect(() => {
    const take = () => { void window.craftingTable.takeInstallLink().then(link => {
      if (!link) return;
      setSessionListView(undefined); setInstallRequest({ id: ++installRequests.current, link }); setSettingsOpen(true);
    }).catch(() => {}); };
    const off = window.craftingTable.onInstallLink(take); take(); return off;
  }, []);

  useEffect(() => {
    let disposed = false, loaded = false, loading = false, delay = 500, bootstrapError = '';
    let retry: ReturnType<typeof setTimeout> | undefined;
    const acceptSettings = (next: SettingsSnapshot) => setSettings(old => old && old.revision >= next.revision ? old : next);
    const load = () => {
      if (disposed || loaded || loading) return;
      loading = true; clearTimeout(retry);
      // These are local reads only. Never retry an uncertain command or launch.
      void Promise.all([window.craftingTable.workspaceRead(), window.craftingTable.workspacePlugins(), window.craftingTable.viewRead(), window.craftingTable.workspaceCapabilities(), window.craftingTable.settingsRead(), installedRenderersReady()])
        .then(([next, types, savedView, capabilities, preferences]) => {
          if (disposed) return;
          loaded = true;
          acceptSettings(preferences); accept(next); void subscribeLayer(layerRef.current); setPlugins(types); viewRef.current = savedView; setView(savedView); setCapabilities(capabilities.creationActions); setProviders(capabilities.providers); setConnection('connected');
          const resolvedError = bootstrapError; setError(old => old === resolvedError ? '' : old);
        })
        .catch(error => {
          if (disposed) return;
          bootstrapError = error.message; setError(bootstrapError);
          retry = setTimeout(load, delay); delay = Math.min(delay * 2, 5000);
        }).finally(() => { loading = false; });
    };
    retryLoad.current = () => { setError(''); delay = 500; load(); };
    const offSettings = window.craftingTable.onSettings(acceptSettings);
    const off = window.craftingTable.onWorkspace(accept), offStatus = window.craftingTable.onConnection(value => { setConnection(value); if (value === 'connected') load(); });
    load();
    return () => { disposed = true; clearTimeout(retry); off(); offStatus(); offSettings(); };
  }, []);
  useEffect(() => {
    if (editor?.mode !== 'menu') { setMenuHighlight(undefined); return; }
    const dismiss = (event: PointerEvent) => {
      if (event.button === 0 && !(event.target as HTMLElement).closest('.canvas-context')) setEditor(undefined);
    };
    const rightClick = (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); setEditor(undefined); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) setEditor(undefined); };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('contextmenu', rightClick, true);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss, true); document.removeEventListener('contextmenu', rightClick, true); document.removeEventListener('keydown', escape); };
  }, [editor?.mode]);
  /** Applies to the workspace on screen, or to the newest one when only background writes landed in between. */
  const apply = async (commands: WorkspaceCommand[]) => {
    const seen = snapshotRef.current?.state;
    if (!seen) throw new Error('Workspace is not connected');
    const result = await applyToLatest(seen, commands,
      revision => window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: revision, actor: { kind: 'user', id: 'desktop' }, commands }),
      async () => { const fresh = await window.craftingTable.workspaceRead().catch(() => undefined); if (fresh) accept(fresh); return fresh?.state; });
    // The service broadcasts the state it committed before it replies; read it back only when that has not arrived.
    if ((snapshotRef.current?.state.revision ?? -1) < (result?.state?.revision ?? Infinity)) accept(await window.craftingTable.workspaceRead());
    setError('');
  };
  /** Saves and resolves with the revision now held, which has the saved commands. */
  const applyAt = async (commands: WorkspaceCommand[]) => { await apply(commands); return snapshotRef.current?.state.revision; };
  /** Text saves name the text they replace, so a write made elsewhere is never overwritten. */
  const writePaper = async (nodeId: string, patch: Record<string, string>, base?: string) => {
    const draft = paperDraftRef.current;
    if (draft?.nodeId === nodeId && !snapshotRef.current?.state.nodes.some(node => node.id === nodeId)) {
      const field = registry.get(draft.pluginId)?.appearance?.paper?.textField ?? 'text', data = { ...draft.data, ...patch };
      if (!data[field]?.trim()) { setPaperDraft({ ...draft, data }); return; }
      const state = snapshotRef.current!.state, source = state.nodes.find(node => node.id === draft.connectedFromId);
      const link = source && automaticLink(draft.linkId, source, { id: draft.nodeId });
      await apply([{ type: 'item.add', id: draft.nodeId, resourceId: draft.resourceId, pluginId: draft.pluginId, data, projectId: draft.projectId, position: draft.position },
        ...(draft.mapDimensions ? [{ type: 'node.resize' as const, id: draft.nodeId, dimensions: draft.mapDimensions }] : []),
        ...creationConnections(link && (link.kind === 'reference' || link.kind === 'context') ? { id: link.id, otherId: source!.id, kind: link.kind, sourceIsNew: link.sourceId === draft.nodeId } : undefined, draft.nodeId)]);
      setPaperDraft(current => current?.nodeId === nodeId ? undefined : current);
      return;
    }
    for (let attempt = 0; ; attempt++) {
      const state = snapshotRef.current?.state, node = state?.nodes.find(candidate => candidate.id === nodeId);
      const resource = state?.resources.find(candidate => candidate.id === node?.resourceId), paper = resource && registry.get(resource.pluginId)?.appearance?.paper;
      if (!resource || !paper) throw new Error('This note is no longer available.');
      const saved = String(resource.data[paper.textField] ?? '');
      if (base !== undefined && saved !== base) throw Object.assign(new Error('This note changed elsewhere. Your draft is kept.'), { code: 'NOTE_CONFLICT', theirs: saved });
      try { await apply([{ type: 'item.update', id: nodeId, data: { ...resource.data, ...patch } }]); return; }
      catch (error) {
        if ((error as { code?: string }).code !== 'REVISION_CONFLICT' || attempt >= 3) throw error;
        accept(await window.craftingTable.workspaceRead());
      }
    }
  };
  /** An unsaved paper tile keeps its new size and place with the draft; nothing is saved until it has text. */
  const resizeOnMap = (id: string, dimensions: { width: number; height: number }, position: { x: number; y: number }) => {
    const draft = paperDraftRef.current;
    if (draft?.nodeId === id && !snapshotRef.current?.state.nodes.some(node => node.id === id)) {
      setPaperDraft(current => current?.nodeId === id ? { ...current, mapDimensions: dimensions, position } : current);
      return Promise.resolve();
    }
    return apply([{ type: 'node.resize', id, dimensions, position }]).catch(error => { setError(error.message); throw error; });
  };
  const archivePaper = (nodeId: string, silent: boolean) => {
    if (paperDraftRef.current?.nodeId === nodeId && !snapshotRef.current?.state.nodes.some(node => node.id === nodeId)) { setPaperDraft(undefined); return; }
    const node = snapshotRef.current?.state.nodes.find(candidate => candidate.id === nodeId);
    if (!node) return;
    void apply([{ type: 'node.archive', id: nodeId }]).then(() => { if (!silent) setArchivedNote({ id: nodeId, title: node.title }); }).catch(error => setError(error.message));
  };
  const paperPlugin = plugins?.find(plugin => plugin.appearance?.paper && plugin.creation)?.id;
  const writeInPlace = (pluginId: string, anchor: Pick<Editor, 'position' | 'projectId' | 'connectedFromId'>) => {
    const nodeId = crypto.randomUUID();
    setEditor(undefined);
    setPaperDraft({ nodeId, resourceId: crypto.randomUUID(), linkId: crypto.randomUUID(), pluginId, position: anchor.position, projectId: anchor.projectId, connectedFromId: anchor.connectedFromId, data: {} });
    setReveal({ nodeId, nonce: Date.now(), origin: 'program' });
  };
  const pasteText = paperPlugin ? ({ text, position, projectId }: { text: string; position: { x: number; y: number }; projectId?: string }) => {
    const field = registry.get(paperPlugin)?.appearance?.paper?.textField ?? 'text';
    void apply([{ type: 'item.add', id: crypto.randomUUID(), resourceId: crypto.randomUUID(), pluginId: paperPlugin, data: { [field]: text }, projectId, position }]).catch(error => setError(error.message));
  } : undefined;
  const openConnections = () => { setSessionListView(undefined); setSettingsOpen(true); };
  const createProject = () => {
    const camera = view?.camera ?? { x: 70, y: 80, zoom: .85 };
    setEditor({ mode: 'create', initialType: 'project', screen: { x: 35, y: 60 }, position: { x: (innerWidth / 2 - camera.x) / camera.zoom, y: (innerHeight / 2 - 80 - camera.y) / camera.zoom } });
  };
  /** A change to one link lands on the newest revision while that link is still the one the person chose; other writes in between never refuse it. */
  const applyToLink = async (seen: GraphLink, commands: WorkspaceCommand[]) => {
    for (let attempt = 0; ; attempt++) {
      try { await apply(commands); return; }
      catch (error) {
        if ((error as { code?: string }).code !== 'REVISION_CONFLICT' || attempt >= 3) throw error;
        const fresh = await window.craftingTable.workspaceRead(); accept(fresh);
        const current = fresh.state.links.find(link => link.id === seen.id);
        if (!current || JSON.stringify(current) !== JSON.stringify(seen)) throw new Error('This connection changed elsewhere. Check it and try again.');
      }
    }
  };
  const run = (commands: WorkspaceCommand[]) => { setEditor(undefined); void apply(commands).catch(error => setError(error.message)); };
  /** Mute is display only. Unmuting says how many items were waiting and can be undone. */
  const setMuted = (id: string, muted: boolean) => {
    const state = snapshotRef.current?.state, project = state?.nodes.find(node => node.id === id);
    if (!state || !project) return;
    const needs = attentionCounts(attentionItems(state.nodes, id), counting).needsMe;
    setEditor(undefined); setUnmuted(undefined);
    void apply([{ type: 'project.mute', id, muted }]).then(() => { if (!muted) setUnmuted({ id, title: project.title, needs }); }).catch(error => setError(error.message));
  };
  const selectedLink = snapshot?.state.links.find(link => link.id === editor?.linkId);
  const menuTargets = useMemo(() => [editor?.linkId, editor?.nodeId, ...editor?.nodeIds ?? []].filter(id => id !== undefined), [editor?.linkId, editor?.nodeId, editor?.nodeIds]);
  const selected = snapshot?.state.nodes.find(node => node.id === editor?.nodeId);
  const selectedResource = resources?.find(resource => resource.id === selected?.resourceId);
  const selectedPlugin = plugins?.find(plugin => plugin.id === selectedResource?.pluginId);
  const pluginSettings = pluginSettingsValues(plugins ?? [], settings?.value.plugins);
  const scope = selectedLink ? 'link' : selected ? selected.resourceId ? 'item' : 'project' : editor?.projectId ? 'neighborhood' : 'board';
  const belowMenu = (node?: GraphNode) => layer === 'below' ? { blocker: node && snapshot ? surfaceBlocker(node, snapshot.state.nodes) : undefined } : undefined;
  /** The item's web page: what Open on … opens and Copy URL copies. */
  const webPage = (resource?: ResourceRecord) => { const link = resource && registry.get(resource.pluginId)?.webLink, url = link && webLinkUrl(link.template, resource.data); return url ? { label: link!.label, url } : undefined; };
  const web = webPage(selectedResource), webUrl = web?.url;
  /** Opens the item's web page in the browser, when its type has one. */
  const webOpener = (id: string) => {
    const state = snapshotRef.current?.state, url = webPage(state?.resources.find(resource => resource.id === state.nodes.find(node => node.id === id)?.resourceId))?.url;
    return url ? () => void window.craftingTable.openUrl(url).then(() => { recordOpened(id); opened(id); }).catch(error => setError(error.message)) : undefined;
  };
  /** A middle click: false when the item has no web page. */
  const openOnWeb = (id: string) => { const open = webOpener(id); open?.(); return Boolean(open); };
  // A generic link whose URL a more specific type claims offers Convert in its menu (RES-10).
  const convertibleUrl = editor?.mode === 'menu' && layer === 'map' && selectedResource ? registry.linkUrl(selectedResource) : undefined;
  const conversions = useUrlCandidates(convertibleUrl ?? '', Boolean(convertibleUrl));
  const linkEnds = selectedLink && [snapshot?.state.nodes.find(node => node.id === selectedLink.sourceId), snapshot?.state.nodes.find(node => node.id === selectedLink.targetId)];
  const selectedItems = snapshot?.state.nodes.filter(node => editor?.nodeIds?.includes(node.id) && !isArchived(node, snapshot.state.nodes)) ?? [];
  // Any item card on the map can move to another project; a selection moves as one block led by the card that was right-clicked.
  const moveIds = editor?.mode !== 'menu' || layer !== 'map' ? undefined : selectedItems.length > 1 ? selectedItems.every(node => node.resourceId) ? [editor.nodeId!, ...selectedItems.map(node => node.id).filter(id => id !== editor.nodeId)] : undefined
    : selected?.resourceId ? [selected.id] : undefined;
  const move = moveIds && snapshot ? moveToProjectAction(moveTargets(snapshot.state, moveIds)) : undefined;
  // Move to plot and Remove from plot (MAP-24) while plots are on; hidden plots are listed too.
  const plotEntries = moveIds && snapshot && settings?.value.mapPlots !== false ? itemPlotActions(snapshot.state.nodes, snapshot.plots?.list ?? [], moveIds) : [];
  // The project a Mute or Unmute entry acts on: the project itself, or the neighbourhood that was right-clicked.
  const muteTarget = editor?.mode === 'menu' && layer === 'map' && snapshot ? scope === 'project' ? selected : scope === 'neighborhood' ? snapshot.state.nodes.find(node => node.id === editor.projectId && !node.resourceId) : undefined : undefined;
  // A hidden item comes back through an item it links to; one the host may hide offers Hide.
  const shownPartner = editor?.mode === 'menu' && layer === 'map' && selected?.resourceId && snapshot ? hiddenPartner(snapshot.state.nodes, snapshot.state.links, selected.id) : undefined;
  const visibility = { ...(shownPartner ? { show: shownPartner.hideLabel } : {}), ...(selected?.hideLabel && !selected.hiddenAt ? { hide: selected.hideLabel } : {}) };
  const sizeDefault = editor?.mode === 'menu' && layer === 'map' && selected && snapshot && settings ? sizeAsDefault(selected, snapshot.state.nodes, snapshot.state.resources, registry, settings.value.itemMapSizes) : undefined;
  const singleActions = selectedLink ? linkMenuActions(selectedLink.kind, linkEnds?.[0]?.title ?? 'Unavailable item', linkEnds?.[1]?.title ?? 'Unavailable item') : contextMenuActions(scope, Boolean(selected?.completedAt), itemEditLabel(selectedPlugin), enabledMenuGroups(selectedPlugin?.contextMenu, pluginSettings), selectedPlugin?.todoSupport ? { enabled: Boolean(selected?.inTodoList) } : undefined, belowMenu(selected), web, Boolean(selectedPlugin?.activityTitle && settings?.value.summaries.agentTitles),
    scope === 'project' && selected && layer === 'map' && settings?.value.mapPlots ? { shown: !snapshot?.plots?.hiddenProjects.includes(selected.id), hidden: snapshot?.plots?.list.filter(plot => plot.projectId === selected.id && plot.hidden).length ?? 0 } : undefined,
    move,
    muteTarget && snapshot ? muteProjectAction(Boolean(muteTarget.mutedAt), attentionCounts(attentionItems(snapshot.state.nodes, muteTarget.id), counting).needsMe) : undefined,
    convertLinkActions(conversions.candidates.flatMap(candidate => { const type = plugins?.find(plugin => plugin.id === candidate.pluginId); return type && !type.creation?.urlFallback && type.id !== selectedResource?.pluginId ? [{ pluginId: type.id, name: type.name }] : []; })),
    selectedResource ? itemMenuCustom(settings?.value.menus, selectedResource.pluginId) : undefined, sizeDefault, visibility,
    // A note that became a badge on its own shows Badge as its Show as.
    layer === 'map' && selected && selectedResource ? fieldMenuActions(selectedPlugin?.fields, selectedResource.data, { display: badged.attached.has(selected.id) || selectedResource.data.display === 'badge' ? 'badge' : 'note' }) : [], plotEntries);
  const menuActions = selectedItems.length > 1 ? sharedContextMenuActions(selectedItems.map(node => {
    const resource = resources?.find(r => r.id === node.resourceId), plugin = plugins?.find(p => p.id === resource?.pluginId);
    return contextMenuActions(node.resourceId ? 'item' : 'project', Boolean(node.completedAt), undefined, enabledMenuGroups(plugin?.contextMenu, pluginSettings), plugin?.todoSupport ? { enabled: Boolean(node.inTodoList) } : undefined, belowMenu(node), webPage(resource), false, undefined, move, undefined, [], {}, undefined, {}, [], plotEntries);
  })) : !selectedLink && selected?.resourceId && settings?.value.itemDelete ? [...singleActions, deleteItemAction()] : singleActions;
  /** One command moves the block; then the map flies to the lead as Show on map does, keeping the moved items selected and closed. */
  const moveToProject = (ids: string[], projectId: string | null) => {
    setEditor(undefined);
    void apply([{ type: 'nodes.send', ids, projectId }]).then(() => setReveal({ nodeId: ids[0], nonce: Date.now(), mode: 'map', select: ids })).catch(error => setError(error.message));
  };
  /** Pins the items in a plot of their project, in a new plot, or unpins them. */
  const plotItems = (ids: string[], id: MenuActionId) => {
    setEditor(undefined);
    const plots = snapshotRef.current?.plots?.list ?? [], node = snapshotRef.current?.state.nodes.find(node => node.id === ids[0]);
    const projectId = id === 'plot-unpin' ? plots.find(plot => plot.pinnedMemberIds.includes(ids[0]))?.projectId : node?.projectId;
    if (!projectId) return;
    const request: Record<string, string | string[]> = id === 'plot-new' ? { operation: 'create', memberIds: ids } : id === 'plot-unpin' ? { operation: 'unpin', memberIds: ids } : { operation: 'pin', plotId: id.slice('plot-pin:'.length), memberIds: ids };
    void window.craftingTable.runtimeRun({ action: 'plot', nodeId: projectId, arguments: request }).catch(error => setError(error.message));
  };
  /** Animate the cards, then send the command; a failed command shows them again. */
  const moveLayer = (ids: string[], action: 'below' | 'surface') => {
    setEditor(undefined);
    const duration = motion, host = workspace.current;
    const cards = ids.map(id => document.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`)).filter((card): card is HTMLElement => Boolean(card));
    const command: WorkspaceCommand = ids.length > 1 ? { type: 'nodes.action', ids, action } : { type: action === 'below' ? 'node.below' : 'node.surface', id: ids[0] };
    const animations = duration && host ? cards.map(card => sinkItem(host, card, action === 'below' ? 'down' : 'up', ITEM_SINK_MS)) : [];
    for (const card of cards) card.style.visibility = 'hidden';
    void Promise.all(animations).then(() => apply([command])).catch(error => { for (const card of cards) card.style.visibility = ''; setError(error.message); });
  };
  /** The other items of the type are pinned before the default changes, so a refused settings write leaves every item
   * as it looks. The map sizes are written as the Settings dialog writes them. */
  const saveSizeAsDefault = () => {
    setEditor(undefined);
    if (!sizeDefault || sizeDefault.disabled || !settings) return;
    const { pins, itemMapSizes } = sizeDefault, saved = settings;
    void (pins.length ? apply(pins.map(pin => ({ type: 'node.resize' as const, ...pin }))) : Promise.resolve())
      .then(() => window.craftingTable.settingsWrite({ expectedRevision: saved.revision, value: { ...saved.value, itemMapSizes } })).catch(error => setError(error.message));
  };
  /** Copying never opens the item or its page, so nothing is acknowledged. */
  const copyUrls = (urls: string[]) => {
    setEditor(undefined);
    void window.craftingTable.copyUrl(urls.length === 1 ? urls[0]! : urls).then(() => setCopiedUrls({ count: urls.length })).catch(error => setError(error.message));
  };
  /** The plugin entries a pick starts: the entry itself, or each entry it `runs`, with its own label for its toast. */
  const pluginPicks = (id: MenuActionId) => {
    const entries = menuActions.flatMap(group => group.children ?? []), action = entries.find(action => action.id === id);
    return (action?.runs ?? (action ? [action.id] : [])).flatMap(run => entries.filter(entry => entry.id === run));
  };
  const menuAction = (id: MenuActionId) => {
    if (!editor) return;
    if (id.startsWith('send:')) { if (moveIds && id.length > 'send:'.length) moveToProject(moveIds, id.slice('send:'.length)); return; }
    if (id === 'plot-new' || id === 'plot-unpin' || id.startsWith('plot-pin:')) { if (moveIds && id !== 'plot-pin:') plotItems(moveIds, id); return; }
    if (selectedItems.length > 1) {
      if (id.startsWith('plugin:')) {
        // A selection's plugin entry runs once per item: each start keeps its own toast and Open action.
        const picks = pluginPicks(id);
        if (!picks.length) return;
        setEditor(undefined);
        for (const node of selectedItems) { const resource = resources?.find(resource => resource.id === node.resourceId); if (resource) for (const pick of picks) resourceMenu.start(node.id, resource, pick.id.slice('plugin:'.length), pick.label); }
        return;
      }
      if (!menuActions.some(action => action.id === id)) return;
      if (id === 'below' || id === 'surface') { moveLayer(selectedItems.map(node => node.id), id); return; }
      if (id === 'copy-url') { copyUrls(selectedItems.flatMap(node => webPage(resources?.find(resource => resource.id === node.resourceId))?.url ?? [])); return; }
      run([{ type: 'nodes.action', ids: selectedItems.map(node => node.id), action: id as 'archive' | 'complete' | 'reopen' | 'add-todo' | 'remove-todo' }]); return;
    }
    if (id.startsWith('plugin:') && selected && selectedResource) {
      const picks = pluginPicks(id);
      if (picks.length) { setEditor(undefined); for (const pick of picks) resourceMenu.start(selected.id, selectedResource, pick.id.slice('plugin:'.length), pick.label); }
      return;
    }
    if ((id === 'plots-toggle' || id === 'plots-unhide') && selected) {
      setEditor(undefined);
      const hidden = snapshotRef.current?.plots?.list.filter(plot => plot.projectId === selected.id && plot.hidden) ?? [];
      const requests = id === 'plots-toggle' ? [{ operation: 'project', shown: Boolean(snapshotRef.current?.plots?.hiddenProjects.includes(selected.id)) }] : hidden.map(plot => ({ operation: 'hide', plotId: plot.id, hidden: false }));
      void requests.reduce((done, request) => done.then(() => window.craftingTable.runtimeRun({ action: 'plot', nodeId: selected.id, arguments: request })), Promise.resolve<unknown>(undefined)).catch(error => setError(error.message));
      return;
    }
    if ((id === 'mute' || id === 'unmute') && muteTarget) { setMuted(muteTarget.id, id === 'mute'); return; }
    if (id.startsWith('convert:') && selected) { setEditor(undefined); void window.craftingTable.runtimeRun({ action: 'resource.convert', nodeId: selected.id, arguments: { pluginId: id.slice('convert:'.length) } }).catch(error => setError(error.message)); return; }
    if (id === 'auto-title' && selected) { setEditor(undefined); void window.craftingTable.runtimeRun({ action: 'agent.title', nodeId: selected.id, arguments: {} }).catch(error => setError(error.message)); return; }
    if (selected && (id === 'add-todo' || id === 'remove-todo')) { run([{ type: 'node.todo', id: selected.id, enabled: id === 'add-todo' }]); return; }
    if (id === 'open' && selected) { setEditor(undefined); revealNode(selected.id); return; }
    if (id === 'show-hidden' && selected && shownPartner) { const shownId = shownPartner.id; setEditor(undefined); void apply([{ type: 'node.show', id: shownId, near: [selected.id] }]).then(() => setReveal({ nodeId: shownId, nonce: Date.now(), mode: 'map', select: [shownId] })).catch(error => setError(error.message)); return; }
    if (id === 'hide-item' && selected) { run([{ type: 'node.hide', id: selected.id }]); return; }
    if (id === 'connect' && selected) { setEditor(undefined); setConnectionDraft({ sourceId: selected.id, screen: editor.screen }); return; }
    if (id === 'new-item') { setEditor({ ...editor, mode: 'create' }); return; }
    if (id === 'new-project') { setEditor({ ...editor, mode: 'create', initialType: 'project', nodeId: undefined, projectId: undefined }); return; }
    if (id === 'archive-browser') { setEditor(undefined); setArchiveOpen(true); return; }
    if (id === 'open-web' && webUrl) { setEditor(undefined); const nodeId = selected?.id; void window.craftingTable.openUrl(webUrl).then(() => { if (nodeId) { recordOpened(nodeId); opened(nodeId); } }).catch(error => setError(error.message)); return; }
    if (id === 'copy-url' && webUrl) { copyUrls([webUrl]); return; }
    if (id === 'edit' && selected) { setEditor({ ...editor, mode: 'edit' }); return; }
    if (id === 'size-default') { saveSizeAsDefault(); return; }
    if ((id === 'make-blocking' || id === 'make-normal' || id === 'reverse-link') && selectedLink) {
      const [source, target] = linkEnds ?? [];
      if (!source || !target) { setEditor(undefined); setError('One of these items is no longer available.'); return; }
      const link: GraphLink = id === 'make-blocking' ? { ...selectedLink, kind: 'blocks' } : id === 'reverse-link' ? { ...selectedLink, sourceId: target.id, targetId: source.id }
        : { ...automaticLink(selectedLink.id, source, target), label: selectedLink.label };
      setEditor(undefined); void applyToLink(selectedLink, [{ type: 'link.save', link }]).catch(error => setError(error.message)); return;
    }
    if (id === 'remove-link' && selectedLink) {
      setEditor(undefined); void applyToLink(selectedLink, [{ type: 'link.remove', id: selectedLink.id }]).then(() => setRemovedLink(selectedLink)).catch(error => setError(error.message)); return;
    }
    if (id === 'delete-cancel') { setEditor(undefined); return; }
    if (id === 'delete-confirm' && selected?.resourceId) { run([{ type: 'node.archive', id: selected.id }, { type: 'node.delete', id: selected.id }]); return; }
    if (selected && (id === 'below' || id === 'surface')) { moveLayer([selected.id], id); return; }
    if (selected && ['complete', 'reopen', 'archive'].includes(id)) run([{ type: `node.${id}` as 'node.complete' | 'node.reopen' | 'node.archive', id: selected.id }]);
  };
  const below = layer === 'below';
  const saveViewBounds = (shown: ReadonlySet<string>, positions: Record<string, ViewPlace>, sizes: Record<string, ViewSize>) => {
    const state = snapshotRef.current?.state; if (!state || !viewRef.current) return;
    const saved = viewRef.current.itemViewBounds, next = mergeViewBounds(saved, shown, new Set(state.nodes.map(node => node.id)), positions, sizes);
    if (!sameViewBounds(next, saved)) saveView({ itemViewBounds: next });
  };
  const foundNodes = useMemo(() => foundBelow ? [foundBelow] : undefined, [foundBelow]);
  const [controlsOpen, setControlsOpen] = useState(false);
  const travelLayer = () => { if (!snapshot || travelling) return false; rail.clear(); void travel(below ? 'map' : 'below'); };
  useWorkspaceShortcuts({
    'rail.undermap': travelLayer, 'layer.toggle': travelLayer,
    'undermap.search': () => { if (!below || !mirrorBelow || travelling) return false; rail.clear(); undermapSearch.current?.focus(); },
    'settings.open': () => { setSessionListView(undefined); setSettingsOpen(true); },
    'rail.settings': () => { setSessionListView(undefined); setSettingsOpen(true); },
    'shortcuts.help': () => { setControlsOpen(old => !old); },
  });
  return <RailContext.Provider value={rail}><section ref={workspace} className="live-workspace" aria-label={below ? 'Undermap' : 'Project map'} data-layer={layer} data-travelling={travelling || undefined} data-chrome-docked={chromeDocked || undefined}>
    {snapshot && plugins && view && settings && <ProjectMap key={layer} layer={layer} neighborhoodColor={below ? undermapColor : undefined} registry={registry} nodes={badged.nodes} resources={layerResources} links={badged.links} badges={badged.onItems} onBadge={(noteId, anchor, menu) => { setConnectionDraft(undefined); setEditor({ ...anchor, nodeId: noteId, mode: menu ? 'menu' : 'edit' }); }}
      onMarkSeen={acknowledge} keep={keep} onKeep={restore} onChromeCover={setChromeDocked} onOpened={opened} onView={viewing} onMute={below ? undefined : setMuted}
      mapCorner={settings.value.mapCorner} projectSummaries={projectSummaries} overview={overviewOpen} onOverview={open => { setOverviewOpen(open); if (open && atlasCorner) { rail.unpin('attention'); rail.close('attention'); } }}
      projectsPanel={view.projectsPanel} onProjectsPanel={patch => { const next = viewSchema.shape.projectsPanel.safeParse({ ...viewRef.current?.projectsPanel, ...patch }); if (next.success) saveView({ projectsPanel: next.data }); }} undermapCount={layerGraph.belowCount} onTravel={to => { rail.clear(); void travel(to); }}
      highlightedNodes={menuHighlight?.nodes ?? (below && foundBelow ? foundNodes : highlightedNodes)} highlightedLinks={menuHighlight?.links} menuFor={editor?.mode === 'menu' ? menuTargets : undefined} undermap={below ? undermapView : undefined}
      attentionCounting={counting} itemMapSizes={settings.value.itemMapSizes} itemViews={settings.value.itemViews} viewBounds={view.itemViewBounds} onViewBounds={saveViewBounds} neighborhoodPadding={settings.value.neighborhoodPadding} neighborhoodAppearance={neighborhoodAppearance} dashboards={settings.value.mapDashboards} workingMark={settings.value.workingMark} plots={plots} onPlot={(projectId, request) => window.craftingTable.runtimeRun({ action: 'plot', nodeId: projectId, arguments: request }).then(() => {}, error => { if (request.operation !== 'seen') setError(error.message); })} plotNaming={settings.value.summaries.plotNames} plotTargets={ids => snapshot ? moveTargets(snapshot.state, ids) : []} onMoveItems={moveToProject} onSendBelow={ids => moveLayer(ids, 'below')} hideImpliedLinks={settings.value.hideImpliedLinks} snap={settings.value.snapToGrid ? SNAP_PITCH : undefined} collisions={settings.value.mapCollisions} initialViewport={view.camera} onViewport={camera => { zoomRef.current = camera.zoom; saveView({ camera }); }} reveal={reveal} onRevealed={revealed => setReveal(current => current === revealed ? undefined : current)}
      onItemDrag={below ? undefined : (id, point) => todoOverlay.current?.drag(id, point)} onItemDrop={below ? undefined : (id, point) => todoOverlay.current?.drop(id, point) ?? false}
      onLink={below ? undefined : anchor => {
        setEditor(undefined); setConnectionDraft(undefined);
        if (!anchor.targetId) { setEditor({ ...anchor, mode: 'create', connectedFromId: anchor.sourceId }); return; }
        const nodes = snapshotRef.current!.state.nodes;
        const source = nodes.find(node => node.id === anchor.sourceId), target = nodes.find(node => node.id === anchor.targetId);
        if (!source || !target) { setError('One of these items is no longer available.'); return; }
        void apply([{ type: 'link.save', link: automaticLink(crypto.randomUUID(), source, target) }]).catch(error => setError(error.message));
      }}
      onConnect={below ? undefined : (sourceId, screen) => { setEditor(undefined); setConnectionDraft({ sourceId, screen }); }}
      onContext={anchor => { setConnectionDraft(undefined); setEditor({ ...anchor, mode: 'menu' }); }}
      onCreate={below ? undefined : anchor => { setConnectionDraft(undefined); setEditor({ ...anchor, mode: 'create' }); }}
      onTodoDrop={!below && !editor && !settingsOpen && !archiveOpen && !connectionDraft ? target => apply([{ type: 'todo.place', ...target, nodeId: crypto.randomUUID(), resourceId: crypto.randomUUID() }]).catch(error => setError(error.message)) : undefined}
      todoDrag={todoDrag} todos={todoEntries} onTodoShow={id => todoOverlay.current?.show(id)}
      onTodoComplete={async (id, completed) => {
        const entry = listTodos(snapshotRef.current!.state).find(entry => entry.id === id);
        if (!entry) { setError('This to-do is no longer available.'); throw new Error('This to-do is no longer available.'); }
        await apply([completeTodo(entry, completed)]).catch(error => { setError(error.message); throw error; });
      }}
      onPreviewDetail={(nodeId, signal) => {
        const state = snapshotRef.current?.state, resource = state?.resources.find(resource => resource.id === state.nodes.find(node => node.id === nodeId)?.resourceId);
        return resource ? previewViews.preview(resource, { runAction: async (action, input) => window.craftingTable.runtimeRun({ action: action as 'resource.read', nodeId, arguments: input ?? {} }) as Promise<any> }, signal) : Promise.resolve(undefined);
      }}
      onUrlDrop={!below && (!editor || editor.mode === 'menu') && !settingsOpen && !archiveOpen && !connectionDraft ? ({ url, ...anchor }) => {
        setEditor({ ...anchor, mode: 'create', initialType: FROM_URL, initialUrl: url });
      } : undefined}
      onMove={(id, position, projectId) => apply([...(projectId ? [{ type: 'node.attach' as const, id, projectId }] : []), { type: 'node.move', id, position }]).catch(error => setError(error.message))}
      onMoveMany={positions => apply([{ type: 'nodes.move', positions }]).catch(error => setError(error.message))}
      onResize={below && mirrorBelow ? undefined : resizeOnMap}
      onRename={(id, title) => apply([{ type: 'node.update', id, title }])}
      onComplete={(id, completed) => apply([{ type: completed ? 'node.complete' : 'node.reopen', id }]).catch(error => { setError(error.message); throw error; })}
      onPaperWrite={writePaper} onPaperArchive={archivePaper} onOpenUrl={url => { void window.craftingTable.openUrl(url).catch(error => setError(error.message)); }}
      onPasteText={!below && !editor && !settingsOpen && !archiveOpen && !connectionDraft ? pasteText : undefined}
      webOpener={settings.value.doubleClickOpensWeb ? webOpener : undefined} onOpenWeb={openOnWeb}
      onActivate={node => {
        const resource = resources?.find(resource => resource.id === node.resourceId);
        const resolved = resource && registry.resolve(resource);
        const activation = resolved?.available ? resolved.plugin.activation : undefined;
        if (activation?.kind !== 'browser') return false;
        const url = resource!.data[activation.urlField];
        if (typeof url !== 'string') setError('This item has no browser URL.');
        else void window.craftingTable.openUrl(url).catch(error => setError(error.message));
        return true;
      }}
      renderDetail={renderDetail} />}
    {!snapshot && (error ? <div className="error-screen-overlay"><ErrorScreen error={error} kind="load" retry={() => retryLoad.current()} /></div> : <div className="map-message"><p>Opening your table…</p></div>)}
    <ToolRail below={below} settings={settingsOpen} actions={actionsOpen || standupOpen} />
    {snapshot && view && <NeedsMeTool items={attention} muted={mutedAttention} counting={counting} state={withUndermap ?? snapshot.state} highlight={setAttentionHighlight} size={view.attentionPanel ?? {}} onSize={size => saveView({ attentionPanel: size })}
      reveal={nodeId => revealNode(nodeId)} locate={nodeId => revealNode(nodeId, 'map')} dismiss={acknowledge} openWeb={openOnWeb} unavailable={setError} />}
    {snapshot && view && plugins && <TodoOverlay ref={todoOverlay} state={snapshot.state} registry={registry} view={view} save={applyAt} saveView={saveView} reveal={nodeId => revealNode(nodeId, 'map')} onDragTodo={setTodoDrag}
      openWeb={nodeId => { if (!openOnWeb(nodeId)) return; if (needsMeIds(snapshotRef.current?.state.nodes ?? []).has(nodeId)) acknowledge(nodeId); }}
      announce={setTodoUndo} doneArchiveDays={doneArchiveDays(pluginSettings['workspace.todo']?.doneArchiveDays)} />}
    {snapshot && view && <RemindersTool reminders={snapshot.reminders} size={view.remindersPanel ?? {}} onSize={size => saveView({ remindersPanel: size })} />}
    {snapshot && view && <GitHubInboxTool openConnections={openConnections} size={view.inboxPanel ?? {}} onSize={size => saveView({ inboxPanel: size })} reveal={nodeId => revealNode(nodeId)} mapCenter={() => {
      const camera = viewRef.current?.camera ?? { x: 70, y: 80, zoom: .85 };
      return { x: (innerWidth / 2 - camera.x) / camera.zoom, y: (innerHeight / 2 - camera.y) / camera.zoom };
    }} />}
    {snapshot && <button type="button" className="below-portal" style={{ left: railSlot('undermap').x, top: railSlot('undermap').y }} data-layer={layer} onPointerEnter={() => setPortalHot(true)} onPointerLeave={() => setPortalHot(false)} onFocus={() => setPortalHot(true)} onBlur={() => setPortalHot(false)} aria-label={below ? 'Back to the map' : 'Go to Undermap'} aria-keyshortcuts={`${shortcutKey('rail.undermap')} ${shortcutKey('layer.toggle')}`} title={below ? 'Back to the map' : 'Go to Undermap'} disabled={travelling} onClick={() => { rail.clear(); void travel(below ? 'map' : 'below'); }}>
      <PortalArt destination={below ? 'map' : 'below'} animate={portalHot} />
    </button>}
    {STANDUP_ENABLED && <ActionsTool open={actionsOpen} setOpen={setActionsOpen} standup={() => { rail.clear(); setStandupOpen(true); }} />}
    <div className="rail-panel rail-settings" style={{ left: railSlot('settings').x, top: railSlot('settings').y }}>
      <button type="button" className="rail-panel-toggle" aria-label="Settings" title="Settings" aria-haspopup="dialog" aria-expanded={settingsOpen} aria-keyshortcuts={`${shortcutKey('rail.settings')} ${shortcutKey('settings.open')}`} onClick={() => { setSessionListView(undefined); setSettingsOpen(true); }}><ItemIcon icon="settings" /></button>
    </div>
    {snapshot && below && <div className="below-bar"><span role="status">Undermap · {layerGraph.belowCount.toLocaleString('en-US')} {layerGraph.belowCount === 1 ? 'item' : 'items'}</span>
      {mirrorBelow && <UndermapSearch ref={undermapSearch} shortcut={shortcutKey('undermap.search')} search={searchBelow} pick={flyBelow} />}<button type="button" onClick={() => setArchiveOpen(true)}>Archive</button><button type="button" onClick={() => { void travel('map'); }}>↑ Back to map</button></div>}
    {snapshot && below && !layerGraph.nodes.length && <div className="map-message below-empty"><p>Undermap is empty. Right-click an item on the map and choose <b>Send to Undermap</b>.</p></div>}
    {below && riseCharge > 0 && <div className="below-rise" aria-hidden="true"><span>Keep zooming out to rise to the map</span><i style={{ width: `${riseCharge * 100}%` }} /></div>}
    {snapshot && !below && !snapshot.state.nodes.length && !snapshot.layers?.below.items && <div className="map-message"><span className="eyebrow">YOUR WORKSPACE</span><h1>A place for every project.</h1><p>Double-click anywhere to add an item · right-click for more</p><button onClick={createProject}>Create your first project</button>
      <FirstRunCard state={snapshot.state} connections={settings?.value.connections ?? []} docked={false} openConnections={openConnections} /></div>}
    {snapshot && !below && snapshot.state.nodes.length > 0 && !snapshot.layers?.below.items && snapshot.state.nodes.every(node => !node.resourceId) && <FirstRunCard state={snapshot.state} connections={settings?.value.connections ?? []} docked openConnections={openConnections} />}
    <div className="map-status"><ConnectionStatus connection={connection} /></div>
    {connectionDraft && snapshot && <ConnectionEditor draft={connectionDraft} state={snapshot.state} registry={registry} save={apply} close={() => setConnectionDraft(undefined)}
      highlight={nodeId => setMenuHighlight(nodeId ? { nodes: [nodeId], links: [] } : undefined)} />}
    {archiveOpen && snapshot && <ArchiveBrowser state={snapshot.state} save={apply} close={() => setArchiveOpen(false)} />}
    <div className="workspace-notices">
    <RecoveryStatus />
    {resourceMenu.notices.map(notice => <ResourceActionNotice key={notice.key} notice={notice} open={openResource} dismiss={() => resourceMenu.dismiss(notice.key)} />)}
    {notices.map(notice => <CompletionNotice key={notice.key} notice={notice} open={nodeId => notice.failed ? openResource(nodeId) : revealNode(nodeId)} />)}
    {updateOffers.map(offer => <UpdateNotice key={offer.key} offer={offer} dismiss={() => saveView({ dismissedUpdates: { ...viewRef.current?.dismissedUpdates, [offer.key]: offer.latest } })}
      open={() => { setSessionListView(undefined); if (offer.plugin) setInstallRequest({ id: ++installRequests.current, link: { source: offer.plugin.source, ref: offer.latest } }); else setSettingsSection('General'); setSettingsOpen(true); }} />)}
    {removedLink && linkNotice.visible && <Toast tone="undo" title="Connection removed" detail={`${snapshot?.state.nodes.find(node => node.id === removedLink.sourceId)?.title ?? 'Item'} → ${snapshot?.state.nodes.find(node => node.id === removedLink.targetId)?.title ?? 'item'}`}
      action={{ label: 'Undo', run: () => {
        if (snapshotRef.current?.state.links.some(link => link.id === removedLink.id)) { setError('This connection changed after removal. Undo cannot replace it.'); return; }
        void apply([{ type: 'link.save', link: removedLink }]).then(() => setRemovedLink(undefined)).catch(error => setError(error.message));
      } }} dismiss={() => setRemovedLink(undefined)} dismissLabel="Dismiss undo" />}
    {archivedNote && noteNotice.visible && <Toast tone="undo" title="Note archived" detail={archivedNote.title}
      action={{ label: 'Undo', run: () => { void apply([{ type: 'node.restore', id: archivedNote.id }]).then(() => setArchivedNote(undefined)).catch(error => setError(error.message)); } }}
      dismiss={() => setArchivedNote(undefined)} dismissLabel="Dismiss undo" />}
    {todoUndo && todoUndoNotice.visible && <Toast tone="undo" title={todoUndo.title} detail={todoUndo.detail}
      action={todoUndo.undo.length ? { label: 'Undo', run: () => { const { undo } = todoUndo; setTodoUndo(undefined); void apply(undo).catch(error => setError(error.message)); } } : undefined}
      dismiss={() => setTodoUndo(undefined)} dismissLabel="Dismiss undo" />}
    {unmuted && unmuteNotice.visible && <Toast tone="undo" title={`${unmuted.title} unmuted`} detail={unmuted.needs ? `${NEEDS_ME}: ${unmuted.needs}` : undefined}
      action={{ label: 'Undo', run: () => { const { id } = unmuted; setUnmuted(undefined); void apply([{ type: 'project.mute', id, muted: true }]).catch(error => setError(error.message)); } }}
      dismiss={() => setUnmuted(undefined)} dismissLabel="Dismiss undo" />}
    {copiedUrls && copyNotice.visible && <Toast tone="done" title={copiedUrls.count === 1 ? 'URL copied' : `${copiedUrls.count} URLs copied`} dismiss={() => setCopiedUrls(undefined)} />}
    {shownError && snapshot && <Toast tone="error" title={shownError.message} details={shownError.details} dismiss={() => setError('')} dismissLabel="Dismiss error" />}
    </div>
    {controlsOpen && <ControlsCard close={() => setControlsOpen(false)} />}
    {standupOpen && <StandupPanel close={() => setStandupOpen(false)} reveal={nodeId => revealNode(nodeId, 'map')} openUrl={url => { void window.craftingTable.openUrl(url).catch(error => setError(error.message)); }}
      onMap={nodeId => { const nodes = withUndermapRef.current?.nodes ?? [], node = nodes.find(candidate => candidate.id === nodeId); return Boolean(node && !isArchived(node, nodes)); }} />}
    {settingsOpen && <Settings sessionRequestId={sessionRequestId} initialSessionView={sessionListView} installRequest={installRequest} initialSection={settingsSection} updates={updates} nodeTitles={new Map(withUndermap?.nodes.map(node => [node.id, node.title]) ?? [])} plugins={plugins ?? []} providers={providers} openArchive={() => setArchiveOpen(true)} clearOverlaps={() => apply([{ type: 'layout.repair' }])} close={() => { setSettingsOpen(false); setInstallRequest(undefined); setSettingsSection(undefined); }} />}
    {editor?.mode === 'menu' && <CanvasMenu key={`${editor.nodeId ?? editor.linkId ?? ''}:${editor.screen.x}:${editor.screen.y}`} screen={editor.screen} avoid={editor.avoid} actions={menuActions}
      loadChoices={async (action, refreshed) => {
        if (!selected || !action.choices) return [];
        const entries = (options: ResourceChoices): MenuAction[] => {
        const prompt = options.prompt ? [{ id: 'plugin:choice-prompt' as const, label: options.prompt, disabled: true }] : [];
        return [...prompt, ...options.options.map(option => ({ id: `plugin:choice:${option.id}` as const, label: option.label, ...(option.description ? { description: option.description } : {}), ...(option.highlight ? { highlight: option.highlight } : {}), ...(option.confirm ? { confirm: option.confirm } : {}),
          ...(options.current ? { checked: option.id === options.current, disabled: option.id === options.current } : option.disabled ? { disabled: true } : {}),
          ...(option.disabled ? {} : { mutation: { actionId: action.choices!.apply, input: choiceInput(options, option.id), ...(options.current ? {} : { label: action.label }), ...(action.choices!.runtime ? { runtime: action.choices!.runtime } : {}) } }) }))];
        };
        return entries(await loadResourceChoices({ runAction: (action, input) => window.craftingTable.runtimeRun({ nodeId: selected.id, action: action as 'resource.action', arguments: input ?? {} }) as any }, action.choices.load, action.choices.runtime, live => refreshed(entries(live))));
      }}
      act={action => {
        if (action.mutation && selected && selectedResource) { setEditor(undefined); resourceMenu.mutate(selected.id, selectedResource, action.mutation.actionId, action.mutation.input, action.mutation.label ?? action.label, action.mutation.runtime); }
        else if (action.id.startsWith('field:')) { const [, key, option = action.value] = action.id.split(':'); if (key && option && selected && selectedResource) run([{ type: 'item.update', id: selected.id, data: { ...selectedResource.data, [key]: option } }]); }
        else menuAction(action.id);
      }} onHighlight={setMenuHighlight} close={() => setEditor(undefined)} />}
    {editor && editor.mode !== 'menu' && snapshot && plugins && settings && <InlineEditor key={`${editor.mode}:${editor.nodeId ?? ''}:${editor.position.x}:${editor.position.y}`} editor={editor} state={withUndermap ?? snapshot.state} plugins={plugins} quickIds={settings.value.quickItemTypes} capabilities={capabilities} save={apply} close={() => setEditor(undefined)}
      writeInPlace={below ? undefined : pluginId => writeInPlace(pluginId, editor)} />}
  </section></RailContext.Provider>;
}
