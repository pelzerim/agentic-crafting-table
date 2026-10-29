import { selectionMoves } from '../../../src/graph/selection.ts';
import { useItemResize } from './item-resize.ts';
import { itemResizeLimits, resolveMapSize } from '../../../packages/core/item-map-sizes.ts';
import type { ItemMapSizes } from '../../../packages/core/item-map-sizes.ts';
import { agentSaid } from '../../../packages/core/last-line.ts';
import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Background, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, ViewportPortal, useReactFlow, useViewport } from '@xyflow/react';
import type { Node, Viewport } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { impliedLinks, shownLinks } from '../../../src/graph/graph.ts';
import type { GraphNode, GraphLink } from '../../../src/graph/graph.ts';
import { itemDropProject, containingProject, neighborhoodTitlePosition, projectActivity, projectNeighborhoods } from '../../../src/graph/project-neighborhoods.ts';
import type { NeighborhoodCache } from '../../../src/graph/project-neighborhoods.ts';
import { ZOOM_LEVELS, attentionTakesOver, neighborhoodZoom, zoomDetail, zoomLevel } from '../../../src/graph/spatial.ts';
import type { MapCollisions } from '../../../src/graph/spatial.ts';
import { isArchived } from '../../../src/graph/archive.ts';
import { blockerList, blockerName, blockingState } from '../../../src/graph/blocking.ts';
import './blocking.css';
import { attentionAge, attentionCountText, attentionDetails, attentionLabel, attentionTierInfo, memberAttentionCounts, nodeAttention } from '../../../src/graph/attention.ts';
import { useNow } from './use-now.ts';
import { cardReference } from '../../../src/graph/reference.ts';
import type { AttentionCounting, AttentionCounts, AttentionTier } from '../../../src/graph/attention.ts';
import { TierCounts, TierMark } from './ui/tier-mark.tsx';
import { performanceMetrics, observeMapPerformance } from './performance.ts';
import { createResourcePluginRegistry } from '../../../src/resource-plugins/builtins.ts';
import { itemFootprint } from '../../../src/graph/footprints.ts';
import { moveItems, resizeItem } from '../../../src/graph/movement.ts';
import { snapPosition, snapStep } from '../../../src/graph/snap.ts';
import { ItemIcon, StatusGlyph } from './icons.tsx';
import { ZoomBar } from './zoom-bar.tsx';
import type { Badge } from '../../../src/graph/badges.ts';
import { WorkingAnimalContext, WorkingMark, workingMarkStyle } from './working-mark.tsx';
import type { WorkingMarkSettings } from '../../../packages/core/settings.ts';
import { leadPose, markLabel } from './grazing.ts';
import { fitIndicators } from './card-indicators.ts';
import { fitTitle, releaseTitle } from './title-fit.ts';
import { edgeTypes } from './direct-edge.tsx';
import { InlineTitle } from './inline-title.tsx';
import { useTerminalPreferences } from './terminal-preferences.ts';
import { useBubbleMotion } from './bubble-motion.ts';
import type { BubbleBounds } from './bubble-motion.ts';
import { presentResource, presentationIcon } from '../../../src/resource-plugins/views.ts';
import type { ResourcePreview, ResourceRecord } from '../../../src/resource-plugins/types.ts';
import type { TodoEntry } from '../../../src/graph/todos.ts';
import type { ResourcePluginRegistry } from '../../../src/resource-plugins/registry.ts';
import { placeProjectLabels } from '../../../src/graph/label-placement.ts';
import { clampItemViewPosition, clampItemViewSize, expandedItemBounds } from '../../../packages/core/item-views.ts';
import type { ItemViewProfile, ItemViewSizes } from '../../../packages/core/item-views.ts';
import { splitViewBounds } from './item-view-bounds.ts';
import type { ItemViewBounds, ViewPlace, ViewSize } from './item-view-bounds.ts';
import { useMapObstacles } from './use-map-obstacles.ts';
import { BiomeGround, NeighborhoodField } from './neighborhood-field.tsx';
import { biomeDetailVisible, biomeFor } from '../../../src/graph/biomes.ts';
import type { BiomeRect } from '../../../src/graph/biomes.ts';
import { projectColor, undermapColor } from '../../../src/graph/project-colors.ts';
import { DEFAULT_NEIGHBORHOOD_APPEARANCE } from '../../../src/graph/neighborhood-fill.ts';
import type { NeighborhoodAppearance } from '../../../src/graph/neighborhood-fill.ts';
import { droppedUrl, mayContainUrl } from './dropped-url.ts';
import { Atlas } from './atlas.tsx';
import { ProjectColumn } from './project-column.tsx';
import { columnItems, columnKind, plotMapOrder, plotName, projectColumn } from '../../../src/graph/project-column.ts';
import type { ProjectColumnModel, ProjectSummaryLines } from '../../../src/graph/project-column.ts';
import type { MapCorner } from '../../../packages/core/settings.ts';
import type { AtlasItemEntry, AtlasProjectEntry } from './atlas.tsx';
import { needsMeIds } from '../../../src/graph/atlas.ts';
import { matchWorkspaceShortcut, OPEN_ALONGSIDE, shortcutKey, shortcutsPaused, useWorkspaceShortcuts } from './shortcuts.ts';
import { DEFAULT_MAP_DASHBOARDS, dashboardArea, dashboardLayout, dashboardPreview, dashboardsShown, projectDashboard } from '../../../src/graph/project-dashboard.ts';
import type { DashboardLayout, DashboardTodo, MapDashboards, ProjectDashboard } from '../../../src/graph/project-dashboard.ts';
import type { ScreenRect } from '../../../src/graph/label-placement.ts';
import { DashboardBody } from './project-dashboard.tsx';
import { PixelGlyph } from './ui/pixel-glyph.tsx';
import { coversChrome } from './chrome-cover.ts';
import { RAIL, RAIL_HEIGHT } from './tool-rail.tsx';
import { PaperFace, expandedPaperHeight } from './paper-face.tsx';
import type { PaperMode } from './paper-face.tsx';
import type { DashboardIcon } from './project-dashboard.tsx';
import type { ProjectsPanelState } from '../../../packages/core/control.ts';
import { neighborhoodContours } from '../../../src/graph/neighborhood.ts';
import type { Point } from '../../../src/graph/neighborhood.ts';
import { plotFill } from '../../../src/graph/plot-fill.ts';
import { placePlotSigns, plotSignPosition, plotSignSize, PLOT_NAME_LENGTH } from '../../../src/graph/plot-signs.ts';
import { PLOT_MIN_LINKED, plotColor, plotPatches } from '../../../src/graph/plots.ts';
import { plotStyle } from './plot-style.ts';
import { paperPaint } from './paper-color.ts';
import type { PlotView } from '../../../src/graph/plots.ts';
import { mutedProjectIds } from '../../../src/graph/mute.ts';
import { MUTE_PEEK, MuteCovers, useMutePeek } from './mute-cover.tsx';
import type { MuteCoverShape } from './mute-cover.tsx';
import { CanvasMenu } from './canvas-menu.tsx';
import { plotMenuActions } from '../../../packages/core/context-menu.ts';
import type { MenuAction } from '../../../packages/core/context-menu.ts';
import type { JsonObject } from '../../../src/resource-plugins/types.ts';
import { UNDERMAP_LOOSE } from '../../../src/graph/undermap.ts';
import type { MirrorArea } from '../../../src/graph/undermap.ts';
import { UndermapMonths, UndermapPlates } from './undermap-months.tsx';

const registry = createResourcePluginRegistry();
type MapItem = GraphNode & { activity?: string; attention?: string; summary?: string; lastLine?: string; recap?: { text: string; at: string } };
export interface ProjectMapProps {
  registry?: ResourcePluginRegistry;
  nodes: MapItem[];
  resources: ResourceRecord[];
  links: GraphLink[];
  onLink?(anchor: { sourceId: string; targetId?: string; projectId?: string; position: { x: number; y: number }; screen: { x: number; y: number } }): void;
  onMove(id: string, position: { x: number; y: number }, projectId?: string): void | Promise<void>;
  onMoveMany?(positions: { id: string; position: { x: number; y: number } }[]): void | Promise<void>;
  onResize?(id: string, dimensions: { width: number; height: number }, position: { x: number; y: number }): Promise<void>;
  onRename?(id: string, title: string): Promise<void>;
  /** Saves a paper tile's data patch; with `base`, only while its saved text still equals it. */
  onPaperWrite?(id: string, patch: Record<string, string>, base?: string): Promise<void>;
  /** Delete on a selected paper tile archives it with Undo; `silent` for an emptied note. */
  onPaperArchive?(id: string, silent: boolean): void;
  /** Opens a link from an item's face through the host's URL guard. */
  onOpenUrl?(url: string): void;
  onConnect?(id: string, screen: { x: number; y: number }): void;
  onActivate?(node: MapItem): boolean;
  /** Opens the item's web page on double-click when that is enabled and the item has one. */
  webOpener?(id: string): (() => void) | undefined;
  /** Opens the item's web page; false when its type has none. */
  onOpenWeb?(id: string): boolean;
  onView?(id: string | undefined): void;
  /** An item was opened (full view, inline editing or its browser page), by a person or by the app. */
  onOpened?(id: string, origin: 'user' | 'program'): void;
  /** Explicitly acknowledges the item's unseen Needs me attention, as the panel's Seen does. */
  onMarkSeen?(id: string): void;
  /** The open item whose Needs me entry this open acknowledged, with the tier it would come back at. */
  keep?: { id: string; tier: AttentionTier };
  /** Puts that entry back into Needs me; the frame closes the item with it. */
  onKeep?(id: string): void;
  /** The open item view reaches the tool rail or the map trail, so the host moves them out of its way. */
  onChromeCover?(covered: boolean): void;
  onItemDrag?(id: string | undefined, screen?: { x: number; y: number }): void;
  onItemDrop?(id: string, screen: { x: number; y: number }): boolean | Promise<boolean>;
  /** `origin: 'program'` marks a reveal the app made on its own rather than a person's choice. */
  /** `select` names the items a map reveal leaves selected. */
  /** `map` centres the item without opening it; `centred` centres it at the current zoom, then opens it. */
  reveal?: { nodeId: string; nonce: number; mode?: 'map' | 'centred'; origin?: 'program'; select?: readonly string[] };
  /** A reveal is a one-time request: the host drops it so a remounted map (layer travel) does not repeat it. */
  onRevealed?(reveal: NonNullable<ProjectMapProps['reveal']>): void;
  /** Transient external inspection; never changes selection, layout or read state. */
  highlightedNodes?: readonly string[];
  /** Connections to emphasize alongside highlighted nodes; the rest are muted. */
  highlightedLinks?: readonly string[];
  /** The items or link whose menu is open; hover links at them stay drawn meanwhile. */
  menuFor?: readonly string[];
  initialViewport?: Viewport;
  neighborhoodPadding?: number;
  neighborhoodAppearance?: NeighborhoodAppearance;
  itemViews?: ItemViewSizes;
  itemMapSizes?: ItemMapSizes;
  /** Where and how large the person left each opened item; saved so it survives reloads and restarts. */
  viewBounds?: ItemViewBounds;
  onViewBounds?(shown: ReadonlySet<string>, positions: Record<string, ViewPlace>, sizes: Record<string, ViewSize>): void;
  onViewport?(viewport: Viewport): void;
  /** `avoid` is the item's title row in canvas pixels; its menu must not cover it. */
  onContext?(target: { screen: { x: number; y: number }; position: { x: number; y: number }; projectId?: string; nodeId?: string; nodeIds?: string[]; linkId?: string; avoid?: { x: number; y: number; width: number; height: number } }): void;
  onCreate?(target: { screen: { x: number; y: number }; position: { x: number; y: number }; projectId?: string }): void;
  /** A to-do row dropped from the list: map tasks move (project per `itemDropProject`), list tasks become map tasks. */
  onTodoDrop?(target: { id: string; position: { x: number; y: number }; projectId?: string }): void | Promise<void>;
  /** The list row being dragged, so the map can preview where it lands. */
  todoDrag?: { id: string; title: string; nodeId?: string };
  /** To-do list entries; each dashboard lists its project's. */
  todos?: readonly TodoEntry[];
  onTodoComplete?(id: string, completed: boolean): Promise<void>;
  /** Mark a map item done or reopen it (the card checkbox of types with `completionToggle`). */
  onComplete?(id: string, completed: boolean): Promise<void>;
  onTodoShow?(id: string): void;
  /** Plugin hover facts from saved local data. */
  onPreviewDetail?(id: string, signal: AbortSignal): Promise<ResourcePreview | undefined>;
  onUrlDrop?(target: { url: string; screen: { x: number; y: number }; position: { x: number; y: number }; projectId?: string }): void;
  /** ⌘V of plain text over the map, at the pointer. A pasted URL goes to `onUrlDrop`. */
  onPasteText?(target: { text: string; position: { x: number; y: number }; projectId?: string }): void;
  renderDetail?(node: MapItem, active: boolean): ReactNode;
  /** Which layer this map shows; the host filters nodes. Only the theme differs. */
  layer?: 'map' | 'below';
  /** Derives each neighborhood's color from its project's color, e.g. darker in Undermap. */
  neighborhoodColor?(projectColor: string): string;
  /** What the bottom-right corner shows (MAP-22); absent is the project column. */
  mapCorner?: MapCorner;
  /** Next and Status lines by project id, shown on the project column while Summarise projects is on. */
  projectSummaries?: ReadonlyMap<string, ProjectSummaryLines>;
  /** The corner's unfolded state (the project list or the Atlas overview); controlled by the host so it survives layer travel. */
  overview?: boolean;
  onOverview?(open: boolean): void;
  /** The Projects panel's saved size, folds, filters and pin (MAP-22). */
  projectsPanel?: ProjectsPanelState;
  onProjectsPanel?(patch: Partial<ProjectsPanelState>): void;
  undermapCount?: number;
  onTravel?(to: 'map' | 'below'): void;
  /** Below this zoom each neighbourhood shows its project's dashboard instead of its items. */
  dashboards?: MapDashboards;
  /** The animal on working cards' edges (Settings → Map → Working animal); a sheep without it. */
  workingMark?: WorkingMarkSettings;
  /** Plots to draw (MAP-24); the host leaves out hidden ones. */
  plots?: readonly PlotView[];
  /** A person's plot change: rename, hide or name automatically; also reports which plots were on screen. */
  onPlot?(projectId: string, request: JsonObject): Promise<void>;
  /** Note badges on items (MAP-BADGES), by item id; the host leaves the badge notes themselves out of `nodes`. */
  badges?: ReadonlyMap<string, readonly Badge[]>;
  /** A badge was clicked (open its note) or right-clicked (its note's menu). */
  onBadge?(noteId: string, anchor: { screen: { x: number; y: number }; position: { x: number; y: number } }, menu: boolean): void;
  /** Settings → AI features → Name plots. */
  plotNaming?: boolean;
  /** Projects a plot's members can move to; without it the sign's menu offers no move. */
  plotTargets?(ids: string[]): { id: string; title: string; current: boolean }[];
  /** Moves items as one block to a project, or out of their project with null. */
  onMoveItems?(ids: string[], projectId: string | null): void;
  /** Sends items to Undermap together. */
  onSendBelow?(ids: string[]): void;
  /** Settings → Map → Hide implied connections (LINK-06); absent hides them. */
  hideImpliedLinks?: boolean;
  /** Grid pitch item centres land on when dropped, nudged or settled aside; none keeps free placement. */
  snap?: number;
  /** Settings → Map → Moving into items (MAP-13): push them aside (absent) or stop at them. */
  collisions?: MapCollisions;
  /** Whether Finished joins the Needs me number on dashboards (Settings → Notifications). */
  attentionCounting?: AttentionCounting;
  /** Mute or unmute a project (MAP-25). Without it no project is drawn covered. */
  onMute?(projectId: string, muted: boolean): void;
  /** The Undermap's mirror layout (MAP-18): areas, month lines and far plates come from these computed boxes, the
   * items' positions are the host's, and nothing can be moved or resized. `collapse` reports whether a month was open. */
  undermap?: { areas: readonly MirrorArea[]; toggle(areaId: string, month: string): void; collapse(): boolean };
}
/** World pixels per culling cell: cards of a mirror layout mount only in the cells around the window. */
const CULL_CELL = 600;
const NOT_MUTED: ReadonlySet<string> = new Set();
const NO_LINKS: ReadonlySet<string> = new Set();
const NO_FOOTPRINTS: readonly BiomeRect[] = [];
/** A member card under a closed cover: not painted, not interactive. */
const COVERED = 'muted-member', PEEKED = 'muted-member muted-peek nopan';
/** A press may slip this far and still be a click; further, it drags. */
const CLICK_SLIP = 6;
type MapPip = { tone: string; style: string };
/** Paper tiles keep their size at mid zoom and become a paper square only when far. */
const PAPER_FAR_ZOOM = .35;
type HeaderData = { needsMe: number; working: number; muted?: true } & Pick<AttentionCounts, AttentionTier>;
type CardData = { /** Where an open item lives, for its header breadcrumb. */ location?: ItemPlace; /** Badges from short notes connected to this item, and their font size in map pixels. */ badges?: readonly Badge[]; badgeSize?: number; far: boolean; /** The card stands at its full map size, so its title may take the lines the card leaves it. */ titleFill?: boolean; /** A far-zoom icon under 16px on screen: the tier shape replaces the icon and frames are dropped. */ takeover: boolean; needsMe?: boolean; /** Close and keep in Needs me is offered at this tier. */ keep?: AttentionTier; header?: HeaderData; projectColor?: string; pips?: MapPip[]; /** The count line after pips a type's presentation drew. */ pipsLabel?: string; frameTitle?: string; /** The short reference the type declares, shown as the card's tag when the title has none. */ reference?: string; viewSurface?: boolean; viewOpen?: boolean; mapSize?: ReturnType<typeof resolveMapSize>; mapFields: string; tiny: boolean; iconOpens: boolean; completionToggle: boolean; undermapWhenComplete?: boolean; resizable: boolean; resizing: boolean; morph?: BubbleBounds; editableTitle: boolean; /** The open view's title is edited in place. */ editableViewTitle: boolean; showFullTitle: boolean; paper?: string; paperText?: string; paperMode?: PaperMode; paperWriter?: string; paperWrittenAt?: string; item: MapItem; icon: string; brand?: string; tint?: boolean; typeName: string; tone: string; width: number; height: number; compact: boolean; expanded: boolean; visited: boolean; scale: number; projectLabel: boolean; labelOverOutline: boolean; attentionSize: number; projectNeedsMe: number; status?: string; dragging: boolean; blocked?: Blocked; linkEnd?: boolean; selected?: boolean; /** Under a closed cover: drawn as an empty box of the card's size. */ covered?: boolean };
type Blocked = { text: string; blockers: { id: string; name: string }[] };
type ItemPlace = { project?: { id: string; title: string; color: string }; plot?: { id: string; name: string } };
type CardNode = Node<CardData, 'card'>;
const nodeOrigin: [number, number] = [.5, .5];
/** The body ignores its pixel size, which follows the camera; only what it lists matters. */
const sameContent = (a: DashboardLayout, b: DashboardLayout) => (['mode', 'needs', 'needsMore', 'working', 'workingMore', 'todos', 'todosMore', 'todoSection', 'plots', 'plotsMore', 'pipelines', 'tallies'] as const).every(key => a[key] === b[key])
  && a.folded.join('\n') === b.folded.join('\n') && a.blocks.length === b.blocks.length && a.blocks.every((block, index) => (['id', 'needs', 'working', 'todos', 'more', 'pipelines'] as const).every(key => block[key] === b.blocks[index][key]));
