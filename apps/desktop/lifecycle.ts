import type { App, BrowserWindow, Dialog } from 'electron';
import type { SettingsSnapshot } from '../../packages/core/settings.ts';
import { once } from 'node:events';
import type { WorkspaceConnection } from '../../packages/workspace-service/connection.ts';
import type { SupervisorConnection } from '../../packages/session-runtime/client.ts';
import type { SessionRecord } from '../../packages/session-runtime/protocol.ts';

export type LifecycleElectron = { app: Pick<App, 'on' | 'quit'>; dialog: Pick<Dialog, 'showMessageBox'> };

/** One close path for Cmd+Q, the app menu Quit and application updates. On macOS the
 * window button and Cmd+W only hide the window (`hideWindow`); sessions keep running.
 * `openViewsAgreeToQuit` is asked once the person has confirmed the quit and before anything
 * stops; false keeps the app open. A quit forced after a failed close does not ask. */
export function installLifecycle(workspace: WorkspaceConnection, runtime: SupervisorConnection, hideWindow: ((window: BrowserWindow) => void) | undefined, { app, dialog }: LifecycleElectron, openViewsAgreeToQuit?: () => Promise<boolean>) {
  let allowed = false, pending: Promise<void> | undefined;
  const close = (after?: () => Promise<void> | void) => {
    if (pending || allowed) return;
    pending = (async () => {
      try {
        const preview = await workspace.call<{ sessions: SessionRecord[]; pending: number }>('lifecycle.preview');
        const warn = await workspace.call<SettingsSnapshot>('settings.read').then(settings => settings.value.warnBeforeClosing === true).catch(() => false);
        if (warn && (preview.sessions.length || preview.pending)) {
          const result = await dialog.showMessageBox({ type: 'warning', title: 'Close Agentic Crafting Table?',
            message: 'Closing will stop ongoing sessions.',
            detail: `${preview.sessions.length} active session${preview.sessions.length === 1 ? '' : 's'}${preview.pending ? ' and work that is starting' : ''} will stop. Your table and session history are saved. Agents will resume when you reopen the app. Terminals will reopen in their folders, but running shell commands will not resume.`,
            buttons: ['Stop and close', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true });
          if (result.response !== 0) return;
        }
        // Open views save or ask about unsaved work while the services still run.
        if (openViewsAgreeToQuit && !await openViewsAgreeToQuit().catch(() => true)) return;
        await workspace.call('lifecycle.close');
        // Drain services only after every managed PTY has stopped and the checkpoint is durable.
        const clients = [await workspace.connect(), await runtime.connect()];
        for (const [index, client] of clients.entries()) {
          const disconnected = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }).catch(() => {});
          await client.call('admin.shutdown').catch(() => {});
          if (index === 0) workspace.close(); else runtime.close();
          await disconnected;
        }
        allowed = true; workspace.close(); runtime.close(); await after?.(); app.quit();
      } catch (error) {
        // A crashed service that cannot start again fails every close, so the person must still be able to quit.
        const choice = await dialog.showMessageBox({ type: 'error', message: 'The app could not finish closing.',
          detail: `${(error as Error).message}\n\nQuit anyway closes the app without stopping active sessions. Sessions that still run are picked up when the app opens again.`,
          buttons: ['Keep open', 'Quit anyway'], defaultId: 0, cancelId: 0, noLink: true });
        if (choice.response === 1) {
          // `after` (an update restart) is skipped: it needs both services stopped.
          allowed = true; workspace.close(); runtime.close(); app.quit(); return;
        }
        await workspace.call('lifecycle.recover').catch(() => {});
      }
    })().finally(() => { pending = undefined; });
  };
  app.on('before-quit', event => { if (!allowed) { event.preventDefault(); close(); } });
  return {
    attach(window: BrowserWindow) {
      window.on('close', event => {
        if (allowed) return;
        event.preventDefault();
        if (hideWindow) hideWindow(window); else close();
      });
    },
    /** Quit as Cmd+Q does; `after` runs only once the quit is confirmed and both services have drained. */
    quit(after?: () => Promise<void> | void) { close(after); },
    // Smoke-test cleanup has already explicitly drained both services.
    allowExit() { allowed = true; },
  };
}
