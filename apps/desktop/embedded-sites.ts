/** A site whose pages an item view may show in the app, each in its own persistent session. */
export interface EmbeddedSite { id: string; partition: string; allows(url: string): boolean }

const httpsHost = (url: string, matches: (host: string) => boolean) => {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  return parsed.protocol === 'https:' && !parsed.port && !parsed.username && !parsed.password && matches(parsed.hostname);
};

/** Adding a site is one entry; a page attaches only on a URL its site allows. */
export const EMBEDDED_SITES: readonly EmbeddedSite[] = [
  { id: 'claude', partition: 'persist:claude-artifacts', allows: url => httpsHost(url, host => host === 'claude.ai' || host.endsWith('.claude.ai')) },
];

export const embeddedSite = (id: unknown) => EMBEDDED_SITES.find(site => site.id === id);

/** The only preferences a guest gets, whatever the embedder or its `webpreferences` attribute asked for. */
const GUEST_PREFERENCES = {
  nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, contextIsolation: true, sandbox: true,
  webSecurity: true, webviewTag: false, allowRunningInsecureContent: false, experimentalFeatures: false, enableBlinkFeatures: '', plugins: false,
  // Popups must reach the guest's window-open handler, which denies them and opens the browser.
  disablePopups: false,
};

/** The site a `<webview>` may attach as, its preferences rebuilt from the list above; undefined refuses it.
 * The webview names its site by the site's partition, the one attribute that reaches the main process. */
export function attachEmbeddedPage(preferences: object, params: Record<string, string>): EmbeddedSite | undefined {
  const site = EMBEDDED_SITES.find(candidate => candidate.partition === params.partition);
  if (!site || typeof params.src !== 'string' || !site.allows(params.src)) return undefined;
  const target = preferences as Record<string, unknown>;
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, GUEST_PREFERENCES, { partition: site.partition });
  delete params.preload;
  return site;
}

/** A guest's top-level page may go to any https page, so identity providers can sign in and send it back; the page
 * starts on its site at every attach. Anything else is cancelled, and a browser link opens in the browser. */
export const embeddedNavigation = (url: string, isMainFrame: boolean): 'allow' | 'external' => {
  if (!isMainFrame) return 'allow';
  try { return new URL(url).protocol === 'https:' ? 'allow' : 'external'; } catch { return 'external'; }
};

/** Embedded pages may write to the clipboard and nothing else: no camera, microphone, location or notifications. */
export const embeddedPermissionAllowed = (permission: string) => permission === 'clipboard-sanitized-write';
