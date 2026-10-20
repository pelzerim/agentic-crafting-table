import test from 'node:test';
import assert from 'node:assert/strict';
import { ZOOM_LEVELS, zoomLevel, zoomDetail, neighborhoodZoom, overlaps, separateItems, nearbyProject, attachFloatingItem } from './spatial.ts';

test('zoom transitions agree exactly with the marked thresholds', () => {
  assert.equal(zoomLevel(ZOOM_LEVELS.neighborhood - .001), 'overview');
  assert.equal(zoomLevel(ZOOM_LEVELS.neighborhood), 'neighborhood');
  assert.equal(zoomLevel(ZOOM_LEVELS.close), 'close');
  assert.equal(zoomLevel(ZOOM_LEVELS.max), 'close');
});

test('with dashboards on, items keep neighborhood rendering down to the dashboard threshold', () => {
  const on = (belowZoom: number) => ({ enabled: true, belowZoom });
  assert.equal(neighborhoodZoom(on(.55)), .55);
  assert.equal(neighborhoodZoom(on(.65)), .65);
  assert.equal(neighborhoodZoom({ enabled: false, belowZoom: .55 }), ZOOM_LEVELS.neighborhood);
  assert.equal(neighborhoodZoom(), ZOOM_LEVELS.neighborhood);
  assert.equal(zoomLevel(.6, on(.55)), 'neighborhood');
  assert.equal(zoomLevel(.55, on(.55)), 'neighborhood');
  assert.equal(zoomLevel(.549, on(.55)), 'overview');
  assert.equal(zoomLevel(.3, on(.25)), 'neighborhood');
  assert.equal(zoomLevel(.6, { enabled: false, belowZoom: .55 }), 'overview');
  assert.equal(zoomLevel(1.2, on(.55)), 'close');
});

test('card detail shifts with the neighborhood threshold so cards are never icon-only above it', () => {
  const on = (belowZoom: number) => ({ enabled: true, belowZoom });
  assert.equal(zoomDetail(.6), (.6 - .45) / .3);
  assert.equal(zoomDetail(.6, { enabled: false, belowZoom: .55 }), zoomDetail(.6));
  assert.equal(zoomDetail(.65, on(.65)), zoomDetail(.65));
  for (const belowZoom of [.25, .4, .55, .6, .65]) {
    assert.ok(Math.abs(zoomDetail(belowZoom, on(belowZoom)) - zoomDetail(ZOOM_LEVELS.neighborhood)) < 1e-9);
    assert.ok(zoomDetail(belowZoom - .02, on(belowZoom)) >= .35, 'hysteresis band stays non-compact');
  }
  assert.equal(zoomDetail(.2), 0);
  assert.equal(zoomDetail(1.3, on(.25)), 1);
});

test('dense mixed-size cards separate without moving the held card or mutating inputs', () => {
  const input = Array.from({ length: 18 }, (_, i) => ({ id: String(i), x: 100, y: 100, width: i % 2 ? 240 : 148, height: i % 3 ? 100 : 44 }));
  const result = separateItems(input, '7');
  assert.deepEqual(result[7], input[7]);
  assert.ok(input.every(item => item.x === 100 && item.y === 100));
  for (let i = 0; i < result.length; i++) for (let j = i + 1; j < result.length; j++) assert.equal(overlaps(result[i], result[j]), false);
  assert.deepEqual(separateItems(result, '7'), result);
});

test('attachment uses the nearest project boundary and has a bounded halo', () => {
  const projects = [{ id: 'a', x: 0, y: 0, width: 100, height: 100 }, { id: 'b', x: 300, y: 0, width: 100, height: 100 }];
  assert.equal(nearbyProject({ x: 80, y: 0 }, projects), 'a');
  assert.equal(nearbyProject({ x: 200, y: 0 }, projects), undefined);
  assert.equal(nearbyProject({ x: 260, y: 0 }, projects), 'b');
});

test('floating membership is optional and attaching preserves position and resource identity', () => {
  const nodes = [{ id: 'project', title: 'Project', position: { x: 0, y: 0 } }, { id: 'item', resourceId: 'session', title: 'Shell', position: { x: 80, y: 10 } }];
  const attached = attachFloatingItem(nodes, 'item', 'project');
  assert.equal(attached[1].projectId, 'project');
  assert.equal(attached[1].resourceId, 'session');
  assert.equal(attached[1].position, nodes[1].position);
  assert.equal('projectId' in nodes[1], false);
  assert.throws(() => attachFloatingItem(attached, 'item', 'project'), /already belongs/);
});