const DASHBOARD_OBSTACLES = '.map-status,.map-locator,.zoom-markers,.todo-overlay,.tool-rail,.below-portal,.below-bar';
function reuseCardData(previous: CardData | undefined, next: CardData): CardData {
  return previous && (Object.keys(next) as (keyof CardData)[]).every(key => previous[key] === next[key]) ? previous : next;
}
/** React Flow observes node identity. Camera-only renders must not publish a new
 * copy of every item, which would remeasure cards and reroute all their edges. */
function reuseProjection(previous: CardNode | undefined, next: CardNode): CardNode {
  if (!previous) return next;
  next.data = reuseCardData(previous.data, next.data);
  if (previous.position.x !== next.position.x || previous.position.y !== next.position.y
    || previous.width !== next.width || previous.height !== next.height || previous.draggable !== next.draggable
    || previous.focusable !== next.focusable || previous.zIndex !== next.zIndex || previous.hidden !== next.hidden || previous.className !== next.className) return next;
  return next.data === previous.data ? previous : next;
}
/** Event callbacks keep their latest committed behavior without invalidating
 * React Flow's memoized node/edge renderers on each viewport update. */
function useStableHandlers<T extends Record<string, (...args: any[]) => any>>(handlers: T): T {
  const latest = useRef(handlers);
  useLayoutEffect(() => { latest.current = handlers; });
  return useMemo(() => Object.fromEntries(Object.keys(handlers).map(key => [key, (...args: any[]) => latest.current[key](...args)])) as T, []);
}
/** The fixed chrome an item view can reach: the rail column and the trail row, in workspace pixels. */
const CHROME = { rail: { x: RAIL.left, y: RAIL.top, width: 52, height: RAIL_HEIGHT }, trail: { x: 22, y: 24, width: 420, height: 24 } };
const DetailContext = createContext<Pick<ProjectMapProps, 'renderDetail' | 'onRename'> & { sendBelow?(ids: string[]): void; paperOpenUrl(url: string): void; paperWrite(id: string, patch: Record<string, string>, base?: string): Promise<void>; paperDiscard(id: string): void; select(id: string): void; toggleDone(id: string, done: boolean): void; open(id: string): void; back(): void; markSeen?(id: string): void; keep?(id: string): void; middleClick(id: string): void; settled(id: string): void; menu(event: React.MouseEvent, id: string): void; startLink(event: React.PointerEvent, id: string): void; connect(event: React.MouseEvent, id: string): void; resize(event: React.PointerEvent, id: string): void; resizeKey(event: React.KeyboardEvent, id: string): void; reveal(id: string): void; unmute(id: string): void; badgeNote(event: React.MouseEvent, noteId: string, menu: boolean): void; fitProject(id: string): void; fitPlot(id: string): void }>({ badgeNote() {}, fitProject() {}, fitPlot() {}, paperOpenUrl() {}, paperWrite: async () => {}, paperDiscard() {}, select() {}, toggleDone() {}, open() {}, back() {}, middleClick() {}, settled() {}, menu() {}, startLink() {}, connect() {}, resize() {}, resizeKey() {}, reveal() {}, unmute() {} });

/** An open item's project and plot; either one closes the item and flies there. */
function ItemLocation({ place }: { place: ItemPlace }) {
  const { fitProject, fitPlot } = useContext(DetailContext), { project, plot } = place;
  if (!project) return <nav className="item-location" aria-label="Item location"><span className="item-location-floating">Floating item</span></nav>;
  return <nav className="item-location" aria-label="Item location">
    <button type="button" className="nodrag" aria-label={`Go to project ${project.title}`} title={project.title} onClick={event => { event.stopPropagation(); fitProject(project.id); }}><i aria-hidden="true" style={{ background: project.color }} /><span>{project.title}</span></button>
    {plot && <><b aria-hidden="true">›</b><button type="button" className="nodrag" aria-label={`Go to plot ${plot.name}`} title={plot.name} onClick={event => { event.stopPropagation(); fitPlot(plot.id); }}><span>{plot.name}</span></button></>}
  </nav>;
}

const Card = memo(function Card({ data }: { data: CardData }) {
  if (data.covered) return <div className="covered-card" data-item-id={data.item.id} data-covered="true" style={{ width: data.width, height: data.height, transform: `scale(${data.scale})`, transformOrigin: 'top left' }}>
    <Handle type="target" position={Position.Left} /><Handle type="source" position={Position.Right} /></div>;
  return <CardFace data={data} />;
}, (previous, next) => previous.data === next.data);
function CardFace({ data }: { data: CardData }) {
  performanceMetrics.record('map.card-render', 1);
  const { renderDetail, onRename, markSeen, keep, sendBelow, middleClick, open, back, settled, menu, startLink, connect, resize, resizeKey, reveal, paperWrite, paperDiscard, select, paperOpenUrl, toggleDone, unmute, badgeNote } = useContext(DetailContext);
  const { item, expanded, compact } = data;
  // A done card drops the grass and the sheep but its summary still says Working.
  const done = Boolean(item.completedAt) && !expanded, running = item.activity === 'working' && !expanded, working = running && !done;
  const surface = useRef<HTMLElement>(null);
  // The mark also says what holds an item that is not working: a prompt, an error, an ended session, work left beside its prompt.
  const markState = { working, helpers: item.helpers, waiting: item.waiting, pose: item.pose, beside: item.beside, tasks: item.tasks, bell: item.bell, pen: item.pen };
  const marked = !expanded && !done && leadPose(markState) !== undefined, markTitle = markLabel(markState);
  useBubbleMotion(surface, data.morph, () => settled(item.id));
  const [paperOpen, setPaperOpen] = useState(false), [paperHeight, setPaperHeight] = useState<number>();
  const need = nodeAttention(item), attention = need?.detail ?? '', age = attentionAge(need?.since, useNow(Boolean(need?.since) && !expanded));
  // A title that leads with a ticket reference shows its words alone; the reference moves to the status row as a quiet tag.
  // Wherever that row has no labels (icons, short cards, an editable title) the title stays whole, so the reference never disappears.
  // The reference an item's type declares ("#48") joins a status row the card has anyway; it never adds a row.
  const cueIcons = compact || data.height < 48 || data.height < 65 && !(item.indicators?.length ? item.indicators.some(cue => cue.showLabel) : true);
  const ticket = !expanded && !cueIcons && !data.editableTitle && data.paper === undefined ? cardReference(item.title, item.indicators?.length ? data.reference : undefined) : undefined;
  // A card that needs me says why in words on its second line, with how long as text; small cards and icons keep the shape alone.
  const reason = need && !compact && !expanded ? <span className="card-reason" data-tier={need.tier}>{need.details[0]}{age && <span className="card-age"> · {age}</span>}</span> : undefined;
  // The tier shape in the corner slot; its name says the tier and the reason, so neither rests on colour or shape alone.
  const mark = need && !expanded && <span className="attention-indicator" data-tier={need.tier} role="img" aria-label={attentionLabel(need.tier, need.detail)} title={attentionLabel(need.tier, need.detail)} style={{ width: data.attentionSize, height: data.attentionSize }}><TierMark tier={need.tier} /></span>;
  // A card with two or more summary lines quotes its agent's recap, or the line it ended the turn on, in place of the summary.
  const said = data.mapSize && data.mapSize.summaryLines >= 2 ? agentSaid(item) : undefined, line = data.status || said || item.summary;
  const cue = item.indicators?.[0], badge = data.far && compact && !expanded && (cue ?? (working ? { id: 'working', label: 'Working', icon: 'working', tone: 'mint' } : undefined));
  const muted = data.header?.muted;
  const titleRoom = data.titleFill && !compact && !expanded && !data.projectLabel && data.paper === undefined && !data.editableTitle
    ? [data.width, data.height, data.mapSize?.size, item.title, item.summary, agentSaid(item), data.status, running, need?.details[0], age, data.mapFields, data.pips?.length, data.pipsLabel, item.indicators?.map(cue => `${cue.id}:${cue.label}:${cue.showLabel}`).join()].join('\n') : '';
  useLayoutEffect(() => { const card = surface.current; if (card) (titleRoom ? fitTitle : releaseTitle)(card); }, [titleRoom]);
  useLayoutEffect(() => { const card = surface.current; return () => { if (card) releaseTitle(card); }; }, []);
  if (data.projectLabel) return <article className="project-neighborhood-title" aria-label={muted ? `${item.title}, muted` : item.title} data-item-id={item.id} data-project-label={item.id} data-muted={muted} data-over-outline={data.labelOverOutline} data-dragging={data.dragging}
    data-world-x={item.position.x} data-world-y={item.position.y}
    style={{ width: data.width, height: data.height, transform: `scale(${data.scale})`, transformOrigin: 'top left', ['--project-color' as string]: data.projectColor }}>
    {!muted && mark}
    <div className="project-title-plate"><i className="project-title-grip" aria-hidden="true"><PixelGlyph name="grip" /></i><div className="project-title-row"><i className="project-swatch" aria-hidden="true" style={{ background: data.projectColor }} /><strong title={item.title}>{item.title}</strong>
      {item.id !== UNDERMAP_LOOSE && <button className="nodrag" aria-label={`Project options: ${item.title}`} onClick={event => { event.stopPropagation(); menu(event, item.id); }}><PixelGlyph name="more" /></button>}</div>
      {muted ? <button type="button" className="project-muted nodrag" aria-label={`Unmute ${item.title}`} title="Unmute project" onClick={event => { event.stopPropagation(); unmute(item.id); }} onDoubleClick={event => event.stopPropagation()}>
        <PixelGlyph name="moon" /><span className="project-muted-state">Muted</span><span className="project-muted-action">Unmute</span></button> : <ProjectHeader header={data.header} />}</div>
  </article>;
  const paper = data.paper !== undefined && !expanded, paperColor = paper ? paperPaint(data.paper) : undefined;
  return <><article ref={surface} className={`map-card tone-${data.tone} ${paper ? 'paper-card' : ''} ${working ? 'working-card' : ''} ${data.tiny && !expanded ? 'tiny-card' : ''} ${data.showFullTitle ? 'full-title-card' : ''} ${data.mapSize && data.mapSize.height > 48 ? 'map-profile-card' : ''} ${expanded ? 'expanded' : ''} ${item.completedAt && !expanded ? 'done-card' : ''} ${compact ? 'compact' : data.height < 65 ? 'small-card' : ''}`}
    role={data.viewSurface ? "region" : undefined} aria-label={paper ? `${data.typeName}: ${item.title}` : data.badges?.length ? `${item.title}, badges ${data.badges.map(entry => entry.text).join(', ')}` : item.title} title={marked && markTitle !== 'Working' ? markTitle : undefined} data-paper={paper ? data.paper : undefined} data-paper-tone={paperColor?.dark ? 'dark' : undefined} data-writer={paper && data.paperWriter ? 'agent' : undefined} data-item-id={data.viewSurface ? undefined : item.id} data-expanded-item-id={data.viewSurface ? item.id : undefined} data-view-open={data.viewOpen || undefined} data-world-x={item.position.x} data-world-y={item.position.y}
    data-tight-title={data.height < 60 || undefined} data-preview="false" data-resizing={data.resizing} data-dragging={data.dragging} data-completed={Boolean(item.completedAt)} data-map-size={data.mapSize?.size} data-blocked={data.blocked ? true : undefined} data-link-end={data.linkEnd || undefined} data-selected={data.selected || undefined} data-tier={need && !expanded ? need.tier : undefined} data-takeover={need && compact && !expanded && data.takeover || undefined}
    data-dimmed={data.far && !expanded && !attention && (Boolean(item.completedAt) || cue?.stage === 'done') || undefined}
    onMouseDown={event => { if (event.button === 1 && (!data.viewSurface || data.needsMe)) event.preventDefault(); }}
    onAuxClick={event => {
      if (event.button !== 1) return;
      if (data.viewSurface) { if (!data.needsMe || !markSeen || (event.target as HTMLElement).closest('a[href]')) return; event.preventDefault(); event.stopPropagation(); markSeen(item.id); return; }
      event.preventDefault(); event.stopPropagation(); middleClick(item.id);
    }}
    style={{ width: data.width, height: !paper || compact ? data.height : paperHeight ?? (paperOpen ? expandedPaperHeight(data.paperText!, data.width) : data.height), transform: `scale(${data.scale})`, transformOrigin: 'top left', ...paperColor ? { '--paper': paperColor.color } : {} }}>
    {marked && !compact && !data.viewSurface && <WorkingMark width={data.width} height={data.height} tiny={data.tiny} state={markState} moment={item.moment} />}
    {data.blocked && !expanded && <span className="blocked-badge" role="img" aria-label={data.blocked.text} title={data.blocked.text} style={{ fontSize: data.attentionSize * .75 }}><i aria-hidden="true" /></span>}
    {mark}
    {done && !attention && !compact && <span className="done-check" role="img" aria-label="Done" title="Done" style={{ width: data.attentionSize, height: data.attentionSize }}>
      <svg viewBox="0 0 8 8" aria-hidden="true" shapeRendering="crispEdges"><path fill="currentColor" d="M6 1h1v2H6v1H5v1H4v1H3V5H2V4H1V3h1v1h1v1h1V4h1V3h1Z" /></svg></span>}
    {badge ? <span className="status-badge" role="img" style={{ fontSize: data.attentionSize * 1.25 }} data-indicator={badge.id} data-tone={badge.tone} title={badge.label} aria-label={badge.label}><StatusGlyph icon={badge.icon} tone={badge.tone} /></span>
      : !expanded && (item.indicators?.length || ticket) ? <CardIndicators cues={item.indicators ?? []} icons={cueIcons} width={data.width - (data.height < 65 ? 54 : 28)} reference={ticket?.reference} reason={reason} reasonLength={need ? need.details[0].length + (age ? age.length + 3 : 0) : 0} /> : null}
    {paper ? compact ? <span className="paper-fold" aria-hidden="true" /> : <PaperFace title={item.title} text={data.paperText!} width={data.width} grow={data.mapSize?.growLines} mode={data.paperMode!} paper={data.paper!} writer={data.paperWriter ? { name: data.paperWriter, at: data.paperWrittenAt ?? '' } : undefined} expanded={paperOpen} expand={setPaperOpen} onHeight={setPaperHeight}
      actions={{ write: (patch, base) => paperWrite(item.id, patch, base), discard: () => paperDiscard(item.id),
        done: () => { surface.current?.closest<HTMLElement>('.react-flow__node')?.focus({ preventScroll: true }); select(item.id); }, openUrl: url => paperOpenUrl(url) }} />
    : <>{expanded && data.location && <ItemLocation place={data.location} />}<div className="card-heading" tabIndex={expanded ? 0 : undefined} aria-label={expanded ? `Move view: ${item.title}` : undefined} title={expanded ? "Drag to move view; arrow keys move it with the keyboard" : undefined}>
      {data.completionToggle && !expanded && !compact ? <CompletionToggle done={done} toggle={() => toggleDone(item.id, !done)}><ItemIcon icon={data.icon} brand={data.brand} tint={data.tint} className="item-glyph" /></CompletionToggle>
        : data.iconOpens && !expanded ? <button className="item-open-icon nodrag nopan" aria-label={`Open ${data.typeName.toLowerCase()}`} onClick={event => { event.stopPropagation(); open(item.id); }}><ItemIcon icon={data.icon} brand={data.brand} tint={data.tint} className="item-glyph" /></button> : <ItemIcon icon={data.icon} brand={data.brand} tint={data.tint} className="item-glyph" />}
      {expanded ? <div className="frame-title">
        {!compact && <div className="card-label">{!data.frameTitle && <small>{data.typeName}</small>}{data.editableViewTitle ? <InlineTitle title={item.title} save={title => onRename!(item.id, title)} /> : <strong>{item.title}</strong>}</div>}
        {data.blocked && <div className="blocked-chips nodrag" role="group" aria-label={data.blocked.text}><span>Blocked by</span>{data.blocked.blockers.map(blocker => <button key={blocker.id} type="button" title={`Go to ${blocker.name}`} onClick={event => { event.stopPropagation(); reveal(blocker.id); }}>{blocker.name}</button>)}
          <button type="button" className="blocked-summary" title={`${data.blocked.text} · go to ${data.blocked.blockers[0].name}`} onClick={event => { event.stopPropagation(); reveal(data.blocked!.blockers[0].id); }}>Blocked · {data.blocked.blockers.length}</button></div>}
      </div>
      : !compact && <div className="card-label">{data.mapSize?.showType && data.height >= 80 && !data.editableTitle && <small>{data.typeName}</small>}{data.editableTitle ? <InlineTitle title={item.title} save={title => onRename!(item.id, title)} /> : <strong title={ticket ? item.title : undefined}>{ticket ? ticket.rest : item.title}</strong>}</div>}
      <div className="item-frame-slot" hidden={!expanded} />
      <div className="session-toolbar-slot" hidden={!expanded} />
      {expanded && data.needsMe && need && <span className="item-needs" data-tier={need.tier} title={attentionLabel(need.tier, need.detail)}><TierMark tier={need.tier} /><b>{attentionTierInfo[need.tier].name}</b><span> · {need.details[0]}</span></span>}
      {expanded && data.undermapWhenComplete && item.activity === 'complete' && !item.belowAt && sendBelow && <button type="button" className="nodrag item-send-below" aria-label="Send to Undermap" title="Send to Undermap" onClick={event => { event.stopPropagation(); sendBelow([item.id]); back(); }}>
        <PixelGlyph name="close" size={12} className="" /><PixelGlyph name="undermap" className="item-send-below-mark" />
      </button>}
      {expanded && data.needsMe && markSeen && <button type="button" className="nodrag item-seen-close" aria-label="Close and mark seen" title={`Close and mark seen (${shortcutKey('view.closeSeen')})`} onClick={event => { event.stopPropagation(); markSeen(item.id); back(); }}>
        <PixelGlyph name="close" size={12} className="" /><PixelGlyph name="check" className="item-seen-close-mark" />
      </button>}
      {expanded && data.needsMe && markSeen && <button type="button" className="nodrag item-seen" aria-label="Mark seen" title="Mark seen (remove from Needs me)" onClick={event => { event.stopPropagation(); markSeen(item.id); }}>
        <PixelGlyph name="check" size={12} className="" />
      </button>}
      {expanded && data.keep && keep && <button type="button" className="nodrag item-keep" aria-label="Close and keep in Needs me" title="Close and keep in Needs me" onClick={event => { event.stopPropagation(); keep(item.id); back(); }}>
        <PixelGlyph name="close" size={12} className="" /><TierMark tier={data.keep} className="item-keep-mark" />
      </button>}
      {expanded && <button className="nodrag item-close" aria-label="Back to project" title="Back to project" onClick={event => { event.stopPropagation(); back(); }}>
        <PixelGlyph name="close" size={12} className="" />
      </button>}
    </div>
    {!compact && !expanded && data.pips && data.mapSize && data.mapSize.summaryLines > 0 && <div className="card-pips" aria-hidden={data.pipsLabel ? undefined : true} aria-label={data.pipsLabel} role={data.pipsLabel ? "img" : undefined}>{data.pips.map((pip, index) => <i key={index} data-tone={pip.tone} data-style={pip.style} />)}{data.pipsLabel && <span className="card-pips-count">{data.pipsLabel}</span>}</div>}
    {!compact && !expanded && !item.indicators?.length && (!data.mapSize || data.mapSize.summaryLines > 0) && (running || line || reason) && <p className={`card-summary${data.pips ? ' pip-summary' : ''}`} data-said={!data.status && said ? true : undefined} style={data.mapSize ? { WebkitLineClamp: data.mapSize.summaryLines } : undefined}>{reason}{reason && line && <span className="card-reason-gap"> · </span>}{!reason && running && <span className="working-label">Working{line && ' · '}</span>}{line}</p>}
    {!compact && !expanded && data.mapSize?.fieldLines && data.mapFields ? <p className="map-size-fields" style={{ WebkitLineClamp: data.mapSize.fieldLines }}>{data.mapFields}</p> : null}
    {data.visited && <div className="card-detail nodrag nopan nowheel" hidden={!expanded}>{renderDetail?.(item, expanded) ?? <p>{item.summary || 'Project context and connected work.'}</p>}</div>}</>}
    {!expanded && !data.viewSurface && <><button className="connect-handle nodrag nopan" aria-label={`Connect ${item.title}`} title="Drag to connect or create; press Enter to choose an item" onPointerDown={event => startLink(event, item.id)} onClick={event => { event.stopPropagation(); if (event.detail === 0) connect(event, item.id); }}>+</button><Handle type="target" position={Position.Left} /><Handle type="source" position={Position.Right} /></>}
    {data.resizable && <button className="item-resize-handle nodrag nopan" aria-label={`Resize ${item.title}`} title="Drag to resize; arrow keys adjust size" onPointerDown={event => resize(event, item.id)} onKeyDown={event => resizeKey(event, item.id)} onClick={event => { event.preventDefault(); event.stopPropagation(); }}>
      <svg viewBox="0 0 12 12" aria-hidden="true" shapeRendering="crispEdges"><path fill="currentColor" d="M8 2h2v8H2V8h2V6h2V4h2Z" /></svg>
    </button>}
  </article>{data.badges?.length && !expanded && !data.viewSurface ? <span className="card-badges" data-far={data.far || compact || undefined} style={{ fontSize: data.badgeSize }}>
    {data.badges.slice(0, 3).map(entry => <button key={entry.noteId} type="button" className="card-badge nodrag nopan" data-paper={entry.paper} data-paper-tone={paperPaint(entry.paper).dark ? 'dark' : undefined} style={{ '--badge-paper': paperPaint(entry.paper).color } as React.CSSProperties} aria-label={`Badge ${entry.text} on ${item.title}`} title={entry.text}
      onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onClick={event => badgeNote(event, entry.noteId, false)} onContextMenu={event => badgeNote(event, entry.noteId, true)}>{data.far || compact ? null : entry.text}</button>)}
    {data.badges.length > 3 && <span className="card-badge-more" title={data.badges.slice(3).map(entry => entry.text).join(', ')}>+{data.badges.length - 3}</span>}
  </span> : null}{working && compact && !data.viewSurface && <WorkingMark width={data.width} height={data.height} icon solid={data.takeover} state={markState} />}</>;
}
/** The type icon as a checkbox. It never starts a drag, selection or opening: pointer and
 * click stop at the button, and Space toggles without the native key-up click. */
