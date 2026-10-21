import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import type { SessionRecord, SessionSnapshot } from '../../../packages/session-runtime/protocol.ts';
import { TerminalSurface } from './terminal.tsx';
import type { TerminalChannel } from './terminal.tsx';
import { performanceMetrics } from './performance.ts';
import { replayTailBytes, terminalPreferences, terminalPreferencesReady } from './terminal-preferences.ts';
import { InlineConfirm } from './settings-ui.tsx';
import { stopNeedsConfirm } from './session-stop.ts';
import { sessionChip } from '../../../src/resource-plugins/state-chips.ts';
import { ErrorBoundary, PanelError, rootErrorOptions } from './error-screen.tsx';
import type { AgentPromptStatus, NativeTerminalOptions } from '../../../src/resource-plugins/types.ts';

/** Recent output for a fresh view, sized to the scrollback it can keep; older output is skipped. */
const replayTail = () => replayTailBytes(terminalPreferences().scrollback);

let readsInFlight = 0;
async function readSession(sessionId: string, after: number, through?: number) {
  const started = performance.now();
  performanceMetrics.record('terminal.read-inflight', ++readsInFlight);
  try {
    if (after === 0) await terminalPreferencesReady();
    const snapshot = await window.craftingTable.sessionRead(sessionId, after, true, through, after === 0 ? replayTail() : undefined);
    if (!snapshot.chunks.length) performanceMetrics.record('terminal.empty-read', 1);
    return snapshot;
  } finally { readsInFlight--; performanceMetrics.record('terminal.read', performance.now() - started); }
}

type Consumer = (data: string) => void | Promise<void>;
class NativeChannel implements TerminalChannel {
  id: string;
  history = '';
  sequence = 0;
  running = false;
  readOnly = false;
  private inputDisabled = false;
  private deleted = false;
  private consumption = Promise.resolve();
  private output = new Set<Consumer>();
  private inputs = new Set<() => void>();
  onInput(listener: () => void) { this.inputs.add(listener); return () => { this.inputs.delete(listener); }; }
  private reset = new Set<Consumer>();
  private resizeTimer?: ReturnType<typeof setTimeout>;
  private size?: { cols: number; rows: number };
  private error: (message: string) => void;
  constructor(id: string, error: (message: string) => void) { this.id = id; this.error = error; }
  onOutput(listener: Consumer) { this.output.add(listener); return () => { this.output.delete(listener); }; }
  onReset(listener: Consumer) { this.reset.add(listener); return () => { this.reset.delete(listener); }; }
  consume(snapshot: SessionSnapshot) {
    const next = this.consumption.then(() => this.applySnapshot(snapshot));
    this.consumption = next.catch(() => {}); return next;
  }
  /** Clear the view and start again from a bounded replay of the recording. */
  restart() {
    const next = this.consumption.then(async () => { if (this.deleted) return; this.sequence = 0; await Promise.all([...this.reset].map(listener => listener(''))); });
    this.consumption = next.catch(() => {}); return next;
  }
  private async applySnapshot(snapshot: SessionSnapshot) {
    if (this.deleted) return;
    this.inputDisabled = snapshot.session.readOnly === true;
    const wasRunning = this.running;
    this.running = !this.readOnly && snapshot.session.state === 'running' && snapshot.session.displayThroughSequence === undefined;
    // A view fitted before its process started could not resize the PTY then.
    if (!wasRunning && this.running && this.size && (this.size.cols !== snapshot.session.cols || this.size.rows !== snapshot.session.rows)) this.resize(this.size.cols, this.size.rows);
    if (snapshot.session.recordingDeletedAt) {
      if (!this.deleted) { this.deleted = true; this.sequence = 0; await Promise.all([...this.reset].map(listener => listener(''))); }
      return;
    }
    const gap = this.sequence > 0 && snapshot.firstSequence > this.sequence + 1;
    if (gap && !this.readOnly) performanceMetrics.record('terminal.output-gap', snapshot.firstSequence - this.sequence - 1);
    const data = snapshot.chunks.filter(chunk => chunk.sequence > this.sequence).map(chunk => chunk.data).join('');
    this.sequence = Math.max(this.sequence, snapshot.lastSequence);
    if (data || gap) await Promise.all([...(gap ? this.reset : this.output)].map(listener => listener(data)));
    // Numeric delivery evidence only: a caught-up terminal can still display a
    // provider's unfinished reply. Quiet output alone is not a model failure.
    if (!this.readOnly) performanceMetrics.record('terminal.backlog-chunks', Math.max(0, (snapshot.recordingEnd ?? snapshot.lastSequence) - this.sequence));
  }
  write(data: string, encoding?: 'binary') {
    if (this.running && !this.inputDisabled) {
      const started = performance.now();
      void window.craftingTable.sessionInput(this.id, data, encoding).then(() => { for (const input of this.inputs) input(); }).catch(error => this.error(error.message))
        .finally(() => performanceMetrics.record('terminal.input', performance.now() - started));
    }
  }
  resize(cols: number, rows: number) { this.size = { cols, rows }; clearTimeout(this.resizeTimer); this.resizeTimer = setTimeout(() => { if (this.running) void window.craftingTable.sessionResize(this.id, cols, rows).catch(error => this.error(error.message)); }, 80); }
  dispose() { clearTimeout(this.resizeTimer); }
}

