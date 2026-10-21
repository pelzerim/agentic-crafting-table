import * as z from 'zod/v4';
import { DesktopNotifications, announcementSchema } from './notifications.ts';
import type { DesktopAnnouncement, NotificationTarget } from './notifications.ts';
import type { WorkspaceSnapshot } from '../../packages/workspace-service/protocol.ts';
import { isOffMap } from '../../src/graph/archive.ts';
import { browserUrl, clipboardUrls } from './browser-url.ts';
import { pluginDiscoverySchema } from '../../src/resource-plugins/url-input.ts';
import { createKeepAwake } from './keep-awake.ts';
import { ScreenReaderWatch, assistiveTechnologyOverride, voiceOverRunning } from './assistive-technology.ts';
import { NEIGHBORHOOD_STYLE_PARAMETER, neighborhoodStylePin } from './neighborhood-style-pin.ts';
import { settingsWriteSchema } from '../../packages/core/settings.ts';
import { providerAccountsSchema, providerRefreshSchema, providerSelectSchema } from '../../packages/core/connections.ts';
import type { SettingsSnapshot } from '../../packages/core/settings.ts';
import { clockTime, reminderDoneSchema, reminderSaveSchema, reminderSnoozeSchema } from '../../packages/core/reminders.ts';
import type { ReminderDue } from '../../packages/core/reminders.ts';
import { standupRequestSchema } from '../../packages/core/standup.ts';
import { app, BrowserWindow, ipcMain, net, protocol, session, shell, dialog, screen, clipboard, Notification, Menu, MenuItem } from 'electron';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isPluginRequest, pluginRequestSchemas } from '../../packages/core/plugin-requests.ts';
import type { PluginBuild } from '../../packages/workspace-service/plugin-loader.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { WorkspaceConnection } from '../../packages/workspace-service/connection.ts';
import { serializeError } from '../../packages/workspace-service/protocol.ts';
import { envelopeSchema, viewSchema } from '../../packages/core/control.ts';
import { savedSessionsSchema, creationOptionsSchema } from '../../packages/session-runtime/saved-sessions.ts';
import { resourceCreateSchema } from '../../packages/core/resource-creation.ts';
import { runtimeTransportSchema } from '../../packages/core/runtime.ts';
import { skillListSchema } from '../../packages/core/skills.ts';
import { SupervisorConnection } from '../../packages/session-runtime/client.ts';
import { SessionWake } from './session-wake.ts';
import { managedSessionsSchema, sessionPageSchema, manageSessionSchema, inputSchema, readSessionSchema, resizeSchema, sessionIdSchema } from '../../packages/session-runtime/protocol.ts';
import { installLifecycle } from './lifecycle.ts';
import { closeHidesWindow, createWindowPresence } from './window-presence.ts';
import { readWindowState, resolveWindowState, trackWindowState } from './window-state.ts';
import { recordingsSchema, deleteRecordingSchema } from '../../packages/session-runtime/protocol.ts';
import { RotatingLog } from '../../packages/diagnostics/rotating-log.ts';
import { INSTALL_LINK_SCHEME, installLinkArgument, parseInstallLink } from './install-link.ts';
import type { InstallLinkRequest } from './install-link.ts';

