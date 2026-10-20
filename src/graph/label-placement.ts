export interface ScreenRect { x: number; y: number; width: number; height: number }
export function intersects(a: ScreenRect, b: ScreenRect, gap = 8) {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}

/** Screen-space annotation placement only: never changes a project's world data.
 * Search around occupied edges, with bounded work even on crowded viewports. */
export function placeProjectLabels(labels: readonly (ScreenRect & { id: string })[], occupied: readonly ScreenRect[], canvas: { width: number; height: number }) {
  const placed = new Map<string, ScreenRect>(), margin = 12;
  // Blockers in insertion order, bucketed by screen cell so each candidate tests only its neighbours.
  const cell = 128, cells = new Map<number, number[]>(), blockers: ScreenRect[] = [];
  const span = (r: ScreenRect, visit: (key: number) => void) => {
    for (let x = Math.floor((r.x - 8) / cell); x <= Math.floor((r.x + r.width + 8) / cell); x++)
      for (let y = Math.floor((r.y - 8) / cell); y <= Math.floor((r.y + r.height + 8) / cell); y++) visit(x * 100_003 + y);
  };
  const block = (r: ScreenRect) => { const index = blockers.push(r) - 1; span(r, key => { const list = cells.get(key); if (list) list.push(index); else cells.set(key, [index]); }); };
  const hits = (r: ScreenRect) => {
    const found = new Set<number>(); span(r, key => { for (const index of cells.get(key) ?? []) found.add(index); });
    return [...found].sort((a, b) => a - b).map(index => blockers[index]).filter(blocker => intersects(r, blocker));
  };
  for (const rect of occupied) block(rect);
  for (const label of [...labels].sort((a, b) => a.id.localeCompare(b.id))) {
    const clamp = (x: number, y: number) => ({ x: Math.max(margin, Math.min(canvas.width - label.width - margin, x)), y: Math.max(margin, Math.min(canvas.height - label.height - margin, y)), width: label.width, height: label.height });
    const desired = clamp(label.x, label.y), queue = [desired];
    // Candidates are clamped inside the canvas, so tenths of a pixel pack into one number.
    const key = (r: ScreenRect) => Math.round(r.x * 10) * 1_000_000 + Math.round(r.y * 10);
    const seen = new Set<number>([key(desired)]);
    const distance = (p: ScreenRect) => (p.x - desired.x) ** 2 + (p.y - desired.y) ** 2;
    const order = (a: ScreenRect, b: ScreenRect) => distance(a) - distance(b) || a.y - b.y || a.x - b.x;
    // The queue is a binary heap: the nearest candidate (ties by y, then x) comes out first.
    const push = (item: ScreenRect) => {
      let i = queue.push(item) - 1;
      while (i > 0) { const parent = (i - 1) >> 1; if (order(queue[i], queue[parent]) >= 0) break; [queue[i], queue[parent]] = [queue[parent], queue[i]]; i = parent; }
    };
    const pop = () => {
      const top = queue[0], last = queue.pop()!;
      if (queue.length) {
        queue[0] = last;
        for (let i = 0; ;) {
          const left = 2 * i + 1, right = left + 1; let smallest = i;
          if (left < queue.length && order(queue[left], queue[smallest]) < 0) smallest = left;
          if (right < queue.length && order(queue[right], queue[smallest]) < 0) smallest = right;
          if (smallest === i) break;
          [queue[i], queue[smallest]] = [queue[smallest], queue[i]]; i = smallest;
        }
      }
      return top;
    };
    let best = desired, bestOverlap = Infinity;
    for (let attempt = 0; queue.length && attempt < 128; attempt++) {
      const next = pop();
      const collisions = hits(next);
      if (!collisions.length) { best = next; break; }
      const overlap = collisions.reduce((sum, b) => sum + Math.max(0, Math.min(next.x + next.width + 8, b.x + b.width + 8) - Math.max(next.x, b.x)) * Math.max(0, Math.min(next.y + next.height + 8, b.y + b.height + 8) - Math.max(next.y, b.y)), 0);
      if (overlap < bestOverlap) { best = next; bestOverlap = overlap; }
      for (const b of collisions) for (const candidate of [clamp(next.x, b.y + b.height + 8), clamp(next.x, b.y - label.height - 8), clamp(b.x - label.width - 8, next.y), clamp(b.x + b.width + 8, next.y)]) {
        if (queue.length >= 512) continue;
        const id = key(candidate); if (!seen.has(id)) { seen.add(id); push(candidate); }
      }
    }
    placed.set(label.id, best); block(best);
  }
  return placed;
}
