import { prepareNativeDriver } from './native-driver.ts';
import type { NativeDriver } from './native-driver.ts';
import { sessionPath } from '../platform/shell.ts';
import { terminalLocale } from './terminal-locale.ts';
import { logPolicySchema, publishLogPolicy } from '../core/log-policy.ts';
import { spawn } from 'node-pty';
import type { IPty } from 'node-pty';
import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, dirname, extname } from 'node:path';
import { prepareWorkspace } from '../workspace-service/paths.ts';
import { serveLocal } from '../workspace-service/local-rpc.ts';
import type { RpcPeer } from '../workspace-service/local-rpc.ts';
import { RuntimeJournal } from './journal.ts';
import { managedSessionsSchema, sessionPageSchema, manageSessionSchema, launchSchema, inputSchema, resizeSchema, sessionIdSchema, readSessionSchema, stopSessionSchema, recordingsSchema, deleteRecordingSchema } from './protocol.ts';
import type { OutputChunk, SessionSnapshot, SessionEvent, SessionRecord } from './protocol.ts';
import { stopProcessTree } from '../platform/process-tree.ts';
import type { ProcessTreeStop } from '../platform/process-tree.ts';
import { outputSuffix } from './output-tail.ts';
import { isDecisiveInput } from './decisive-input.ts';
import { HeadlessTerminal } from './terminal-identity.ts';

export const OUTPUT_BYTES = 256 * 1024;
type Live = { pty: IPty; ended: Promise<void>; stopping?: ProcessTreeStop };
type BufferState = { chunks: OutputChunk[]; bytes: number; sequence: number; timer?: ReturnType<typeof setTimeout>; truncated: boolean; pending: OutputChunk[]; pendingBytes: number };

