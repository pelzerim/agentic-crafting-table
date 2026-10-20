import { terminalKey } from './terminal-keys.ts';
import { bindTerminalLinks } from './terminal-links.ts';
import type { TerminalLink } from './terminal-links.ts';
import { TerminalLinkMenu } from './terminal-link-menu.tsx';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { observeTerminalPerformance, performanceMetrics } from './performance.ts';
import { bindTerminalWheel } from './terminal-wheel.ts';
import { bindTerminalIdentity } from './terminal-identity.ts';
import { createTerminalRenderer } from './terminal-renderer.ts';
import { useTerminalPreferences } from './terminal-preferences.ts';

const WRITE_SLICE = 32 * 1024;

export interface TerminalChannel {
  id: string;
  history: string;
  onOutput(listener: (data: string) => void | Promise<void>): () => void;
  onReset?(listener: (data: string) => void | Promise<void>): () => void;
  write(data: string, encoding?: 'binary'): void;
  resize(cols: number, rows: number): void;
}

/** A view only: unmounting never stops the underlying session. */
export function TerminalSurface({ channel, active, readOnly = false, nativeShiftEnter = false }: { channel: TerminalChannel; active: boolean; readOnly?: boolean; nativeShiftEnter?: boolean }) {
  const container = useRef<HTMLDivElement>(null), host = useRef<HTMLDivElement>(null);
  const instance = useRef<{ terminal: Terminal; fit: FitAddon; renderer: ReturnType<typeof createTerminalRenderer>; wheel: ReturnType<typeof bindTerminalWheel> } | null>(null);
  const [linkMenu, setLinkMenu] = useState<TerminalLink>();
  const activeRef = useRef(active); activeRef.current = active;
  const nativeKeyRef = useRef(nativeShiftEnter); nativeKeyRef.current = nativeShiftEnter;
  useEffect(() => { if (!active) setLinkMenu(undefined); }, [active]);
  const [mountId] = useState(() => crypto.randomUUID());
  const preferences = useTerminalPreferences(), preferencesRef = useRef(preferences); preferencesRef.current = preferences;
  useEffect(() => { if (active) return observeTerminalPerformance(); }, [active]);
  useLayoutEffect(() => {
    // Leave ordinary history on the native viewport default: xterm 6 smoothing
    // can retain an old bottom target after output arrives while reading history.
    const terminal = new Terminal({ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: Math.max(8, Math.min(32, Number(localStorage.getItem('craft.terminal.fontSize')) || 13)), cursorBlink: true, screenReaderMode: preferencesRef.current.screenReaderMode, scrollback: preferencesRef.current.scrollback, theme: { background: '#101612', foreground: '#dce8df', cursor: '#98d6ac' } });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    const element = host.current!;
    terminal.open(element);
    terminal.attachCustomKeyEventHandler(event => terminalKey(terminal, event, nativeKeyRef.current));
    const links = bindTerminalLinks(terminal, link => { if (activeRef.current) setLinkMenu(link); });
    const renderer = createTerminalRenderer(terminal, mode => { element.dataset.terminalRenderer = mode; });
    renderer.setActive(active);
    const pending = new Set<() => void>();
    const write = (data: string) => new Promise<void>(resolve => {
      const started = performance.now();
      performanceMetrics.record('terminal.output', data.length);
      pending.add(resolve);
      // xterm parses each write without yielding; slicing a large page lets
      // input and frames run between slices.
      let start = 0;
      do {
        let end = Math.min(data.length, start + WRITE_SLICE);
        if (end < data.length && data.charCodeAt(end - 1) >= 0xd800 && data.charCodeAt(end - 1) <= 0xdbff) end--;
        terminal.write(data.slice(start, end), end < data.length ? undefined : () => {
          if (pending.delete(resolve)) performanceMetrics.record('terminal.write', performance.now() - started);
          resolve();
        });
        start = end;
      } while (start < data.length);
    });
    const unsubscribe = channel.onOutput(write);
    const identity = bindTerminalIdentity(terminal, data => channel.write(data));
    const input = bindTerminalWheel(terminal, (data, encoding) => channel.write(data, encoding));
    const reset = channel.onReset?.(data => { input.reset(); terminal.reset(); return write(data); });
    const resize = terminal.onResize(({ cols, rows }) => channel.resize(cols, rows));
    // History can arrive before the next animation frame. Fit first so a
    // full-screen recording isn't parsed into xterm's default 80×24 grid and
    // irreversibly scrolls its first rows away before our observer runs.
    if (active && host.current!.clientWidth > 0 && host.current!.clientHeight > 0) fit.fit();
    terminal.write(channel.history);
    instance.current = { terminal, fit, renderer, wheel: input };
    return () => { unsubscribe(); reset?.(); input.dispose(); identity.dispose(); links(); resize.dispose(); renderer.dispose(); terminal.dispose(); for (const resolve of pending) resolve(); pending.clear(); instance.current = null; };
  }, [channel]);
  useLayoutEffect(() => {
    const terminal = instance.current?.terminal;
    if (!terminal) return;
    if (terminal.options.screenReaderMode !== preferences.screenReaderMode) terminal.options.screenReaderMode = preferences.screenReaderMode;
    // Shrinking drops the oldest history rows of this view; the recording keeps them.
    if (terminal.options.scrollback !== preferences.scrollback) terminal.options.scrollback = preferences.scrollback;
    container.current!.dataset.terminalScrollback = String(terminal.options.scrollback);
  }, [preferences, channel]);
  useLayoutEffect(() => {
    const current = instance.current;
    if (!current) return;
    current.renderer.setActive(active);
    if (active) current.terminal.refresh(0, current.terminal.rows - 1);
    current.terminal.options.disableStdin = !active || readOnly;
    if (!active || readOnly) current.wheel.reset();
    let fitFrame = 0;
    const fit = () => {
      fitFrame = 0;
      if (active && container.current!.clientWidth > 0 && container.current!.clientHeight > 0) {
        const started = performance.now(); current.fit.fit(); performanceMetrics.record('terminal.fit', performance.now() - started);
      }
    };
    const scheduleFit = () => { if (active && !fitFrame) fitFrame = requestAnimationFrame(fit); };
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(host.current!);
    scheduleFit();
    const zoom = (direction: -1 | 0 | 1) => {
      if (!active) return;
      const fontSize = direction === 0 ? 13 : Math.max(8, Math.min(32, current.terminal.options.fontSize! + direction));
      current.terminal.options.fontSize = fontSize;
      localStorage.setItem('craft.terminal.fontSize', String(fontSize));
      scheduleFit();
    };
    const keyZoom = (event: KeyboardEvent) => {
      if (!active || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      const direction = ['+', '='].includes(event.key) ? 1 : ['-', '_'].includes(event.key) ? -1 : event.key === '0' ? 0 : undefined;
      if (direction !== undefined) { event.preventDefault(); event.stopPropagation(); zoom(direction); }
    };
    const offZoom = window.craftingTable.onTerminalZoom(zoom);
    window.addEventListener('keydown', keyZoom, true);
    if (active) window.craftingTable.terminalZoomTarget(channel.id);
    // Enable and focus input in the same commit that reveals a running session.
    // Waiting for a passive effect/frame can drop the beginning of fast input.
    if (active && !readOnly) current.terminal.focus();
    // Let the map finish its selection focus before handing input to the terminal.
    const frame = requestAnimationFrame(() => { if (active && !readOnly) current.terminal.focus(); });
    return () => { cancelAnimationFrame(frame); cancelAnimationFrame(fitFrame); observer.disconnect(); offZoom(); window.removeEventListener('keydown', keyZoom, true); if (active) window.craftingTable.terminalZoomTarget(null); };
  }, [active, readOnly, channel]);
  return <><div ref={container} className="terminal-surface nodrag nopan nowheel" data-terminal-id={channel.id} data-mount-id={mountId} aria-label="Terminal"><div ref={host} className="terminal-host" /></div>{active && linkMenu && <TerminalLinkMenu link={linkMenu} close={focus => {
    setLinkMenu(current => current === linkMenu ? undefined : current);
    if (focus && activeRef.current) instance.current?.terminal.focus();
  }} />}</>;
}