function CompletionToggle({ done, toggle, children }: { done: boolean; toggle(): void; children: React.ReactNode }) {
  return <button type="button" role="checkbox" aria-checked={done} aria-label={done ? 'Mark not done' : 'Mark done'} title={done ? 'Mark not done' : 'Mark done'} className="item-check nodrag nopan"
    onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onClick={event => { event.stopPropagation(); toggle(); }}
    onKeyDown={event => {
      if (event.key === ' ') { event.preventDefault(); event.stopPropagation(); if (!event.repeat) toggle(); }
      else if (event.key === 'Enter') event.stopPropagation();
    }}>{children}</button>;
}
/** In priority order, when the row runs out of width, count labels shrink to icon plus number and other labels truncate.
 * While the card needs me the row leads with the `reason` in words; the cues follow in whatever form still fits. */
function CardIndicators({ cues, icons, width, reference, reason, reasonLength = 0 }: { cues: NonNullable<MapItem['indicators']>; icons: boolean; width: number; reference?: string; reason?: React.ReactNode; reasonLength?: number }) {
  const lead = icons ? undefined : reason, tag = icons ? undefined : reference;
  // The reference is never shortened: the cue labels give way first.
  const room = width - (tag ? tag.length * REFERENCE_CHAR + 7 : 0) - (lead ? reasonLength * REASON_CHAR + 7 : 0);
  const forms = icons ? undefined : fitIndicators(cues.map(cue => cue.label), Math.max(0, room));
  return <div className={`item-indicators ${icons ? 'indicator-icons' : 'indicator-labels'}${lead ? ' card-reason-row' : ''}`} aria-label="Item status">{tag && <span className="card-reference">{tag}</span>}{lead}{cues.map((cue, index) => <span key={cue.id} role="img" data-indicator={cue.id} data-tone={cue.tone} data-short={forms?.[index].short ? forms[index].text === cue.label ? 'truncated' : 'count' : undefined} title={cue.label} aria-label={cue.label}>
    <ItemIcon icon={cue.icon} size={8} />{forms?.[index].text !== '' && <span>{forms ? forms[index].text : cue.label}</span>}</span>)}</div>;
}
/** Screen pixels a character takes in the cue row: the reason's 10px semibold text, the reference's 10px mono. */
const REASON_CHAR = 5.8, REFERENCE_CHAR = 6.1;
/** Line two: the Needs me tiers and working, each a mark, a number and its word; zeros omitted. */
function ProjectHeader({ header }: { header?: HeaderData }) {
  if (!header || !(header.asking + header.turn + header.finished + header.working)) return null;
  return <small className="project-counts" data-needs-me={header.asking + header.turn > 0}><TierCounts counts={header} working={header.working} words /></small>;
}
/** `bounds` and `center` are the largest part's, where the sign stands. */
type PlotShape = { plot: PlotView; parts: number; paths: string[]; bounds: { left: number; top: number; right: number; bottom: number }; center: Point };
type PlotSign = PlotShape & { x: number; y: number; spot: number };
/** One cell of patch around the members' footprints, on the field's 24 px grid. */
const PLOT_PADDING = 24, PLOT_CELL = 24, PLOT_SEEN_BATCH = 60;
const plotLabel = (name: string) => name.length > PLOT_NAME_LENGTH ? `${name.slice(0, PLOT_NAME_LENGTH - 1).trimEnd()}…` : name;
type PlotStats = { tiers: AttentionCounts; working: number };
interface PlotSignActions {
  hover(id: string | undefined): void; select(id: string, add: boolean): void; grab(event: React.PointerEvent<HTMLElement>, id: string): void;
  rename(id: string): void; save(id: string, name: string): void; cancel(): void; menu(id: string, client: { x: number; y: number }): void;
}
/** Enter saves, Escape cancels; leaving the field saves. */
function PlotRename({ name, save, cancel }: { name: string; save(name: string): void; cancel(): void }) {
  const done = useRef(false), finish = (run: () => void) => { if (!done.current) { done.current = true; run(); } };
  return <input className="plot-sign-input nodrag nopan" aria-label="Plot name" defaultValue={name} maxLength={48} autoFocus data-owns-escape onFocus={event => event.currentTarget.select()}
    onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') { const value = event.currentTarget.value; finish(() => save(value)); } else if (event.key === 'Escape') finish(cancel); }}
    onBlur={event => { const value = event.currentTarget.value; finish(() => save(value)); }} />;
}
/** Signs are world-anchored; only a zoom change re-renders them, never a pan. */
const PlotSigns = memo(function PlotSigns({ signs, zoom, hovered, renaming, stats, neighborhoods, actions }: { signs: readonly PlotSign[]; zoom: number; hovered?: string; renaming?: string; stats: ReadonlyMap<string, PlotStats>; neighborhoods: ReadonlyMap<string, string>; actions: PlotSignActions }) {
  return <div className="plot-signs">{signs.map(sign => {
    const { id, name, memberIds } = sign.plot, stat = stats.get(id), tip = `plot-tip-${id}`, pinned = sign.plot.pinnedMemberIds.length > 0;
    return <div key={id} className="plot-sign" data-plot-sign={id} data-plot-color={plotColor(sign.plot)} data-spot={sign.spot} data-source={sign.plot.source} data-pinned={pinned || undefined} data-hover={hovered === id || undefined}
      style={{ ...plotStyle(neighborhoods.get(sign.plot.projectId), plotColor(sign.plot)), left: sign.x, top: sign.y, transform: `scale(${1 / zoom})` }}>
      {renaming === id ? <PlotRename name={name} save={value => actions.save(id, value)} cancel={actions.cancel} />
        : <button type="button" className="plot-sign-button nodrag nopan" aria-label={`Plot: ${name}, ${pinned ? 'pinned, ' : ''}${memberIds.length} items`} aria-describedby={hovered === id ? tip : undefined}
          onPointerEnter={event => { if (!event.buttons) actions.hover(id); }} onPointerLeave={() => actions.hover(undefined)} onFocus={() => actions.hover(id)} onBlur={() => actions.hover(undefined)}
          onPointerDown={event => actions.grab(event, id)} onClick={event => actions.select(id, event.shiftKey)} onDoubleClick={() => actions.rename(id)}
          onKeyDown={event => {
            if (event.key === 'F2') { event.preventDefault(); actions.rename(id); }
            else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); actions.menu(id, { x: rect.left, y: rect.bottom }); }
          }}
          onContextMenu={event => { event.preventDefault(); event.stopPropagation(); actions.menu(id, { x: event.clientX, y: event.clientY }); }}>
          <PixelGlyph name="sprout" />{pinned && <PixelGlyph name="pin" className="act-glyph plot-sign-pin" />}<span>{plotLabel(name)}</span></button>}
      {hovered === id && renaming !== id && <div className="plot-tip" role="tooltip" id={tip}><strong>{name}</strong>
        <span>{[pinned ? 'Pinned' : '', `${memberIds.length} items`, stat ? attentionCountText(stat.tiers) : '', stat?.working ? `${stat.working} working` : ''].filter(Boolean).join(' · ')}</span></div>}
    </div>;
  })}</div>;
});
const FLY_ZOOM = .8, WEB_DOUBLE_CLICK_MS = 300, DENSE_PROJECT_LINKS = 12, DASHBOARD_DRAG_THRESHOLD = 4;
const nodeTypes = { card: Card };

