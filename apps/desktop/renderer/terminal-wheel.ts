import type { Terminal } from '@xterm/xterm';

/** Keep fractional trackpad movement without the terminal library's small-delta
 * slowdown. A reversal or a new gesture must not pay off old movement first. */
export class TerminalWheelLines {
  private remainder = 0;
  private lastTime = 0;
  reset() { this.remainder = 0; this.lastTime = 0; }
  consume(delta: number, mode: number, cellHeight: number, rows: number, time: number) {
    if (!Number.isFinite(delta) || !Number.isFinite(cellHeight) || cellHeight <= 0 || rows <= 0) return 0;
    if (time - this.lastTime > 250 || delta * this.remainder < 0) this.remainder = 0;
    this.lastTime = time;
    const amount = mode === 1 ? delta : mode === 2 ? delta * rows : delta / cellHeight;
    const total = this.remainder + amount, whole = Math.trunc(total);
    this.remainder = total - whole;
    // A malformed/huge browser event must not queue thousands of PTY reports.
    return Math.max(-rows, Math.min(rows, whole)) || 0;
  }
}

/** xterm 6 converts a multi-line TUI wheel event to a single report and reduces
 * pixel deltas under 50px by 70%. Normalize only that path; xterm still owns
 * mouse protocol encoding, coordinates and application arrows: it encodes one
 * line step for where the pointer rests, and that report is written once per
 * line, at once. Agent CLIs merge what arrives between their own frames, so
 * nothing is queued or paced here. Normal scrollback stays with its native
 * viewport. */
export function bindTerminalWheel(terminal: Terminal, write: (data: string, encoding?: 'binary') => void) {
  const lines = new TerminalWheelLines(), forwarded = new WeakSet<WheelEvent>();
  let lastMode = '', direction = 0, batch: { data: string; encoding?: 'binary' }[] | undefined;
  const modeKey = () => `${terminal.buffer.active.type}:${terminal.modes.mouseTrackingMode}:${terminal.options.disableStdin}`;
  const reset = () => { lines.reset(); direction = 0; };
  const send = (data: string, encoding?: 'binary') => {
    if (batch) batch.push({ data, encoding });
    else { reset(); write(data, encoding); }
  };
  const input = terminal.onData(data => send(data));
  // Legacy mouse reports use a separate event and may contain bytes above 127.
  // Forwarding them as UTF-8 changes their coordinates; omitting them loses input.
  const binary = terminal.onBinary(data => send(data, 'binary'));
  // Encoding a step makes xterm look up the mouse cell, which measures layout
  // and so lays out the whole window. A resting pointer gives the same report
  // every time, so it is kept until the pointer, the mode or the grid changes.
  let step: { key: string; reports: { data: string; encoding?: 'binary' }[] } | undefined;
  const encode = (sign: number, event: WheelEvent) => {
    const key = `${sign}:${event.clientX}:${event.clientY}:${event.altKey}:${lastMode}`;
    if (step?.key === key) return step.reports;
    batch = [];
    try {
      const line = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaMode: WheelEvent.DOM_DELTA_LINE, deltaY: sign, clientX: event.clientX, clientY: event.clientY, altKey: event.altKey });
      forwarded.add(line);
      terminal.element!.dispatchEvent(line);
    } finally {
      const reports: { data: string; encoding?: 'binary' }[] = [];
      // Adjacent reports of one encoding become one write, with protocol order intact.
      for (const report of batch) { const last = reports.at(-1); if (last && last.encoding === report.encoding) last.data += report.data; else reports.push({ ...report }); }
      batch = undefined; step = { key, reports };
    }
    return step.reports;
  };
  const relay = (count: number, event: WheelEvent) => {
    const reports = encode(Math.sign(count), event), steps = Math.min(Math.abs(count), terminal.rows * 3);
    if (reports.length === 1) write(reports[0].data.repeat(steps), reports[0].encoding);
    else for (let i = 0; i < steps; i++) for (const report of reports) write(report.data, report.encoding);
  };
  // Measuring forces a layout of the whole page, so the cell height is kept
  // until something that changes it happens.
  let cell: { height: number; fontSize: number | undefined; lineHeight: number | undefined; ratio: number } | undefined;
  const cellHeight = () => {
    const { fontSize, lineHeight } = terminal.options;
    if (!cell || cell.fontSize !== fontSize || cell.lineHeight !== lineHeight || cell.ratio !== devicePixelRatio)
      cell = { height: terminal.element!.querySelector('.xterm-screen')!.getBoundingClientRect().height / terminal.rows, fontSize, lineHeight, ratio: devicePixelRatio };
    return cell.height;
  };
  const resized = terminal.onResize(() => { cell = undefined; step = undefined; });
  // xterm looks up the mouse cell for every wheel event it receives before
  // asking a custom handler. Take the event in the capture phase so it only
  // ever sees the step being encoded.
  const wheel = (event: WheelEvent) => {
    if (forwarded.has(event)) return;
    const buffer = terminal.buffer.active.type, mouse = terminal.modes.mouseTrackingMode;
    const mode = modeKey();
    if (mode !== lastMode) { reset(); lastMode = mode; }
    if (buffer === 'normal' && (mouse === 'none' || mouse === 'x10')) { reset(); return; }
    // Horizontal/Shift scrolling retains native semantics; pinch/zoom must not
    // accidentally send input to the CLI or zoom the surrounding application.
    if (!event.deltaY || event.shiftKey) { reset(); return; }
    event.preventDefault(); event.stopPropagation();
    if (event.ctrlKey || event.metaKey) { reset(); return; }
    // A reversal must not pay off the previous direction's fraction first.
    if (direction * event.deltaY < 0) reset();
    direction = Math.sign(event.deltaY);
    const count = lines.consume(event.deltaY, event.deltaMode, cellHeight(), terminal.rows, event.timeStamp);
    if (terminal.options.disableStdin) {
      if (buffer === 'normal') terminal.scrollLines(count);
      return;
    }
    if (count) relay(count, event);
  };
  const element = terminal.element!;
  element.addEventListener('wheel', wheel, { capture: true, passive: false });
  return { reset, dispose() { reset(); input.dispose(); binary.dispose(); resized.dispose(); element.removeEventListener('wheel', wheel, { capture: true }); } };
}
