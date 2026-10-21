export interface AppInfo {
  name: string;
  version: string;
  packaged: boolean;
}

export interface DesktopBridge {
  windowFocused(): Promise<boolean>;
  onWindowFocus(listener: (focused: boolean) => void): () => void;
  appInfo(): Promise<AppInfo>;
  /** Whether a screen reader such as VoiceOver is running. */
  assistiveTechnology(): Promise<boolean>;
  onAssistiveTechnology(listener: (enabled: boolean) => void): () => void;
  notifyAnnouncement(input: import('./notifications.ts').DesktopAnnouncement): Promise<boolean>;
  notificationTest(): Promise<{ supported: boolean; error?: string }>;
  notificationStatus(): Promise<{ supported: boolean; error?: string }>;
  takeNotificationTarget(): Promise<import('./notifications.ts').NotificationTarget | null>;
  onNotificationOpen(listener: () => void): () => void;
  /** The install link the app was opened with, once; parsed and checked by the app, never installed from directly. */
  takeInstallLink(): Promise<import('./install-link.ts').InstallLinkRequest | null>;
  onInstallLink(listener: () => void): () => void;
  diagnosticsReport(): Promise<import('../../packages/diagnostics/support-report.ts').SupportReport>;
  /** Appends a bounded renderer failure to the local renderer.log; never uploaded. */
  reportError(entry: { kind: 'uncaught' | 'caught' | 'recoverable'; message: string; stack?: string }): void;
  openLogs(): Promise<void>;
  recordingsList(before?: number): Promise<import('../../packages/session-runtime/protocol.ts').RecordingPage>;
  recordingDelete(sessionId: string, confirmation: 'delete-recording'): Promise<{ session: SessionRecord; cleanupPending: boolean }>;
  onRecordingDeleted(listener: (sessionId: string) => void): () => void;
  onSettings(listener: (snapshot: import('../../packages/core/settings.ts').SettingsSnapshot) => void): () => void;
  settingsRead(): Promise<import('../../packages/core/settings.ts').SettingsSnapshot>;
  settingsWrite(input: { expectedRevision: number; value: import('../../packages/core/settings.ts').AppSettings }): Promise<import('../../packages/core/settings.ts').SettingsSnapshot>;
  openUrl(url: string): Promise<void>;
  setBadgeCount(count: number): Promise<void>;
  /** Puts one http(s) URL on the clipboard, or several, one per line. */
  copyUrl(url: string | string[]): Promise<void>;
  chooseDirectory(): Promise<string | undefined>;
  /** Launch directories, most recent first; only paths that still exist. */
  recentDirectories(): Promise<string[]>;
  workspaceCapabilities(): Promise<{ creationActions: string[]; providers: import('../../packages/core/connections.ts').ProviderDescription[] }>;
  providerAccounts(providerId: string): Promise<import('../../packages/core/connections.ts').ProviderAccount[]>;
  providerStatus(): Promise<import('../../packages/core/connections.ts').ProviderSyncStatus[]>;
  providerRefresh(connectionId?: string): Promise<import('../../packages/core/connections.ts').ProviderSyncStatus[]>;
  /** Applies immediately (not part of the Settings draft); returns the new settings snapshot. */
  providerSelect(providerId: string, account?: string, label?: string): Promise<import('../../packages/core/settings.ts').SettingsSnapshot>;
  recoveryStatus(): Promise<import('../../packages/workspace-service/lifecycle.ts').RecoveryState>;
  githubInbox(refresh?: boolean, opened?: boolean): Promise<{ accounts: import('../../packages/workspace-service/github-inbox.ts').InboxAccount[] }>;
  githubInboxShow(request: { connectionId: string; key: string; position: { x: number; y: number } }): Promise<{ nodeId: string; created: boolean }>;
  githubInboxHide(key: string): Promise<{ hidden: true }>;
  githubInboxSeen(key: string, seen: boolean): Promise<{ seen: boolean }>;
  /** Starts the standup report for a range (STANDUP-01), superseding one still running; poll standupStatus until it is done. */
  standupOpen(request: import('../../packages/core/standup.ts').StandupRequest): Promise<import('../../packages/core/standup.ts').StandupStatus>;
  updatesStatus(): Promise<import('../../packages/core/updates.ts').UpdateStatus>;
  updatesCheck(): Promise<import('../../packages/core/updates.ts').UpdateStatus>;
  standupStatus(): Promise<import('../../packages/core/standup.ts').StandupStatus>;
  attentionHistory(offset?: number, limit?: number): Promise<{ entries: import('../../packages/workspace-service/sqlite-store.ts').AttentionHistoryEntry[]; more: boolean }>;
  /** Saves the whole reminder list in order; each call returns the reminders as the next snapshot carries them. */
  remindersSave(list: import('../../packages/core/reminders.ts').Reminder[]): Promise<import('../../packages/core/reminders.ts').RemindersSnapshot>;
  remindersDone(id: string): Promise<import('../../packages/core/reminders.ts').RemindersSnapshot>;
  remindersSnooze(id: string, minutes: typeof import('../../packages/core/reminders.ts').SNOOZE_MINUTES[number]): Promise<import('../../packages/core/reminders.ts').RemindersSnapshot>;
  /** A reminder came due (also after a snooze), whatever the notification preference. */
  onReminderDue(listener: (event: import('../../packages/core/reminders.ts').ReminderDue) => void): () => void;
  retryRecovery(): Promise<import('../../packages/workspace-service/lifecycle.ts').RecoveryState>;
  resourceOptions(pluginId: string, field: string, values: import('../../src/resource-plugins/types.ts').JsonObject): Promise<import('../../src/resource-plugins/types.ts').ResourceOptions>;
  resourceSessions(pluginId: string, query?: string, offset?: number, options?: { provider?: string; cursor?: string }): Promise<import('../../src/resource-plugins/types.ts').SavedSessionPage>;
  resourceCreate(input: ResourceCreate): Promise<unknown>;
  projectSkills(input: import('zod/v4').infer<typeof import('../../packages/core/skills.ts').skillListSchema>): Promise<import('../../packages/core/skills.ts').ProjectSkillCatalog>;
  runtimeRun(request: RuntimeRequest): Promise<unknown>;
  sessionsList(view?: import('../../packages/session-runtime/protocol.ts').SessionListView): Promise<SessionRecord[]>;
  /** One filtered page of Settings → Sessions plus the counts of every view. */
  sessionsPage(view: import('../../packages/session-runtime/protocol.ts').SessionPageView, offset?: number, limit?: number): Promise<import('../../packages/session-runtime/protocol.ts').SessionPage>;
  sessionManage(sessionId: string, action: import('../../packages/session-runtime/protocol.ts').SessionManagementAction): Promise<SessionRecord>;
  sessionRead(sessionId: string, after?: number, history?: boolean, through?: number, tail?: number): Promise<SessionSnapshot>;
  terminalZoomTarget(id: string | null): void;
  onTerminalZoom(listener: (direction: -1 | 0 | 1) => void): () => void;
  sessionInput(sessionId: string, data: string, encoding?: 'binary'): Promise<void>;
  /** Watch a session so `onSessionActivity` reports its new output or state. */
  sessionAttach(sessionId: string): Promise<void>;
  sessionDetach(sessionId: string): Promise<void>;
  onSessionActivity(listener: (sessionIds: string[]) => void): () => void;
  sessionResize(sessionId: string, cols: number, rows: number): Promise<void>;
  sessionStop(sessionId: string): Promise<SessionRecord>;
  workspaceRead(): Promise<WorkspaceSnapshot>;
  workspaceApply(envelope: CommandEnvelope): Promise<CommandResult>;
  resourceMatchUrl(input: string): Promise<import('../../src/resource-plugins/registry.ts').AttachmentCandidate[]>;
  workspacePlugins(): Promise<ReturnType<WorkspaceControl['registry']['describe']>>;
  viewRead(): Promise<ViewState>;
  viewWrite(view: ViewState): Promise<ViewState>;
  onWorkspace(listener: (snapshot: WorkspaceSnapshot) => void): () => void;
  onConnection(listener: (status: string) => void): () => void;
  /** Bundled and installed plugin packages with their approval, run and failure state. */
  pluginsInstalled(): Promise<import('../../packages/workspace-service/plugin-status.ts').PluginStatuses>;
  /** Window code of the packages the service loaded, and why missing item types are unavailable. */
  pluginsLoaded(): Promise<RendererPlugins>;
  /** Fetches and verifies a git release without running it, for the user to review. */
  pluginsPrepare(url: string, ref?: string): Promise<import('../../packages/workspace-service/plugin-store.ts').PluginCandidate>;
  pluginsPrepareFolder(path: string): Promise<import('../../packages/workspace-service/plugin-store.ts').PluginCandidate>;
  /** Approves exactly the reviewed build. */
  pluginsInstall(id: string, commit: string): Promise<import('../../packages/workspace-service/plugin-status.ts').PluginStatuses>;
  pluginsEnable(id: string, enabled: boolean): Promise<import('../../packages/workspace-service/plugin-status.ts').PluginStatuses>;
  pluginsRollback(id: string, commit: string): Promise<import('../../packages/workspace-service/plugin-status.ts').PluginStatuses>;
  pluginsRemove(id: string): Promise<import('../../packages/workspace-service/plugin-status.ts').PluginStatuses>;
  /** Restarts the workspace service and reloads the window so plugin changes apply. */
  pluginsReload(): Promise<void>;
}

export interface RendererPlugin { id: string; name: string; version: string; commit: string; dev: boolean; itemTypes: string[]; actionTargets: string[]; renderer?: string; css: string[] }
export interface RendererPlugins { plugins: RendererPlugin[]; unavailable: Record<string, string> }

declare global {
  interface Window { craftingTable: DesktopBridge }
}
import type { CommandEnvelope, CommandResult, ViewState } from '../../packages/core/control.ts';
import type { WorkspaceSnapshot } from '../../packages/workspace-service/protocol.ts';
import type { WorkspaceControl } from '../../packages/core/control.ts';
import type { ResourceCreate } from '../../packages/core/resource-creation.ts';
import type { SessionRecord, SessionSnapshot } from '../../packages/session-runtime/protocol.ts';
import type { RuntimeRequest } from '../../packages/core/runtime.ts';
