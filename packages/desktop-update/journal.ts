import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type FileIdentity = { dev: number; ino: number };
export type InstallIntent = {
  version: 1; id: string; destination: string; phase: 'copying' | 'ready'; staging: FileIdentity;
  original?: { app: FileIdentity; contents: FileIdentity };
  prepared?: { app: FileIdentity; contents: FileIdentity };
};

function identity(value: unknown): value is FileIdentity {
  if (!value || typeof value !== 'object') return false;
  const item = value as FileIdentity;
  return Number.isSafeInteger(item.dev) && item.dev >= 0 && Number.isSafeInteger(item.ino) && item.ino > 0;
}
function bundle(value: unknown) {
  return value && typeof value === 'object' && identity((value as InstallIntent['original'])?.app) && identity((value as InstallIntent['original'])?.contents);
}

/** A process lease serializes installers; committed intent survives SIGKILL.
 * A reused live PID refuses takeover rather than risking a concurrent installer. */
export class InstallJournal {
  private db: DatabaseSync;
  private owner = randomUUID();
  private destination: string;
  constructor(parent: string, destination: string) {
    this.destination = destination;
    const key = createHash('sha256').update(destination).digest('hex').slice(0, 16);
    const path = join(parent, `.app-install-${key}.sqlite`);
    const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe installer journal');
    } finally { closeSync(fd); }
    chmodSync(path, 0o600);
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=2000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
      const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
      if (version > 1) throw new Error('Installer journal is from a newer version');
      this.db.exec('CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL, pid INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS pending (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); PRAGMA user_version=1');
      const previous = this.db.prepare('SELECT pid FROM owner WHERE id=1').get();
      if (previous) {
        let alive = true;
        try { process.kill(Number(previous.pid), 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
        if (alive) throw new Error('Another installer is already running');
      }
      this.db.prepare('INSERT OR REPLACE INTO owner VALUES(1,?,?)').run(this.owner, process.pid);
      this.db.exec('COMMIT');
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} this.db.close(); throw error; }
  }
  read(): InstallIntent | undefined {
    const row = this.db.prepare('SELECT body FROM pending WHERE id=1').get();
    if (!row) return;
    const raw = String(row.body);
    if (raw.length > 4096) throw new Error('Invalid installer recovery record');
    const data = JSON.parse(raw) as InstallIntent;
    if (!data || data.version !== 1 || data.destination !== this.destination ||
      !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(data.id) ||
      !['copying', 'ready'].includes(data.phase) || !identity(data.staging) ||
      (data.original !== undefined && !bundle(data.original)) ||
      (data.prepared !== undefined && !bundle(data.prepared)) ||
      (data.phase === 'ready' && !data.prepared)) throw new Error('Invalid installer recovery record');
    return data;
  }
  write(intent: InstallIntent) { this.db.prepare('INSERT OR REPLACE INTO pending VALUES(1,?)').run(JSON.stringify(intent)); }
  clear() { this.db.exec('DELETE FROM pending WHERE id=1'); }
  close() {
    try { this.db.prepare('DELETE FROM owner WHERE token=?').run(this.owner); }
    finally { this.db.close(); }
  }
}
