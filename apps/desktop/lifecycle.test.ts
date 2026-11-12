import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installLifecycle, type LifecycleElectron } from './lifecycle.ts';
import type { WorkspaceConnection } from '../../packages/workspace-service/connection.ts';
import type { SupervisorConnection } from '../../packages/session-runtime/client.ts';

function fixture(choice: 'Keep open' | 'Quit anyway') {
  const calls: string[] = [], shown: Electron.MessageBoxOptions[] = [];
  const app = Object.assign(new EventEmitter(), { quit() { calls.push('quit'); } });
  const dialog = { async showMessageBox(options: Electron.MessageBoxOptions) { shown.push(options); return { response: options.buttons!.indexOf(choice), checkboxChecked: false }; } };
  // A crashed service that cannot start again fails every call.
  const workspace = {
    async call(method: string) { calls.push(method); throw new Error('Workspace service did not start (exit 1).'); },
    close() { calls.push('workspace.close'); },
  } as unknown as WorkspaceConnection;
  const runtime = { close() { calls.push('runtime.close'); } } as unknown as SupervisorConnection;
  return { calls, shown, app, lifecycle: installLifecycle(workspace, runtime, undefined, { app, dialog } as unknown as LifecycleElectron) };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('a close that fails shows the error and keeps the app open by default', async () => {
  const { calls, shown, lifecycle } = fixture('Keep open');
  let updated = false;
  lifecycle.quit(() => { updated = true; }); await settle();
  assert.equal(shown.length, 1);
  assert.equal(shown[0].message, 'The app could not finish closing.');
  assert.match(String(shown[0].detail), /did not start \(exit 1\)/);
  assert.equal(shown[0].buttons![shown[0].defaultId!], 'Keep open');
  assert.equal(shown[0].buttons![shown[0].cancelId!], 'Keep open');
  assert.ok(calls.includes('lifecycle.recover'));
  assert.ok(!calls.includes('quit')); assert.equal(updated, false);
});

test('a close that fails can still quit, without the update that needs stopped services', async () => {
  const { calls, app, lifecycle } = fixture('Quit anyway');
  let updated = false;
  lifecycle.quit(() => { updated = true; }); await settle();
  assert.deepEqual(calls.slice(-3), ['workspace.close', 'runtime.close', 'quit']);
  assert.ok(!calls.includes('lifecycle.recover'));
  assert.equal(updated, false);
  // The quit that follows is not stopped again.
  let prevented = false;
  app.emit('before-quit', { preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
});

function working({ sessions = 0, warn = false, warningChoice = 'Stop and close', openViewsAgreeToQuit }: { sessions?: number; warn?: boolean; warningChoice?: 'Stop and close' | 'Cancel'; openViewsAgreeToQuit?: (calls: string[]) => Promise<boolean> } = {}) {
  const calls: string[] = [], shown: Electron.MessageBoxOptions[] = [];
  const app = Object.assign(new EventEmitter(), { quit() { calls.push('quit'); } });
  const dialog = { async showMessageBox(options: Electron.MessageBoxOptions) { shown.push(options); return { response: options.buttons!.indexOf(warningChoice), checkboxChecked: false }; } };
  const service = (name: string) => ({
    async call(method: string) {
      calls.push(method);
      if (method === 'lifecycle.preview') return { sessions: Array.from({ length: sessions }, () => ({})), pending: 0 };
      if (method === 'settings.read') return { revision: 1, value: { warnBeforeClosing: warn } };
      return undefined;
    },
    async connect() {
      const client = Object.assign(new EventEmitter(), { async call(method: string) { calls.push(`${name}:${method}`); setImmediate(() => client.emit('disconnected')); } });
      return client;
    },
    close() {},
  });
  const lifecycle = installLifecycle(service('workspace') as unknown as WorkspaceConnection, service('runtime') as unknown as SupervisorConnection, undefined,
    { app, dialog } as unknown as LifecycleElectron, openViewsAgreeToQuit && (() => { calls.push('open views asked'); return openViewsAgreeToQuit(calls); }));
  return { calls, shown, lifecycle };
}
const quits = async (calls: string[]) => { for (let turn = 0; turn < 50 && !calls.includes('quit'); turn++) await settle(); return calls.includes('quit'); };

test('the open views are asked before anything stops, and a view that refuses keeps the app open', async () => {
  const { calls, shown, lifecycle } = working({ openViewsAgreeToQuit: async () => false });
  lifecycle.quit();
  assert.equal(await quits(calls), false);
  assert.ok(calls.includes('open views asked'));
  assert.ok(!calls.includes('lifecycle.close')); assert.equal(shown.length, 0);
  // The next quit asks again.
  lifecycle.quit(); await settle(); await settle();
  assert.equal(calls.filter(call => call === 'open views asked').length, 2);
});

test('open views that agree are asked before the sessions stop, and the app quits', async () => {
  const { calls, lifecycle } = working({ openViewsAgreeToQuit: async () => true });
  lifecycle.quit();
  assert.equal(await quits(calls), true);
  assert.deepEqual(calls.filter(call => call === 'open views asked' || call === 'lifecycle.close'), ['open views asked', 'lifecycle.close']);
  assert.deepEqual(calls.slice(-3), ['workspace:admin.shutdown', 'runtime:admin.shutdown', 'quit']);
});

test('a quit cancelled at the warning about sessions does not ask the open views', async () => {
  const { calls, shown, lifecycle } = working({ sessions: 1, warn: true, warningChoice: 'Cancel', openViewsAgreeToQuit: async () => false });
  lifecycle.quit();
  assert.equal(await quits(calls), false);
  assert.equal(shown.length, 1);
  assert.ok(!calls.includes('open views asked'));
});

test('open views that cannot be asked do not keep the app open', async () => {
  const { calls, shown, lifecycle } = working({ openViewsAgreeToQuit: async () => { throw new Error('The window is gone.'); } });
  lifecycle.quit();
  assert.equal(await quits(calls), true);
  assert.equal(shown.length, 0);
});