type TerminalOptions = NativeTerminalOptions;

function SessionMenu({ open, setOpen, resume, resumeDisabled, prompt, promptDisabled, message, stop, stopDisabled }: {
  open: boolean; setOpen(open: boolean): void;
  resume?(): void; resumeDisabled: boolean; prompt(): void; promptDisabled: boolean; message: string; stop(): void; stopDisabled: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const close = (focus = false) => { setOpen(false); if (focus) trigger.current?.focus(); };
  useLayoutEffect(() => {
    if (!open) return;
    const fit = () => {
      const anchor = trigger.current!.getBoundingClientRect(), panel = menu.current!;
      panel.style.left = `${Math.max(8, Math.min(anchor.right - panel.offsetWidth, innerWidth - panel.offsetWidth - 8))}px`;
      panel.style.top = `${Math.max(8, Math.min(anchor.bottom + 6, innerHeight - panel.offsetHeight - 8))}px`;
    };
    fit(); menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside, true); window.addEventListener('resize', fit);
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', fit); };
  }, [open, setOpen]);
  return <><button ref={trigger} aria-label="Agent session menu" aria-haspopup="menu" aria-expanded={open}
    onClick={() => setOpen(!open)} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); } }}>Session ▾</button>
    {open && createPortal(<div ref={menu} className="native-session-menu" role="menu" aria-label="Agent session actions" data-shortcuts="off"
      onPointerDown={event => event.stopPropagation()} onContextMenu={event => { event.preventDefault(); close(true); }}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
        if (event.key === 'Tab') { close(true); return; }
        const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')], current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }
      }}>
      <button role="menuitem" disabled={resumeDisabled || !resume} onClick={() => { close(true); resume?.(); }}>Resume / reconnect</button>
      <button role="menuitem" disabled={promptDisabled} aria-describedby="agent-prompt-explanation" onClick={() => { close(true); prompt(); }}>Add system prompt</button>
      <p id="agent-prompt-explanation">{message}</p>
      <hr />
      <button role="menuitem" className="session-stop" disabled={stopDisabled} onClick={() => { close(true); stop(); }}>Stop session</button>
    </div>, document.body)}
  </>;
}

