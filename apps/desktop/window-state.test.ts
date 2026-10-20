import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWindowState, resolveWindowState, trackWindowState } from './window-state.ts';
import type { WindowState } from './window-state.ts';

const displays = [
  { id: 1, workArea: { x: 0, y: 30, width: 1440, height: 840 } },
  { id: 2, workArea: { x: -1920, y: -200, width: 1920, height: 1080 } },
];
const saved: WindowState = { version: 1, bounds: { x: -1700, y: -100, width: 960, height: 650 }, displayId: 2, maximized: false };
class WindowFixture extends EventEmitter {
  bounds = { ...saved.bounds }; minimized = false; maximized = false; fullscreen = false; destroyed = false;
  getNormalBounds() { return { ...this.bounds }; }
  isDestroyed() { return this.destroyed; }
  isMinimized() { return this.minimized; }
  isMaximized() { return this.maximized; }
  isFullScreen() { return this.fullscreen; }
}

test('window placement preserves valid negative coordinates and chooses the display with greatest overlap', () => {
  assert.deepEqual(resolveWindowState(saved, displays, 1).state, saved);
  assert.equal(resolveWindowState({ ...saved, displayId: 1 }, displays, 1).state.displayId, 2);
  const spanning = { ...saved, bounds: { x: -200, y: 100, width: 1100, height: 650 } };
  assert.deepEqual(resolveWindowState(spanning, displays, 1).state.bounds, { x: 0, y: 100, width: 1100, height: 650 });
});

test('missing displays recenter safely, changed work areas clamp bounds and defaults fit small screens', () => {
  assert.deepEqual(resolveWindowState(saved, [displays[0]], 1).state.bounds, { x: 240, y: 125, width: 960, height: 650 });
  const movedDisplay = { id: 2, workArea: { x: 1440, y: 0, width: 1200, height: 800 } };
  assert.deepEqual(resolveWindowState(saved, [displays[0], movedDisplay], 1).state.bounds, { x: 1560, y: 75, width: 960, height: 650 });
  const oversized = { ...saved, bounds: { x: 1200, y: 700, width: 2000, height: 1200 }, maximized: true };
  assert.deepEqual(resolveWindowState(oversized, displays, 1).state, { version: 1, bounds: displays[0].workArea, displayId: 1, maximized: true });
  const small = { id: 3, workArea: { x: 0, y: 24, width: 640, height: 480 } };
  assert.deepEqual(resolveWindowState(undefined, [small], 3), { state: { version: 1, bounds: small.workArea, displayId: 3, maximized: false }, minWidth: 640, minHeight: 480 });
  assert.deepEqual(resolveWindowState(undefined, displays, 1).state.bounds, { x: 80, y: 30, width: 1280, height: 840 });
});

test('missing, corrupt, oversized or invalid preferences fall back without preventing startup', t => {
  const dir = mkdtempSync(join(tmpdir(), 'craft-window-read-')), file = join(dir, 'window-state.json');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(readWindowState(file), undefined);
  for (const content of ['{', 'null', '{}', ' '.repeat(5000), JSON.stringify({ ...saved, version: 2 }),
    JSON.stringify({ ...saved, maximized: 'yes' }), JSON.stringify({ ...saved, bounds: { ...saved.bounds, width: -1 } }),
    JSON.stringify({ ...saved, bounds: { ...saved.bounds, x: null } })]) {
    writeFileSync(file, content); assert.equal(readWindowState(file), undefined);
  }
  writeFileSync(file, JSON.stringify(saved)); assert.deepEqual(readWindowState(file), saved);
});

test('moves/resizes debounce atomic persistence and immediate close flushes the latest geometry', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dir = mkdtempSync(join(tmpdir(), 'craft-window-write-')), file = join(dir, 'window-state.json');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const window = new WindowFixture(); trackWindowState(window, file, saved, () => displays);
  window.bounds.x = -1600; window.emit('move');
  t.mock.timers.tick(200); assert.equal(readWindowState(file), undefined);
  window.bounds.width = 1000; window.emit('resize');
  t.mock.timers.tick(249); assert.equal(readWindowState(file), undefined);
  t.mock.timers.tick(1); assert.deepEqual(readWindowState(file)?.bounds, window.bounds);
  window.bounds.height = 700; window.emit('resize'); window.emit('close');
  assert.deepEqual(readWindowState(file)?.bounds, window.bounds);
  window.destroyed = true; window.emit('closed');
  assert.equal(window.eventNames().length, 0);
  assert.deepEqual(readdirSync(dir), ['window-state.json']);
  t.mock.timers.tick(500); assert.deepEqual(readWindowState(file)?.bounds, window.bounds);
});

test('maximizing, minimizing and full-screen preserve normal geometry and never save a minimized launch', t => {
  const dir = mkdtempSync(join(tmpdir(), 'craft-window-mode-')), file = join(dir, 'window-state.json');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const window = new WindowFixture(), dispose = trackWindowState(window, file, saved, () => displays);
  window.maximized = true; window.emit('maximize'); window.emit('close');
  assert.deepEqual(readWindowState(file), { ...saved, maximized: true });
  window.minimized = true; window.maximized = false; window.emit('minimize'); window.emit('close');
  assert.deepEqual(readWindowState(file), { ...saved, maximized: true });
  window.minimized = false; window.fullscreen = true; window.emit('enter-full-screen'); window.emit('close');
  assert.deepEqual(readWindowState(file), { ...saved, maximized: true });
  window.fullscreen = false; window.emit('leave-full-screen'); dispose();
  assert.deepEqual(readWindowState(file), saved);
});

test('an unwritable preference location never blocks closing and a later retry can save', t => {
  const dir = mkdtempSync(join(tmpdir(), 'craft-window-failure-')), parent = join(dir, 'not-a-directory'), file = join(parent, 'window-state.json');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(parent, 'existing file');
  const warning = t.mock.method(console, 'warn', () => {});
  const window = new WindowFixture(), dispose = trackWindowState(window, file, saved, () => displays);
  assert.doesNotThrow(() => { window.emit('close'); window.emit('close'); });
  assert.equal(warning.mock.callCount(), 1);
  assert.equal(readFileSync(parent, 'utf8'), 'existing file');
  rmSync(parent); dispose(); assert.deepEqual(readWindowState(file), saved);
});
