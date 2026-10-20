import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync } from 'node:fs';
import { canonical } from '../core/control.ts';
import { outputSuffix } from './output-tail.ts';
import { TerminalModes, restartOffset } from './replay-tail.ts';
import type { LaunchRequest, SessionRecord, OutputChunk, SessionListView, SessionManagementAction, RecordingPage, SessionPage, SessionPageRequest, SessionPageView } from './protocol.ts';

const live = `json_extract(body,'$.state') IN ('starting','running')`;
const pageFilters: Record<SessionPageView, string> = {
  current: `json_extract(body,'$.archivedAt') IS NULL AND ${live}`,
  ended: `json_extract(body,'$.archivedAt') IS NULL AND NOT ${live}`,
  archived: `json_extract(body,'$.archivedAt') IS NOT NULL`,
};
const pageOrder: Record<SessionPageView, string> = { current: 'rowid', ended: `json_extract(body,'$.updatedAt') DESC, rowid DESC`, archived: 'rowid' };

/** Runtime journal is separate from the workspace graph database. */
export class RuntimeJournal {
  private db: DatabaseSync;
  private owner: string;
  private scannedModes = new Map<string, { through: number; modes: TerminalModes }>();
  constructor(path: string, owner: string) {
    this.owner = owner; this.db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600); this.db.exec('PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
      const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
      if (version > 3) throw new Error('Supervisor journal is from a newer app version');
      const backup = path + (version === 1 ? '.before-v2.sqlite' : '.before-v3.sqlite');
      if ([1, 2].includes(version) && !existsSync(backup)) { this.db.prepare('VACUUM INTO ?').run(backup); chmodSync(backup, 0o600); }
      this.db.exec('BEGIN IMMEDIATE');
      this.db.exec('CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1), instance TEXT NOT NULL, pid INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, request TEXT NOT NULL, body TEXT NOT NULL)');
      // v3 requires readers to respect recording-deletion tombstones. Older
      // supervisors must reject a downgrade rather than replay a stale cache.
      this.db.exec('CREATE TABLE IF NOT EXISTS output (session_id TEXT NOT NULL REFERENCES sessions(id), sequence INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id,sequence)); PRAGMA user_version=3');
      const prior = this.db.prepare('SELECT * FROM owner WHERE id=1').get();
      if (prior) {
        let alive = true;
        try { process.kill(Number(prior.pid), 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
        if (alive) throw Object.assign(new Error('Session supervisor is already running'), { code: 'SERVICE_RUNNING' });
      }
      this.db.prepare('INSERT OR REPLACE INTO owner(id,instance,pid) VALUES(1,?,?)').run(owner, process.pid);
      for (const session of this.list()) if (['running', 'starting'].includes(session.state)) this.update(session.id, { state: 'lost', error: 'Supervisor stopped; the process can no longer be attached. Start a new shell or resume the native agent conversation.' });
      this.db.exec('COMMIT');
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} this.db.close(); throw error; }
  }
  list(): SessionRecord[] { return this.db.prepare('SELECT body FROM sessions ORDER BY rowid').all().map(row => JSON.parse(String(row.body))); }
  managed(view: SessionListView = 'active'): SessionRecord[] {
    return this.list().filter(session => !session.removedAt && (view === 'all' || (view === 'archived' ? !!session.archivedAt : !session.archivedAt)));
  }
  /** Filtered in SQLite so a polling view reads only its visible page plus counts. */
  page({ view, offset, limit }: SessionPageRequest): SessionPage {
    const visible = `json_extract(body,'$.removedAt') IS NULL`;
    const row = this.db.prepare(`SELECT ${Object.entries(pageFilters).map(([name, filter]) => `COALESCE(SUM(CASE WHEN ${filter} THEN 1 ELSE 0 END),0) AS ${name}`).join(',')} FROM sessions WHERE ${visible}`).get()!;
    const counts = { current: Number(row.current), ended: Number(row.ended), archived: Number(row.archived) };
    const sessions = this.db.prepare(`SELECT body FROM sessions WHERE ${visible} AND ${pageFilters[view]} ORDER BY ${pageOrder[view]} LIMIT ? OFFSET ?`).all(limit, offset).map(row => JSON.parse(String(row.body)) as SessionRecord);
    return { sessions, total: counts[view], counts };
  }
  manage(id: string, action: SessionManagementAction): SessionRecord {
    const session = this.get(id);
    if (session.removedAt) {
      if (action === 'remove') return session;
      throw Object.assign(new Error('Session was removed from the managed list'), { code: 'SESSION_REMOVED' });
    }
    if (action === 'remove' && ['starting', 'running'].includes(session.state)) throw Object.assign(new Error('Stop the session before removing it'), { code: 'SESSION_RUNNING' });
    if (action === 'remove' && !session.archivedAt) throw Object.assign(new Error('Archive the session before deleting its entry'), { code: 'SESSION_NOT_ARCHIVED' });
    if (action === 'archive') return session.archivedAt ? session : this.update(id, { archivedAt: new Date().toISOString() });
    if (action === 'restore') return session.archivedAt ? this.update(id, { archivedAt: undefined }) : session;
    return this.update(id, { removedAt: new Date().toISOString() });
  }
  get(id: string): SessionRecord { const row = this.db.prepare('SELECT body FROM sessions WHERE id=?').get(id); if (!row) throw Object.assign(new Error('Session not found'), { code: 'SESSION_NOT_FOUND' }); return JSON.parse(String(row.body)); }
  reserve(request: LaunchRequest): { session: SessionRecord; fresh: boolean } {
    const prior = this.db.prepare('SELECT request,body FROM sessions WHERE id=? OR request_id=?').get(request.sessionId, request.requestId);
    if (prior) { if (prior.request !== canonical(request)) throw new Error('Session launch identity was reused with different arguments'); return { session: JSON.parse(String(prior.body)), fresh: false }; }
    let predecessor: SessionRecord | undefined;
    if (request.predecessorId) { try { predecessor = this.get(request.predecessorId); } catch (error) { if ((error as { code?: string }).code !== 'SESSION_NOT_FOUND') throw error; } }
    if (predecessor && (predecessor.nodeId !== request.nodeId || predecessor.workspaceId !== request.workspaceId)) throw new Error('Session predecessor belongs to another item or workspace');
    const now = new Date().toISOString();
    const session: SessionRecord = { id: request.sessionId, requestId: request.requestId, nodeId: request.nodeId, workspaceId: request.workspaceId, cwd: request.cwd, state: 'starting', cols: request.cols, rows: request.rows, createdAt: now, updatedAt: now, recordingComplete: true, ...(request.stopOnArchive ? { stopOnArchive: true } : {}), ...(request.readOnly ? { readOnly: true } : {}), ...(predecessor ? { predecessorId: predecessor.id, ...(!predecessor.removedAt && predecessor.archivedAt ? { archivedAt: predecessor.archivedAt } : {}) } : {}) };
    this.db.prepare('INSERT INTO sessions(id,request_id,request,body) VALUES(?,?,?,?)').run(session.id, session.requestId, canonical(request), JSON.stringify(session));
    return { session, fresh: true };
  }
  update(id: string, patch: Partial<SessionRecord>) { const next = { ...this.get(id), ...patch, updatedAt: new Date().toISOString() }; this.db.prepare('UPDATE sessions SET body=? WHERE id=?').run(JSON.stringify(next), id); return next; }
  recordings(before = Number.MAX_SAFE_INTEGER): RecordingPage {
    const rows = this.db.prepare('SELECT rowid,body,EXISTS(SELECT 1 FROM output WHERE session_id=sessions.id) AS has_output FROM sessions WHERE rowid<? ORDER BY rowid DESC LIMIT 21').all(before);
    const pageSize = Number(this.db.prepare('PRAGMA page_size').get()!.page_size);
    return { allocatedBytes: Number(this.db.prepare('PRAGMA page_count').get()!.page_count) * pageSize,
      reusableBytes: Number(this.db.prepare('PRAGMA freelist_count').get()!.freelist_count) * pageSize,
      ...(rows.length > 20 ? { nextBefore: Number(rows[19].rowid) } : {}),
      recordings: rows.slice(0, 20).map(row => {
        const session: SessionRecord = JSON.parse(String(row.body));
        return { id: session.id, nodeId: session.nodeId, state: session.state, createdAt: session.createdAt, deletedAt: session.recordingDeletedAt, archivedAt: session.archivedAt, removedAt: session.removedAt, hasOutput: Boolean(row.has_output) };
      }) };
  }
  deleteRecording(id: string): SessionRecord {
    const session = this.get(id);
    if (['starting', 'running'].includes(session.state)) throw Object.assign(new Error('Stop the session before deleting its recording'), { code: 'SESSION_RUNNING' });
    if (!session.archivedAt && !session.removedAt) throw Object.assign(new Error('Archive the session before deleting its recording'), { code: 'SESSION_NOT_ARCHIVED' });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM output WHERE session_id=?').run(id); this.scannedModes.delete(id);
      const next = session.recordingDeletedAt ? session : this.update(id, { recordingDeletedAt: new Date().toISOString(), recordingComplete: false });
      this.db.exec('COMMIT'); return next;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  append(id: string, chunks: OutputChunk[]) {
    if (!chunks.length || this.get(id).recordingDeletedAt) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const insert = this.db.prepare('INSERT OR IGNORE INTO output(session_id,sequence,data) VALUES(?,?,?)');
      for (const chunk of chunks) insert.run(id, chunk.sequence, chunk.data);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  history(id: string, after: number, through: number, pending: OutputChunk[] = []) {
    if (through <= after || this.get(id).recordingDeletedAt) return [];
    // Recent output is already in memory. A read must not force an fsync or spool
    // rewrite; the supervisor's bounded batch/exit flush owns recording durability.
    const rows = pending.length && after >= pending[0].sequence - 1 ? []
      : this.db.prepare('SELECT sequence,data FROM output WHERE session_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT 128').all(id, after, through);
    const chunks: OutputChunk[] = []; let bytes = 0;
    for (const row of [...rows, ...pending]) {
      const chunk = { sequence: Number(row.sequence), data: String(row.data) }, size = Buffer.byteLength(chunk.data);
      if (chunk.sequence <= after || chunk.sequence > through) continue;
      if (chunks.length >= 128) break;
      if (chunks.length && bytes + size > 256 * 1024) break;
      chunks.push(chunk); bytes += size;
    }
    return chunks;
  }
  /**
   * Where a bounded replay of (after, through] restarts when that range exceeds
   * maxBytes: a reset or line boundary within the newest maxBytes. Earlier output
   * is only scanned for the terminal modes it leaves behind.
   */
  replayStart(id: string, after: number, through: number, maxBytes: number, pending: OutputChunk[] = []) {
    if (through <= after || this.get(id).recordingDeletedAt) return undefined;
    const recent = pending.filter(chunk => chunk.sequence > after && chunk.sequence <= through);
    const below = recent[0]?.sequence ?? through + 1;
    const stored = (order: 'ASC' | 'DESC', before: number, from = after) => this.db.prepare(`SELECT sequence,data FROM output WHERE session_id=? AND sequence>? AND sequence<? ORDER BY sequence ${order}`).iterate(id, from, before);
    const window: { sequence: number; data: string; original: string }[] = [];
    let bytes = 0, overflow = false;
    const newest = function* () { yield* recent.toReversed(); yield* stored('DESC', below); };
    for (const chunk of newest()) {
      const sequence = Number(chunk.sequence), data = String(chunk.data), size = Buffer.byteLength(data);
      if (bytes + size > maxBytes) {
        if (!window.length) window.push({ sequence, data: outputSuffix(data, maxBytes), original: data });
        overflow = true; break;
      }
      window.push({ sequence, data, original: data }); bytes += size;
    }
    if (!overflow) return undefined;
    window.reverse();
    let offset = restartOffset(window.map(chunk => chunk.data).join('')), index = 0;
    while (index < window.length - 1 && offset >= window[index].data.length) offset -= window[index++].data.length;
    const start = window[index];
    offset += start.original.length - start.data.length;
    // Remounts reuse the modes already scanned from the beginning of the recording.
    const cached = after === 0 ? this.scannedModes.get(id) : undefined, reuse = cached && cached.through < start.sequence;
    const modes = reuse ? cached.modes.clone() : new TerminalModes(), from = reuse ? cached.through : after;
    for (const row of stored('ASC', Math.min(start.sequence, below), from)) modes.scan(String(row.data));
    for (const chunk of recent) if (chunk.sequence > from && chunk.sequence < start.sequence) modes.scan(chunk.data);
    if (after === 0) this.scannedModes.set(id, { through: start.sequence - 1, modes: modes.clone() });
    modes.scan(start.original.slice(0, offset));
    return { sequence: start.sequence, offset, prefix: modes.prefix() };
  }
  lastSequence(id: string): number { return Number(this.db.prepare('SELECT MAX(sequence) AS last FROM output WHERE session_id=?').get(id)!.last ?? 0); }
  /** Read only the newest bounded tail, not the whole recording or a cached copy. */
  tail(id: string, maxBytes: number, maxChunks: number) {
    const session = this.get(id), chunks: OutputChunk[] = [];
    let bytes = 0, sequence = 0, truncated = session.recordingComplete === false;
    if (session.recordingDeletedAt) return { chunks, bytes, sequence, truncated: false };
    for (const row of this.db.prepare('SELECT sequence,data FROM output WHERE session_id=? ORDER BY sequence DESC').iterate(id)) {
      const chunk = { sequence: Number(row.sequence), data: String(row.data) }, size = Buffer.byteLength(chunk.data);
      sequence ||= chunk.sequence;
      if (chunks.length >= maxChunks || (chunks.length && bytes + size > maxBytes)) { truncated = true; break; }
      if (size > maxBytes) {
        chunk.data = outputSuffix(chunk.data, maxBytes);
        truncated = true;
      }
      chunks.push(chunk); bytes += Buffer.byteLength(chunk.data);
      if (truncated && size > maxBytes) break;
    }
    chunks.reverse();
    truncated ||= (chunks[0]?.sequence ?? 0) > 1;
    return { chunks, bytes, sequence, truncated };
  }
  close() { this.db.prepare('DELETE FROM owner WHERE id=1 AND instance=?').run(this.owner); this.db.close(); }
}
