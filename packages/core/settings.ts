import { itemMapSizesSchema } from './item-map-sizes.ts';
import { REVIEW_AGENT_IDS } from '../../src/pull-requests/review-agents.ts';
import * as z from 'zod/v4';
import { itemViewsSchema } from './item-views.ts';
import { LARGE_ITEM_WIDTH } from '../../src/graph/footprints.ts';
import { MAP_COLLISIONS } from '../../src/graph/spatial.ts';
import { providerConnectionsSchema } from './connections.ts';
import { DEFAULT_QUICK_ITEMS, MAX_QUICK_ITEMS } from './item-picker.ts';
import { DEFAULT_LOG_POLICY, logPolicySchema } from './log-policy.ts';
import { DEFAULT_NEIGHBORHOOD_APPEARANCE, NEIGHBORHOOD_STYLES, NEIGHBORHOOD_TEXTURES } from '../../src/graph/neighborhood-fill.ts';
import { DASHBOARD_SECTION_KEYS, DASHBOARD_ZOOM_RANGE, DEFAULT_DASHBOARD_SECTIONS, DEFAULT_MAP_DASHBOARDS } from '../../src/graph/project-dashboard.ts';

export const neighborhoodAppearanceSchema = z.object({
  pixelSize: z.number().int().min(8).max(96).default(DEFAULT_NEIGHBORHOOD_APPEARANCE.pixelSize),
  fade: z.number().finite().min(0).max(480).default(DEFAULT_NEIGHBORHOOD_APPEARANCE.fade),
  scatter: z.number().finite().min(0).max(100).default(DEFAULT_NEIGHBORHOOD_APPEARANCE.scatter),
  /** Biome ground and growth for preset colours (BIOME-01), or one plain colour. Settings saved before biomes read the defaults. */
  style: z.enum(NEIGHBORHOOD_STYLES).default(DEFAULT_NEIGHBORHOOD_APPEARANCE.style),
  texture: z.enum(NEIGHBORHOOD_TEXTURES).default(DEFAULT_NEIGHBORHOOD_APPEARANCE.texture),
  brightness: z.number().int().min(10).max(100).default(DEFAULT_NEIGHBORHOOD_APPEARANCE.brightness),
}).default(() => ({ ...DEFAULT_NEIGHBORHOOD_APPEARANCE }));

// Native identity, transport and synchronization flags remain owned by the host.
const managed = new Set(['--model', '--worktree', '--resume', '--continue', '--session-id', '--fork-session', '--mcp-config', '--strict-mcp-config', '--plugin-dir', '--append-system-prompt', '--append-system-prompt-file', '--system-prompt', '--system-prompt-file', '--system-prompt-snapshot', '--settings', '--setting-sources', '--bare', '--print', '--output-format', '--input-format', '--remote-control', '--rc', '--no-remote-control', '--no-session-persistence', '--help', '--version']);
const configurable: Record<string, 'value' | 'optional' | 'switch'> = {
  '--effort': 'value', '--verbose': 'switch', '--debug': 'optional', '--add-dir': 'value',
  '--allowedTools': 'value', '--allowed-tools': 'value', '--disallowedTools': 'value',
  '--disallowed-tools': 'value', '--tools': 'value', '--permission-mode': 'value',
};
export const agentArgumentsSchema = z.array(z.string().min(1).max(4096).refine(value => !/[\0\r\n]/.test(value), 'Arguments cannot contain line breaks')).max(64).superRefine((args, context) => {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i], flag = arg.split('=')[0], mode = configurable[flag], inline = arg.includes('=');
    const fail = (message: string) => context.addIssue({ code: 'custom', path: [i], message });
    if (managed.has(flag)) { fail(`${flag} is managed by the app`); continue; }
    if (!mode) { fail(`Unsupported launch flag ${flag}. Use effort, verbose, debug, add-dir, tools, allowedTools, disallowedTools or permission-mode.`); continue; }
    if (mode === 'switch') { if (inline) fail(`${flag} takes no value`); continue; }
    if (inline) { if (!arg.slice(flag.length + 1)) fail(`${flag} needs a value`); continue; }
    if (args[i + 1] && !args[i + 1].startsWith('-')) i++;
    else if (mode === 'value') fail(`${flag} needs a value on the next line`);
  }
});
export const pullRequestConversationSchema = z.object({
  comments: z.boolean().default(true), threads: z.boolean().default(true),
  reviewBodies: z.boolean().default(true), bots: z.boolean().default(false),
  activity: z.boolean().default(false),
}).default({ comments: true, threads: true, reviewBodies: true, bots: false, activity: false });
export const notificationSettingsSchema = z.object({
  mode: z.enum(['off', 'background', 'always']).default('background'),
  needsMe: z.boolean().default(true), announcements: z.boolean().default(true),
  sound: z.boolean().default(true), dockBadge: z.boolean().default(true),
  /** Finished work (finished turns, approvals) is listed in Needs me but stays out of its number,
   * the Dock badge and macOS banners unless this is on. */
  countFinished: z.boolean().default(false),
  /** Item type ids whose Needs me entry is marked seen when a person opens the item.
   * Ids of types that are not installed are kept and match nothing. */
  seenOnOpen: z.array(z.string().min(1).max(200)).max(500).default([]),
  /** Reminders notify regardless of `mode`; `app` shows only the in-app notice. */
  reminders: z.enum(['sound', 'silent', 'app']).default('sound'),
}).default({ mode: 'background', needsMe: true, announcements: true, sound: true, dockBadge: true, countFinished: false, seenOnOpen: [], reminders: 'sound' });
/** How an item came to be opened: by a person's gesture, or by the app on its own. */
export interface OpenContext { origin: 'user' | 'program'; windowFocused: boolean; documentVisible: boolean }
/** Whether opening an item of this type marks its Needs me entry seen. */
export function seenOnOpen(type: string | undefined, settings: { seenOnOpen: readonly string[] }, context: OpenContext) {
  return type !== undefined && context.origin === 'user' && context.windowFocused && context.documentVisible && settings.seenOnOpen.includes(type);
}
export const DEFAULT_BELOW_ANIMATION = { enabled: true, durationMs: 260 } as const;
/** Sending items below the map and travelling between layers. */
export const belowAnimationSchema = z.object({
  enabled: z.boolean().default(true), durationMs: z.number().int().min(80).max(1500).default(260),
}).default({ ...DEFAULT_BELOW_ANIMATION });
/** How the Undermap is laid out (MAP-18). `mirror` computes every position below from the map; `classic` shows
 * the positions stored when items were sent, which are still written in both modes. */