function MapCanvas(props: ProjectMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1000, height: 700 });
  const [focus, setFocus] = useState<string>();
  useEffect(() => { props.onView?.(focus); }, [focus, props.onView]);
  const occupiedControls = useMapObstacles(container, size.width, size.height, Boolean(focus));
  const dashboardObstacles = useMapObstacles(container, size.width, size.height, Boolean(focus), DASHBOARD_OBSTACLES);
  const [closing, setClosing] = useState<string>();
  const [viewPositions, setViewPositions] = useState<Record<string, { x: number; y: number }>>(() => splitViewBounds(props.viewBounds).positions);
  const [viewSizes, setViewSizes] = useState<Record<string, { width: number; height: number }>>(() => splitViewBounds(props.viewBounds).sizes);
  const [morph, setMorph] = useState<{ id: string; from: BubbleBounds }>();
  const captureBubble = (id: string, expanded = false) => {
    const element = container.current?.querySelector<HTMLElement>(`[${expanded ? "data-expanded-item-id" : "data-item-id"}="${CSS.escape(id)}"]`);
    if (element) setMorph({ id, from: element.getBoundingClientRect() });
  };
  useEffect(() => focus ? undefined : observeMapPerformance(), [focus]);
  const [hovered, setHovered] = useState<string>(), [keyboardFocused, setKeyboardFocused] = useState<string>();
  const pointerFocus = useRef(false);
  const zoomPreview = useRef<string>(undefined);
  const pointerPosition = useRef<{ x: number; y: number }>(undefined);
  const [hoveredEdge, setHoveredEdge] = useState<string>(), [focusedEdge, setFocusedEdge] = useState<string>();
  const clearInspection = () => { zoomPreview.current = undefined; setHovered(undefined); setKeyboardFocused(undefined); setHoveredEdge(undefined); setFocusedEdge(undefined); };
  useEffect(() => {
    const pointer = (event: PointerEvent) => {
      const previous = pointerPosition.current;
      pointerPosition.current = { x: event.clientX, y: event.clientY };
      if (event.type === 'pointermove' && previous?.x === event.clientX && previous.y === event.clientY) return;
      const nodeId = (event.target as Element).closest('.react-flow__node')?.getAttribute('data-id') ?? undefined;
      if (zoomPreview.current) { zoomPreview.current = undefined; setHovered(nodeId); }
      // Resizing a card or removing its menu can replace React Flow's hovered
      // surface before mouseleave fires. Real pointer departure still clears it.
      if (!nodeId) setHovered(undefined);
      pointerFocus.current = true; setKeyboardFocused(undefined); setFocusedEdge(undefined);
    };
    const keyboard = () => { pointerFocus.current = false; };
    const leave = () => { pointerFocus.current = true; clearInspection(); };
    const exitWindow = (event: PointerEvent) => { if (!event.relatedTarget) leave(); };
    window.addEventListener('pointerdown', pointer, true); window.addEventListener('pointermove', pointer, true);
    window.addEventListener('pointerout', exitWindow, true);
    window.addEventListener('keydown', keyboard, true); window.addEventListener('blur', leave);
    return () => { window.removeEventListener('pointerdown', pointer, true); window.removeEventListener('pointermove', pointer, true); window.removeEventListener('pointerout', exitWindow, true); window.removeEventListener('keydown', keyboard, true); window.removeEventListener('blur', leave); };
  }, []);
  const [visited, setVisited] = useState<Set<string>>(new Set());
  const [selection, setSelection] = useState<Set<string>>(new Set());
  useEffect(() => { setSelection(old => { const next = new Set([...old].filter(id => props.nodes.some(node => node.id === id && !isArchived(node, props.nodes)))); return next.size === old.size ? old : next; }); }, [props.nodes]);
  const [marquee, setMarquee] = useState<{ start: { x: number; y: number }; end: { x: number; y: number }; base: string[] }>();
  const marqueeRef = useRef<typeof marquee>(undefined);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number }>();
  const [linkDrag, setLinkDrag] = useState<{ id: string; from: { x: number; y: number }; to: { x: number; y: number } }>();
  const [dropping, setDropping] = useState(false);
  /** Moves still saving, in order. A card grabbed meanwhile drags from the map they leave (`settling`), not from the last commit. */
  const saves = useRef({ queue: Promise.resolve(), pending: 0 }), moving = useRef(false);
  const [settling, setSettling] = useState<MapItem[]>();
  // A solid drag travels from where the previous frame stopped it, so it slides along items instead of jumping past them.
  const solidFrom = useRef<Map<string, MapItem['position']>>(undefined);
  // A list task without a map item previews as a ghost; a map task previews as a drag of its own item.
  const [todoGhost, setTodoGhost] = useState<{ x: number; y: number }>(), todoMoving = useRef(false);
  const itemResize = useItemResize(props.onResize);
  const previousNodes = useRef<CardNode[]>([]);
  const previousViews = useRef(new Map<string, CardData>());
  const dragStart = useRef<{ id: string; projected: { x: number; y: number }; world: { x: number; y: number }; pointer: { x: number; y: number }; projects: ReturnType<typeof projectNeighborhoods>; selected: string[] }>(undefined);
  const viewGesture = useRef<{ id: string; mode: 'move' | 'resize'; capture: HTMLElement; pointerId: number; start: { x: number; y: number }; moved: boolean; origin: { x: number; y: number }; previous?: { x: number; y: number }; previousSize?: { width: number; height: number }; dimensions: { width: number; height: number }; profile: ItemViewProfile }>(undefined);
  const [viewInteracting, setViewInteracting] = useState(false);
  const dashboardGesture = useRef<{ id: string; members?: string[]; anchor: HTMLElement; pointerId: number; start: { x: number; y: number }; moved: boolean; cancelled: boolean }>(undefined);
  const suppressClick = useRef(false);
  const flyTarget = useRef<string>(undefined), webClick = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(webClick.current), []);
  /** Where a double-click opens the item's web page, a pointer click waits to see whether a second click follows. */
  const afterWebClick = (id: string, detail: number, run: () => void) => {
    clearTimeout(webClick.current);
    if (!detail || !props.webOpener?.(id)) run(); else if (detail === 1) webClick.current = setTimeout(run, WEB_DOUBLE_CLICK_MS);
  };
  const viewport = useViewport();
  const lastZoom = useRef(viewport.zoom);
  const { setCenter, zoomTo, zoomIn, zoomOut, screenToFlowPosition, fitBounds, setViewport } = useReactFlow();
  const [ownOverview, setOwnOverview] = useState(false);
  // The project column is not shown below (MAP-22), so there is nothing to unfold there.
  const cornerShown = props.mapCorner === 'atlas' || props.layer !== 'below';
  // The Projects panel stays open beside an open item and, pinned, until M or unpinning; the Atlas folds as before.
  const columnMode = props.mapCorner !== 'atlas', pinned = Boolean(columnMode && props.projectsPanel?.pinned);
  const overview = cornerShown && (pinned || ((columnMode || !focus) && (props.overview ?? ownOverview)));
  const setOverview = (open: boolean) => { (props.onOverview ?? setOwnOverview)(open); if (!open && pinned) props.onProjectsPanel?.({ pinned: false }); };
  useWorkspaceShortcuts({ 'map.overview': () => { if ((focus && !columnMode) || !cornerShown) return false; setOverview(!overview); },
    'map.zoomIn': () => { if (focus) return false; void zoomIn(); }, 'map.zoomOut': () => { if (focus) return false; void zoomOut(); },
    'map.zoomReset': () => { if (focus) return false; void zoomTo(1); },
    'project.mute': () => {
      const id = document.activeElement?.closest('.react-flow__node')?.getAttribute('data-id');
      const project = id ? props.nodes.find(node => node.id === id && !node.resourceId && !node.projectId) : undefined;
      if (focus || !project || !props.onMute) return false;
      if (project.mutedAt) toggleMute.current(project.id, false); else props.onMute(project.id, true);
    } });
  const toggleMute = useRef<(id: string, muted: boolean) => void>(() => {});
  const duration = () => matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 250;
  const back = () => {
    if (focus) {
      cancelViewGesture();
      captureBubble(focus, true);
      setClosing(focus);
      clearInspection();
      setFocus(undefined);
    } else if (viewport.zoom >= neighborhoodZoom(props.dashboards ?? DEFAULT_MAP_DASHBOARDS)) {
      void setCenter((size.width / 2 - viewport.x) / viewport.zoom, (size.height / 2 - viewport.y) / viewport.zoom, { zoom: .5, duration: duration() });
    }
  };
  useEffect(() => { if (focus && !props.nodes.some(node => node.id === focus && !isArchived(node, props.nodes))) back(); }, [focus, props.nodes]);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(container.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dashboardGesture.current?.moved) { event.preventDefault(); event.stopImmediatePropagation(); dashboardDrag.cancel(); return; }
      if (event.key === 'Escape' && (event.defaultPrevented || document.querySelector('.project-column-panel [data-dragging]'))) return;
      const inPanel = (event.target as HTMLElement).closest('.project-column-panel');
      if (event.key === 'Escape' && overview && !pinned && (!focus || inPanel) && !document.querySelector(inPanel ? '[role="menu"],.inline-editor' : '[role="menu"],.inline-editor,.attention-list')) { event.preventDefault(); event.stopImmediatePropagation(); setOverview(false); return; }
      if (event.key === 'Escape' && !focus && (selection.size || marqueeRef.current)) { event.preventDefault(); setSelection(new Set()); marqueeRef.current = undefined; setMarquee(undefined); return; }
      if (event.key === 'Escape' && !focus && props.undermap && !(event.target as HTMLElement).closest('input,textarea,select,[data-owns-escape]') && !document.querySelector('[role="menu"],.inline-editor,.attention-list') && props.undermap.collapse()) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      if (event.key === 'Escape' && itemResize.preview) return;
      if (event.key === 'Escape' && viewGesture.current) { event.preventDefault(); event.stopImmediatePropagation(); cancelViewGesture(); return; }
      // Capture phase, so ⌘E also works while a terminal has focus; keys meant for another panel are left alone.
      const inView = event.target === document.body || (event.target as HTMLElement).closest(`[data-expanded-item-id="${CSS.escape(focus ?? '')}"]`);
      if (focus && needsMe.has(focus) && props.onMarkSeen && matchWorkspaceShortcut(event) === 'view.closeSeen' && inView && !shortcutsPaused() && !document.querySelector('[role="menu"]')) { event.preventDefault(); event.stopImmediatePropagation(); props.onMarkSeen(focus); back(); return; }
      if (event.key === 'Escape' && !(event.target as HTMLElement).closest('.terminal-surface,input,textarea,select,[data-owns-escape]') && !document.querySelector('[role="menu"],.inline-editor,.attention-list')) back();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
  const { rightClickCloses } = useTerminalPreferences();
  const rightClickRef = useRef(rightClickCloses); rightClickRef.current = rightClickCloses;
  useEffect(() => {
    if (!focus) return;
    const keepsOpen = (target: EventTarget | null) => rightClickRef.current === 'outside' && target instanceof Element && Boolean(target.closest('[data-expanded-item-id]')?.querySelector('.native-terminal'));
    // Capture before native terminal handlers or map menus: secondary click is navigation here.
    const returnToProject = (event: MouseEvent) => {
      event.preventDefault(); event.stopPropagation();
      if (!keepsOpen(event.target)) back();
    };
    window.addEventListener('contextmenu', returnToProject, true);
    return () => window.removeEventListener('contextmenu', returnToProject, true);
  }, [focus]);
  // A resource that did not change keeps its presentation, so one changed record never re-presents the rest.
  const presented = useRef<{ registry: unknown; views: WeakMap<ProjectMapProps['resources'][number], ReturnType<typeof presentResource>> }>(undefined);
  const presentations = useMemo(() => {
    const plugins = props.registry ?? registry;
    if (presented.current?.registry !== plugins) presented.current = { registry: plugins, views: new WeakMap() };
    const views = presented.current.views;
    return new Map(props.resources.map(resource => { let view = views.get(resource); if (!view) { view = presentResource(plugins, resource); views.set(resource, view); } return [resource.id, view]; }));
  }, [props.resources, props.registry]);
  const blocking = useMemo(() => {
    const state = blockingState(props.nodes, props.links), blocked = new Map<string, Blocked>();
    for (const [id, blockers] of state.blocked) {
      const named = blockers.map(blocker => ({ id: blocker.id, name: blockerName(blocker.title, blocker.resourceId ? presentations.get(blocker.resourceId)?.reference : undefined) }));
      blocked.set(id, { text: `Blocked by ${blockerList(named.map(blocker => blocker.name))}`, blockers: named });
    }
    return { blocked, resolved: state.resolved };
  }, [props.nodes, props.links, presentations]);
  const dropProject = (item: MapItem, position: { x: number; y: number }) => itemDropProject(item, position,
    (dragStart.current?.projects ?? []).filter(project => props.nodes.some(node => node.id === project.id && !node.archivedAt)));
  const dragged = drag && props.nodes.find(node => node.id === drag.id);
  const attachingTo = drag && dragged && (dragStart.current?.selected.length ?? 0) < 2 ? dropProject(dragged, drag) : undefined;
  const endTodoPreview = () => { setTodoGhost(undefined); if (todoMoving.current) { todoMoving.current = false; dragStart.current = undefined; setDrag(undefined); } };
  useEffect(() => { if (!props.todoDrag && !dropping) endTodoPreview(); }, [props.todoDrag]);
  const layout = useMemo(() => {
    const base = settling ?? props.nodes, intent = itemResize.preview ?? drag;
    if (!intent || !base.some(node => node.id === intent.id)) { solidFrom.current = undefined; return base; }
    const started = performance.now(), stopped = !itemResize.preview && props.collisions === 'solid' ? solidFrom.current : undefined;
    const from = stopped ? base.map(node => stopped.has(node.id) ? { ...node, position: stopped.get(node.id)! } : node) : base;
    const result = itemResize.preview
      ? resizeItem(base, props.resources, props.registry ?? registry, itemResize.preview, props.itemMapSizes)
      : moveItems(attachingTo ? from.map(node => node.id === drag!.id ? { ...node, projectId: attachingTo } : node) : from,
        props.resources, props.registry ?? registry, selectionMoves(from, dragStart.current?.selected ?? [drag!.id], drag!.id, drag!), props.itemMapSizes, props.snap, props.collisions);
    if (!itemResize.preview && props.collisions === 'solid') solidFrom.current = new Map(result.filter((node, index) => node.position !== base[index].position).map(node => [node.id, node.position]));
    performanceMetrics.record('map.placement', performance.now() - started); return result;
  }, [props.nodes, settling, props.resources, props.registry, props.itemMapSizes, props.snap, props.collisions, drag, itemResize.preview, attachingTo]);
  const measureBox = (item: MapItem) => {
    const view = item.resourceId ? presentations.get(item.resourceId) : undefined;
    const { width, height } = itemFootprint(item, props.resources, props.registry ?? registry, props.itemMapSizes);
    const record = props.resources.find(resource => resource.id === item.resourceId);
    const mapSize = record ? resolveMapSize(item, record, (props.registry ?? registry).get(record.pluginId), props.itemMapSizes) : undefined;
    const fields = mapSize?.fields?.map(key => view?.fields.find(field => field.key === key)).filter(field => field && field.value !== undefined && field.value !== '') ?? [];
    const mapFields = fields.map(field => `${fields.length > 1 ? field!.label + ": " : ""}${String(field!.value).replace(/\s+/g, " ")}`).join(" · ").slice(0, 1000);
    const pipValue = mapSize?.pips && record ? mapSize.pips.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], record.data) : undefined;
    const presented = mapSize?.presentationPips ? item.pips : undefined;
    const pips = Array.isArray(pipValue) ? pipValue.filter((pip): pip is MapPip => typeof pip?.tone === 'string' && typeof pip?.style === 'string').slice(0, 24) : presented?.pips;
    // An unsaved tile has no text yet, so it is read from its type rather than its validated presentation.
    const paperType = record && (props.registry ?? registry).get(record.pluginId), spec = paperType?.appearance?.paper;
    const paper = spec && record ? { color: String(record.data[spec.paperField ?? ''] ?? '') || 'mint', text: String(record.data[spec.textField] ?? '') } : undefined;
    const writer = paperType?.authorship && record?.data[paperType.authorship.field] as { name?: unknown; at?: unknown } | undefined;
    return { item, record, presentation: view, paper: paper?.color, paperText: paper?.text, paperWriter: typeof writer?.name === 'string' ? writer.name : undefined, paperWrittenAt: typeof writer?.at === 'string' ? writer.at : undefined, mapSize, mapFields, pips: pips?.length ? pips : undefined, pipsLabel: presented?.label, frameTitle: view?.frameTitle, reference: view?.reference, view: view?.view, tiny: Boolean(mapSize && mapSize.height <= 36 && !mapSize.iconOnly), iconOpens: view?.appearance.openFromIcon === true, completionToggle: view?.appearance.completionToggle === true, undermapWhenComplete: view?.appearance.undermapWhenComplete === true, showFullTitle: view?.appearance.showFullTitle === true, editableTitle: view?.appearance.editableTitle === true, editableViewTitle: view?.appearance.editableViewTitle === true, width, height, x: item.position.x, y: item.position.y, icon: presentationIcon(view, Boolean(item.completedAt)), brand: view?.brand, tint: view?.appearance.brandTint === true, tone: view?.appearance.tone ?? 'mint', typeName: paper ? paperType!.name : view?.typeName ?? 'Project' };
  };
  // Items a drag preview leaves in place keep their box, so their cards do not re-render per frame.
  const measured = useRef<{ inputs: unknown[]; boxes: WeakMap<MapItem, ReturnType<typeof measureBox>> }>(undefined);
  const allBoxes = useMemo(() => {
    const inputs = [props.registry, props.itemMapSizes];
    const known = measured.current?.inputs.every((input, index) => input === inputs[index]) ? measured.current.boxes : new WeakMap<MapItem, ReturnType<typeof measureBox>>();
    measured.current = { inputs, boxes: known };
    const records = new Map(props.resources.map(resource => [resource.id, resource]));
    // A box is measured again only when its own item, record or presentation changed.
    return layout.filter(item => !isArchived(item, layout)).map(item => {
      const record = item.resourceId ? records.get(item.resourceId) : undefined, view = item.resourceId ? presentations.get(item.resourceId) : undefined;
      let box = known.get(item);
      if (!box || box.record !== record || box.presentation !== view) { box = measureBox(item); known.set(item, box); }
      return box;
    });
  }, [layout, props.resources, props.registry, props.itemMapSizes, presentations]);
  // A mirror layout mounts only the cards in the cells around the window; the key changes when the window crosses a cell.
  const mirror = props.undermap;
  const cullKey = mirror ? [Math.floor(-viewport.x / viewport.zoom / CULL_CELL) - 1, Math.floor(-viewport.y / viewport.zoom / CULL_CELL) - 1, Math.ceil((size.width - viewport.x) / viewport.zoom / CULL_CELL) + 1, Math.ceil((size.height - viewport.y) / viewport.zoom / CULL_CELL) + 1].join() : '';
  const boxes = useMemo(() => {
    if (!cullKey) return allBoxes;
    const [left, top, right, bottom] = cullKey.split(',').map(cell => Number(cell) * CULL_CELL);
    return allBoxes.filter(box => !box.item.resourceId || visited.has(box.item.id) || selection.has(box.item.id) || props.highlightedNodes?.includes(box.item.id)
      || box.x + box.width / 2 >= left && box.x - box.width / 2 <= right && box.y + box.height / 2 >= top && box.y - box.height / 2 <= bottom);
  }, [allBoxes, cullKey, visited, selection, props.highlightedNodes]);
  // A drag moves one project's members; the others keep their shapes, and their fields skip re-rendering.
  const neighborhoodCache = useRef<NeighborhoodCache>(new Map());
  const projects = useMemo(() => {
    const started = performance.now();
    // Below, in a mirror layout, a project's field is its computed area, whatever is mounted inside.
    const members = mirror ? mirror.areas.flatMap(area => {
      const plate = boxes.find(box => box.item.id === area.id);
      return plate ? [{ ...plate, id: area.id }, { id: `${area.id}:area`, x: area.x, y: area.y, width: area.width, height: area.height, item: { id: `${area.id}:area`, title: '', resourceId: 'area', projectId: area.id, position: { x: area.x, y: area.y } } }] : [];
    }) : boxes.map(box => ({ ...box, id: box.item.id }));
    const shapes = projectNeighborhoods(members, props.neighborhoodPadding, neighborhoodCache.current);
    performanceMetrics.record('map.geometry', performance.now() - started); return shapes;
  }, [boxes, props.neighborhoodPadding, mirror]);
  // Muted projects (MAP-25) are covered on the map layer; the set changes only when one is muted or unmuted.
  const mutedKey = useMemo(() => props.onMute ? [...mutedProjectIds(props.nodes)].sort().join('\n') : '', [props.nodes, props.onMute]);
  const mutedProjects = useMemo(() => mutedKey ? new Set(mutedKey.split('\n')) : NOT_MUTED, [mutedKey]);
  const mute = useMutePeek(mutedProjects), peek = mute.peek;
  // A preset colour is a biome on the map (BIOME-01). Muted and custom-coloured fields and the Undermap stay one plain colour.
  const fieldAppearance = props.neighborhoodAppearance ?? DEFAULT_NEIGHBORHOOD_APPEARANCE;
  const grounds = useMemo(() => {
    const byId = new Map(props.nodes.map(node => [node.id, node])), tint = props.neighborhoodColor ?? ((color: string) => color);
    const biomes = fieldAppearance.style === 'biome' && props.layer !== 'below' && !props.neighborhoodColor;
    return projects.map(project => {
      const muted = mutedProjects.has(project.id), color = projectColor(byId.get(project.id));
      return { project, color: muted ? 'var(--act-mute-hull)' : tint(color), biome: biomes && !muted ? biomeFor(color) : undefined, items: neighborhoodCache.current.get(project.id)?.footprints ?? NO_FOOTPRINTS };
    });
  }, [projects, props.nodes, props.neighborhoodColor, props.layer, mutedProjects, fieldAppearance.style]);
  const flatGround = !biomeDetailVisible(fieldAppearance.pixelSize, viewport.zoom, devicePixelRatio);
  useEffect(() => mute.focus(keyboardFocused && mutedProjects.has(keyboardFocused) ? keyboardFocused : undefined), [keyboardFocused, mutedProjects]);
  const coverPress = useRef<{ x: number; y: number }>(undefined);
  const unmute = (id: string) => { mute.close(); props.onMute?.(id, false); };
  toggleMute.current = unmute;
  const coverShapes = useMemo<MuteCoverShape[]>(() => mutedProjects.size ? projects.filter(project => mutedProjects.has(project.id)).map(project => ({ id: project.id, points: project.points,
    boxes: boxes.filter(box => box.item.resourceId && box.item.projectId === project.id).map(box => ({ x: box.x, y: box.y, width: box.width, height: box.height, paper: box.paper !== undefined })) })) : [], [projects, boxes, mutedProjects]);
  // Plot colors follow each project's own neighborhood color, never the Undermap's darkened one.
  const neighborhoodKey = useMemo(() => { const byId = new Map(props.nodes.map(node => [node.id, node])); return projects.map(project => `${project.id}=${projectColor(byId.get(project.id))}`).join('\n'); }, [projects, props.nodes]);
  const plotNeighborhoods = useMemo(() => new Map(neighborhoodKey ? neighborhoodKey.split('\n').map(entry => entry.split('=') as [string, string]) : []), [neighborhoodKey]);
  // Member geometry only: a pan never recomputes a patch, and a drag recomputes just the held plot.
  const plotCache = useRef(new Map<string, { key: string; field: Point[]; shape: PlotShape }>());
  const plotShapes = useMemo(() => {
    if (!props.plots?.length) { plotCache.current.clear(); return []; }
    const started = performance.now(), byId = new Map(boxes.map(box => [box.item.id, box])), fields = new Map(projects.map(project => [project.id, project.points]));
    const next = new Map<string, { key: string; field: Point[]; shape: PlotShape }>();
    let computed = false;
    const shapes = props.plots.flatMap(plot => {
      const members = plot.memberIds.flatMap(id => byId.get(id) ?? []), field = fields.get(plot.projectId);
      if (members.length < (plot.pinnedMemberIds.length ? 1 : PLOT_MIN_LINKED) || !field || mutedProjects.has(plot.projectId)) return [];
      const key = `${members.map(box => `${box.x},${box.y},${box.width},${box.height}`).join(';')}`, cached = plotCache.current.get(plot.id);
      if (cached && cached.key === key && cached.field === field && cached.shape.plot === plot) { next.set(plot.id, cached); return [cached.shape]; }
      computed = true;
      const parts = plotPatches(members.map(box => ({ id: box.item.id, projectId: plot.projectId, x: box.x, y: box.y, width: box.width, height: box.height })));
      const outlines = parts.map(part => neighborhoodContours(part, PLOT_PADDING, PLOT_CELL)[0]), paths = ['', ''];
      for (const outline of outlines) plotFill(outline, field, PLOT_CELL).paths.forEach((path, shade) => { paths[shade] += path; });
      const xs = outlines[0].map(point => point.x), ys = outlines[0].map(point => point.y);
      const bounds = { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
      const shape = { plot, parts: parts.length, paths, bounds, center: { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 } };
      next.set(plot.id, { key, field, shape }); return [shape];
    });
    plotCache.current = next;
    if (computed) performanceMetrics.record('map.plots', performance.now() - started);
    return shapes;
  }, [props.plots, boxes, projects, mutedProjects]);
  // Placement follows committed layout and the zoom band; a drag keeps each sign's spot.
  const placementZoom = Math.round(viewport.zoom * 20) / 20, signSpots = useRef(new Map<string, number>());
  const placing = Boolean(drag || itemResize.preview);
  const plotSigns = useMemo<PlotSign[]>(() => {
    if (!plotShapes.length) return [];
    const sized = plotShapes.map(shape => ({ shape, size: plotSignSize(plotLabel(shape.plot.name), placementZoom, shape.plot.pinnedMemberIds.length > 0) }));
    if (placing) return sized.map(({ shape, size }) => ({ ...shape, ...plotSignPosition({ bounds: shape.bounds, ...size }, signSpots.current.get(shape.plot.id) ?? 0) }));
    const cards = boxes.filter(box => box.item.resourceId).map(box => ({ x: box.x - box.width / 2, y: box.y - box.height / 2, width: box.width, height: box.height }));
    const titles = projects.map(project => ({ x: (project.left + project.right) / 2 - 150 / placementZoom, y: project.top - 60 / placementZoom, width: 300 / placementZoom, height: 48 / placementZoom }));
    const centers = new Map(boxes.map(box => [box.item.id, { x: box.x, y: box.y }]));
    const links = props.links.flatMap(link => { const from = centers.get(link.sourceId), to = centers.get(link.targetId); return from && to ? [{ from, to }] : []; });
    const placed = placePlotSigns(sized.map(({ shape, size }) => ({ id: shape.plot.id, bounds: shape.bounds, ...size })), [...cards, ...titles], links, signSpots.current);
    signSpots.current = new Map([...placed].map(([id, spot]) => [id, spot.spot]));
    return plotShapes.map(shape => ({ ...shape, ...placed.get(shape.plot.id)! }));
  }, [plotShapes, placementZoom, placing, props.links, boxes, projects]);
  const ghostProject = todoGhost ? containingProject(todoGhost, projects) : undefined;
  const ghostSize = useMemo(() => itemFootprint({ id: 'todo-ghost', title: '', resourceId: 'todo-ghost', position: { x: 0, y: 0 } }, [{ id: 'todo-ghost', pluginId: 'workspace.todo', schemaVersion: 1, title: '', data: {} }], props.registry ?? registry, props.itemMapSizes), [props.registry, props.itemMapSizes]);
  const rollups = useMemo(() => new Map(projects.map(project => {
    // Only a project covered on this layer says Muted; in Undermap its plate is an ordinary one.
    const { muted, ...counts } = projectActivity(project.id, props.nodes), header: HeaderData = muted && mutedProjects.has(project.id) ? { ...counts, muted } : counts;
    // Four counts with their words need a wider plate than the usual two.
    const kinds = [counts.asking, counts.turn, counts.finished, counts.working].filter(Boolean).length;
    return [project.id, { ...header, header, size: { width: kinds > 3 ? 348 : 300, height: 48 } }];
  })), [props.nodes, projects, mutedProjects]);
  const dashboardSetting = props.dashboards ?? DEFAULT_MAP_DASHBOARDS, dashboardsWere = useRef<boolean>(undefined);
  const level = zoomLevel(viewport.zoom, dashboardSetting);
  const detail = zoomDetail(viewport.zoom, dashboardSetting);
  // Never fold notes to their far form above the threshold where other items are still cards.
  const paperFarZoom = Math.min(PAPER_FAR_ZOOM, neighborhoodZoom(dashboardSetting) - .02);
  const dashboards = !focus && projects.length > 0 && dashboardsShown(viewport.zoom, dashboardSetting, dashboardsWere.current ?? viewport.zoom < dashboardSetting.belowZoom);
  useLayoutEffect(() => { dashboardsWere.current = dashboards; });
  const projectIds = useMemo(() => new Set(projects.map(project => project.id)), [projects]);
  const replaced = (item: MapItem) => dashboards && (projectIds.has(item.id) || Boolean(item.projectId && projectIds.has(item.projectId)));
  // A project cut by the viewport edge that is not the one filling most of it is a neighbour: one faded line.
  const edgeProjects = useMemo(() => {
    const shown = projects.map(project => {
      const left = project.left * viewport.zoom + viewport.x, right = project.right * viewport.zoom + viewport.x, top = project.top * viewport.zoom + viewport.y, bottom = project.bottom * viewport.zoom + viewport.y;
      const cover = Math.max(0, Math.min(right, size.width) - Math.max(left, 0)) * Math.max(0, Math.min(bottom, size.height) - Math.max(top, 0));
      return { id: project.id, cover, cut: left < 0 || top < 0 || right > size.width || bottom > size.height };
    }).filter(project => project.cover > 0);
    const most = Math.max(0, ...shown.map(project => project.cover));
    return new Set(shown.filter(project => project.cut && project.cover < most).map(project => project.id));
  }, [projects, viewport, size]);
  // Panning must not re-render cards, so the neighbour state is a DOM attribute, not card data.
  useLayoutEffect(() => {
    for (const label of container.current?.querySelectorAll<HTMLElement>('[data-project-label]') ?? []) {
      if (edgeProjects.has(label.dataset.projectLabel!)) label.dataset.edge = 'true'; else delete label.dataset.edge;
    }
  });
  const labelPositions = useMemo(() => {
    const visibleProjects = projects.filter(p => p.right * viewport.zoom + viewport.x > 0 && p.left * viewport.zoom + viewport.x < size.width && p.bottom * viewport.zoom + viewport.y > 0 && p.top * viewport.zoom + viewport.y < size.height);
    const labels = visibleProjects.map(project => { const header = rollups.get(project.id)?.size ?? { width: 300, height: 48 }, point = neighborhoodTitlePosition(project, viewport, size, header.width, header.height); return { id: project.id, x: point.x * viewport.zoom + viewport.x - header.width / 2, y: point.y * viewport.zoom + viewport.y - header.height / 2, ...header }; });
    const items = boxes.filter(box => box.item.resourceId).map(box => ({ x: box.x * viewport.zoom + viewport.x - box.width * viewport.zoom / 2, y: box.y * viewport.zoom + viewport.y - box.height * viewport.zoom / 2, width: box.width * viewport.zoom, height: box.height * viewport.zoom })).filter(r => r.x + r.width > 0 && r.x < size.width && r.y + r.height > 0 && r.y < size.height);
    return placeProjectLabels(labels, [...occupiedControls, ...items], size);
  }, [projects, boxes, viewport, size, occupiedControls, rollups]);
  const focusLeftInset = props.onItemDrop ? 64 : 24; // Keep the persistent to-do icon clear of terminal text.
  const priorById = new Map(previousNodes.current.map(node => [node.id, node]));
  const inspectedBlock = !focus ? props.links.find(link => link.kind === 'blocks' && link.id === (hoveredEdge ?? focusedEdge)) : undefined;
  const projected: CardNode[] = boxes.map(box => {
    const project = projects.find(project => project.id === box.item.id), projectLabel = Boolean(project);
    const header = projectLabel ? rollups.get(box.item.id) : undefined;
    const paperMode: PaperMode | undefined = box.paper === undefined ? undefined : viewport.zoom < paperFarZoom ? 'far' : detail < .35 ? 'mid' : 'near';
    const fullSize = Boolean(project) || paperMode === 'near' || paperMode === 'mid';
    const width = header ? header.size.width : fullSize ? box.width : 46 + (box.width - 46) * detail;
    const height = header ? header.size.height : fullSize ? box.height : 46 + (box.height - 46) * detail;
    const scale = projectLabel ? 1 / viewport.zoom : 1;
    let position = projectLabel ? neighborhoodTitlePosition(project!, viewport, size, width, height) : project ? project.center : { x: box.x, y: box.y };
    const label = projectLabel && labelPositions.get(box.item.id);
    if (label) position = { x: (label.x + width / 2 - viewport.x) / viewport.zoom, y: (label.y + height / 2 - viewport.y) / viewport.zoom };
    // A covered card is below its project's cover; an item being dragged in stays in hand.
    const quiet = !projectLabel && drag?.id !== box.item.id && box.item.projectId !== undefined && mutedProjects.has(box.item.projectId);
    const covered = quiet && peek?.id !== box.item.projectId && box.item.id !== focus && !visited.has(box.item.id) && !selection.has(box.item.id) && !props.highlightedNodes?.includes(box.item.id);
    const held = dragStart.current;
    if (projectLabel && drag?.id === box.item.id && held?.id === box.item.id) {
      position = { x: held.projected.x + drag.x - held.world.x, y: held.projected.y + drag.y - held.world.y };
    }
    return reuseProjection(priorById.get(box.item.id), { id: box.item.id, type: 'card', position, hidden: replaced(box.item),
      style: { width: width * scale, height: height * scale }, width: width * scale, height: height * scale,
      measured: { width: width * scale, height: height * scale }, draggable: !mirror && !quiet && !dropping && !itemResize.preview && !viewInteracting, focusable: !quiet,
      // A card never pans the map, even while it cannot be dragged (Undermap, a save, a resize).
      className: quiet ? peek?.id === box.item.projectId ? PEEKED : COVERED : projectLabel ? 'nopan project-title-node' : 'nopan',
      zIndex: quiet ? -2 : itemResize.preview?.id === box.item.id ? 5 : projectLabel ? 0 : 1,
      data: { badges: projectLabel ? undefined : props.badges?.get(box.item.id), badgeSize: Math.min(20, Math.max(11, 11 / viewport.zoom)), far: !projectLabel && level === 'overview', titleFill: !projectLabel && (fullSize || detail >= 1), takeover: !projectLabel && !fullSize && attentionTakesOver(width, viewport.zoom), header: header?.header, projectColor: projectLabel ? (props.neighborhoodColor ?? (color => color))(projectColor(box.item)) : undefined, pips: box.pips, pipsLabel: box.pipsLabel, frameTitle: box.frameTitle, reference: box.reference, mapSize: box.mapSize, mapFields: box.mapFields, tiny: box.tiny, iconOpens: box.iconOpens, completionToggle: box.completionToggle && Boolean(props.onComplete), undermapWhenComplete: box.undermapWhenComplete, resizable: Boolean(props.onResize && !mirror && !focus && !projectLabel && !quiet && detail >= .35), resizing: itemResize.preview?.id === box.item.id, viewOpen: box.item.id === focus, showFullTitle: box.showFullTitle, editableTitle: box.editableTitle && Boolean(props.onRename), editableViewTitle: box.editableViewTitle && Boolean(props.onRename), paper: box.paper, paperText: box.paperText, paperMode, paperWriter: box.paperWriter, paperWrittenAt: box.paperWrittenAt, item: box.item, icon: box.icon, brand: box.brand, tint: box.tint, typeName: box.typeName, tone: box.tone, width, height, compact: box.mapSize?.iconOnly || !project && (paperMode ? paperMode === 'far' : detail < .35), expanded: false, visited: false, scale, projectLabel, labelOverOutline: projectLabel, projectNeedsMe: rollups.get(box.item.id)?.needsMe ?? 0, attentionSize: projectLabel ? 14 : Math.max(14, 8 / viewport.zoom), dragging: drag?.id === box.item.id, blocked: projectLabel ? undefined : blocking.blocked.get(box.item.id), linkEnd: inspectedBlock && (inspectedBlock.sourceId === box.item.id || inspectedBlock.targetId === box.item.id), selected: !projectLabel && selection.has(box.item.id), covered } });
  });
  const nodes = projected.length === previousNodes.current.length && projected.every((node, index) => node === previousNodes.current[index]) ? previousNodes.current : projected;
  // Detail surfaces are screen-space siblings, never graph nodes or edge endpoints.
  const needsMe = useMemo(() => needsMeIds(props.nodes), [props.nodes]);
  // The open item's project and plot as the map shows them; a key keeps the object stable while they stay the same.
  const placeKey = useMemo(() => {
    const item = focus ? props.nodes.find(node => node.id === focus) : undefined, project = item?.projectId ? props.nodes.find(node => node.id === item.projectId) : undefined;
    const plot = item && props.plots?.find(plot => plot.projectId === item.projectId && plot.memberIds.includes(item.id)), tint = props.neighborhoodColor ?? ((color: string) => color);
    return JSON.stringify(item ? { ...(project ? { project: { id: project.id, title: project.title, color: tint(projectColor(project)) } } : {}), ...(project && plot ? { plot: { id: plot.id, name: plotName(plot.name) } } : {}) } : null);
  }, [focus, props.nodes, props.plots, props.neighborhoodColor]);
  const place = useMemo(() => JSON.parse(placeKey) as ItemPlace | null ?? undefined, [placeKey]);
  // The open view keeps the screen spot it opened at while the board pans or zooms under it.
  const openAnchor = useMemo(() => { const box = focus ? boxes.find(box => box.item.id === focus) : undefined; return box && { x: box.x * viewport.zoom + viewport.x, y: box.y * viewport.zoom + viewport.y }; }, [focus]);
  // Keep visited views mounted so moving/closing/reopening does not replace a PTY view.
  const itemViews = nodes.filter(node => visited.has(node.id) && !node.data.projectLabel).map(node => {
    const box = boxes.find(box => box.item.id === node.id)!;
    const open = node.id === focus, returning = node.id === closing;
    const bounds = expandedItemBounds(box.view!, props.itemViews ?? {}, size,
      open && openAnchor ? openAnchor : { x: box.x * viewport.zoom + viewport.x, y: box.y * viewport.zoom + viewport.y }, focusLeftInset);
    if (viewSizes[node.id]) Object.assign(bounds, clampItemViewSize(viewSizes[node.id], box.view!, size));
    const position = clampItemViewPosition(viewPositions[node.id] ?? { x: bounds.x - bounds.width / 2, y: bounds.y - bounds.height / 2 }, bounds, size);
    const origin = { x: (node.position.x - node.width! / 2) * viewport.zoom + viewport.x,
      y: (node.position.y - node.height! / 2) * viewport.zoom + viewport.y };
    return { id: node.id, profile: box.view!, hidden: !open && !returning, position: returning ? origin : position,
      data: reuseCardData(previousViews.current.get(node.id), { ...node.data, viewSurface: true, viewOpen: false, visited: true, expanded: open, resizable: false, needsMe: open && needsMe.has(node.id), keep: open && props.keep?.id === node.id ? props.keep.tier : undefined,
        compact: open ? false : node.data.compact, location: open ? place : undefined, width: returning ? node.data.width : bounds.width,
        height: returning ? node.data.height : bounds.height, scale: returning ? viewport.zoom : 1,
        morph: morph?.id === node.id ? morph.from : undefined }) };
  });
  const inspected = !focus ? nodes.find(node => node.id === (hovered ?? keyboardFocused) && !node.data.projectLabel) : undefined;
  const inspectedConnection = !focus ? props.links.find(link => link.id === (hoveredEdge ?? focusedEdge)) : undefined;
  const connectionEndpoints = inspectedConnection && [nodes.find(node => node.id === inspectedConnection.sourceId), nodes.find(node => node.id === inspectedConnection.targetId)];
  useLayoutEffect(() => { previousNodes.current = nodes; }, [nodes]);
  useLayoutEffect(() => { previousViews.current = new Map(itemViews.map(view => [view.id, view.data])); }, [itemViews]);
  const openView = itemViews.find(view => view.id === focus && !view.hidden);
  const chromeCovered = Boolean(openView && coversChrome({ ...openView.position, width: openView.data.width, height: openView.data.height }, CHROME));
  useEffect(() => { props.onChromeCover?.(chromeCovered); }, [chromeCovered, props.onChromeCover]);
  const drawable = useMemo(() => {
    const visible = new Map(boxes.map(box => [box.item.id, box.item]));
    // A link inside closed covers is not drawn; one that leaves a muted project runs under the cover, which cuts it at the hull.
    const quietOf = (id: string) => { const project = visible.get(id)?.projectId; return project !== undefined && mutedProjects.has(project) ? project : undefined; };
    const coveredEnd = (id: string) => { const project = quietOf(id); return project !== undefined && project !== peek?.id; };
    const explicit = props.links.filter(link => visible.get(link.sourceId)?.resourceId && visible.get(link.targetId)?.resourceId && !replaced(visible.get(link.sourceId)!) && !replaced(visible.get(link.targetId)!)
      && !(coveredEnd(link.sourceId) && coveredEnd(link.targetId)));
    return { visible, quietOf, explicit };
  }, [props.links, boxes, dashboards, projectIds, mutedProjects, peek?.id]);
  // Implied links (LINK-06) follow the drawn links only, so moving items or the camera never recomputes them.
  const impliedKey = useMemo(() => props.hideImpliedLinks === false ? '' : drawable.explicit.map(link => `${link.id} ${link.sourceId} ${link.targetId} ${link.kind} ${link.reveal ?? ''}`).join('\n'), [drawable, props.hideImpliedLinks]);
  const implied = useMemo(() => impliedKey ? impliedLinks(drawable.explicit) : NO_LINKS, [impliedKey]);
  const edges = useMemo(() => {
    const { visible, quietOf, explicit } = drawable;
    // A hover or implied link is drawn only while an end is hovered, focused, selected or open, or the link itself is hovered, focused or highlighted.
    const revealed = new Set([hovered, keyboardFocused, focus, hoveredEdge, focusedEdge, ...selection, ...props.highlightedLinks ?? [], ...props.menuFor ?? []].filter(id => id !== undefined));
    const shown = new Set(shownLinks(explicit, revealed, implied).map(link => link.id));
    const inspection = !focus && (hoveredEdge ?? focusedEdge ?? inspected?.id), emphasized = props.highlightedLinks?.length ? new Set(props.highlightedLinks) : undefined;
    // Past DENSE_PROJECT_LINKS a project's links rest faint; the selection's links stay full strength.
    const perProject = new Map<string, number>(), projectOf = (id: string) => visible.get(id)?.projectId;
    for (const link of explicit.filter(link => !link.reveal && !implied.has(link.id))) {
      const from = projectOf(link.sourceId), to = projectOf(link.targetId);
      if (from) perProject.set(from, (perProject.get(from) ?? 0) + 1);
      if (to && to !== from) perProject.set(to, (perProject.get(to) ?? 0) + 1);
    }
    const resting = (link: GraphLink) => link.kind !== 'blocks' && !selection.has(link.sourceId) && !selection.has(link.targetId)
      && [projectOf(link.sourceId), projectOf(link.targetId)].some(project => project && perProject.get(project)! > DENSE_PROJECT_LINKS);
    return explicit.map(link => ({ id: link.id, source: link.sourceId, target: link.targetId, type: 'direct', selectable: true, focusable: true, interactionWidth: 24, ...(quietOf(link.sourceId) ?? quietOf(link.targetId) ? { zIndex: -2 } : {}), markerEnd: link.kind === 'context' ? { type: MarkerType.ArrowClosed, color: '#98d6ac', width: 22, height: 22 } : undefined, ...(link.kind === 'blocks' ? { data: { stop: true } } : {}), className: `explicit-edge ${link.kind}-edge ${link.kind === 'blocks' && blocking.resolved.get(link.id) ? 'blocks-resolved ' : ''}${shown.has(link.id) ? '' : 'link-concealed '}${emphasized ? emphasized.has(link.id) ? 'connection-active' : 'connection-muted' : inspection ? [link.id, link.sourceId, link.targetId].includes(inspection) ? 'connection-active' : 'connection-muted' : resting(link) ? 'connection-resting' : ''}`, ariaLabel: link.kind === 'blocks' ? `Blocking: ${visible.get(link.sourceId)?.title} blocks ${visible.get(link.targetId)?.title}${blocking.resolved.get(link.id) ? ' (resolved)' : ''}` : `${link.kind === 'context' ? 'Context' : 'Related'}: ${visible.get(link.sourceId)?.title} to ${visible.get(link.targetId)?.title}` }));
  }, [blocking, drawable, implied, hovered, keyboardFocused, hoveredEdge, focusedEdge, focus, inspected?.id, props.highlightedLinks, props.menuFor, selection]);
  const settledAtlas = useRef<{ projects: AtlasProjectEntry[]; items: AtlasItemEntry[] }>(undefined);
  // The Atlas follows committed layout only; drag and resize previews keep the last one.
  const atlas = useMemo(() => {
    if ((drag || itemResize.preview) && settledAtlas.current) return settledAtlas.current;
    const byId = new Map(props.nodes.map(node => [node.id, node]));
    // Undermap fields are near-black at map scale; the Atlas keeps them dark but legible.
    const tint = props.layer === 'below' ? (color: string) => undermapColor(color, .62) : props.neighborhoodColor ?? ((color: string) => color);
    return settledAtlas.current = {
      projects: projects.map(project => ({ ...project, title: byId.get(project.id)?.title ?? '', color: tint(projectColor(byId.get(project.id))), working: rollups.get(project.id)?.working ?? 0, needsMe: rollups.get(project.id)?.needsMe ?? 0, asking: rollups.get(project.id)?.asking ?? 0, turn: rollups.get(project.id)?.turn ?? 0, finished: rollups.get(project.id)?.finished ?? 0, ...(mutedProjects.has(project.id) ? { muted: true } : {}) })),
      items: allBoxes.filter(box => box.item.resourceId).map(box => ({ id: box.item.id, x: box.x, y: box.y, width: box.width, height: box.height, projectId: box.item.projectId, resourceId: box.item.resourceId,
        activity: box.item.activity, completedAt: box.item.completedAt, title: box.item.title, reason: attentionDetails([box.item]).details[0] })),
    };
  }, [projects, allBoxes, rollups, props.nodes, props.neighborhoodColor, props.layer, drag, itemResize.preview, mutedProjects]);
  // Keyed by project ids, not geometry, so a dragged project keeps its board.
  const projectKey = projects.map(project => project.id).join('\n');
  const boards = useMemo(() => {
    if (!dashboards || mirror) return { list: [] as ProjectDashboard[], colors: new Map<string, string>() };
    const pipelineOf = (node: MapItem) => node.resourceId ? presentations.get(node.resourceId)?.overview?.pipeline : undefined;
    const tallyOf = (node: MapItem) => node.resourceId ? presentations.get(node.resourceId)?.overview?.tally : undefined;
    const byId = new Map(props.nodes.map(node => [node.id, node])), tint = props.neighborhoodColor ?? ((color: string) => color);
    return { list: projects.map(project => projectDashboard(project.id, props.nodes, { pipelineOf, tallyOf, paused: props.layer === 'below', todos: props.todos, links: props.links, plots: props.plots, sections: dashboardSetting.sections, counting: props.attentionCounting })),
      colors: new Map(projects.map(project => [project.id, tint(projectColor(byId.get(project.id)))])) };
  }, [dashboards, Boolean(mirror), projectKey, props.nodes, props.links, presentations, props.layer, props.neighborhoodColor, props.todos, props.plots, dashboardSetting.sections, props.attentionCounting]);
  const dashboardIcons = useMemo(() => new Map<string, DashboardIcon>(props.nodes.map(node => {
    const view = node.resourceId ? presentations.get(node.resourceId) : undefined;
    return [node.id, { icon: presentationIcon(view, Boolean(node.completedAt)), brand: view?.brand, tint: view?.appearance.brandTint === true }];
  })), [props.nodes, presentations]);
  const dashboardLayouts = useRef(new Map<string, DashboardLayout>());
  // Screen-space room per frame; the body only re-renders when its layout changes.
  const placedDashboards: ScreenRect[] = [];
  const dashboardViews = boards.list.flatMap(board => {
    const project = projects.find(project => project.id === board.id);
    const area = project && dashboardArea({ x: project.left * viewport.zoom + viewport.x, y: project.top * viewport.zoom + viewport.y, width: (project.right - project.left) * viewport.zoom, height: (project.bottom - project.top) * viewport.zoom }, size, [...dashboardObstacles, ...placedDashboards]);
    if (!area) return [];
    const layout = dashboardLayout(area, board), previous = dashboardLayouts.current.get(board.id), content = previous && sameContent(previous, layout) ? previous : layout;
    dashboardLayouts.current.set(board.id, content);
    const x = Math.max(12, Math.min(size.width - 12 - layout.width, area.x + (area.width - layout.width) / 2)), y = Math.max(12, Math.min(size.height - 12 - layout.height, dashboardSetting.placement === 'top' ? area.y : area.y + (area.height - layout.height) / 2));
    placedDashboards.push({ x, y, width: layout.width, height: layout.height });
    return [{ board, layout, content, color: boards.colors.get(board.id), x: Math.round((x - viewport.x) / viewport.zoom * 100) / 100, y: Math.round((y - viewport.y) / viewport.zoom * 100) / 100 }];
  });
  const dashboardActions = useStableHandlers({
    fly: (id: string, detail = 0) => afterWebClick(id, detail, () => {
      const item = props.nodes.find(node => node.id === id && !isArchived(node, props.nodes));
      if (!item) return;
      clearInspection(); flyTarget.current = id;
      void setCenter(item.position.x, item.position.y, { zoom: FLY_ZOOM, duration: duration() });
    }),
    go: (id: string, detail = 0) => afterWebClick(id, detail, () => {
      const item = props.nodes.find(node => node.id === id && !isArchived(node, props.nodes));
      if (!item) return;
      clearInspection(); flyTarget.current = id;
      void setCenter(item.position.x, item.position.y, { zoom: FLY_ZOOM, duration: duration() }).then(() => open(id));
    }),
    project: (id: string) => open(id), web: (id: string) => props.webOpener?.(id)?.(),
    preview: (id: string) => dashboardPreview(id, props.nodes, props.links, node => {
      const view = node.resourceId ? presentations.get(node.resourceId) : undefined;
      return view && { typeName: view.typeName, ...(view.frameTitle ? { subtitle: view.frameTitle } : {}), ...(view.reference ? { reference: view.reference } : {}) };
    }),
    previewDetail: (id: string, signal: AbortSignal) => props.onPreviewDetail?.(id, signal) ?? Promise.resolve(undefined),
    complete: async (id: string, completed: boolean) => { await props.onTodoComplete?.(id, completed); },
    plot: (id: string) => {
      const plot = props.plots?.find(plot => plot.id === id), shape = plotShapes.find(shape => shape.plot.id === id);
      if (!plot || !shape) return;
      clearInspection(); setSelection(new Set(plot.memberIds));
      void setCenter(shape.center.x, shape.center.y, { zoom: FLY_ZOOM, duration: duration() });
    },
    openTodo: (todo: DashboardTodo) => {
      const target = todo.nodeId ?? (todo.nodeIds.length === 1 ? todo.nodeIds[0] : undefined);
      if (target && props.nodes.some(node => node.id === target && !isArchived(node, props.nodes))) dashboardActions.fly(target); else props.onTodoShow?.(todo.id);
    },
  });
  const locate = (id: string) => {
    const item = props.nodes.find(node => node.id === id && !isArchived(node, props.nodes));
    if (!item) return;
    setFocus(undefined); setClosing(undefined); setMorph(undefined); setHovered(undefined); setHoveredEdge(undefined); setKeyboardFocused(undefined); setFocusedEdge(undefined);
    const point = projects.find(project => project.id === item.id)?.center ?? item.position;
    void setCenter(point.x, point.y, { zoom: item.resourceId ? 1 : .8, duration: duration() });
    // Show on map looks under a muted project's cover for a moment; it never unmutes.
    if (item.resourceId && item.projectId && mutedProjects.has(item.projectId)) mute.locate(item.projectId);
  };
  // The column lists Map projects only; below, Needs me and Working pause, so the corner stays empty.
  const columnShown = cornerShown && props.mapCorner !== 'atlas';
  const now = useNow(columnShown);
  const settledColumn = useRef<{ key: string; model: ProjectColumnModel }>(undefined);
  // Rebuilt from committed state only; an unchanged model keeps its identity so the column skips rendering.
  const column = useMemo(() => {
    if (!columnShown) return undefined;
    const byId = new Map(props.nodes.map(node => [node.id, node])), tint = props.neighborhoodColor ?? ((color: string) => color);
    const pipelineOf = (node: MapItem) => node.resourceId ? presentations.get(node.resourceId)?.overview?.pipeline : undefined;
    const plotOrder = plotMapOrder(props.plots ?? [], props.nodes), filters = props.projectsPanel?.filters, everything = filters?.needsMe === false;
    const kindOf = (id: string) => columnKind(presentations.get(byId.get(id)?.resourceId ?? '')?.pluginId);
    const model = projectColumn(projectKey ? projectKey.split('\n').map(id => {
      const board = projectDashboard(id, props.nodes, { pipelineOf, todos: props.todos, plots: props.plots, counting: props.attentionCounting });
      return { id, title: byId.get(id)?.title ?? '', color: tint(projectColor(byId.get(id))), muted: mutedProjects.has(id), board, summary: props.projectSummaries?.get(id), plotOrder,
        ...(everything ? { items: columnItems(id, props.nodes, board, props.plots ?? [], node => kindOf(node.id)) } : {}) };
    }) : [], now, { filters, kindOf, order: props.projectsPanel?.order, plotOrder: props.projectsPanel?.plotOrder });
    const key = JSON.stringify(model);
    if (settledColumn.current?.key === key) return settledColumn.current.model;
    settledColumn.current = { key, model }; return model;
  }, [columnShown, projectKey, props.nodes, props.todos, props.plots, props.attentionCounting, props.projectSummaries, props.neighborhoodColor, presentations, mutedProjects, now, props.projectsPanel?.filters, props.projectsPanel?.order, props.projectsPanel?.plotOrder]);
  const atlasActions = useStableHandlers({
    fitProject: (id: string) => { const project = projects.find(project => project.id === id); if (focus) back(); if (project) void fitBounds({ x: project.left, y: project.top, width: project.right - project.left, height: project.bottom - project.top }, { padding: .08, duration: duration() }); },
    locate, centre: (point: { x: number; y: number }) => void setCenter(point.x, point.y, { zoom: viewport.zoom, duration: duration() }),
    fitPlot: (id: string) => { if (focus) back(); dashboardActions.plot(id); }, openItem: (id: string) => { if (focus) open(id); else dashboardActions.go(id); }, showNeed: (id: string) => { if (focus) open(id); else locate(id); }, markSeen: (id: string) => props.onMarkSeen?.(id), showTodo: (id: string) => props.onTodoShow?.(id),
    pan: (next: Viewport) => void setViewport(next), travel: (to: 'map' | 'below') => props.onTravel?.(to),
  });
  const open = (id: string, origin: 'user' | 'program' = 'user') => {
    const item = props.nodes.find(node => node.id === id)!;
    if (item.resourceId) props.onOpened?.(id, origin);
    if (item.id === focus) return;
    const box = boxes.find(box => box.item.id === id);
    if (box?.view?.mode === 'inline' || box?.editableTitle || box?.paper !== undefined) {
      // Another expanded item may have obscured this inline item. Never mount its detail.
      setFocus(undefined); setClosing(undefined); setMorph(undefined); clearInspection();
      const edit = (tries = 5) => {
        const target = container.current?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(id)}"] :is([data-inline-title][role="button"],[data-paper-face])`);
        if (target) target.click(); else if (tries) requestAnimationFrame(() => edit(tries - 1));
      };
      if (detail < .35) void setCenter(item.position.x, item.position.y, { zoom: 1, duration: duration() }).then(() => edit()); else edit();
      return;
    }
    if (props.onActivate?.(item)) return;
    if (!item.resourceId) {
      const project = projects.find(project => project.id === id)!;
      setFocus(undefined); setClosing(undefined); setMorph(undefined);
      void setCenter(project.center.x, project.center.y, { zoom: .8, duration: duration() }); return;
    }
    cancelViewGesture(); setClosing(undefined);
    captureBubble(id, closing === id);
    clearInspection();
    setVisited(old => new Set([...old, id]));
    setFocus(id);
  };
  const context = (event: Pick<MouseEvent, 'clientX' | 'clientY' | 'preventDefault'>, nodeId?: string) => {
    event.preventDefault();
    if (focus) { back(); return; }
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const rect = container.current!.getBoundingClientRect();
    // The Loose area is a place, not a project: its plate and ground open the layer's menu.
    if (nodeId === UNDERMAP_LOOSE) nodeId = undefined;
    const selected = props.nodes.find(node => node.id === nodeId);
    const owner = selected ? selected.projectId ?? (!selected.resourceId ? selected.id : undefined) : containingProject(position, projects), projectId = owner === UNDERMAP_LOOSE ? undefined : owner;
    const title = nodeId ? container.current!.querySelector(`[data-item-id="${CSS.escape(nodeId)}"] :is(.card-heading,.project-title-row,.paper-face)`)?.getBoundingClientRect() : undefined;
    props.onContext?.({ screen: { x: event.clientX - rect.left, y: event.clientY - rect.top }, position, projectId, nodeId, nodeIds: nodeId && selection.has(nodeId) && selection.size > 1 ? [...selection] : undefined,
      ...(title ? { avoid: { x: title.left - rect.left, y: title.top - rect.top, width: title.width, height: title.height } } : {}) });
  };
  useEffect(() => {
    if (!props.reveal) return;
    const item = props.nodes.find(node => node.id === props.reveal!.nodeId && !isArchived(node, props.nodes));
    if (!item) return;
    props.onRevealed?.(props.reveal);
    if (props.reveal.mode === 'centred') {
      const point = projects.find(project => project.id === item.id)?.center ?? item.position, origin = props.reveal.origin ?? 'user';
      void setCenter(point.x, point.y, { zoom: viewport.zoom, duration: duration() }).then(() => open(item.id, origin));
      return;
    }
    if (props.reveal.mode !== 'map') { open(item.id, props.reveal.origin ?? 'user'); return; }
    if (props.reveal.select) setSelection(new Set(props.reveal.select));
    locate(item.id);
  }, [props.reveal]);
  const screenPoint = (event: MouseEvent | TouchEvent) => {
    const point = 'touches' in event ? event.touches[0] ?? event.changedTouches[0] : event;
    return { x: point.clientX, y: point.clientY };
  };
  const dragPointer = (event: MouseEvent | TouchEvent) => screenToFlowPosition(screenPoint(event));
  const draggedPosition = (event: MouseEvent | TouchEvent, node: CardNode) => {
    const start = dragStart.current;
    const pointer = dragPointer(event);
    return start?.id === node.id ? { x: start.world.x + pointer.x - start.pointer.x, y: start.world.y + pointer.y - start.pointer.y } : node.position;
  };
  const keyboard = (event: React.KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (focus && target.matches('.item-view-resize-handle') && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (event.key === 'Home') { event.preventDefault(); event.stopPropagation(); resetViewSize(focus); return; }
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        if (viewGesture.current) return;
        const view = itemViews.find(view => view.id === focus)!, step = event.shiftKey ? 40 : 10;
        setViewPositions(old => ({ ...old, [focus]: view.position }));
        setViewSizes(old => ({ ...old, [focus]: clampItemViewSize({
          width: view.data.width + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
          height: view.data.height + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0),
        }, view.profile, size, view.position) })); return;
      }
    }
    if (focus && target.matches('.expanded .card-heading') && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      if (viewGesture.current) return;
      const view = itemViews.find(view => view.id === focus)!, step = event.shiftKey ? 40 : 10;
      setViewPositions(old => ({ ...old, [focus]: clampItemViewPosition({
        x: view.position.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
        y: view.position.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0),
      }, view.data, size) })); return;
    }
    if (target.closest('button,input,textarea,select,.terminal-surface,[contenteditable=true],[data-inline-title]') || event.metaKey || event.ctrlKey || event.altKey) return;
    const edgeId = target.closest('.react-flow__edge')?.getAttribute('data-id');
    if (!focus && edgeId && props.links.some(link => link.id === edgeId) && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
      event.preventDefault(); event.stopPropagation(); const rect = target.getBoundingClientRect(), canvas = container.current!.getBoundingClientRect();
      props.onContext?.({ screen: { x: rect.x + rect.width / 2 - canvas.left, y: rect.y + rect.height / 2 - canvas.top }, position: screenToFlowPosition({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }), linkId: edgeId }); return;
    }
    const id = target.closest('.react-flow__node')?.getAttribute('data-id'), item = props.nodes.find(node => node.id === id);
    if (!item || focus) return;
    if ((event.key === 'Delete' || event.key === 'Backspace') && props.onPaperArchive && boxes.some(box => box.item.id === item.id && box.paper !== undefined)) {
      event.preventDefault(); event.stopPropagation(); setSelection(new Set()); props.onPaperArchive(item.id, false); return;
    }
    if (event.key === 'Enter' && mutedProjects.has(item.id)) { event.preventDefault(); event.stopPropagation(); unmute(item.id); }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); open(item.id); }
    else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault(); event.stopPropagation(); const rect = target.getBoundingClientRect();
      context({ clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2, preventDefault() {} }, item.id);
    } else if (!mirror && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation(); const step = snapStep(event.shiftKey ? 100 : 10, props.snap);
      const position = snapPosition({ x: item.position.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0), y: item.position.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0) }, props.snap);
      if (selection.has(item.id) && selection.size > 1) props.onMoveMany?.(selectionMoves(props.nodes, [...selection], item.id, position)); else props.onMove(item.id, position);
    }
  };
  const startLink = (event: React.PointerEvent, id: string) => {
    if (event.button !== 0 || focus) return; event.preventDefault(); event.stopPropagation();
    const rect = container.current!.getBoundingClientRect(), point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    event.currentTarget.setPointerCapture(event.pointerId); setLinkDrag({ id, from: point, to: point });
  };
  /** The dropped card stays where it was let go until its save lands. Saves run one after another,
   * and the cards stay draggable meanwhile: a press during a save never falls through to the map. */
  const finishMove = (id: string, dropped: { x: number; y: number }, screen: { x: number; y: number }) => {
    const position = snapPosition(props.collisions === 'solid' ? layout.find(node => node.id === id)?.position ?? dropped : dropped, props.snap);
    const held = dragStart.current, base = settling ?? props.nodes, item = base.find(node => node.id === id), saving = saves.current;
    const many = held && held.selected.length > 1 ? selectionMoves(base, held.selected, id, position) : undefined, projectId = !many && item ? dropProject(item, position) : undefined;
    moving.current = false; setDrag({ id, ...position }); saving.pending++;
    const save = async () => {
      if (many) { await props.onMoveMany?.(many); return; }
      if (await props.onItemDrop?.(id, screen)) return;
      await props.onMove(id, position, projectId);
    };
    saving.queue = saving.queue.then(save).finally(() => {
      if (--saving.pending) return;
      setSettling(undefined);
      if (moving.current) return;
      props.onItemDrag?.(undefined); if (dragStart.current === held) dragStart.current = undefined; setDrag(undefined);
    }).catch(error => { console.error(error); });
  };
  /** A drag that starts while a move is saving builds on the map that move leaves. */
  const startMoving = () => { moving.current = true; if (saves.current.pending) setSettling(old => old ?? layout); };
  /** A press on a dashboard stays a click until it travels past the threshold; then it drags the project like its label does. */
  const dashboardDrag = useStableHandlers({
    grab: (event: React.PointerEvent<HTMLElement>, id: string, members?: string[]) => {
      if (event.button !== 0 || event.shiftKey || focus || dropping || itemResize.preview || viewInteracting || dashboardGesture.current) return;
      if (!props.nodes.some(node => node.id === id && !isArchived(node, props.nodes))) return;
      dashboardGesture.current = { id, members, anchor: event.currentTarget, pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, moved: false, cancelled: false };
      window.addEventListener('pointermove', dashboardDrag.move, true); window.addEventListener('pointerup', dashboardDrag.release, true);
      window.addEventListener('pointercancel', dashboardDrag.abort, true); window.addEventListener('blur', dashboardDrag.abort);
    },
    position: (event: PointerEvent) => {
      const start = dragStart.current!, pointer = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      return { x: start.world.x + pointer.x - start.pointer.x, y: start.world.y + pointer.y - start.pointer.y };
    },
    move: (event: PointerEvent) => {
      const held = dashboardGesture.current;
      if (!held || event.pointerId !== held.pointerId || held.cancelled) return;
      if (!held.moved) {
        const item = props.nodes.find(node => node.id === held.id);
        if (!item || Math.hypot(event.clientX - held.start.x, event.clientY - held.start.y) <= DASHBOARD_DRAG_THRESHOLD) return;
        held.moved = true; clearTimeout(webClick.current); clearInspection(); startMoving();
        dragStart.current = { id: held.id, projected: { ...item.position }, world: { ...item.position }, pointer: screenToFlowPosition(held.start), projects, selected: held.members ?? [held.id] };
        if (held.anchor.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
        if (held.anchor.isConnected) held.anchor.setPointerCapture(held.pointerId);
      }
      setDrag({ id: held.id, ...dashboardDrag.position(event) }); if (!held.members) props.onItemDrag?.(held.id, { x: event.clientX, y: event.clientY });
    },
    release: (event: PointerEvent) => {
      const held = dashboardGesture.current;
      if (!held || event.pointerId !== held.pointerId) return;
      dashboardDrag.stop();
      if (!held.moved) return;
      suppressClick.current = true; setTimeout(() => { suppressClick.current = false; });
      if (!held.cancelled) void finishMove(held.id, dashboardDrag.position(event), { x: event.clientX, y: event.clientY });
    },
    cancel: () => {
      const held = dashboardGesture.current;
      if (!held?.moved || held.cancelled) return;
      held.cancelled = true; moving.current = false; dragStart.current = undefined; setDrag(undefined); props.onItemDrag?.(undefined);
    },
    abort: () => { dashboardDrag.cancel(); dashboardDrag.stop(); },
    stop: () => {
      const held = dashboardGesture.current; dashboardGesture.current = undefined;
      window.removeEventListener('pointermove', dashboardDrag.move, true); window.removeEventListener('pointerup', dashboardDrag.release, true);
      window.removeEventListener('pointercancel', dashboardDrag.abort, true); window.removeEventListener('blur', dashboardDrag.abort);
      if (held?.anchor.hasPointerCapture(held.pointerId)) held.anchor.releasePointerCapture(held.pointerId);
    },
  });
  useEffect(() => () => dashboardDrag.stop(), []);
  const [hoveredPlot, setHoveredPlot] = useState<string>(), [renamingPlot, setRenamingPlot] = useState<string>();
  const [plotMenu, setPlotMenu] = useState<{ id: string; screen: { x: number; y: number } }>();
  const plotStats = useMemo(() => {
    const byId = new Map(props.nodes.map(node => [node.id, node]));
    return new Map((props.plots ?? []).map(plot => {
      const members = plot.memberIds.flatMap(id => byId.get(id) ?? []);
      return [plot.id, { tiers: memberAttentionCounts(members), working: members.filter(node => node.activity === 'working').length }];
    }));
  }, [props.plots, props.nodes]);
  const plotOf = (id: string) => props.plots?.find(plot => plot.id === id);
  const plotActions = useStableHandlers({
    hover: (id: string | undefined) => setHoveredPlot(id),
    select: (id: string, add: boolean) => { const plot = plotOf(id); if (plot) setSelection(old => new Set([...add ? old : [], ...plot.memberIds])); },
    grab: (event: React.PointerEvent<HTMLElement>, id: string) => { const plot = plotOf(id); if (plot) dashboardDrag.grab(event, plot.memberIds[0], plot.memberIds); },
    rename: (id: string) => { setPlotMenu(undefined); setRenamingPlot(id); },
    save: (id: string, name: string) => {
      setRenamingPlot(undefined); const plot = plotOf(id), value = name.trim();
      if (plot && value !== plot.name) void props.onPlot?.(plot.projectId, { operation: 'rename', plotId: id, name: value });
    },
    cancel: () => setRenamingPlot(undefined),
    menu: (id: string, client: { x: number; y: number }) => { const rect = container.current!.getBoundingClientRect(); setHoveredPlot(undefined); setPlotMenu({ id, screen: { x: client.x - rect.left, y: client.y - rect.top } }); },
  });
  const plotMenuAct = (action: MenuAction) => {
    const plot = plotMenu && plotOf(plotMenu.id); setPlotMenu(undefined);
    if (!plot) return;
    if (action.id === 'plot-select') plotActions.select(plot.id, false);
    else if (action.id === 'plot-rename') setRenamingPlot(plot.id);
    else if (action.id === 'plot-hide') void props.onPlot?.(plot.projectId, { operation: 'hide', plotId: plot.id, hidden: true });
    else if (action.id === 'plot-auto') void props.onPlot?.(plot.projectId, { operation: 'auto', plotId: plot.id });
    else if (action.id === 'plot-color' && action.value) void props.onPlot?.(plot.projectId, { operation: 'color', plotId: plot.id, color: action.value });
    else if (action.id === 'plot-color-auto') void props.onPlot?.(plot.projectId, { operation: 'color', plotId: plot.id, color: null });
    else if (action.id === 'plot-leave') props.onMoveItems?.(plot.memberIds, null);
    else if (action.id.startsWith('send:') && action.id.length > 'send:'.length) props.onMoveItems?.(plot.memberIds, action.id.slice('send:'.length));
    else if (action.id === 'plot-below') props.onSendBelow?.(plot.memberIds);
  };
  // Plots are named lazily: the service hears which ones were on screen once the camera settles.
  const [settledView, setSettledView] = useState(0), reportedPlots = useRef(new Map<string, number>());
  useEffect(() => {
    if (!props.onPlot || dashboards || focus || !plotShapes.length) return;
    const now = Date.now(), left = -viewport.x / viewport.zoom, top = -viewport.y / viewport.zoom, right = left + size.width / viewport.zoom, bottom = top + size.height / viewport.zoom;
    const byProject = new Map<string, string[]>();
    for (const { plot, bounds } of plotShapes) {
      if (bounds.right < left || bounds.left > right || bounds.bottom < top || bounds.top > bottom || now - (reportedPlots.current.get(plot.id) ?? -Infinity) < 60_000) continue;
      reportedPlots.current.set(plot.id, now); byProject.set(plot.projectId, [...byProject.get(plot.projectId) ?? [], plot.id]);
    }
    for (const [projectId, plotIds] of byProject) for (let at = 0; at < plotIds.length; at += PLOT_SEEN_BATCH) void props.onPlot(projectId, { operation: 'seen', plotIds: plotIds.slice(at, at + PLOT_SEEN_BATCH) });
  }, [plotShapes, settledView, dashboards, focus, size]);
  useEffect(() => {
    if (!plotMenu) return;
    const dismiss = (event: PointerEvent) => { if (!(event.target as HTMLElement).closest('.canvas-context')) setPlotMenu(undefined); };
    document.addEventListener('pointerdown', dismiss, true);
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, [plotMenu]);
  // Hovering a sign dims the other cards; a DOM attribute, so no card re-renders.
  useLayoutEffect(() => {
    const members = hoveredPlot ? new Set(plotOf(hoveredPlot)?.memberIds) : undefined;
    for (const element of container.current?.querySelectorAll<HTMLElement>('.react-flow__node') ?? []) {
      if (members && !members.has(element.dataset.id!) && !element.querySelector('[data-project-label]')) element.dataset.plotDim = 'true'; else delete element.dataset.plotDim;
    }
  }, [hoveredPlot, nodes]);
  const boundsProps = useRef(props); boundsProps.current = props;
  useEffect(() => {
    if (viewInteracting) return;
    const timer = setTimeout(() => {
      boundsProps.current.onViewBounds?.(new Set(boundsProps.current.nodes.map(node => node.id)), viewPositions, viewSizes);
    }, 200);
    return () => clearTimeout(timer);
  }, [viewPositions, viewSizes, viewInteracting]);
  const cancelViewGesture = () => {
    const held = viewGesture.current; viewGesture.current = undefined;
    setViewInteracting(false);
    if (held?.moved) setViewPositions(old => {
      const next = { ...old }; if (held.previous) next[held.id] = held.previous; else delete next[held.id]; return next;
    });
    if (held?.moved && held.mode === 'resize') setViewSizes(old => {
      const next = { ...old }; if (held.previousSize) next[held.id] = held.previousSize; else delete next[held.id]; return next;
    });
    if (held?.capture.hasPointerCapture(held.pointerId)) held.capture.releasePointerCapture(held.pointerId);
  };
  const resetViewSize = (id: string) => {
    cancelViewGesture(); setMorph(undefined);
    setViewSizes(old => { const next = { ...old }; delete next[id]; return next; });
  };
  useEffect(() => {
    const abort = () => cancelViewGesture();
    window.addEventListener('blur', abort); return () => window.removeEventListener('blur', abort);
  }, []);
  const connected = useMemo(() => {
    if (!focus) return [];
    const ids = new Set(props.links.flatMap(link => link.sourceId === focus ? [link.targetId] : link.targetId === focus ? [link.sourceId] : []));
    return boxes.filter(box => ids.has(box.item.id));
  }, [focus, props.links, boxes]);
  const resizeOrigin = (id: string) => {
    const box = boxes.find(box => box.item.id === id)!, resource = props.resources.find(resource => resource.id === box.item.resourceId)!;
    const types = props.registry ?? registry;
    return { id, dimensions: { width: box.width, height: box.height }, position: box.item.position, limits: itemResizeLimits(types.get(resource.pluginId)), zoom: viewport.zoom, detail,
      fit: (mapDimensions: { width: number; height: number }) => itemFootprint({ ...box.item, mapDimensions }, props.resources, types, props.itemMapSizes) };
  };
  const actions = useStableHandlers({ resize: (event: React.PointerEvent, id: string) => { clearInspection(); itemResize.start(event, resizeOrigin(id)); },
    resizeKey: (event: React.KeyboardEvent, id: string) => itemResize.key(event, resizeOrigin(id)), open, back, settled: (id: string) => { setMorph(current => current?.id === id ? undefined : current); setClosing(current => current === id ? undefined : current); }, menu: context, startLink, connect: (event: React.MouseEvent, id: string) => {
    // Anchor to the bubble's right edge at the current semantic zoom.
    const node = nodes.find(node => node.id === id);
    if (node) { props.onConnect?.(id, { x: (node.position.x + node.width! / 2) * viewport.zoom + viewport.x, y: node.position.y * viewport.zoom + viewport.y }); return; }
    const rect = event.currentTarget.getBoundingClientRect(), canvas = container.current!.getBoundingClientRect();
    props.onConnect?.(id, { x: rect.right - canvas.left, y: rect.top - canvas.top });
  }, onRename: (id: string, title: string) => props.onRename!(id, title), reveal: (id: string) => locate(id), unmute,
    paperWrite: (id: string, patch: Record<string, string>, base?: string) => props.onPaperWrite ? props.onPaperWrite(id, patch, base) : Promise.reject(new Error('Notes cannot be edited here.')),
    paperDiscard: (id: string) => props.onPaperArchive?.(id, true), paperOpenUrl: (url: string) => props.onOpenUrl?.(url), select: (id: string) => setSelection(new Set([id])),
    toggleDone: (id: string, done: boolean) => { void props.onComplete?.(id, done).catch(() => {}); }, fitProject: (id: string) => atlasActions.fitProject(id), fitPlot: (id: string) => atlasActions.fitPlot(id),
    middleClick: (id: string) => { props.onOpenWeb?.(id); if (needsMe.has(id)) props.onMarkSeen?.(id); },
    badgeNote: (event: React.MouseEvent, noteId: string, menu: boolean) => {
      event.preventDefault(); event.stopPropagation();
      const rect = container.current!.getBoundingClientRect();
      props.onBadge?.(noteId, { screen: { x: event.clientX - rect.left, y: event.clientY - rect.top }, position: screenToFlowPosition({ x: event.clientX, y: event.clientY }) }, menu);
    } });
  const detailContext = useMemo(() => ({ ...actions, renderDetail: props.renderDetail, markSeen: props.onMarkSeen, keep: props.onKeep, sendBelow: props.onSendBelow }), [actions, props.renderDetail, props.onMarkSeen, props.onKeep, props.onSendBelow]);
  const coverHandlers = useStableHandlers({
    enter: (id: string, event: React.PointerEvent) => { if (!focus && !drag && !linkDrag && !marqueeRef.current) mute.enter(id, event.buttons); },
    leave: (id: string) => mute.leave(id),
    down: (id: string, event: React.PointerEvent) => { coverPress.current = { x: event.clientX, y: event.clientY }; mute.press(id); },
    // Only a plain click on a cover that has already parted unmutes: never a pan, a modified or secondary click, or one that lands before it opened.
    click: (id: string, event: React.MouseEvent) => {
      const start = coverPress.current; coverPress.current = undefined;
      if (event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || focus) return;
      if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > MUTE_PEEK.drag) return;
      if (peek?.id === id && peek.parted) unmute(id);
    },
    menu: (id: string, event: React.MouseEvent) => { event.stopPropagation(); context(event, id); },
  });
  const undermapActions = useStableHandlers({
    color: (id: string) => (props.neighborhoodColor ?? ((color: string) => color))(projectColor(props.nodes.find(node => node.id === id))),
    open: (id: string) => open(id), menu: (event: React.MouseEvent, id: string) => { event.stopPropagation(); context(event, id); },
  });
  const flowHandlers = useStableHandlers({
    onMove: (_event: unknown, view: Viewport) => {
      if (view.zoom !== lastZoom.current) zoomPreview.current ??= hovered;
      else if (!zoomPreview.current) setHovered(undefined);
      lastZoom.current = view.zoom;
      setHoveredEdge(undefined);
    },
    onMoveEnd: (event: unknown, view: Viewport) => { if (!focus || event) props.onViewport?.(view); setSettledView(count => count + 1); },
    onNodeMouseEnter: (_event: React.MouseEvent, node: CardNode) => { if (!focus && !zoomPreview.current) setHovered(node.id); },
    onNodeMouseLeave: () => { if (!zoomPreview.current) setHovered(undefined); if (pointerFocus.current) setKeyboardFocused(undefined); },
    onEdgeMouseEnter: (_event: React.MouseEvent, edge: { id: string }) => { if (!focus) setHoveredEdge(edge.id); },
    onEdgeMouseLeave: () => setHoveredEdge(undefined),
    onEdgeContextMenu: (event: React.MouseEvent, edge: { id: string }) => {
      if (!props.links.some(link => link.id === edge.id)) return;
      event.preventDefault(); event.stopPropagation(); if (focus) { back(); return; }
      const rect = container.current!.getBoundingClientRect();
      props.onContext?.({ screen: { x: event.clientX - rect.left, y: event.clientY - rect.top }, position: screenToFlowPosition({ x: event.clientX, y: event.clientY }), linkId: edge.id });
    },
    onPaneClick: () => setSelection(new Set()),
    onPaneContextMenu: (event: React.MouseEvent | MouseEvent) => context(event),
    onNodeContextMenu: (event: React.MouseEvent, node: CardNode) => context(event, node.id),
    onNodeClick: (event: React.MouseEvent, node: CardNode) => {
      if (event.detail > 1) { clearTimeout(webClick.current); return; }
      if (event.shiftKey) return;
      setSelection(new Set());
      afterWebClick(node.id, event.detail, () => {
        // At far zoom the first click flies to the item; the second click, a double-click or Enter opens it.
        if (!focus && node.data.far && flyTarget.current !== node.id) {
          flyTarget.current = node.id; clearInspection();
          void setCenter(node.data.item.position.x, node.data.item.position.y, { zoom: Math.max(FLY_ZOOM, viewport.zoom), duration: duration() }); return;
        }
        flyTarget.current = undefined; open(node.id);
      });
    },
    onNodeDoubleClick: (event: React.MouseEvent, node: CardNode) => {
      const web = !node.data.viewSurface && !(event.target as Element).closest('[data-inline-title],input,textarea,select,button,[contenteditable]') ? props.webOpener?.(node.id) : undefined;
      if (web) { clearTimeout(webClick.current); flyTarget.current = undefined; web(); return; }
      if (flyTarget.current === node.id) { flyTarget.current = undefined; open(node.id); }
    },
    onNodeDragStart: (event: MouseEvent | TouchEvent, node: CardNode) => { clearTimeout(webClick.current); startMoving(); setDrag({ id: node.id, ...draggedPosition(event, node) }); if ((dragStart.current?.selected.length ?? 0) < 2) props.onItemDrag?.(node.id, screenPoint(event)); },
    onNodeDrag: (event: MouseEvent | TouchEvent, node: CardNode) => { setDrag({ id: node.id, ...draggedPosition(event, node) }); if ((dragStart.current?.selected.length ?? 0) < 2) props.onItemDrag?.(node.id, screenPoint(event)); },
    onNodeDragStop: (event: MouseEvent | TouchEvent, node: CardNode) => finishMove(node.id, draggedPosition(event, node), screenPoint(event)),
  });
  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (focus || (!props.onPasteText && !props.onUrlDrop) || target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),.terminal-host,.xterm')) return;
      if (document.querySelector('.inline-editor,.canvas-menu,[role="dialog"],.session-manager')) return;
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (!text.trim()) return;
      const rect = container.current!.getBoundingClientRect(), pointer = pointerPosition.current;
      const inside = pointer && pointer.x >= rect.left && pointer.x <= rect.right && pointer.y >= rect.top && pointer.y <= rect.bottom;
      const screen = inside ? pointer : { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, position = screenToFlowPosition(screen), projectId = containingProject(position, projects);
      const url = /^https?:\/\/\S+$/.test(text.trim()) ? text.trim() : undefined;
      event.preventDefault();
      if (url) props.onUrlDrop?.({ url, screen: { x: screen.x - rect.left, y: screen.y - rect.top }, position, projectId });
      else props.onPasteText?.({ text, position, projectId });
    };
    window.addEventListener('paste', paste);
    return () => window.removeEventListener('paste', paste);
  });
  const animal = props.workingMark?.animal ?? 'sheep', kits = props.workingMark?.helpers !== 'same';
  const workingAnimal = useMemo(() => ({ animal, kits }), [animal, kits]);
  const nativeDropTarget = (target: EventTarget) => (target as Element).closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),.terminal-host');
  return <DetailContext.Provider value={detailContext}><WorkingAnimalContext.Provider value={workingAnimal}><div ref={container} className="map-area" style={{ '--map-zoom': viewport.zoom, ...workingMarkStyle } as React.CSSProperties} data-layer={props.layer ?? 'map'} data-undermap-layout={props.layer === 'below' ? mirror ? 'mirror' : 'classic' : undefined} data-dashboards={dashboards || undefined} data-todo-drag={props.todoDrag ? true : undefined} onPointerLeave={() => { setHovered(undefined); setHoveredEdge(undefined); }} data-zoom={viewport.zoom} data-level={level} data-resizing={Boolean(itemResize.preview)} data-focus={focus ?? ''} data-overview={overview} data-corner={props.mapCorner ?? 'projects'}
    onDragOver={event => {
      // A to-do row lands on the map even over an item's text; only other drops may belong to a field.
      const todo = !focus && props.onTodoDrop && event.dataTransfer.types.includes('application/x-crafting-todo-map');
      if (!todo && nativeDropTarget(event.target)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = todo ? 'move' : !focus && props.onUrlDrop && mayContainUrl(event.dataTransfer) ? 'copy' : 'none';
      if (!todo || !props.todoDrag || dropping) return;
      const point = screenToFlowPosition({ x: event.clientX, y: event.clientY }), moved = (at?: { x: number; y: number }) => !at || Math.abs(at.x - point.x) + Math.abs(at.y - point.y) >= 1;
      const item = props.todoDrag.nodeId ? props.nodes.find(node => node.id === props.todoDrag!.nodeId && !isArchived(node, props.nodes)) : undefined;
      if (item && !replaced(item)) {
        if (!todoMoving.current) { todoMoving.current = true; dragStart.current = { id: item.id, projected: { ...item.position }, world: { ...item.position }, pointer: point, projects, selected: [item.id] }; }
        if (drag?.id !== item.id || moved(drag)) setDrag({ id: item.id, ...point });
      } else if (moved(todoGhost)) setTodoGhost(point);
    }} onDragLeave={event => { if (!container.current!.contains(event.relatedTarget as globalThis.Node | null) && !dropping) endTodoPreview(); }}
    onDrop={event => {
      if (event.defaultPrevented || (!event.dataTransfer.types.includes('application/x-crafting-todo-map') && nativeDropTarget(event.target))) return;
      event.preventDefault(); event.stopPropagation(); // Never navigate the app for unsupported drops.
      if (focus) return;
      const todoId = event.dataTransfer.getData('application/x-crafting-todo-map');
      if (todoId && props.onTodoDrop) {
        clearInspection();
        const position = screenToFlowPosition({ x: event.clientX, y: event.clientY }), item = todoId.startsWith('map:') ? props.nodes.find(node => `map:${node.id}` === todoId) : undefined;
        // An existing item moves like a map drag: only a drop inside another project transfers it.
        const projectId = item ? itemDropProject(item, position, dragStart.current?.projects ?? projects) : containingProject(position, projects);
        if (todoMoving.current) setDrag({ id: item!.id, ...position });
        setDropping(true);
        void Promise.resolve(props.onTodoDrop({ id: todoId, position, ...(projectId ? { projectId } : {}) })).finally(() => { setDropping(false); endTodoPreview(); });
        return;
      }
      if (!props.onUrlDrop) return;
      const url = droppedUrl(event.dataTransfer); if (!url) return;
      clearInspection();
      const rect = container.current!.getBoundingClientRect(), position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      props.onUrlDrop({ url, screen: { x: event.clientX - rect.left, y: event.clientY - rect.top }, position, projectId: containingProject(position, projects) });
    }} onDoubleClick={event => {
    if (focus || !(event.target as Element).classList.contains('react-flow__pane')) return;
    event.preventDefault(); event.stopPropagation();
    const rect = container.current!.getBoundingClientRect(), position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    props.onCreate?.({ screen: { x: event.clientX - rect.left, y: event.clientY - rect.top }, position, projectId: containingProject(position, projects) });
  }} onKeyDownCapture={event => { setKeyboardFocused((event.target as HTMLElement).closest('.react-flow__node')?.getAttribute('data-id') ?? undefined); setFocusedEdge((event.target as HTMLElement).closest('.react-flow__edge')?.getAttribute('data-id') ?? undefined); if (viewGesture.current && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelViewGesture(); } else if (linkDrag && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setLinkDrag(undefined); } else keyboard(event); }}
    onClickCapture={event => { if (suppressClick.current) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); } }}
    onPointerMove={event => {
      if (marqueeRef.current) {
        event.preventDefault(); event.stopPropagation();
        const rect = container.current!.getBoundingClientRect(), end = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        const box = { ...marqueeRef.current, end }; marqueeRef.current = box; setMarquee(box);
        const left = Math.min(box.start.x, end.x), right = Math.max(box.start.x, end.x), top = Math.min(box.start.y, end.y), bottom = Math.max(box.start.y, end.y);
        setSelection(new Set([...box.base, ...nodes.filter(node => {
          if (node.className === COVERED) return false;
          const x = node.position.x * viewport.zoom + viewport.x, y = node.position.y * viewport.zoom + viewport.y;
          return x + node.width! * viewport.zoom / 2 >= left && x - node.width! * viewport.zoom / 2 <= right && y + node.height! * viewport.zoom / 2 >= top && y - node.height! * viewport.zoom / 2 <= bottom;
        }).map(node => node.id)])); return;
      }
      const held = viewGesture.current;
      if (held?.pointerId === event.pointerId) {
        if (!held.moved && Math.hypot(event.clientX - held.start.x, event.clientY - held.start.y) < 6) return;
        event.preventDefault(); event.stopPropagation();
        held.moved = true; setMorph(undefined); setViewInteracting(true);
        if (held.mode === 'resize') {
          setViewPositions(old => ({ ...old, [held.id]: held.origin }));
          setViewSizes(old => ({ ...old, [held.id]: clampItemViewSize({
            width: held.dimensions.width + event.clientX - held.start.x,
            height: held.dimensions.height + event.clientY - held.start.y,
          }, held.profile, size, held.origin) }));
        } else setViewPositions(old => ({ ...old, [held.id]: clampItemViewPosition({
            x: held.origin.x + event.clientX - held.start.x, y: held.origin.y + event.clientY - held.start.y,
          }, held.dimensions, size) }));
      } else if (linkDrag) { const rect = container.current!.getBoundingClientRect(); setLinkDrag({ ...linkDrag, to: { x: event.clientX - rect.left, y: event.clientY - rect.top } }); }
    }}
    onPointerCancel={() => { marqueeRef.current = undefined; setMarquee(undefined); setLinkDrag(undefined); cancelViewGesture(); }}
    onLostPointerCapture={() => { if (viewGesture.current) cancelViewGesture(); }}
    onPointerUp={event => {
      if (marqueeRef.current) { event.preventDefault(); event.stopPropagation(); marqueeRef.current = undefined; setMarquee(undefined); suppressClick.current = true; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); return; }
      const held = viewGesture.current;
      if (held?.pointerId === event.pointerId) {
        viewGesture.current = undefined; setViewInteracting(false);
        if (held.capture.hasPointerCapture(event.pointerId)) held.capture.releasePointerCapture(event.pointerId);
        if (held.moved) { event.preventDefault(); event.stopPropagation(); suppressClick.current = true; }
        return;
      }
      if (!linkDrag) return; event.preventDefault(); event.stopPropagation();
      const sourceId = linkDrag.id; setLinkDrag(undefined);
      if (Math.hypot(linkDrag.to.x - linkDrag.from.x, linkDrag.to.y - linkDrag.from.y) < 6) return;
      const targetId = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-item-id]')?.getAttribute('data-item-id') ?? undefined;
      if (targetId === sourceId) return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY }), rect = container.current!.getBoundingClientRect();
      props.onLink?.({ sourceId, targetId, position, projectId: containingProject(position, projects), screen: { x: event.clientX - rect.left, y: event.clientY - rect.top } });
    }}
    onFocusCapture={event => { if (pointerFocus.current && !(event.target as Element).matches(':focus-visible')) return; setKeyboardFocused((event.target as HTMLElement).closest('.react-flow__node')?.getAttribute('data-id') ?? undefined); setFocusedEdge((event.target as HTMLElement).closest('.react-flow__edge')?.getAttribute('data-id') ?? undefined); }}
    onBlurCapture={event => { if (pointerFocus.current) { setKeyboardFocused(undefined); setFocusedEdge(undefined); return; } setKeyboardFocused((event.relatedTarget as HTMLElement | null)?.closest?.('.react-flow__node')?.getAttribute('data-id') ?? undefined); setFocusedEdge((event.relatedTarget as HTMLElement | null)?.closest?.('.react-flow__edge')?.getAttribute('data-id') ?? undefined); }}
    onPointerDownCapture={event => {
      if (event.button !== 0 || dropping) return;
      const target = event.target as HTMLElement;
      if (!focus && !document.querySelector(`.inline-editor:not(${OPEN_ALONGSIDE}),[role=dialog]:not(${OPEN_ALONGSIDE})`) && event.shiftKey && !target.closest('input,textarea,select,.terminal-host,.item-view,button,a,[contenteditable=true]')) {
        const id = target.closest('.react-flow__node')?.getAttribute('data-id');
        if (id || target.classList.contains('react-flow__pane')) {
          event.preventDefault(); event.stopPropagation(); suppressClick.current = true;
          if (id) setSelection(old => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; });
          else { const rect = container.current!.getBoundingClientRect(), start = { x: event.clientX - rect.left, y: event.clientY - rect.top }; const box = { start, end: start, base: [] }; marqueeRef.current = box; setMarquee(box); setSelection(new Set()); event.currentTarget.setPointerCapture(event.pointerId); }
          return;
        }
      }
      const sizing = target.closest('.item-view-resize-handle');
      if (focus && (sizing || target.closest('.expanded :is(.card-heading,.item-location)') && !target.closest('button,input,select,textarea,a,label,summary,[role=button],[role=menuitem],[contenteditable]:not([contenteditable=false])'))) {
        event.preventDefault(); event.stopPropagation();
        const view = itemViews.find(view => view.id === focus)!;
        viewGesture.current = { id: focus, mode: sizing ? 'resize' : 'move', capture: (sizing as HTMLElement) || container.current!, pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, moved: false,
          origin: view.position, previous: viewPositions[focus], previousSize: viewSizes[focus], dimensions: view.data, profile: view.profile };
        // Keep keyboard moves available after a grab without a pointer-triggered focus ring.
        ((sizing || target.closest('.expanded')?.querySelector('.card-heading')) as HTMLElement).focus({ preventScroll: true, focusVisible: false } as FocusOptions);
        viewGesture.current.capture.setPointerCapture(event.pointerId); return;
      }
      const id = (event.target as HTMLElement).closest('.react-flow__node')?.getAttribute('data-id');
      const node = nodes.find(node => node.id === id);
      // Capture the actual grab point, before React Flow crosses its drag threshold.
      dragStart.current = node ? { id: node.id, projected: { ...node.position }, world: { ...node.data.item.position }, pointer: screenToFlowPosition({ x: event.clientX, y: event.clientY }), projects, selected: selection.has(node.id) ? [...selection].filter(id => props.nodes.some(item => item.id === id && !isArchived(item, props.nodes))) : [node.id] } : undefined;
    }}>
    <ReactFlow nodes={nodes} nodeTypes={nodeTypes} edgeTypes={edgeTypes} nodeOrigin={nodeOrigin} edges={edges} {...flowHandlers}
      defaultViewport={props.initialViewport ?? { x: 70, y: 80, zoom: .85 }} minZoom={ZOOM_LEVELS.min} maxZoom={ZOOM_LEVELS.max} nodeDragThreshold={CLICK_SLIP} nodeClickDistance={CLICK_SLIP} zoomOnDoubleClick={false} elevateNodesOnSelect={false} proOptions={{ hideAttribution: true }}
      selectionKeyCode={null} multiSelectionKeyCode={null} elementsSelectable={false} nodesConnectable={false} deleteKeyCode={null} onlyRenderVisibleElements={false}
      panOnDrag={!itemResize.preview && !viewInteracting} zoomOnScroll={!itemResize.preview && !viewInteracting} zoomOnPinch={!itemResize.preview && !viewInteracting}>
      <Background color={props.layer === 'below' ? '#4a2426' : '#364c3c'} gap={24} size={1} />
      <ViewportPortal>{grounds.some(ground => ground.biome) && <div className="neighborhood-biomes" data-flat={flatGround || undefined} aria-hidden="true" style={{ opacity: fieldAppearance.brightness / 100 }}>{grounds.map(({ project, biome, items }) => biome && <BiomeGround key={project.id} id={project.id} points={project.points} appearance={fieldAppearance} biome={biome} items={items} flat={flatGround} attaching={attachingTo === project.id || ghostProject === project.id} dragging={Boolean(drag || itemResize.preview || todoGhost)} />)}</div>}
        <svg className="neighborhoods" aria-label="Project neighborhoods" opacity=".24" shapeRendering="crispEdges">{grounds.map(({ project, color, biome }) => <NeighborhoodField key={project.id} id={project.id} points={project.points} appearance={props.neighborhoodAppearance} attaching={attachingTo === project.id || ghostProject === project.id} dragging={Boolean(drag || itemResize.preview || todoGhost)} color={color} biome={biome?.id} />)}
          {!dashboards && plotShapes.map(shape => <g key={shape.plot.id} className="plot-patch" data-plot-patch={shape.plot.id} data-plot-color={plotColor(shape.plot)} style={plotStyle(plotNeighborhoods.get(shape.plot.projectId), plotColor(shape.plot))} data-parts={shape.parts} data-hover={hoveredPlot === shape.plot.id || undefined} aria-hidden="true">{shape.paths.map((path, shade) => <path key={shade} data-shade={shade} d={path} />)}</g>)}</svg>
        {coverShapes.length > 0 && <MuteCovers shapes={coverShapes} appearance={props.neighborhoodAppearance} peek={peek} attaching={attachingTo ?? ghostProject} handlers={coverHandlers} />}
        {!dashboards && plotSigns.length > 0 && <PlotSigns signs={plotSigns} zoom={viewport.zoom} hovered={hoveredPlot} renaming={renamingPlot} stats={plotStats} neighborhoods={plotNeighborhoods} actions={plotActions} />}
        {mirror && !dashboards && <UndermapMonths areas={mirror.areas} toggle={mirror.toggle} />}
        {mirror && dashboards && <UndermapPlates areas={mirror.areas} zoom={viewport.zoom} color={undermapActions.color} open={undermapActions.open} menu={undermapActions.menu} />}
        {dashboardViews.length > 0 && <div className="project-dashboards">{dashboardViews.map(view => <div key={view.board.id} className="project-dashboard-anchor nopan" data-mode={view.layout.mode} data-dragging={drag?.id === view.board.id || undefined} onContextMenu={event => context(event, view.board.id)} onPointerDown={event => dashboardDrag.grab(event, view.board.id)}
          style={{ left: view.x, top: view.y, width: view.layout.width, transform: `scale(${1 / viewport.zoom})`, '--project-color': view.color } as React.CSSProperties}>
          <DashboardBody board={view.board} neighborhood={plotNeighborhoods.get(view.board.id)} layout={view.content} icons={dashboardIcons} badges={props.badges} highlighted={props.highlightedNodes} actions={dashboardActions} />
        </div>)}</div>}
      </ViewportPortal>
    </ReactFlow>
    {!focus && <svg className="map-selection" aria-label={`${selection.size} items selected`}>{nodes.filter(node => selection.has(node.id) && !node.hidden && node.className !== COVERED).map(node => <rect key={node.id} data-selected-id={node.id} x={(node.position.x - node.width! / 2) * viewport.zoom + viewport.x - 4} y={(node.position.y - node.height! / 2) * viewport.zoom + viewport.y - 4} width={node.width! * viewport.zoom + 8} height={node.height! * viewport.zoom + 8} />)}{marquee && <rect className="selection-marquee" x={Math.min(marquee.start.x, marquee.end.x)} y={Math.min(marquee.start.y, marquee.end.y)} width={Math.abs(marquee.start.x - marquee.end.x)} height={Math.abs(marquee.start.y - marquee.end.y)} />}</svg>}
    <svg className="map-item-highlights" aria-hidden="true">{nodes.filter(node => props.highlightedNodes?.includes(node.id) && !node.hidden && node.className !== COVERED).map(node => {
      const x = (node.position.x - node.width! / 2) * viewport.zoom + viewport.x - 6;
      const y = (node.position.y - node.height! / 2) * viewport.zoom + viewport.y - 6;
      const w = node.width! * viewport.zoom + 12, h = node.height! * viewport.zoom + 12, corner = Math.min(14, w / 3, h / 3);
      return <path key={node.id} data-map-highlight={node.id} d={`M${x},${y + corner}v-${corner}h${corner} M${x + w - corner},${y}h${corner}v${corner} M${x + w},${y + h - corner}v${corner}h-${corner} M${x + corner},${y + h}h-${corner}v-${corner}`} />;
    })}</svg>
    {itemViews.map(view => <div key={view.id} className="item-view" data-item-view={view.id} data-returning={view.id !== focus && !view.hidden || undefined} data-dragging={viewInteracting && viewGesture.current?.mode === 'move' && view.id === focus} data-resizing={viewInteracting && viewGesture.current?.mode === 'resize' && view.id === focus} hidden={view.hidden}
      style={{ left: view.position.x, top: view.position.y, width: view.data.width * view.data.scale, height: view.data.height * view.data.scale }}>
      <Card data={view.data} />
      {view.id === focus && !view.data.morph && <button className="item-view-resize-handle" aria-label={`Resize view: ${view.data.item.title}`} title="Drag to resize; arrow keys adjust; double-click or Home resets size"
        onClick={event => { event.preventDefault(); event.stopPropagation(); }} onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); resetViewSize(view.id); }}>
        <svg viewBox="0 0 12 12" aria-hidden="true" shapeRendering="crispEdges"><path fill="currentColor" d="M9 1h2v2H9zM6 4h2v2H6zM9 4h2v2H9zM3 7h2v2H3zM6 7h2v2H6zM9 7h2v2H9z" /></svg>
      </button>}
    </div>)}
    {inspectedConnection && connectionEndpoints?.[0] && connectionEndpoints[1] && <div className="connection-meaning-tip" role="tooltip" style={{ left: Math.max(175, Math.min(size.width - 175, (connectionEndpoints[0].position.x + connectionEndpoints[1].position.x) / 2 * viewport.zoom + viewport.x)), top: Math.max(8, Math.min(size.height - 65, (connectionEndpoints[0].position.y + connectionEndpoints[1].position.y) / 2 * viewport.zoom + viewport.y)) }}>{inspectedConnection.kind === 'blocks' ? `${connectionEndpoints[0].data.item.title} blocks ${connectionEndpoints[1].data.item.title}${blocking.resolved.get(inspectedConnection.id) ? ' · resolved' : ''}` : inspectedConnection.kind === 'context' ? `Provides context to ${connectionEndpoints[1].data.item.title}` : 'Related information'}</div>}
    {attachingTo && drag && <div className="attachment-preview" role="status" style={{ left: drag.x * viewport.zoom + viewport.x + 20, top: drag.y * viewport.zoom + viewport.y + 20 }}>{dragged?.projectId ? 'Move to' : 'Attach to'} {props.nodes.find(node => node.id === attachingTo)?.title}</div>}
    {todoGhost && props.todoDrag && <div className="todo-drop-ghost" aria-hidden="true" style={{ left: (todoGhost.x - ghostSize.width / 2) * viewport.zoom + viewport.x, top: (todoGhost.y - ghostSize.height / 2) * viewport.zoom + viewport.y, width: ghostSize.width * viewport.zoom, height: ghostSize.height * viewport.zoom }}><ItemIcon icon="square-check" /><span>{props.todoDrag.title}</span></div>}
    {todoGhost && props.todoDrag && <div className="attachment-preview" role="status" style={{ left: todoGhost.x * viewport.zoom + viewport.x + 20, top: todoGhost.y * viewport.zoom + viewport.y + ghostSize.height * viewport.zoom / 2 + 8 }}>{ghostProject ? `Add to ${props.nodes.find(node => node.id === ghostProject)?.title}` : 'Place on the map'}</div>}
    {linkDrag && <svg className="connection-preview" aria-label="Connection preview"><path d={`M${linkDrag.from.x},${linkDrag.from.y} L${linkDrag.to.x},${linkDrag.to.y}`} /></svg>}
    {props.mapCorner === 'atlas' ? <Atlas projects={atlas.projects} items={atlas.items} needsMe={needsMe} viewport={viewport} screen={size} layer={props.layer ?? 'map'} highlighted={props.highlightedNodes}
      overview={overview} setOverview={setOverview} undermapCount={props.undermapCount} actions={atlasActions} />
      : column && <ProjectColumn model={column} open={overview} setOpen={setOverview} actions={atlasActions} icons={dashboardIcons} panel={props.projectsPanel} onPanel={props.onProjectsPanel} />}
    {focus && <nav className="map-trail" aria-label="Map location"><span>{place?.project?.title ?? 'Floating item'}</span>{place?.plot && <><span>/</span><span>{place.plot.name}</span></>}<span>/</span><span>{props.nodes.find(node => node.id === focus)?.title}</span>
      {connected.length > 0 && <div className="connected-items" role="group" aria-label="Connected items">{connected.map(box => <button key={box.item.id} aria-label={`Open connected item: ${box.item.title}`} title={box.item.title} onClick={() => open(box.item.id)}><ItemIcon icon={box.icon} brand={box.brand} tint={box.tint} /></button>)}</div>}
    </nav>}
    {plotMenu && <CanvasMenu screen={plotMenu.screen} actions={plotMenuActions(props.plotNaming ?? true, plotOf(plotMenu.id), plotNeighborhoods.get(plotOf(plotMenu.id)?.projectId ?? ''), props.plotTargets && props.onMoveItems && plotOf(plotMenu.id) ? props.plotTargets(plotOf(plotMenu.id)!.memberIds) : undefined)} act={plotMenuAct} close={() => setPlotMenu(undefined)} />}
    <ZoomBar zoom={viewport.zoom} dashboards={dashboardSetting} zoomTo={zoom => void zoomTo(zoom)} />
  </div></WorkingAnimalContext.Provider></DetailContext.Provider>;
}

export function ProjectMap(props: ProjectMapProps) { return <ReactFlowProvider><MapCanvas {...props} /></ReactFlowProvider>; }
