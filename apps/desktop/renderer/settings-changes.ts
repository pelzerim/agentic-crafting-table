const pages: Record<string, string> = {
  notifications: 'Notifications', summaries: 'AI features', keepAwake: 'General', warnBeforeClosing: 'General', terminal: 'General', diagnostics: 'Data & diagnostics',
  quickItemTypes: 'Items', defaultWorkingDirectory: 'Items', menus: 'Items', neighborhoodPadding: 'Map', neighborhoodAppearance: 'Map', belowAnimation: 'Map', undermapLayout: 'Map', mapDashboards: 'Map', mapPlots: 'Map', hideImpliedLinks: 'Map', workingMark: 'Map', doubleClickOpensWeb: 'Map', snapToGrid: 'Map', mapCollisions: 'Map',
  pullRequestConversation: 'github.pull-request', claude: 'agent.session:claude', connections: 'Connections',
};
const plain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Where each package's settings are shown, with the defaults its fields declare. */
export type PluginSettingsPages = Readonly<Record<string, { page: string; defaults: Record<string, unknown> }>>;

/** One settings page id per changed leaf value between the saved settings and the draft. */
export function draftChanges(saved: object, draft: object, pluginPages: PluginSettingsPages = {}): string[] {
  const changes: string[] = [];
  const walk = (a: unknown, b: unknown, page: string) => {
    if (plain(a) && plain(b)) for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[key], b[key], page);
    else if (JSON.stringify(a) !== JSON.stringify(b)) changes.push(page);
  };
  for (const key of new Set([...Object.keys(saved), ...Object.keys(draft)])) {
    const a = (saved as Record<string, unknown>)[key], b = (draft as Record<string, unknown>)[key];
    if (key === 'plugins') for (const owner of new Set([...Object.keys(plain(a) ? a : {}), ...Object.keys(plain(b) ? b : {})])) {
      const defaults = pluginPages[owner]?.defaults ?? {}, before = plain(a) && plain(a[owner]) ? a[owner] : {}, after = plain(b) && plain(b[owner]) ? b[owner] : {};
      walk({ ...defaults, ...before }, { ...defaults, ...after }, pluginPages[owner]?.page ?? '');
    }
    else if (key === 'itemViews' || key === 'itemMapSizes') for (const type of new Set([...Object.keys(plain(a) ? a : {}), ...Object.keys(plain(b) ? b : {})])) walk(plain(a) ? a[type] : undefined, plain(b) ? b[type] : undefined, type);
    else walk(a, b, pages[key] ?? '');
  }
  return changes;
}
