import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { closeHidesWindow, createWindowPresence } from './window-presence.ts';

class WindowFixture extends EventEmitter {
  calls: string[] = []; minimized = false; fullscreen = false; visible = true;
  isMinimized() { return this.minimized; }
  isFullScreen() { return this.fullscreen; }
  setFullScreen(value: boolean) { this.calls.push(`fullscreen:${value}`); this.fullscreen = value; }
  restore() { this.calls.push('restore'); this.minimized = false; }
  show() { this.calls.push('show'); this.visible = true; }
  focus() { this.calls.push('focus'); }
  hide() { this.calls.push('hide'); this.visible = false; }
}

test('only macOS keeps the app running when its window closes', () => {
  assert.equal(closeHidesWindow('darwin'), true);
  for (const platform of ['linux', 'win32'] as const) assert.equal(closeHidesWindow(platform), false);
});

test('hiding and revealing reuse the same window and restore a minimized one', () => {
  const presence = createWindowPresence(false), window = new WindowFixture();
  presence.hide(window);
  assert.equal(presence.state, 'hidden'); assert.equal(window.visible, false);
  window.minimized = true;
  presence.reveal(window);
  assert.equal(presence.state, 'shown');
  assert.deepEqual(window.calls, ['hide', 'restore', 'show', 'focus']);
});

test('a full-screen window leaves full screen before it hides', () => {
  const presence = createWindowPresence(false), window = new WindowFixture();
  window.fullscreen = true;
  presence.hide(window);
  assert.deepEqual(window.calls, ['fullscreen:false']); assert.equal(window.visible, true);
  window.emit('leave-full-screen');
  assert.deepEqual(window.calls, ['fullscreen:false', 'hide']);
});

test('revealing before full screen finishes leaving cancels the pending hide', () => {
  const presence = createWindowPresence(false), window = new WindowFixture();
  window.fullscreen = true;
  presence.hide(window); presence.reveal(window); window.emit('leave-full-screen');
  assert.equal(window.visible, true); assert.equal(presence.state, 'shown');
});

test('background test windows track presence without showing or focusing', () => {
  const presence = createWindowPresence(true), window = new WindowFixture();
  presence.hide(window); presence.reveal(window);
  assert.equal(presence.state, 'shown'); assert.deepEqual(window.calls, []);
});