export async function startSupervisor(directory: string) {
  const paths = prepareWorkspace(directory), instanceId = randomUUID();
  const journal = new RuntimeJournal(join(directory, 'supervisor.sqlite'), instanceId);
  const spoolDirectory = join(directory, 'scrollback');
  let cacheWarning = false;
  const warnCache = (error: unknown) => {
    if (cacheWarning) return; cacheWarning = true;
    const code = (error as NodeJS.ErrnoException).code ?? '';
    const safeCode = ['EACCES', 'EPERM', 'EISDIR', 'ENOSPC', 'EROFS', 'ENOTDIR', 'EIO', 'EMFILE', 'ENFILE'].includes(code) ? code : 'IO_ERROR';
    process.stderr.write(`Terminal tail cache unavailable (${safeCode}); using SQLite recordings.\n`);
  };
  try { mkdirSync(spoolDirectory, { recursive: true, mode: 0o700 }); } catch (error) { warnCache(error); }
  const launches = new Set<Promise<void>>();
  const preparing = new Map<string, { abort: AbortController; done: Promise<void> }>();
  const live = new Map<string, Live>(), buffers = new Map<string, BufferState>(), events = new EventEmitter();
  events.setMaxListeners(100);
  let closing = false;
  const spoolPath = (id: string) => join(spoolDirectory, createHash('sha256').update(id).digest('hex') + '.json');
  const deletedRecordings = new Set(journal.list().filter(session => session.recordingDeletedAt).map(session => session.id));
  const cleanRecordingCache = (id: string) => {
    let pending = false;
    for (const file of [spoolPath(id), spoolPath(id) + '.tmp']) try { rmSync(file, { force: true }); } catch { pending = true; }
    return pending;
  };
  // A durable tombstone wins even if a crash interrupted cache removal.
  for (const id of deletedRecordings) cleanRecordingCache(id);
  const bufferFor = (id: string): BufferState => {
    let buffer = buffers.get(id);
    if (!buffer) {
      buffer = { chunks: [], bytes: 0, sequence: 0, truncated: false, pending: [], pendingBytes: 0 };
      if (deletedRecordings.has(id)) { buffers.set(id, buffer); return buffer; }
      // Only old sessions need a file import. Current recordings are authoritative
      // in SQLite even if the cache is stale, corrupt, absent or unwritable.
      if (journal.get(id).recordingComplete === undefined) {
        try {
          const file = spoolPath(id);
          if (statSync(file).size < OUTPUT_BYTES * 8) {
            const saved = JSON.parse(readFileSync(file, 'utf8'));
            if (Array.isArray(saved.chunks) && saved.chunks.every((chunk: OutputChunk) => Number.isSafeInteger(chunk.sequence) && typeof chunk.data === 'string')) {
              buffer.chunks = saved.chunks; buffer.sequence = saved.sequence; buffer.truncated = Boolean(saved.truncated);
              buffer.bytes = buffer.chunks.reduce((count, chunk) => count + Buffer.byteLength(chunk.data), 0);
              while (buffer.bytes > OUTPUT_BYTES && buffer.chunks.length) { buffer.bytes -= Buffer.byteLength(buffer.chunks.shift()!.data); buffer.truncated = true; }
            }
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') buffer.truncated = true; }
        // Import the old retained tail once. Missing earlier bytes stay explicitly marked.
        journal.append(id, buffer.chunks);
        journal.update(id, { recordingComplete: !buffer.truncated && buffer.chunks.length > 0 });
      }
      Object.assign(buffer, journal.tail(id, OUTPUT_BYTES, 4096));
      buffers.set(id, buffer);
    }
    return buffer;
  };
  const flush = (id: string) => {
    const buffer = bufferFor(id); clearTimeout(buffer.timer); buffer.timer = undefined;
    if (!buffer.pending.length) return;
    journal.append(id, buffer.pending); buffer.pending = []; buffer.pendingBytes = 0;
    const path = spoolPath(id), temporary = path + '.tmp';
    try {
      writeFileSync(temporary, JSON.stringify({ chunks: buffer.chunks, sequence: buffer.sequence, truncated: buffer.truncated }), { mode: 0o600 });
      renameSync(temporary, path);
    } catch (error) { warnCache(error); } // The durable append above already succeeded.
  };
  const emitState = (session: SessionRecord) => events.emit('session', { kind: 'state', session } satisfies SessionEvent);
  const output = (id: string, data: string) => {
    if (deletedRecordings.has(id)) return;
    const buffer = bufferFor(id), chunk = { sequence: ++buffer.sequence, data };
    buffer.pending.push(chunk); buffer.pendingBytes += Buffer.byteLength(data);
    const retained = { ...chunk }; buffer.chunks.push(retained); buffer.bytes += Buffer.byteLength(data);
    while ((buffer.bytes > OUTPUT_BYTES || buffer.chunks.length > 4096) && buffer.chunks.length > 1) { buffer.bytes -= Buffer.byteLength(buffer.chunks.shift()!.data); buffer.truncated = true; }
    if (buffer.bytes > OUTPUT_BYTES) { retained.data = outputSuffix(data, OUTPUT_BYTES); buffer.bytes = Buffer.byteLength(retained.data); buffer.truncated = true; }
    if (buffer.pendingBytes >= OUTPUT_BYTES) flush(id);
    else if (!buffer.timer) buffer.timer = setTimeout(() => flush(id), 200);
    events.emit('session', { kind: 'output', sessionId: id, chunk } satisfies SessionEvent);
  };
  const decisive = new Map<string, { at: number; sequence: number }>();
  const record = (id: string): SessionRecord => {
    const session = journal.get(id), input = decisive.get(id);
    return input ? { ...session, decisiveInputAt: input.at, decisiveInputSequence: input.sequence } : session;
  };
  const snapshot = (id: string): SessionSnapshot => {
    const buffer = bufferFor(id), session = record(id);
    return { session, chunks: [...buffer.chunks], firstSequence: buffer.chunks[0]?.sequence ?? buffer.sequence + 1, lastSequence: buffer.sequence, truncated: buffer.truncated };
  };
  const stop = async (id: string, preservePids: number[] = []) => {
    const current = journal.get(id), pending = preparing.get(id);
    if (['starting', 'running'].includes(current.state) && !current.stopRequestedAt) emitState(journal.update(id, { stopRequestedAt: new Date().toISOString() }));
    if (pending && !live.has(id)) {
      pending.abort.abort(new Error('Session stopped before launch'));
      await pending.done; // Cleanup must finish before announcing a stopped session.
      return journal.get(id);
    }
    const running = live.get(id);
    if (running && !running.stopping) {
      // Freeze the readable screen before native CLI teardown clears its alternate buffer.
      emitState(journal.update(id, { displayThroughSequence: bufferFor(id).sequence }));
      flush(id);
      running.stopping = stopProcessTree({ pid: running.pty.pid, kill: signal => { if (live.has(id)) running.pty.kill(signal); } }, [process.pid, ...preservePids]);
    }
    return journal.get(id);
  };
  const subscriptions = new Map<RpcPeer, Map<string, (event: SessionEvent) => void>>();
  const watched = (sessionId: string) => { for (const attached of subscriptions.values()) if (attached.has(sessionId)) return true; return false; };
  const server = await serveLocal(paths.socket, paths.secret, async (method, input, peer) => {
    if (closing) throw new Error('Session supervisor is shutting down');
    switch (method) {
      case 'hello': return { protocol: 1, service: 'sessions', instanceId, pid: process.pid };
      case 'diagnostics.configure': { const policy = logPolicySchema.parse(input); publishLogPolicy(policy); return policy; }
      case 'recordings.list': {
        const page = journal.recordings(recordingsSchema.parse(input).before);
        for (const entry of page.recordings) {
          const cached = existsSync(spoolPath(entry.id)) || existsSync(spoolPath(entry.id) + '.tmp');
          if (entry.deletedAt) entry.cleanupPending = cached;
          else entry.hasOutput ||= cached;
        }
        return page;
      }
      case 'recordings.delete': {
        const { sessionId } = deleteRecordingSchema.parse(input);
        if (live.has(sessionId)) throw Object.assign(new Error('Stop the session before deleting its recording'), { code: 'SESSION_RUNNING' });
        const session = journal.deleteRecording(sessionId);
        deletedRecordings.add(sessionId); clearTimeout(buffers.get(sessionId)?.timer); buffers.delete(sessionId);
        const cleanupPending = cleanRecordingCache(sessionId); emitState(session);
        return { session, cleanupPending };
      }
      case 'sessions.list': return journal.list();
      case 'sessions.managed': return journal.managed(managedSessionsSchema.parse(input).view);
      case 'sessions.page': return journal.page(sessionPageSchema.parse(input));
      case 'sessions.manage': {
        const { sessionId, action, preservePids } = manageSessionSchema.parse(input), session = journal.manage(sessionId, action);
        emitState(session);
        if (action === 'archive' && session.stopOnArchive) return stop(sessionId, preservePids);
        return session;
      }
      case 'sessions.read': {
        const { sessionId, after, history, through, tail } = readSessionSchema.parse(input);
        if (history) {
          const buffer = bufferFor(sessionId);
          const session = record(sessionId), end = Math.min(buffer.sequence, session.displayThroughSequence ?? Infinity, through ?? Infinity);
          // A tail read skips older output beyond its byte budget; later pages continue by sequence.
          const start = tail ? journal.replayStart(sessionId, after ?? 0, end, tail, buffer.pending) : undefined;
          const chunks = journal.history(sessionId, start ? start.sequence - 1 : after ?? 0, end, buffer.pending), last = chunks.at(-1)?.sequence ?? Math.min(after ?? 0, end);
          if (start && chunks[0]?.sequence === start.sequence) chunks[0] = { sequence: start.sequence, data: start.prefix + chunks[0].data.slice(start.offset) };
          return { session, chunks, firstSequence: chunks[0]?.sequence ?? last + 1, lastSequence: last, recordingEnd: Math.min(buffer.sequence, session.displayThroughSequence ?? Infinity), hasMore: last < end, truncated: !session.recordingComplete && !session.recordingDeletedAt, ...(start ? { replayFrom: start.sequence } : {}) } satisfies SessionSnapshot;
        }
        const current = snapshot(sessionId);
        if (after !== undefined) current.chunks = current.chunks.filter(chunk => chunk.sequence > after);
        return current;
      }
      case 'sessions.launch': {
        const request = launchSchema.parse(input);
        if (!isAbsolute(request.executable) || !isAbsolute(request.cwd)) throw new Error('Executable and working directory must be absolute paths');
        // Deduplicate before any external action. Lost/failed IDs never relaunch silently.
        const reservation = journal.reserve(request);
        if (!reservation.fresh) return snapshot(reservation.session.id);
        const abort = new AbortController(), { signal } = abort;
        let prepared!: () => void;
        preparing.set(request.sessionId, { abort, done: new Promise<void>(resolve => { prepared = resolve; }) });
        const launch = async () => {
        let native: NativeDriver | undefined;
        try {
          if (live.size + launches.size >= 32) throw new Error('The local supervisor supports up to 32 simultaneous sessions');
          accessSync(request.executable, constants.X_OK);
          if (!statSync(request.cwd).isDirectory()) throw new Error('Working directory is not a directory');
          // Listing/replaying recordings and serving the idle table need no shell
          // profile. Resolve its potentially slow PATH only for a fresh launch.
          const environment = terminalLocale({ ...process.env, PATH: await sessionPath() });
          signal.throwIfAborted();
          for (const key of Object.keys(environment)) if (key.startsWith('ACT_') || ['ELECTRON_RUN_AS_NODE', 'NO_COLOR', 'FORCE_COLOR', 'CLICOLOR', 'CLICOLOR_FORCE'].includes(key)) delete environment[key];
          Object.assign(environment, request.bindings, { TERM: 'xterm-256color', COLORTERM: 'truecolor' });
          native = await prepareNativeDriver(request, environment,
            state => { if (!signal.aborted) emitState(journal.update(request.sessionId, { native: state })); },
            error => {
              emitState(journal.update(request.sessionId, { error: error.message, native: { ...journal.get(request.sessionId).native!, status: 'error', observedAt: new Date().toISOString() } }));
              output(request.sessionId, '\r\nCodex disconnected. Stop and resume this conversation to reconnect.\r\n'); void stop(request.sessionId);
            }, { executable: process.execPath, entrypoint: join(dirname(process.argv[1]), `native-process-owner${extname(process.argv[1])}`), electron: Boolean(process.versions.electron) }, signal);
          signal.throwIfAborted();
          if (journal.get(request.sessionId).error) throw new Error(journal.get(request.sessionId).error);
          // Launch the user's shell unchanged. Legacy capture/replay fields are
          // accepted for durable request compatibility but never executed.
          const pty = spawn(request.executable, native?.args ?? request.args, { name: 'xterm-256color', cwd: request.cwd, cols: request.cols, rows: request.rows, env: environment });
          let end!: () => void;
          const running: Live = { pty, ended: new Promise<void>(resolve => { end = resolve; }) }; live.set(request.sessionId, running);
          // A view's emulator answers the CLI's startup probes; while none watches, answer for it.
          const headless = new HeadlessTerminal();
          pty.onData(data => {
            output(request.sessionId, data);
            const replies = headless.feed(data);
            if (replies && !watched(request.sessionId)) pty.write(replies);
          });
          pty.onExit(({ exitCode, signal }) => {
            void (async () => {
              running.stopping?.settle();
              try { await native?.close(); }
              finally { live.delete(request.sessionId); decisive.delete(request.sessionId); emitState(journal.update(request.sessionId, { state: 'exited', exitCode, signal })); flush(request.sessionId); end(); }
            })().catch(error => { process.stderr.write(`Native session cleanup failed: ${(error as Error).message}\n`); });
          });
          emitState(journal.update(request.sessionId, { state: 'running', pid: pty.pid }));
        } catch (error) { await native?.close(); emitState(journal.update(request.sessionId, signal.aborted ? { state: 'exited', error: undefined } : { state: 'failed', error: (error as Error).message })); }
        };
        const pending = launch(); launches.add(pending);
        try { await pending; } finally { launches.delete(pending); preparing.delete(request.sessionId); prepared(); }
        return snapshot(request.sessionId);
      }
      case 'sessions.attach': {
        const { sessionId } = sessionIdSchema.parse(input); const current = snapshot(sessionId);
        let attached = subscriptions.get(peer);
        if (!attached) {
          attached = new Map(); subscriptions.set(peer, attached);
          peer.onClose(() => { for (const handler of subscriptions.get(peer)?.values() ?? []) events.off('session', handler); subscriptions.delete(peer); });
        }
        if (!attached.has(sessionId)) {
          const handler = (event: SessionEvent) => { if ((event.kind === 'output' ? event.sessionId : event.session.id) === sessionId) peer.notify('session', event); };
          attached.set(sessionId, handler); events.on('session', handler);
        }
        return current;
      }
      case 'sessions.detach': {
        const { sessionId } = sessionIdSchema.parse(input); const handler = subscriptions.get(peer)?.get(sessionId);
        if (handler) events.off('session', handler); subscriptions.get(peer)?.delete(sessionId); return {};
      }
      case 'sessions.input': { const request = inputSchema.parse(input), running = live.get(request.sessionId); if (!running) throw new Error('Session has no live process'); if (journal.get(request.sessionId).readOnly) throw new Error('One-off analysis sessions do not accept terminal input');
        if (request.source === 'user' && request.encoding !== 'binary' && isDecisiveInput(request.data)) decisive.set(request.sessionId, { at: Date.now(), sequence: bufferFor(request.sessionId).sequence });
        running.pty.write(request.encoding === 'binary' ? Buffer.from(request.data, 'latin1') : request.data); return {}; }
      case 'sessions.resize': { const request = resizeSchema.parse(input), running = live.get(request.sessionId); if (!running) throw new Error('Session has no live process'); running.pty.resize(request.cols, request.rows); return journal.update(request.sessionId, { cols: request.cols, rows: request.rows }); }
      case 'sessions.stop': { const request = stopSessionSchema.parse(input); return stop(request.sessionId, request.preservePids); }
      case 'admin.shutdown': setTimeout(() => { void close(); }, 50); return {};
      default: throw new Error('Unknown supervisor method');
    }
  }).catch(error => { journal.close(); throw error; });
  async function close() {
    if (closing) return; closing = true;
    await Promise.allSettled([...launches]);
    await Promise.all([...live.keys()].map(id => stop(id)));
    await Promise.all([...live.values()].map(session => session.ended));
    for (const id of buffers.keys()) flush(id);
    await server.close(); journal.close();
  }
  return { close, instanceId };
}
