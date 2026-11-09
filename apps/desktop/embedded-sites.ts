/** A site whose pages an item view may show in the app, each in its own persistent session. `signIn` names the popups
 * that open as a small app window in that session, so a sign-in there signs the page in. */
export interface EmbeddedSite { id: string; partition: string; allows(url: string): boolean; signIn?(url: string): boolean }

const httpsHost = (url: string, matches: (host: string) => boolean) => {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  return parsed.protocol === 'https:' && !parsed.port && !parsed.username && !parsed.password && matches(parsed.hostname);
};

/** Adding a site is one entry; a page attaches only on a URL its site allows. */
const claudeHost = (host: string) => host === 'claude.ai' || host.endsWith('.claude.ai');
export const EMBEDDED_SITES: readonly EmbeddedSite[] = [
  {
    id: 'claude', partition: 'persist:claude-artifacts', allows: url => httpsHost(url, claudeHost),
    signIn: url => httpsHost(url, host => host === 'accounts.google.com' || claudeHost(host)),
  },
];

export const embeddedSite = (id: unknown) => EMBEDDED_SITES.find(site => site.id === id);

/** The only preferences a guest gets, whatever the embedder or its `webpreferences` attribute asked for. */
export const GUEST_PREFERENCES = {
  nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, contextIsolation: true, sandbox: true,
  webSecurity: true, webviewTag: false, allowRunningInsecureContent: false, experimentalFeatures: false, enableBlinkFeatures: '', plugins: false,
  // Popups must reach the guest's window-open handler, which opens them in the browser or a sign-in window.
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

/** A page of the site itself may write to the clipboard and nothing else: no camera, microphone, location or
 * notifications. `pageUrl` is the top-level page, so frames the site embeds keep what it delegates to them. */
export const embeddedPermissionAllowed = (site: EmbeddedSite, permission: string, pageUrl: string | undefined) =>
  permission === 'clipboard-sanitized-write' && typeof pageUrl === 'string' && site.allows(pageUrl);

/** A download the browser can fetch again opens there; one the page made itself (blob:, data:) is saved in the app. */
export const embeddedDownload = (url: string): 'browser' | 'save' => {
  try { return /^https?:$/.test(new URL(url).protocol) ? 'browser' : 'save'; } catch { return 'browser'; }
};

/** The user agent without the `Electron/x` and app-name tokens: Google refuses to sign in agents it sees as embedded. */
export const browserUserAgent = (userAgent: string) =>
  userAgent.replace(/ Electron\/\S+/, '').replace(/(\(KHTML, like Gecko\)) .*? (Chrome\/)/, '$1 $2');