protocol.registerSchemesAsPrivileged([{ scheme: 'craft', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const origin = 'craft://app';
app.setName('Agentic Crafting Table');
const testDirectory = process.env.ACT_TEST_DATA_DIR;
// Test windows still render and accept automation input, but never take over the
// user's desktop. The opt-in is useful when watching a failing journey locally.
const backgroundTest = Boolean(testDirectory) && process.env.ACT_TEST_SHOW_WINDOW !== '1';
if (backgroundTest && process.platform === 'darwin') app.setActivationPolicy('accessory');
app.setPath('userData', testDirectory ? resolve(testDirectory) : join(app.getPath('appData'), 'agent-crafting-table'));
const spike = process.argv.includes('--renderer-spike');
const presence = createWindowPresence(backgroundTest);
// Hidden journeys cannot observe native visibility, so they read the tracked presence.
if (testDirectory) (globalThis as { actWindowPresence?: typeof presence }).actWindowPresence = presence;
/** Dock click, second instance, notification click and Window menu show the same window. */
let showWindow: () => Promise<BrowserWindow | undefined> = async () => undefined;
/** The newest install link, parsed, until the window takes it. Links can arrive before the app is ready. */
let installLink: InstallLinkRequest | null = null;
let deliverInstallLink = () => {};
function receiveInstallLink(link: string) {
  try { installLink = parseInstallLink(link); } catch (error) { installLink = { error: (error as Error).message }; }
  deliverInstallLink();
}
// Test and development runs never take over the system's act:// handler; packaged builds also declare it in Info.plist.
if (app.isPackaged && !testDirectory) app.setAsDefaultProtocolClient(INSTALL_LINK_SCHEME);
app.on('open-url', (event, link) => { event.preventDefault(); receiveInstallLink(link); });
const launchLink = installLinkArgument(process.argv);
if (launchLink) receiveInstallLink(launchLink);

function assertCaller(event: Electron.IpcMainInvokeEvent) {
  const url = new URL(event.senderFrame?.url ?? 'about:blank');
  if (event.senderFrame !== event.sender.mainFrame || url.protocol !== 'craft:' || url.host !== 'app') throw new Error('Untrusted caller');
}

async function main() {
  await app.whenReady();
  const root = join(app.getAppPath(), 'dist', 'renderer');
  // Refresh packaged builds too: macOS may retain Electron's cached bundle icon after an update.
  if (!backgroundTest) app.dock?.setIcon(join(app.getAppPath(), 'dist', 'app-icon.png'));
  protocol.handle('craft', async request => {
    const url = new URL(request.url);
    if (url.host === 'app' && url.pathname.startsWith('/plugins/')) return pluginFile(url.pathname);
    const path = resolve(root, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
    if (url.host !== 'app' || !path.startsWith(root + sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(path).href);
  });
  const loadedPlugins = async () => spike ? [] : (await workspace.call<{ plugins: PluginBuild[] }>('plugins.loaded')).plugins;
  /** craft://app/plugins/<id>/<commit>/<file>: only the window entry, stylesheets and dist/ files of a
   * build the service loaded, each checked against its approved sha256 before it is served. */
  const pluginFile = async (pathname: string) => {
    const missing = new Response('Not found', { status: 404 });
    const match = /^\/plugins\/([a-z][a-z0-9.-]{0,99})\/([0-9a-f]{40}|dev)\/(.{1,400})$/.exec(pathname);
    if (!match) return missing;
    const [, id, commit, encoded] = match;
    let file: string;
    try { file = decodeURIComponent(encoded); } catch { return missing; }
    if (!file.split('/').every(part => /^(?!\.\.?$)[A-Za-z0-9._@+-]{1,200}$/.test(part))) return missing;
    const build = (await loadedPlugins().catch(() => [])).find(plugin => plugin.id === id && plugin.commit === commit);
    if (!build || !(file === build.entries.renderer || build.css.includes(file) || file.startsWith('dist/'))) return missing;
    try {
      const base = await realpath(build.root), path = await realpath(join(build.root, file));
      if (!path.startsWith(base + sep)) return missing;
      const body = await readFile(path);
      if (build.integrity && build.integrity[file] !== createHash('sha256').update(body).digest('hex')) return new Response('Plugin file does not match its approved build', { status: 403 });
      const type = ({ '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' } as Record<string, string>)[/\.[a-z0-9]+$/.exec(file)?.[0] ?? ''] ?? 'application/octet-stream';
      return new Response(body, { headers: { 'content-type': type, 'cache-control': 'no-store' } });
    } catch { return missing; }
  };
  // The app's own pages may put text on the clipboard; nothing may read it.
  const clipboardWrite = (permission: string, url: string | undefined) => permission === 'clipboard-sanitized-write' && Boolean(url?.startsWith(origin + '/'));
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(clipboardWrite(permission, details.requestingUrl ?? contents.getURL())));
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => clipboardWrite(permission, `${requestingOrigin}/`));
  ipcMain.handle('app:focused', event => { assertCaller(event); return backgroundTest || Boolean(BrowserWindow.fromWebContents(event.sender)?.isFocused()); });
  ipcMain.handle('app:info', event => {
    assertCaller(event);
    return { name: 'Agentic Crafting Table', version: app.getVersion(), packaged: app.isPackaged };
  });
  ipcMain.handle('app:badge', (event, input: unknown) => {
    assertCaller(event);
    app.setBadgeCount(Number.isInteger(input) ? Math.max(0, Math.min(9999, input as number)) : 0);
  });
  ipcMain.handle('app:open-url', async (event, input: unknown) => {
    assertCaller(event);
    await shell.openExternal(browserUrl(input));
  });
  ipcMain.handle('app:copy-url', async (event, input: unknown) => {
    assertCaller(event);
    await clipboard.writeText(clipboardUrls(input));
  });
  const broadcast = (channel: string, value: unknown) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.webContents.getURL().startsWith(origin + '/')) window.webContents.send(channel, value);
    }
  };
  // Terminals turn on their screen reader support while a screen reader runs.
  const pinnedAssistive = assistiveTechnologyOverride(Boolean(testDirectory), process.env.ACT_TEST_ASSISTIVE_TECH);
  const screenReader = new ScreenReaderWatch(process.platform, () => app.accessibilitySupportEnabled, voiceOverRunning, active => broadcast('app:assistive-technology', active));
  ipcMain.handle('app:assistive-technology', async event => { assertCaller(event); return pinnedAssistive ?? await screenReader.refresh(); });
  if (pinnedAssistive === undefined) {
    app.on('accessibility-support-changed', () => { void screenReader.refresh(); });
    // VoiceOver can start after another client already raised the flag, which fires no change event.
    const recheck = setInterval(() => { if (app.accessibilitySupportEnabled) void screenReader.refresh(); }, 5000);
    app.on('will-quit', () => clearInterval(recheck));
  }
  let notificationError: string | undefined, notificationTarget: NotificationTarget | null = null;
  const nativeNotices = new Map<string, Electron.Notification>();
  const notificationStatus = () => ({ supported: Notification.isSupported(), ...(notificationError ? { error: notificationError } : {}) });
  const showNotification = (notice: DesktopAnnouncement, silent = !notifications.preferences?.sound) => {
    // Ordinary hidden tests never send real OS notifications. The notification
    // journey explicitly substitutes the native delivery methods before opting in.
    if (testDirectory && process.env.ACT_TEST_NOTIFICATIONS !== '1') return;
    if (!Notification.isSupported()) { notificationError = 'Native notifications are unavailable on this system.'; return; }
    try {
      const notification = new Notification({ title: notice.title, body: notice.body, silent });
      nativeNotices.set(notice.key, notification);
      const forget = () => { if (nativeNotices.get(notice.key) === notification) nativeNotices.delete(notice.key); };
      notification.on('failed', () => { notificationError = 'macOS could not deliver the notification. Allow ACT in System Settings → Notifications and use a signed app build. In-app alerts remain available.'; forget(); });
      notification.on('show', () => { notificationError = undefined; });
      notification.on('close', forget);
      notification.on('click', () => {
        void (async () => {
          let target = notice.nodeId;
          if (target) {
            const { state } = await workspace.call<WorkspaceSnapshot>('read');
            const node = state.nodes.find(node => node.id === target);
            if (!node || isOffMap(node, state.nodes)) target = undefined;
          }
          notificationTarget = { ...(target ? { nodeId: target } : {}) };
          await showWindow();
          broadcast('app:notification-open', null);
        })().catch(() => { notificationError = 'Could not open the notification item. Open ACT to reconnect.'; });
      });
      notification.show();
      // Keep callbacks alive for recent notifications without unbounded memory.
      if (nativeNotices.size > 100) { const key = nativeNotices.keys().next().value!; nativeNotices.get(key)?.close(); nativeNotices.delete(key); }
    } catch { notificationError = 'Native notification delivery failed. In-app alerts remain available.'; }
  };
  const notifications = new DesktopNotifications({ show: showNotification, close: key => { nativeNotices.get(key)?.close(); nativeNotices.delete(key); } }, () => Boolean(BrowserWindow.getFocusedWindow()));
  ipcMain.handle('app:announce', (event, input) => { assertCaller(event); return notifications.announcement(announcementSchema.parse(input)); });
  ipcMain.handle('app:notification-status', event => { assertCaller(event); return notificationStatus(); });
  ipcMain.handle('app:notification-test', async event => {
    assertCaller(event); notificationError = undefined;
    notifications.announcement({ key: `test:${randomUUID()}`, title: 'Agentic Crafting Table', body: 'Notifications are connected. Click to return to your table.' }, true);
    await new Promise(resolve => setTimeout(resolve, 700)); return notificationStatus();
  });
  ipcMain.handle('app:notification-target', event => { assertCaller(event); const target = notificationTarget; notificationTarget = null; return target; });
  ipcMain.handle('app:install-link', event => { assertCaller(event); const link = installLink; installLink = null; return link; });
  app.on('will-quit', () => { notifications.dispose(); for (const notice of nativeNotices.values()) notice.close(); nativeNotices.clear(); });
  const keepAwake = createKeepAwake();
  let settingsRevision = -1;
  const applySettings = (snapshot: SettingsSnapshot) => {
    if (snapshot.revision < settingsRevision) return;
    settingsRevision = snapshot.revision; keepAwake.apply(snapshot.value.keepAwake); notifications.preferences = snapshot.value.notifications;
    broadcast('workspace:settings', snapshot);
  };
  app.on('will-quit', () => keepAwake.apply(false));
  const workspace = new WorkspaceConnection(app.getPath('userData'), process.execPath, join(app.getAppPath(), 'dist', 'workspace-service.cjs'), true);
  const rendererErrorSchema = z.object({ kind: z.enum(['uncaught', 'caught', 'recoverable']), message: z.string().max(2000), stack: z.string().max(8000).optional() });
  let rendererLog: RotatingLog | undefined;
  app.on('will-quit', () => rendererLog?.close());
  ipcMain.on('app:renderer-error', (event, input: unknown) => {
    const url = new URL(event.senderFrame?.url ?? 'about:blank');
    if (event.senderFrame !== event.sender.mainFrame || url.protocol !== 'craft:' || url.host !== 'app') return;
    const entry = rendererErrorSchema.safeParse(input); if (!entry.success) return;
    try {
      rendererLog ??= new RotatingLog(join(app.getPath('userData'), 'renderer.log'));
      rendererLog.write(`${new Date().toISOString()} ${entry.data.kind} ${entry.data.message}\n${entry.data.stack ? `${entry.data.stack}\n` : ''}`);
    } catch (error) { console.error('Renderer diagnostics could not be written', (error as Error).message); }
  });
  ipcMain.handle('app:open-logs', async event => {
    assertCaller(event);
    // Hidden test windows never open Finder.
    if (testDirectory) return;
    const failure = await shell.openPath(app.getPath('userData'));
    if (failure) throw new Error(failure);
  });
  ipcMain.handle('app:choose-directory', async event => {
    assertCaller(event);
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, { properties: ['openDirectory'] });
    return result.canceled ? undefined : result.filePaths[0];
  });
  const runtime = new SupervisorConnection({ directory: join(app.getPath('userData'), 'runtime'), executable: process.execPath, entrypoint: join(app.getAppPath(), 'dist', 'session-supervisor.cjs'), electronRuntime: true });
  app.on('will-quit', () => runtime.close());
  const wake = new SessionWake((method, input) => runtime.call(method, input), sessionIds => broadcast('session:activity', sessionIds));
  runtime.onNotification(notification => wake.notify(notification));
  runtime.onConnect(() => { void wake.reconnected().catch(() => {}); });
  // Each renderer's watches end with it, so a closed window never keeps a subscription alive.
  const watches = new WeakMap<Electron.WebContents, Map<string, number>>();
  const watchedBy = (sender: Electron.WebContents) => {
    let counts = watches.get(sender);
    if (!counts) { counts = new Map(); watches.set(sender, counts); sender.once('destroyed', () => { for (const [sessionId, count] of counts!) for (let i = 0; i < count; i++) void wake.detach(sessionId).catch(() => {}); }); }
    return counts;
  };
  const lifecycle = spike ? undefined : installLifecycle(workspace, runtime, closeHidesWindow(process.platform) ? window => presence.hide(window) : undefined);
  ipcMain.handle('session:request', async (event, request) => {
    assertCaller(event);
    try {
      let input: unknown;
      switch (request.method) {
        case 'sessions.list': input = {}; break;
        case 'sessions.read': input = readSessionSchema.parse(request.args); break;
        // Keys from the app's terminal are the person's; the workspace service's own pastes never carry this mark.
        case 'sessions.input': input = { ...inputSchema.parse(request.args), source: 'user' }; break;
        case 'sessions.resize': input = resizeSchema.parse(request.args); break;
        case 'sessions.stop': input = { ...sessionIdSchema.parse(request.args), preservePids: [(await workspace.call<{ pid: number }>('hello')).pid] }; break;
        case 'sessions.attach': { const { sessionId } = sessionIdSchema.parse(request.args), counts = watchedBy(event.sender); await wake.attach(sessionId); counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1); return { result: undefined }; }
        case 'sessions.detach': {
          const { sessionId } = sessionIdSchema.parse(request.args), counts = watchedBy(event.sender), count = counts.get(sessionId) ?? 0;
          if (!count) return { result: undefined };
          if (count > 1) counts.set(sessionId, count - 1); else counts.delete(sessionId);
          await wake.detach(sessionId); return { result: undefined };
        }
        default: throw new Error('Unsupported terminal operation');
      }
      return { result: await runtime.call(request.method, input) };
    } catch (error) { return { error: serializeError(error) }; }
  });
  workspace.on('settings', applySettings);
  workspace.on('recording-deleted', value => broadcast('workspace:recording-deleted', value));
  workspace.on('reminder-due', (value: ReminderDue) => {
    notifications.reminder({ key: `reminder:${value.reminder.id}:${value.day.date}`, title: value.reminder.label, body: clockTime(value.day.dueAt) });
    broadcast('workspace:reminder-due', value);
  });
  const startupId = randomUUID();
  workspace.on('status', value => { if (value === 'connected') void workspace.call<SettingsSnapshot>('settings.read').then(applySettings).catch(() => {}); });
  workspace.on('snapshot', (value: WorkspaceSnapshot) => { notifications.snapshot(value); broadcast('workspace:snapshot', value); });
  workspace.on('status', value => broadcast('workspace:status', value));
  workspace.on('status', value => { if (value === 'connected' && !spike) void workspace.call('lifecycle.recover', { startupId }).catch(error => broadcast('workspace:status', error.message)); });
  app.on('will-quit', () => workspace.close());
  ipcMain.handle('workspace:request', async (event, request) => {
    assertCaller(event);
    try {
      if (spike) throw new Error('The renderer fixture has no workspace service');
      const { method, args } = request;
      // The renderer cannot choose a socket, credential, admin method or actor.
      let result: unknown;
      switch (method) {
        case 'read': case 'settings.read': case 'directories.recent': case 'plugins': case 'capabilities': case 'lifecycle.status': case 'connections.status': case 'diagnostics.report': result = await workspace.call(method); break;
        case 'github.inbox.read': result = await workspace.call(method, z.object({ refresh: z.boolean().default(false), opened: z.boolean().default(false) }).strict().parse(args ?? {})); break;
        case 'github.inbox.show': result = await workspace.call(method, z.object({ connectionId: z.string().min(1).max(200), key: z.string().min(1).max(400), position: z.object({ x: z.number().finite(), y: z.number().finite() }) }).strict().parse(args)); break;
        case 'github.inbox.hide': result = await workspace.call(method, z.object({ key: z.string().min(1).max(400) }).strict().parse(args)); break;
        case 'github.inbox.seen': result = await workspace.call(method, z.object({ key: z.string().min(1).max(400), seen: z.boolean() }).strict().parse(args)); break;
        case 'reminders.save': result = await workspace.call(method, reminderSaveSchema.parse(args)); break;
        case 'reminders.done': result = await workspace.call(method, reminderDoneSchema.parse(args)); break;
        case 'reminders.snooze': result = await workspace.call(method, reminderSnoozeSchema.parse(args)); break;
        case 'standup.open': result = await workspace.call(method, standupRequestSchema.parse(args)); break;
        case 'standup.status': result = await workspace.call(method); break;
        case 'updates.status': result = await workspace.call(method); break;
        case 'updates.check': result = await workspace.call(method); break;
        case 'attention.history': result = await workspace.call(method, z.object({ offset: z.number().int().min(0).max(99).default(0), limit: z.number().int().min(1).max(100).default(10) }).strict().parse(args ?? {})); break;
        case 'plugins.discover': result = await workspace.call(method, pluginDiscoverySchema.parse(args)); break;
        case 'connections.refresh': result = await workspace.call(method, providerRefreshSchema.parse(args)); break;
        case 'connections.accounts': result = await workspace.call(method, providerAccountsSchema.parse(args)); break;
        case 'settings.write': case 'connections.select': {
          const saved = await workspace.call<SettingsSnapshot>(method, method === 'settings.write' ? settingsWriteSchema.parse(args) : providerSelectSchema.parse(args));
          applySettings(saved); result = saved; break;
        }
        case 'lifecycle.retry': result = await workspace.call('lifecycle.recover', { retry: true }); break;
        case 'sessions.managed': result = await workspace.call(method, managedSessionsSchema.parse(args)); break;
        case 'sessions.page': result = await workspace.call(method, sessionPageSchema.parse(args)); break;
        case 'sessions.manage': result = await workspace.call(method, manageSessionSchema.parse(args)); break;
        case 'recordings.list': result = await workspace.call(method, recordingsSchema.parse(args)); break;
        case 'recordings.delete': result = await workspace.call(method, deleteRecordingSchema.parse(args)); break;
        case 'creation.options': result = await workspace.call(method, creationOptionsSchema.parse(args)); break;
        case 'skills.list': result = await workspace.call(method, skillListSchema.parse(args)); break;
        case 'creation.sessions': result = await workspace.call(method, savedSessionsSchema.parse(args)); break;
        case 'item.create': result = await workspace.call(method, resourceCreateSchema.parse(args)); break;
        case 'runtime.run': result = await workspace.call(method, runtimeTransportSchema.parse(args)); break;
        case 'apply': result = await workspace.call(method, { ...envelopeSchema.parse(args), actor: { kind: 'user', id: 'desktop' } }); break;
        case 'view.read': result = await workspace.call(method, { clientId: 'desktop' }); break;
        case 'view.write': result = await workspace.call(method, { clientId: 'desktop', view: viewSchema.parse(args) }); break;
        case 'plugins.installed': result = await workspace.call(method); break;
        case 'plugins.loaded': {
          const loaded = await workspace.call<{ plugins: PluginBuild[]; unavailable: Record<string, string> }>(method), at = (plugin: PluginBuild, file: string) => `${origin}/plugins/${plugin.id}/${plugin.commit}/${file}`;
          result = { unavailable: loaded.unavailable, plugins: loaded.plugins.map(plugin => ({ id: plugin.id, name: plugin.name, version: plugin.version, commit: plugin.commit, dev: plugin.dev,
            itemTypes: plugin.contributes.itemTypes, actionTargets: Object.keys(plugin.contributes.actionContributions),
            ...(plugin.entries.renderer ? { renderer: at(plugin, plugin.entries.renderer) } : {}), css: plugin.css.map(file => at(plugin, file)) })) };
          break;
        }
        default:
          if (!isPluginRequest(method)) throw new Error('Unsupported desktop request');
          result = await workspace.call(method, pluginRequestSchemas[method].parse(args));
      }
      return { result };
    } catch (error) { return { error: serializeError(error) }; }
  });
  if (!spike) void workspace.connect().catch(error => broadcast('workspace:status', error.message));
  /** Installed plugin code is loaded once per process, so applying plugin changes restarts the
   * workspace service (sessions keep running in the supervisor) and reloads the window. */
  ipcMain.handle('app:plugins-reload', async event => {
    assertCaller(event);
    if (spike) return;
    const client = await workspace.connect(), { pid } = await client.call<{ pid: number }>('hello');
    const stopped = once(client, 'disconnected', { signal: AbortSignal.timeout(15_000) });
    await client.call('admin.shutdown'); await stopped;
    // The old service accepts no new work but still owns its socket until it exits.
    for (const deadline = Date.now() + 15_000; Date.now() < deadline;) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await workspace.connect();
    event.sender.reload();
  });
  const zoomTargets = new Map<number, string>();
  ipcMain.on('terminal:zoom-target', (event, id: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || !event.senderFrame?.url.startsWith(origin + '/')) return;
    if (id === null) zoomTargets.delete(event.sender.id);
    else if (typeof id === 'string' && id.length <= 240) zoomTargets.set(event.sender.id, id);
  });
  const openWindow = async () => {
    const placementFile = join(app.getPath('userData'), 'window-state.json');
    const placement = resolveWindowState(readWindowState(placementFile), screen.getAllDisplays(), screen.getPrimaryDisplay().id);
    const window = new BrowserWindow({
      ...placement.state.bounds, minWidth: placement.minWidth, minHeight: placement.minHeight,
      show: !backgroundTest, focusable: !backgroundTest,
      backgroundColor: '#141a17', title: 'Agentic Crafting Table',
      webPreferences: { preload: join(app.getAppPath(), 'dist', 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: !backgroundTest },
    });
    // maximize() reveals a hidden window, so background tests retain normal bounds.
    if (placement.state.maximized && !backgroundTest) window.maximize();
    window.on('focus', () => window.webContents.send('app:focus', true));
    window.on('blur', () => window.webContents.send('app:focus', false));
    trackWindowState(window, placementFile, placement.state, () => screen.getAllDisplays());
    lifecycle?.attach(window);
    window.webContents.on('before-input-event', (event, input) => {
      if (!zoomTargets.has(window.webContents.id) || input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
      const direction = ['+', '=', 'Add'].includes(input.key) ? 1 : ['-', '_', 'Subtract'].includes(input.key) ? -1 : input.key === '0' ? 0 : undefined;
      if (direction !== undefined) { event.preventDefault(); window.webContents.send('terminal:zoom', direction); }
    });
    const contentsId = window.webContents.id;
    window.webContents.on('destroyed', () => zoomTargets.delete(contentsId));
    window.webContents.setWindowOpenHandler(({ url }) => {
      let target: string | undefined;
      try { target = browserUrl(url); } catch { target = undefined; }
      if (target) void shell.openExternal(target).catch(() => {});
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', event => event.preventDefault());
    const query = new URLSearchParams(spike ? { spike: '1' } : {}), pinnedStyle = neighborhoodStylePin(Boolean(testDirectory), process.env.ACT_TEST_NEIGHBORHOOD_STYLE);
    if (pinnedStyle) query.set(NEIGHBORHOOD_STYLE_PARAMETER, pinnedStyle);
    await window.loadURL(`${origin}/index.html${query.size ? `?${query}` : ''}`);
    return window;
  };
  await openWindow();
  showWindow = async () => {
    let window = BrowserWindow.getAllWindows()[0];
    if (!window && !backgroundTest) window = await openWindow();
    if (window) presence.reveal(window);
    return window;
  };
  app.on('activate', () => { void showWindow(); });
  deliverInstallLink = () => { if (installLink) void showWindow().then(() => broadcast('app:install-link-open', null)); };
  deliverInstallLink();
  const windowMenu = Menu.getApplicationMenu()?.items.find(item => item.role?.toLowerCase() === 'windowmenu')?.submenu;
  if (windowMenu) {
    windowMenu.append(new MenuItem({ type: 'separator' }));
    windowMenu.append(new MenuItem({ id: 'show-main-window', label: 'Agentic Crafting Table', click: () => { void showWindow(); } }));
    Menu.setApplicationMenu(Menu.getApplicationMenu());
  }
  const report = process.argv.find(arg => arg.startsWith('--smoke-report='))?.slice('--smoke-report='.length);
  if (report) {
    const child = await promisify(execFile)(process.execPath, [join(app.getAppPath(), 'dist', 'pty-probe.cjs')], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 15_000,
    });
    const probe = JSON.parse(child.stdout);
    const snapshot = await workspace.call('read');
    const savedSessions = await workspace.call('creation.sessions', { pluginId: 'agent.session' });
    const requestId = randomUUID();
    const terminal = await workspace.call<{ session: { id: string; state: string } }>('item.create', {
      requestId, nodeId: randomUUID(), resourceId: randomUUID(), expectedRevision: 0, pluginId: 'terminal.session',
      title: 'Packaged terminal check', position: { x: 0, y: 0 }, data: { cwd: app.getPath('userData') },
    });
    if (terminal.session.state !== 'running') throw new Error('Packaged terminal did not start');
    await runtime.call('sessions.resize', { sessionId: requestId, cols: 76, rows: 29 });
    await runtime.call('sessions.input', { sessionId: requestId, data: "printf 'PACKAGED_TERMINAL_OK\\n'\r" });
    let nativeTerminal: import('../../packages/session-runtime/protocol.ts').SessionSnapshot | undefined;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      nativeTerminal = await runtime.call('sessions.read', { sessionId: requestId });
      if (nativeTerminal!.chunks.map(chunk => chunk.data).join('').includes('PACKAGED_TERMINAL_OK')) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!nativeTerminal?.chunks.some(chunk => chunk.data.includes('PACKAGED_TERMINAL_OK'))) throw new Error('Packaged terminal input failed');
    const window = BrowserWindow.getAllWindows()[0];
    await writeFile(report, JSON.stringify({ packaged: app.isPackaged, versions: process.versions, ...probe, workspace: snapshot, savedSessions,
      window: { bounds: window.getNormalBounds(), visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(), dockVisible: app.dock?.isVisible() },
      nativeTerminal: { state: nativeTerminal.session.state, cols: nativeTerminal.session.cols, rows: nativeTerminal.session.rows } }));
    await workspace.connect(); workspace.close();
    // Explicit smoke cleanup uses the same services without opening a confirmation dialog.
    const { connectWorkspace } = await import('../../packages/workspace-service/client.ts');
    const cleanup = await connectWorkspace(app.getPath('userData'));
    const workspaceStopped = once(cleanup, 'disconnected'); await cleanup.call('admin.shutdown'); await workspaceStopped; cleanup.close();
    const runtimeClient = await runtime.connect(), runtimeStopped = once(runtimeClient, 'disconnected');
    await runtimeClient.call('admin.shutdown'); await runtimeStopped; runtime.close();
    lifecycle?.allowExit(); app.quit();
  }
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
if (app.requestSingleInstanceLock()) {
  app.on('second-instance', (_event, argv = []) => {
    const link = installLinkArgument(argv);
    if (link) receiveInstallLink(link); else void showWindow();
  });
  main().catch(error => { console.error(error); app.exit(1); });
} else app.quit();
