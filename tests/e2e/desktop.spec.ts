import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';

test('desktop loads with an isolated renderer and a narrow working bridge', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-desktop-'));
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow();
    const background = process.env.ACT_TEST_SHOW_WINDOW !== '1';
    if (background) {
      expect(await app.evaluate(({ app, BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        (globalThis as any).testWindowActivation = [];
        window.on('show', () => (globalThis as any).testWindowActivation.push('show'));
        window.on('focus', () => (globalThis as any).testWindowActivation.push('focus'));
        return { visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(),
          throttled: window.webContents.getBackgroundThrottling(),
          dockVisible: app.dock?.isVisible() ?? false };
      })).toEqual({ visible: false, focused: false, focusable: false, throttled: false, dockVisible: false });
      // Dock/second-instance callbacks must not reveal an automated window later.
      await app.evaluate(({ app }) => { app.emit('activate'); app.emit('second-instance'); });
      expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
    }
    await expect(page.getByRole('heading', { name: 'A place for every project.' })).toBeVisible();
    await expect(page.getByText('Double-click anywhere to add an item · right-click for more')).toBeVisible();
    await expect(page.getByText('Desktop connected')).toBeVisible();
    await expect(page.locator('.workspace > header')).toHaveCount(0);
    await expect(page.getByText('Agentic Crafting Table', { exact: true })).toHaveCount(0);
    await expect(page.getByText('My workspace', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Workspace overview' })).toHaveCount(0);
    expect(await page.evaluate(() => typeof (globalThis as any).require)).toBe('undefined');
    expect(await page.evaluate(() => typeof (globalThis as any).process)).toBe('undefined');
    expect(await page.evaluate(() => Object.keys(window.craftingTable))).toEqual(['windowFocused', 'onWindowFocus', 'appInfo', 'assistiveTechnology', 'onAssistiveTechnology', 'notifyAnnouncement', 'notificationTest', 'notificationStatus', 'takeNotificationTarget', 'onNotificationOpen', 'takeInstallLink', 'onInstallLink', 'onSettings', 'settingsRead', 'diagnosticsReport', 'reportError', 'openLogs', 'recordingsList', 'recordingDelete', 'onRecordingDeleted', 'settingsWrite', 'openUrl', 'setBadgeCount', 'copyUrl', 'chooseDirectory', 'recentDirectories', 'workspaceCapabilities', 'providerAccounts', 'providerStatus', 'providerRefresh', 'providerSelect', 'recoveryStatus', 'githubInbox', 'githubInboxShow', 'githubInboxHide', 'githubInboxSeen', 'attentionHistory', 'standupOpen', 'standupStatus', 'updatesStatus', 'updatesCheck', 'remindersSave', 'remindersDone', 'remindersSnooze', 'onReminderDue', 'retryRecovery', 'resourceOptions', 'projectSkills', 'resourceSessions', 'resourceCreate', 'runtimeRun', 'sessionsList', 'sessionsPage', 'sessionManage', 'sessionRead', 'terminalZoomTarget', 'onTerminalZoom', 'sessionInput', 'sessionAttach', 'sessionDetach', 'onSessionActivity', 'sessionResize', 'sessionStop', 'workspaceRead', 'workspaceApply', 'resourceMatchUrl', 'workspacePlugins', 'viewRead', 'viewWrite', 'onWorkspace', 'onConnection', 'pluginsInstalled', 'pluginsLoaded', 'pluginsPrepare', 'pluginsPrepareFolder', 'pluginsInstall', 'pluginsEnable', 'pluginsRollback', 'pluginsRemove', 'pluginsReload']);
    expect(await page.evaluate(() => window.craftingTable.assistiveTechnology())).toBe(process.env.ACT_TEST_ASSISTIVE_TECH === '1');
    expect(await page.evaluate(async () => (await window.craftingTable.workspaceRead()).state.revision)).toBe(0);
    expect(await page.evaluate(async () => {
      try { await window.craftingTable.workspaceApply({ commandId: 'stale', expectedRevision: 99, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'project.create', id: 'rejected', title: 'Stale project', summary: '', position: { x: 0, y: 0 } }] }); }
      catch (error) { return (error as Error & { code?: string }).code; }
    })).toBe('REVISION_CONFLICT');
    // Real keyboard/pointer input remains usable without OS window focus.
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Close settings' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Close settings' })).toHaveCount(0);
    if (background) {
      expect(await app.evaluate(() => (globalThis as any).testWindowActivation)).toEqual([]);
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible() && !window.isFocused()))).toBe(true);
    }
  } finally {
    await app.close();
    const cleanup = await connectWorkspace(directory).catch(() => undefined); if (cleanup) { await cleanup.call('admin.shutdown'); cleanup.close(); }
    await rm(directory, { recursive: true, force: true });
  }
});
