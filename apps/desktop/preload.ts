import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from './bridge.ts';

async function invoke(method: string, args?: unknown) {
  const response = await ipcRenderer.invoke('workspace:request', { method, args });
  // contextBridge drops custom fields on Error objects. Reject with the plain
  // wire record so the renderer can distinguish conflicts from uncertain launches.
  if (response.error) throw response.error;
  return response.result;
}
function listen(channel: string, listener: (value: any) => void) {
  const wrapped = (_event: Electron.IpcRendererEvent, value: unknown) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}
async function sessionCall(method: string, args?: unknown) {
  const response = await ipcRenderer.invoke('session:request', { method, args });
  if (response.error) throw response.error;
  return response.result;
}
const bridge: DesktopBridge = {
  windowFocused: () => ipcRenderer.invoke('app:focused'),
  onWindowFocus: listener => listen('app:focus', listener),
  onColorScheme: listener => listen('app:color-scheme', listener),
  appInfo: () => ipcRenderer.invoke('app:info'),
  assistiveTechnology: () => ipcRenderer.invoke('app:assistive-technology'),
  onAssistiveTechnology: listener => listen('app:assistive-technology', listener),
  notifyAnnouncement: input => ipcRenderer.invoke('app:announce', input),
  notificationTest: () => ipcRenderer.invoke('app:notification-test'),
  notificationStatus: () => ipcRenderer.invoke('app:notification-status'),
  takeNotificationTarget: () => ipcRenderer.invoke('app:notification-target'),
  onNotificationOpen: listener => listen('app:notification-open', listener),
  takeInstallLink: () => ipcRenderer.invoke('app:install-link'),
  onInstallLink: listener => listen('app:install-link-open', listener),
  onSettings: listener => listen('workspace:settings', listener),
  settingsRead: () => invoke('settings.read'),
  diagnosticsReport: () => invoke('diagnostics.report'),
  serviceHealth: () => invoke('diagnostics.health'),
  connectionEvents: () => ipcRenderer.invoke('app:connection-events'),
  reportError: entry => ipcRenderer.send('app:renderer-error', entry),
  openLogs: () => ipcRenderer.invoke('app:open-logs'),
  recordingsList: before => invoke('recordings.list', { before }),
  recordingDelete: (sessionId, confirmation) => invoke('recordings.delete', { sessionId, confirmation }),
  onRecordingDeleted: listener => listen('workspace:recording-deleted', listener),
  settingsWrite: input => invoke('settings.write', input),
  openUrl: url => ipcRenderer.invoke('app:open-url', url),
  setBadgeCount: count => ipcRenderer.invoke('app:badge', count),
  copyUrl: url => ipcRenderer.invoke('app:copy-url', url),
  savePastedImage: bytes => ipcRenderer.invoke('app:save-pasted-image', bytes),
  chooseDirectory: () => ipcRenderer.invoke('app:choose-directory'),
  recentDirectories: () => invoke('directories.recent'),
  workspaceCapabilities: () => invoke('capabilities'),
  providerAccounts: providerId => invoke('connections.accounts', { providerId }),
  providerStatus: () => invoke('connections.status'),
  providerRefresh: connectionId => invoke('connections.refresh', { connectionId }),
  providerSelect: (providerId, account, label) => invoke('connections.select', { providerId, ...(account ? { account } : {}), ...(label ? { label } : {}) }),
  recoveryStatus: () => invoke('lifecycle.status'),
  githubInbox: (refresh = false, opened = false) => invoke('github.inbox.read', { refresh, opened }),
  githubInboxShow: request => invoke('github.inbox.show', request),
  githubInboxHide: key => invoke('github.inbox.hide', { key }),
  githubInboxSeen: (key, seen) => invoke('github.inbox.seen', { key, seen }),
  attentionHistory: (offset = 0, limit = 10) => invoke('attention.history', { offset, limit }),
  standupOpen: request => invoke('standup.open', request),
  standupStatus: () => invoke('standup.status', {}),
  updatesStatus: () => invoke('updates.status'),
  updatesCheck: () => invoke('updates.check'),
  updatesRestart: () => invoke('updates.restart'),
  remindersSave: list => invoke('reminders.save', { list }),
  remindersDone: id => invoke('reminders.done', { id }),
  remindersSnooze: (id, minutes) => invoke('reminders.snooze', { id, minutes }),
  onReminderDue: listener => listen('workspace:reminder-due', listener),
  retryRecovery: () => invoke('lifecycle.retry'),
  resourceOptions: (pluginId, field, values) => invoke('creation.options', { pluginId, field, values }),
  projectSkills: input => invoke('skills.list', input),
  resourceSessions: (pluginId, query, offset, options) => invoke('creation.sessions', { pluginId, query, offset, ...options }),
  resourceCreate: input => invoke('item.create', input),
  runtimeRun: request => invoke('runtime.run', request),
  sessionsList: (view = 'active') => invoke('sessions.managed', { view }),
  sessionsPage: (view, offset = 0, limit = 50) => invoke('sessions.page', { view, offset, limit }),
  sessionManage: (sessionId, action) => invoke('sessions.manage', { sessionId, action }),
  sessionRead: (sessionId, after, history, through, tail) => sessionCall('sessions.read', { sessionId, after, history, through, tail }),
  terminalZoomTarget: id => ipcRenderer.send('terminal:zoom-target', id),
  onTerminalZoom: listener => listen('terminal:zoom', listener),
  sessionInput: (sessionId, data, encoding) => sessionCall('sessions.input', { sessionId, data, ...(encoding ? { encoding } : {}) }),
  sessionAttach: sessionId => sessionCall('sessions.attach', { sessionId }),
  sessionDetach: sessionId => sessionCall('sessions.detach', { sessionId }),
  onSessionActivity: listener => listen('session:activity', listener),
  sessionResize: (sessionId, cols, rows) => sessionCall('sessions.resize', { sessionId, cols, rows }),
  sessionStop: sessionId => sessionCall('sessions.stop', { sessionId }),
  workspaceRead: () => invoke('read'),
  workspaceSubscribe: input => invoke('subscribe', input),
  workspaceApply: envelope => invoke('apply', envelope),
  resourceMatchUrl: async input => (await invoke('plugins.discover', { input })).urlCandidates,
  workspacePlugins: () => invoke('plugins'),
  viewRead: () => invoke('view.read'),
  viewWrite: view => invoke('view.write', view),
  onWorkspace: listener => listen('workspace:snapshot', listener),
  onConnection: listener => listen('workspace:status', listener),
  pluginsInstalled: () => invoke('plugins.installed'),
  pluginsLoaded: () => invoke('plugins.loaded'),
  pluginsPrepare: (url, ref) => invoke('plugins.prepare', { url, ...(ref ? { ref } : {}) }),
  pluginsPrepareFolder: path => invoke('plugins.prepareFolder', { path }),
  pluginsInstall: (id, commit) => invoke('plugins.install', { id, commit }),
  pluginsEnable: (id, enabled) => invoke('plugins.enable', { id, enabled }),
  pluginsRollback: (id, commit) => invoke('plugins.rollback', { id, commit }),
  pluginsRemove: id => invoke('plugins.remove', { id }),
  pluginsReload: () => ipcRenderer.invoke('app:plugins-reload'),
};
contextBridge.exposeInMainWorld('craftingTable', Object.freeze(bridge));