function NativeTerminal({ sessionId, active, options }: { sessionId: string; active: boolean; options: TerminalOptions & { toolbar?: HTMLElement } }) {
  useLayoutEffect(() => { performanceMetrics.record('terminal.commit', 1); });
  const [session, setSession] = useState<SessionRecord>(), [error, setError] = useState(''), [readError, setReadError] = useState(''), [truncated, setTruncated] = useState(false);
  const [skipped, setSkipped] = useState(false), [replaying, setReplaying] = useState(true);
  const [busy, setBusy] = useState(false);
  const [recordingRevision, refreshRecording] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false), [promptStatus, setPromptStatus] = useState<AgentPromptStatus>();
  const [promptError, setPromptError] = useState('');
  const metadata = useRef(''), opening = useRef(true);
  const channel = useMemo(() => new NativeChannel(sessionId, setError), [sessionId]);
  useEffect(() => () => channel.dispose(), [channel]);
  useEffect(() => { if (!active) setMenuOpen(false); else opening.current = true; }, [active]);
  useEffect(() => {
    if (!active || !options.prompt || (!menuOpen && promptStatus?.state !== 'queued')) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      let pending = promptStatus?.state === 'queued';
      try {
        const next = await options.prompt!('status');
        if (cancelled) return;
        setPromptError(''); pending = next.state === 'queued';
        setPromptStatus(previous => previous?.state === next.state && previous.message === next.message ? previous : next);
      } catch (error) { if (!cancelled) setPromptError((error as Error).message); }
      if (!cancelled && pending) timer = setTimeout(() => { void read(); }, 1000);
    };
    void read(); return () => { cancelled = true; clearTimeout(timer); };
  }, [active, menuOpen, options.prompt, promptStatus?.state]);
  useEffect(() => {
    let cancelled = false;
    const deleted = window.craftingTable.onRecordingDeleted(id => {
      if (id === sessionId) { refreshRecording(value => value + 1); }
    });
    // A disconnected desktop may have missed a deletion notification.
    const connected = window.craftingTable.onConnection(status => {
      if (status === 'connected') void window.craftingTable.sessionRead(sessionId, Number.MAX_SAFE_INTEGER, true).then(snapshot => {
        if (!cancelled && snapshot.session.recordingDeletedAt) { refreshRecording(value => value + 1); }
      }).catch(() => {});
    });
    return () => { cancelled = true; deleted(); connected(); };
  }, [sessionId]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout>, idleReads = 0, reading = false, interactiveUntil = 0, caughtUp = false, again = false, watched = false;
    // A retained view missed output while inactive. Catch up page by page, but
    // once the backlog exceeds a fresh view's replay, restart from that replay.
    let behind = channel.sequence > 0 ? 0 : undefined;
    const read = async () => {
      if (cancelled || reading) return;
      reading = true;
      let more = false;
      try {
        const snapshot = await readSession(sessionId, channel.sequence).catch(error => {
          if (opening.current && options.startWhenStopped && (error as { code?: string }).code === 'SESSION_NOT_FOUND') return undefined;
          throw error;
        });
        if (cancelled) return;
        const ended = !snapshot || ['exited', 'failed', 'lost'].includes(snapshot.session.state);
        const retired = Boolean(snapshot?.session.archivedAt || snapshot?.session.recordingDeletedAt);
        if (opening.current && options.startWhenStopped && ended && !retired && options.resume) { opening.current = false; void action(options.resume); return; }
        opening.current = false;
        if (!snapshot) return;
        setReadError('');
        // Session metadata rarely changes. Output belongs to xterm, not React state.
        const encoded = JSON.stringify(snapshot.session);
        if (encoded !== metadata.current) { metadata.current = encoded; setSession(snapshot.session); }
        setTruncated(snapshot.truncated);
        if (snapshot.replayFrom) setSkipped(true);
        idleReads = snapshot.chunks.length ? 0 : idleReads + 1;
        if (behind !== undefined) behind += snapshot.chunks.reduce((total, chunk) => total + chunk.data.length, 0);
        if (behind !== undefined && snapshot.hasMore && behind > replayTail()) { behind = undefined; await channel.restart(); more = true; }
        else {
          if (!snapshot.hasMore) behind = undefined;
          // Replaying bounded pages also recovers bytes missed while the view was closed.
          await channel.consume(snapshot); more = Boolean(snapshot.hasMore);
          if (!more && ['exited', 'failed', 'lost'].includes(snapshot.session.state)) return;
        }
      } catch (error) { if (!cancelled) setReadError((error as Error).message); }
      finally { reading = false; if (!more && !caughtUp) { caughtUp = true; setReplaying(false); } }
      // Watched sessions announce new output, so the poll only backs up a missed
      // notification; an unwatched one keeps a short response window after input.
      const delay = more || again ? 0 : !watched && performance.now() < interactiveUntil ? 16 : Math.min(100, 16 * (idleReads + 1));
      again = false;
      if (!cancelled) timer = setTimeout(() => { void read(); }, delay);
    };
    const wake = () => { idleReads = 0; clearTimeout(timer); if (reading) again = true; else void read(); };
    const offActivity = window.craftingTable.onSessionActivity(sessionIds => { if (sessionIds.includes(sessionId)) wake(); });
    void window.craftingTable.sessionAttach(sessionId).then(() => { if (!cancelled) watched = true; }, () => {});
    const offInput = channel.onInput(() => {
      // Wake the idle poll on input, then keep a short response window for the
      // CLI's redraw. One reader drains output in order; wheel bursts cannot
      // create overlapping reads or wait out the 100ms idle backoff.
      interactiveUntil = performance.now() + 300; wake();
    });
    void read(); return () => { cancelled = true; clearTimeout(timer); offInput(); offActivity(); void window.craftingTable.sessionDetach(sessionId).catch(() => {}); };
  }, [active, sessionId, channel, recordingRevision]);
  const action = async (run: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await run(); } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  };
  const [confirmStop, setConfirmStop] = useState(false);
  const stop = () => { setConfirmStop(false); void action(() => window.craftingTable.sessionStop(sessionId)); };
  const requestStop = async () => {
    const activity = options.agentMenu && session ? await window.craftingTable.workspaceRead().then(({ state }) => state.nodes.find(node => node.id === session.nodeId)?.activity, () => undefined) : undefined;
    if (stopNeedsConfirm(session, Boolean(options.agentMenu), activity)) setConfirmStop(true); else stop();
  };
  const state = sessionChip(session?.state, Boolean(session?.stopRequestedAt));
  const stopDisabled = busy || !session || !['starting', 'running'].includes(session.state) || !!session.stopRequestedAt;
  const toolbar = <div className="terminal-status">
      <span className="view-chip terminal-state" data-tone={state.tone}>{state.label}</span>
      {options.launchLabel && <small className="terminal-launch" title="Launch provider and model; the native session may change its model">{options.launchLabel}</small>}
      <span className="terminal-directory" title={session?.cwd}>{session?.cwd}</span>
      {truncated && <small title="This older session only retained its last output">Partial recording</small>}
      {skipped && !session?.recordingDeletedAt && <small title="Only the most recent output was replayed into this view. The full recording is kept.">Earlier output skipped</small>}
      {session?.recordingDeletedAt && <small>Recording deleted</small>}
      {options.agentMenu ? <>
        {options.resume && session && ['lost', 'failed'].includes(session.state) && <button disabled={busy} onClick={() => { void action(options.resume!); }}>Resume</button>}
        <SessionMenu open={active && menuOpen} setOpen={setMenuOpen}
          resume={options.resume && (() => { void action(options.resume!); })} resumeDisabled={busy}
          prompt={() => { void action(async () => setPromptStatus(await options.prompt!('queue'))); }}
          promptDisabled={busy || !options.prompt || session?.state !== 'running' || !!session.stopRequestedAt || promptStatus?.state === 'queued' || promptStatus?.state === 'unavailable'}
          message={options.prompt ? promptStatus?.message ?? 'Adds the workbench guide and current project context with your next prompt. Claude’s own system instructions stay intact.' : 'Adding context to a running session is currently available for Claude.'}
          stop={() => { void requestStop(); }} stopDisabled={stopDisabled} />
      </> : <>
        {options.resume && <button disabled={busy || (options.resumeWhenStopped && (!session || ['running', 'starting'].includes(session.state)))} onClick={() => { void action(options.resume!); }}>{options.resumeLabel ?? 'Resume / reconnect'}</button>}
        <span className="terminal-stop-divider" aria-hidden="true" />
        <button className="session-stop" aria-busy={busy || undefined} disabled={stopDisabled} onClick={() => { void requestStop(); }}>Stop session</button>
      </>}
    </div>;
  return <div className="native-terminal" data-session-state={session?.state ?? 'connecting'}>
    {options.toolbar ? active && createPortal(toolbar, options.toolbar) : toolbar}
    {confirmStop && session?.state === 'running' && !session.stopRequestedAt && <div className="terminal-stop-confirm">
      <InlineConfirm confirmLabel="Stop" keepLabel="Keep running" busy={busy} cancel={() => setConfirmStop(false)} confirm={stop}
        message={<><b>Stop {options.agentName ?? 'the agent'}?</b> The current turn is lost. The conversation and recording are kept, so you can resume later.</>} />
    </div>}
    {(error || readError || promptError) && <div className="terminal-error" role="alert">{error || readError || promptError}</div>}
    {promptStatus && ['queued', 'acknowledged'].includes(promptStatus.state) && <div className="terminal-prompt-status" role="status">{promptStatus.message}</div>}
    <div className="terminal-content" aria-busy={replaying || undefined}><TerminalSurface channel={channel} active={active} nativeShiftEnter={options.agentMenu} readOnly={Boolean(session?.readOnly) || session?.state !== 'running'} /></div>
  </div>;
}

export function mountNativeTerminal(sessionId: string, container: HTMLElement, options: TerminalOptions = {}) {
  const toolbar = options.inlineToolbar ? undefined : container.closest('[data-expanded-item-id],[data-item-id]')?.querySelector<HTMLElement>('.session-toolbar-slot') ?? undefined;
  const root = createRoot(container, rootErrorOptions); let active = true;
  const render = () => root.render(<ErrorBoundary fallback={(error, reset) => <PanelError error={error} retry={reset} />}><NativeTerminal sessionId={sessionId} active={active} options={{ ...options, toolbar }} /></ErrorBoundary>);
  render();
  return { setActive(value: boolean) { active = value; render(); }, dispose() { root.unmount(); } };
}

