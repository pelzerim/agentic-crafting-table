import { PerformanceMetrics } from '../../../packages/diagnostics/performance.ts';

export const performanceMetrics = new PerformanceMetrics();
const longTasksSupported = PerformanceObserver.supportedEntryTypes.includes('longtask');
export const performanceReport = () => ({ ...performanceMetrics.snapshot(), longTasksSupported });
let activeTerminals = 0, activeMaps = 0, frame = 0, previous = 0;
const visible = () => document.visibilityState === 'visible';
const foreground = () => (activeTerminals > 0 || activeMaps > 0) && visible();
function tick(now: number) {
  frame = 0;
  if (!foreground()) { previous = 0; return; }
  if (previous) {
    if (activeTerminals) performanceMetrics.record('frame.interval', now - previous);
    if (activeMaps) performanceMetrics.record('map.frame-interval', now - previous);
  }
  previous = now; frame = requestAnimationFrame(tick);
}
function update() {
  if (foreground() && !frame) frame = requestAnimationFrame(tick);
  if (!foreground()) { cancelAnimationFrame(frame); frame = 0; previous = 0; }
}
document.addEventListener('visibilitychange', update);
if (longTasksSupported) {
  new PerformanceObserver(list => {
    if (visible()) for (const entry of list.getEntries()) {
      if (activeTerminals) performanceMetrics.record('renderer.long-task', entry.duration);
      if (activeMaps) performanceMetrics.record('map.long-task', entry.duration);
    }
  }).observe({ type: 'longtask' });
}
export function observeTerminalPerformance() {
  activeTerminals++; update();
  return () => { activeTerminals--; update(); };
}
export function observeMapPerformance() {
  activeMaps++; update();
  return () => { activeMaps--; update(); };
}

// Read/reset only. The Settings UI and end-to-end tests use the same collector.
window.craftingPerformance = Object.freeze({ snapshot: performanceReport, reset: () => performanceMetrics.reset() });
declare global { interface Window { craftingPerformance: { snapshot(): ReturnType<typeof performanceReport>; reset(): void } } }
