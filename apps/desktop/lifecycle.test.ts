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
