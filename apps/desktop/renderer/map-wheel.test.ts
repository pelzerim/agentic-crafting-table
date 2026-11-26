import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MapWheelGestures, zoomAroundPointer } from './map-wheel.ts';

const wheel = (event: Partial<{ deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean; metaKey: boolean; wheelDeltaY: number; timeStamp: number }>) =>
  ({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, wheelDeltaY: 0, timeStamp: 0, ...event });

test('a pinch zooms', () => {
  assert.equal(new MapWheelGestures().classify(wheel({ ctrlKey: true, deltaY: 3.2, wheelDeltaY: -9.6 })), 'zoom');
});

test('a mouse wheel zooms, in pixel and in line mode', () => {
  const gestures = new MapWheelGestures();
  assert.equal(gestures.classify(wheel({ deltaY: 4, wheelDeltaY: -120, timeStamp: 0 })), 'zoom');
  assert.equal(gestures.classify(wheel({ deltaY: -100, wheelDeltaY: 120, timeStamp: 40 })), 'zoom');
  assert.equal(gestures.classify(wheel({ deltaY: 3, deltaMode: 1, timeStamp: 80 })), 'zoom');
});

test('two fingers on a trackpad pan, sideways or straight', () => {
  const gestures = new MapWheelGestures();
  assert.equal(gestures.classify(wheel({ deltaY: 6, wheelDeltaY: -18, timeStamp: 0 })), 'pan');
  assert.equal(new MapWheelGestures().classify(wheel({ deltaX: 5, deltaY: 0, timeStamp: 0 })), 'pan');
});

test('a trackpad gesture keeps panning when one of its events looks like a mouse notch', () => {
  const gestures = new MapWheelGestures();
  assert.equal(gestures.classify(wheel({ deltaY: 2, wheelDeltaY: -6, timeStamp: 0 })), 'pan');
  assert.equal(gestures.classify(wheel({ deltaY: -40, wheelDeltaY: 120, timeStamp: 16 })), 'pan');
  assert.equal(gestures.classify(wheel({ deltaY: 4, wheelDeltaY: -120, timeStamp: 1000 })), 'zoom');
});

test('a pinch inside a two-finger gesture still zooms', () => {
  const gestures = new MapWheelGestures();
  gestures.classify(wheel({ deltaY: 2, wheelDeltaY: -6, timeStamp: 0 }));
  assert.equal(gestures.classify(wheel({ ctrlKey: true, deltaY: 2, timeStamp: 16 })), 'zoom');
});

test('two fingers on a trackpad with Command held zoom, also inside a panning gesture', () => {
  const gestures = new MapWheelGestures();
  assert.equal(gestures.classify(wheel({ metaKey: true, deltaY: 6, wheelDeltaY: -18, timeStamp: 0 })), 'zoom');
  assert.equal(gestures.classify(wheel({ deltaY: 2, wheelDeltaY: -6, timeStamp: 1000 })), 'pan');
  assert.equal(gestures.classify(wheel({ metaKey: true, deltaY: 2, wheelDeltaY: -6, timeStamp: 1016 })), 'zoom');
});

test('zooming around the pointer keeps the point under it in place', () => {
  const before = { x: 100, y: 50, zoom: 1 };
  const after = zoomAroundPointer(before, { x: 300, y: 250 }, { deltaY: -100, deltaMode: 0 }, { min: .2, max: 1.35 });
  assert.ok(after.zoom > 1);
  const flowX = (300 - before.x) / before.zoom, flowY = (250 - before.y) / before.zoom;
  assert.ok(Math.abs(after.x + flowX * after.zoom - 300) < 1e-9);
  assert.ok(Math.abs(after.y + flowY * after.zoom - 250) < 1e-9);
  assert.ok(zoomAroundPointer(before, { x: 0, y: 0 }, { deltaY: 100, deltaMode: 0 }, { min: .2, max: 1.35 }).zoom < 1);
});

test('zooming around the pointer stops at the zoom limits', () => {
  const limits = { min: .2, max: 1.35 };
  assert.equal(zoomAroundPointer({ x: 0, y: 0, zoom: 1.3 }, { x: 0, y: 0 }, { deltaY: -2000, deltaMode: 0 }, limits).zoom, 1.35);
  assert.equal(zoomAroundPointer({ x: 0, y: 0, zoom: .25 }, { x: 0, y: 0 }, { deltaY: 2000, deltaMode: 0 }, limits).zoom, .2);
});