export const UNDERMAP_LAYOUTS = ['mirror', 'classic'] as const;
export const undermapLayoutSchema = z.enum(UNDERMAP_LAYOUTS).default('mirror');
/** The animal of a card's Working mark (VIS-03), and whether a raccoon's helpers are kits or as big as it. */
export const WORKING_ANIMALS = ['sheep', 'raccoon'] as const;
export const WORKING_HELPERS = ['kits', 'same'] as const;
export const workingMarkSchema = z.object({
  animal: z.enum(WORKING_ANIMALS).default('sheep'), helpers: z.enum(WORKING_HELPERS).default('kits'),
}).default({ animal: 'sheep', helpers: 'kits' });
export type WorkingMarkSettings = z.infer<typeof workingMarkSchema>;
/** Project dashboards replace a neighbourhood's items below this zoom (MAP-23). */
export const mapDashboardsSchema = z.object({
  enabled: z.boolean().default(DEFAULT_MAP_DASHBOARDS.enabled),
  belowZoom: z.number().finite().min(DASHBOARD_ZOOM_RANGE.min).max(DASHBOARD_ZOOM_RANGE.max).default(DEFAULT_MAP_DASHBOARDS.belowZoom),
  placement: z.enum(['center', 'top']).default(DEFAULT_MAP_DASHBOARDS.placement),
  /** Settings saved before sections existed read the defaults, so PR and ticket lines turn off. */
  sections: z.object(Object.fromEntries(DASHBOARD_SECTION_KEYS.map(key => [key, z.boolean().default(DEFAULT_DASHBOARD_SECTIONS[key])])) as Record<typeof DASHBOARD_SECTION_KEYS[number], z.ZodDefault<z.ZodBoolean>>)
    .default(() => ({ ...DEFAULT_DASHBOARD_SECTIONS })),
}).default(() => ({ ...DEFAULT_MAP_DASHBOARDS, sections: { ...DEFAULT_DASHBOARD_SECTIONS } }));
export const TERMINAL_SCROLLBACK_CHOICES = [2000, 5000, 10000, 25000] as const;
export const DEFAULT_TERMINAL_SCROLLBACK = 5000;
/** Terminal views. Screen reader support also turns on while macOS reports assistive technology. */
export const terminalSettingsSchema = z.object({
  screenReader: z.boolean().default(false),
  /** Lines of history each terminal view keeps; the full recording is unaffected. */
  scrollback: z.union(TERMINAL_SCROLLBACK_CHOICES.map(lines => z.literal(lines))).default(DEFAULT_TERMINAL_SCROLLBACK),
}).default({ screenReader: false, scrollback: DEFAULT_TERMINAL_SCROLLBACK });
/** Settings of item packages, keyed by package id; each package declares and validates its own fields. */
export const pluginSettingsSchema = z.record(z.string().max(100).regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/), z.record(z.string().max(100), z.json())).default({});
const menuLists = (max: number) => z.record(z.string().min(1).max(200), z.array(z.string().min(1).max(200)).max(max)).default({});
/** Each item type's context menu as the user arranged it, by item type id (MAP-27). `layout` lists entry ids and
 * `---` separators in order; `hidden` lists the entry ids the menu leaves out. `order` is the shape saved before
 * separators could be placed (entry ids only); it is still read and is replaced by a layout when that type's menu is
 * next changed. An absent type uses the default menu; ids the menu does not have are kept and ignored. */
