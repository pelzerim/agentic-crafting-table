import test from 'node:test';
import assert from 'node:assert/strict';
import { intersects, placeProjectLabels } from './label-placement.ts';

test('viewport labels avoid controls and each other at both supported window sizes without moving their anchors', () => {
  for (const width of [900, 1280]) for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
    const canvas = { width, height: 640 };
    const controls = [{ x: width - 360, y: 16, width: 340, height: 40 }, { x: width - 140, y: 490, width: 125, height: 130 }, { x: 18, y: 115, width: 44, height: 44 }];
    const labels = [0, 1, 2].map(i => ({ id: `project-${i}`, x: corner.endsWith('right') ? width - 300 : 0, y: corner.startsWith('top') ? 0 : 620, width: 300, height: 48 }));
    const original = structuredClone(labels), placed = [...placeProjectLabels(labels, controls, canvas).values()];
    assert.deepEqual(labels, original);
    for (const [i, label] of placed.entries()) {
      assert.ok(label.x >= 0 && label.x + label.width <= width && label.y >= 0 && label.y + label.height <= 640);
      assert.ok(controls.every(control => !intersects(label, control)));
      assert.ok(placed.slice(0, i).every(other => !intersects(label, other)));
    }
    assert.deepEqual(placeProjectLabels([...labels].reverse(), controls, canvas), placeProjectLabels(labels, controls, canvas));
  }
});
test('unobstructed labels keep their natural centered placement and crowded layouts remain bounded', () => {
  const label = { id: 'project', x: 400, y: 90, width: 300, height: 48 };
  assert.deepEqual(placeProjectLabels([label], [], { width: 1280, height: 800 }).get('project'), { x: 400, y: 90, width: 300, height: 48 });
  const crowded = placeProjectLabels(Array.from({ length: 30 }, (_, i) => ({ ...label, id: String(i) })), [{ x: 0, y: 0, width: 900, height: 640 }], { width: 900, height: 640 });
  assert.equal(crowded.size, 30);
});
test('the bucketed search places labels exactly like a full scan of every blocker', () => {
  type Rect = { x: number; y: number; width: number; height: number };
  const reference = (labels: (Rect & { id: string })[], occupied: Rect[], canvas: { width: number; height: number }) => {
    const placed = new Map<string, Rect>(), blockers = [...occupied], margin = 12;
    for (const label of [...labels].sort((a, b) => a.id.localeCompare(b.id))) {
      const clamp = (x: number, y: number) => ({ x: Math.max(margin, Math.min(canvas.width - label.width - margin, x)), y: Math.max(margin, Math.min(canvas.height - label.height - margin, y)), width: label.width, height: label.height });
      const desired = clamp(label.x, label.y), queue = [desired], key = (r: Rect) => `${Math.round(r.x * 10)},${Math.round(r.y * 10)}`, seen = new Set([key(desired)]);
      const distance = (p: Rect) => (p.x - desired.x) ** 2 + (p.y - desired.y) ** 2;
      let best = desired, bestOverlap = Infinity;
      for (let attempt = 0; queue.length && attempt < 128; attempt++) {
        queue.sort((a, b) => distance(a) - distance(b) || a.y - b.y || a.x - b.x);
        const next = queue.shift()!, collisions = blockers.filter(blocker => intersects(next, blocker));
        if (!collisions.length) { best = next; break; }
        const overlap = collisions.reduce((sum, b) => sum + Math.max(0, Math.min(next.x + next.width + 8, b.x + b.width + 8) - Math.max(next.x, b.x)) * Math.max(0, Math.min(next.y + next.height + 8, b.y + b.height + 8) - Math.max(next.y, b.y)), 0);
        if (overlap < bestOverlap) { best = next; bestOverlap = overlap; }
        for (const b of collisions) for (const candidate of [clamp(next.x, b.y + b.height + 8), clamp(next.x, b.y - label.height - 8), clamp(b.x - label.width - 8, next.y), clamp(b.x + b.width + 8, next.y)])
          if (!seen.has(key(candidate)) && queue.length < 512) { seen.add(key(candidate)); queue.push(candidate); }
      }
      placed.set(label.id, best); blockers.push(best);
    }
    return placed;
  };
  let seed = 7; const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let round = 0; round < 20; round++) {
    const canvas = { width: 1600, height: 1000 };
    const occupied = Array.from({ length: 40 + round * 20 }, () => ({ x: random() * 1500, y: random() * 950, width: 20 + random() * 120, height: 10 + random() * 50 }));
    const labels = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, x: random() * 1400, y: random() * 900, width: 300, height: round % 2 ? 64 : 48 }));
    assert.deepEqual(placeProjectLabels(labels, occupied, canvas), reference(labels, occupied, canvas), `round ${round}`);
  }
});
