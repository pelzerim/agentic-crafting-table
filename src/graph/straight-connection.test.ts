import test from 'node:test';
import assert from 'node:assert/strict';
import { straightConnection } from './straight-connection.ts';

const a = { id: 'a', x: 0, y: 0, width: 240, height: 112 };
test('straight connections meet facing boundaries in every direction and retain arrow direction', () => {
  for (const [x, y] of [[600, 0], [-600, 0], [0, 400], [0, -400], [500, 300], [-500, 300], [-500, -300], [500, -300]]) {
    const b = { id: 'b', x, y, width: 220, height: 48 }, line = straightConnection(a, b)!;
    const reverse = straightConnection(b, a)!;
    for (const [point, box] of [[line.source, a], [line.target, b]] as const) {
      assert.ok(Math.abs((point.x - a.x) * y - (point.y - a.y) * x) < 1e-8);
      assert.ok(Math.abs(Math.max(Math.abs(point.x - box.x) / (box.width / 2), Math.abs(point.y - box.y) / (box.height / 2)) - 1) < 1e-8);
    }
    assert.ok(Math.hypot(reverse.target.x - line.source.x, reverse.target.y - line.source.y) < 1e-8);
    assert.ok(Math.hypot(reverse.source.x - line.target.x, reverse.source.y - line.target.y) < 1e-8);
    assert.ok((line.target.x - line.source.x) * x + (line.target.y - line.source.y) * y > 0);
  }
});

test('displayed dimensions and translation control endpoints without changing saved records', () => {
  const b = { id: 'b', x: 350, y: 200, width: 200, height: 84 }, before = structuredClone([a, b]);
  const line = straightConnection(a, b)!;
  const compact = straightConnection({ ...a, width: 56, height: 36 }, b)!;
  assert.ok(Math.hypot(compact.source.x, compact.source.y) < Math.hypot(line.source.x, line.source.y));
  const shifted = straightConnection({ ...a, x: a.x - 900, y: a.y + 42 }, { ...b, x: b.x - 900, y: b.y + 42 })!;
  for (const end of ['source', 'target'] as const) {
    assert.ok(Math.abs(shifted[end].x - line[end].x + 900) < 1e-8);
    assert.ok(Math.abs(shifted[end].y - line[end].y - 42) < 1e-8);
  }
  assert.deepEqual([a, b], before);
});

test('overlap, touching and unmeasured endpoints do not produce reversed or invalid arrows', () => {
  for (const b of [{ ...a, id: 'b' }, { ...a, x: 100 }, { ...a, x: 240 }, { ...a, x: 600, width: 0 }, { ...a, x: NaN }]) assert.equal(straightConnection(a, b), undefined);
});