export const menuSettingsSchema = z.object({ order: menuLists(200), layout: menuLists(400), hidden: menuLists(200) }).default({ order: {}, layout: {}, hidden: {} });
export const settingsSchema = z.object({
  notifications: notificationSettingsSchema,
  connections: providerConnectionsSchema,
  itemViews: itemViewsSchema,
  pullRequestConversation: pullRequestConversationSchema,
  plugins: pluginSettingsSchema,
  itemMapSizes: itemMapSizesSchema,
  menus: menuSettingsSchema,
  keepAwake: z.boolean().default(false),
  warnBeforeClosing: z.boolean().default(false),
  diagnostics: logPolicySchema.default(() => ({ ...DEFAULT_LOG_POLICY })),
  neighborhoodPadding: z.number().finite().nonnegative().default(LARGE_ITEM_WIDTH),
  neighborhoodAppearance: neighborhoodAppearanceSchema,
  belowAnimation: belowAnimationSchema,
  undermapLayout: undermapLayoutSchema,
  terminal: terminalSettingsSchema,
  mapDashboards: mapDashboardsSchema,
  /** Plots in neighbourhoods (MAP-24). */
  mapPlots: z.boolean().default(true),
  /** Draw a link a path of other links of its kind already joins only while revealed (LINK-06). */
  hideImpliedLinks: z.boolean().default(true),
  workingMark: workingMarkSchema,
  doubleClickOpensWeb: z.boolean().default(false),
  /** Item centres land on an invisible 48 px grid when moved or placed (MAP-30). */
  snapToGrid: z.boolean().default(false),
  /** A moved item pushes the items in its way aside, or stops at them (MAP-13). */
  mapCollisions: z.enum(MAP_COLLISIONS).default('shove'),
  /** Item menus end in Delete…, which removes the item for good after a confirmation. */
  itemDelete: z.boolean().default(false),
  /** Pull requests that land on the map while this is on get one direct review from each chosen agent. */
  autoReview: z.object({
    enabled: z.boolean().default(false),
    agents: z.array(z.enum(REVIEW_AGENT_IDS)).max(REVIEW_AGENT_IDS.length).refine(agents => new Set(agents).size === agents.length, 'Each review agent once').default(['claude']),
  }).default({ enabled: false, agents: ['claude'] }),
  /** Absolute folder used for new launches when their project has none; empty means unset. */
  defaultWorkingDirectory: z.string().max(4096).default(''),
  quickItemTypes: z.array(z.string().min(1).max(200)).max(MAX_QUICK_ITEMS).refine(ids => new Set(ids).size === ids.length, 'Choose each type only once').default(DEFAULT_QUICK_ITEMS),
  claude: z.object({ remoteControl: z.boolean().default(true), autoMode: z.boolean().default(true), arguments: agentArgumentsSchema.default([]) }).default({ remoteControl: true, autoMode: true, arguments: [] }),
  summaries: z.object({
    enabled: z.boolean().default(false), model: z.string().trim().min(1).max(100).default('haiku'),
    intervalSeconds: z.number().int().min(30).max(600).default(60),
    requestsPerHour: z.number().int().min(1).max(120).default(12),
    requestsPerDay: z.number().int().min(1).max(1000).default(100),
    agentTitles: z.boolean().default(true),
    /** Plot names from the title helper (MAP-24); off means local names only. */
    plotNames: z.boolean().default(true),
    /** One title for a newly attached Slack message or thread; never regenerated. */
    attachTitles: z.boolean().default(true),
    /** Daily digests of agent conversations and PRs, and the standup report written from them (STANDUP-01). */
    standupDigests: z.boolean().default(true),
    standupRequestsPerReport: z.number().int().min(1).max(500).default(150),
  }).default({ enabled: false, model: 'haiku', intervalSeconds: 60, requestsPerHour: 12, requestsPerDay: 100, agentTitles: true, plotNames: true, attachTitles: true, standupDigests: true, standupRequestsPerReport: 150 }),
  /** A daily look at the app's and installed packs' release tags (UPDATE-01). Nothing is downloaded or installed by it. */
  updates: z.object({ check: z.boolean().default(true) }).default({ check: true }),
});
export const settingsWriteSchema = z.object({ expectedRevision: z.number().int().nonnegative(), value: settingsSchema });
export type AppSettings = z.infer<typeof settingsSchema>;
export interface SettingsSnapshot { revision: number; value: AppSettings }
