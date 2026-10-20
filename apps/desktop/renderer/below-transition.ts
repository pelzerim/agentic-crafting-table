/** Motion for moving items and the camera between the map and the layer below.
 * Purely visual: every command runs regardless of whether an animation plays. */
export interface BelowMotion { enabled: boolean; durationMs: number }

const DOWN = ['#7b3cff', '#9b5cff', '#5e22c9', '#b98cff', '#3b1680'];
const UP = ['#5f8f5b', '#7fb87d', '#9cd29a', '#3f6b3c', '#b9e3b3'];
const EMBER = ['#ffb15a', '#ff7a2f', '#ffd27a'];

/** Sending one item keeps the prototype's deliberate pace; the setting times travel. */
export const ITEM_SINK_MS = 900;

export function activeMotion(motion: BelowMotion | undefined) {
  if (!motion?.enabled || matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
  return motion.durationMs;
}

/** A layer over the map pane that follows the viewport's pan/zoom transform, so
 * effects stay anchored to the map. Children use map (world) coordinates. */
function mapEffectsLayer(host: HTMLElement, viewport: HTMLElement) {
  const pane = viewport.parentElement!, hostRect = host.getBoundingClientRect(), paneRect = pane.getBoundingClientRect();
  const layer = document.createElement('div'); layer.className = 'below-fx'; layer.setAttribute('aria-hidden', 'true');
  Object.assign(layer.style, { left: `${paneRect.left - hostRect.left}px`, top: `${paneRect.top - hostRect.top}px` });
  const sync = () => { layer.style.transform = viewport.style.transform; };
  sync(); host.append(layer);
  const observer = new MutationObserver(sync); observer.observe(viewport, { attributes: true, attributeFilter: ['style'] });
  return { layer, dispose() { observer.disconnect(); layer.remove(); } };
}

/** A card sinks through a pixel portal in the floor (down) or rises through the
 * ceiling (up), anchored to the map. Only transforms and opacity animate. */
export function sinkItem(host: HTMLElement, element: HTMLElement, direction: 'down' | 'up', duration: number) {
  const viewport = element.closest<HTMLElement>('.react-flow__viewport');
  if (!viewport) return Promise.resolve();
  const zoom = new DOMMatrixReadOnly(getComputedStyle(viewport).transform).a || 1;
  const rect = element.getBoundingClientRect(), origin = viewport.getBoundingClientRect();
  const box = { x: (rect.left - origin.left) / zoom, y: (rect.top - origin.top) / zoom, width: rect.width / zoom, height: rect.height / zoom };
  const { layer, dispose } = mapEffectsLayer(host, viewport);
  const frame = document.createElement('div'), clone = element.cloneNode(true) as HTMLElement, tint = document.createElement('div');
  frame.className = 'below-sink';
  Object.assign(frame.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` });
  clone.removeAttribute('data-item-id'); clone.classList.add('below-sink-card');
  tint.className = 'below-sink-tint'; tint.style.background = direction === 'down' ? '#2b0a5c' : '#fff3d6';
  const mover = document.createElement('div'); mover.className = 'below-sink-mover'; mover.append(clone, tint);
  frame.append(mover); layer.append(frame);
  const ringColumns = Math.max(4, Math.ceil(box.width / 6) + 4), ring = document.createElement('canvas');
  ring.width = ringColumns; ring.height = 3; ring.className = 'below-ring';
  Object.assign(ring.style, { left: `${box.x - 12}px`, top: `${(direction === 'down' ? box.y + box.height : box.y) - 9}px`, width: `${ringColumns * 6}px`, height: '18px' });
  layer.append(ring);
  const colors = direction === 'down' ? DOWN : EMBER, context = ring.getContext('2d')!;
  const started = performance.now();
  let raf = 0, lastStep = -1;
  const glow = (now: number) => {
    const t = (now - started) / duration, step = Math.floor(t * 24);
    // Redraw only on each pixel step, not every display frame.
    if (step !== lastStep) {
      lastStep = step;
      const open = Math.min(1, t * 4) * Math.min(1, Math.max(0, (1.15 - t) * 4));
      context.clearRect(0, 0, ringColumns, 3);
      for (let x = 0; x < ringColumns; x++) for (let y = 0; y < 3; y++) {
        if (Math.abs(x - ringColumns / 2) > ringColumns / 2 * open || (x * 7 + y * 13 + Math.floor(t * 12)) % 4 === 0) continue;
        context.fillStyle = colors[(x + y + Math.floor(t * 10)) % colors.length]; context.fillRect(x, y, 1, 1);
      }
    }
    if (t < 1.15) raf = requestAnimationFrame(glow);
  };
  raf = requestAnimationFrame(glow);
  // Particles drift away from the portal: purple downward sends, embers on return.
  for (let i = 0; i < 18; i++) {
    const particle = document.createElement('i'); particle.className = 'below-particle'; particle.style.background = colors[i % colors.length];
    Object.assign(particle.style, { left: `${box.x + Math.random() * box.width}px`, top: `${direction === 'down' ? box.y + box.height - 4 : box.y}px` });
    layer.append(particle);
    particle.animate([{ transform: 'translate(0,0)', opacity: 1 }, { transform: `translate(${(Math.random() - .5) * 60}px,${(direction === 'down' ? -1 : 1) * (30 + Math.random() * 70)}px)`, opacity: 0 }],
      { duration: duration * (.75 + Math.random() * .55), delay: duration * (.15 + Math.random() * .4), easing: 'steps(6)', fill: 'backwards' }).finished.catch(() => {}).then(() => particle.remove());
  }
  const sink = mover.animate([
    { transform: 'translate3d(0,0,0)' }, { transform: 'translate3d(-2px,0,0)', offset: .1 }, { transform: 'translate3d(0,0,0)', offset: .2 },
    { transform: `translate3d(0,${direction === 'down' ? 105 : -105}%,0)` },
  ], { duration, easing: 'steps(10)', fill: 'forwards' });
  tint.animate([{ opacity: 0 }, { opacity: 0, offset: .2 }, { opacity: direction === 'down' ? .45 : .3 }], { duration, easing: 'steps(10)', fill: 'forwards' });
  return sink.finished.catch(() => {}).then(() => { cancelAnimationFrame(raf); dispose(); });
}

/** Full-screen pixel wipe. `swap` runs once the screen is covered. */
export function portalWipe(host: HTMLElement, direction: 'down' | 'up', duration: number, swap: () => void) {
  const canvas = document.createElement('canvas'), width = Math.ceil(innerWidth / 24), height = Math.ceil(innerHeight / 24);
  canvas.width = width; canvas.height = height; canvas.className = 'below-wipe'; canvas.setAttribute('aria-hidden', 'true');
  host.append(canvas);
  const context = canvas.getContext('2d')!, colors = direction === 'down' ? DOWN : UP;
  const cells: { x: number; y: number; r: number }[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) cells.push({ x, y, r: Math.random() * .6 + Math.hypot(x - width / 2, y - height / 2) / width });
  cells.sort((a, b) => a.r - b.r);
  const cover = duration * .45, hold = duration * .1, clear = duration * .45;
  return new Promise<void>(resolve => {
    let started: number | undefined, swapped = false;
    const frame = (now: number) => {
      started ??= now; const elapsed = now - started;
      const filled = Math.floor(cells.length * Math.min(1, elapsed / cover));
      const cleared = elapsed > cover + hold ? Math.floor(cells.length * Math.min(1, (elapsed - cover - hold) / clear)) : 0;
      if (!swapped && elapsed >= cover) { swapped = true; swap(); }
      context.clearRect(0, 0, width, height);
      const tick = Math.floor(elapsed / 90);
      for (let i = cleared; i < filled; i++) {
        const cell = cells[cells.length - 1 - i] ?? cells[i];
        context.fillStyle = colors[(((cell.x * 73856093) ^ (cell.y * 19349663) ^ (tick * 83492791)) >>> 0) % colors.length];
        context.fillRect(cell.x, cell.y, 1, 1);
      }
      if (elapsed < cover + hold + clear) requestAnimationFrame(frame);
      else { canvas.remove(); resolve(); }
    };
    requestAnimationFrame(frame);
  });
}
