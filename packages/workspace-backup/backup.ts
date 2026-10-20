import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as z from 'zod/v4';
import { migrations } from '../workspace-service/sqlite-store.ts';

// Only app-owned durable state is included. Native conversations, OS credentials,
// Electron caches, IPC secrets, diagnostics and prior backups are not exports.
const databases = ['workspace.sqlite', 'runtime/supervisor.sqlite'] as const;
const folders = ['agent-launches', 'review-launches', 'review-resumes', 'comparisons', 'runtime/terminal-launches', 'runtime/scrollback'];
const MAX_ENTRIES = 100_000, MAX_MANIFEST = 32 * 1024 * 1024;
const entrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('file'), path: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/), executable: z.boolean() }).strict(),
  z.object({ type: z.literal('directory'), path: z.string() }).strict(),
  z.object({ type: z.literal('symlink'), path: z.string(), target: z.string().max(4096) }).strict(),
]);
const manifestSchema = z.object({ format: z.literal('agent-crafting-table-backup'), version: z.literal(1), createdAt: z.iso.datetime(), sourceDirectory: z.string(), entries: z.array(entrySchema).min(1).max(MAX_ENTRIES) }).strict();
export type BackupManifest = z.infer<typeof manifestSchema>;
type Entry = z.infer<typeof entrySchema>;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
function exists(path: string) { try { lstatSync(path); return true; } catch (error) { if (missing(error)) return false; throw error; } }
function alive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid saved process identity');
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
function canonical(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); } catch (error) {
    if (!missing(error) || dirname(absolute) === absolute) throw error;
    return join(canonical(dirname(absolute)), relative(dirname(absolute), absolute));
  }
}
const contains = (parent: string, path: string) => { const offset = relative(parent, path); return !offset || (!isAbsolute(offset) && offset !== '..' && !offset.startsWith('../')); };
function disjoint(a: string, b: string) { if (contains(a, b) || contains(b, a)) throw new Error('Source and destination must be separate, non-nested directories'); }
function regular(path: string) {
  const info = lstatSync(path);
  if (!info.isFile() || info.nlink !== 1 || (process.getuid && info.uid !== process.getuid())) throw new Error('Expected an owned regular file without hard links');
  return info;
}
function directory(path: string) {
  const info = lstatSync(path);
  if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) throw new Error('Expected an owned directory, not a symbolic link');
}
function safeParents(root: string, path: string) {
  for (let parent = dirname(path); parent !== root; parent = dirname(parent)) { if (!contains(root, parent)) throw new Error('Path escaped its root'); directory(parent); }
  directory(root);
}
function allowed(path: string) {
  return databases.includes(path as typeof databases[number]) || path === 'runtime' || folders.some(folder => path === folder || path.startsWith(folder + '/'));
}
function validPath(path: string) {
  return !!path && path.length <= 4096 && path.split('/').length <= 128 && !path.includes('\\') && !path.includes('\0') && !isAbsolute(path) && path.split('/').every(part => part && part !== '.' && part !== '..') && allowed(path);
}
function validLink(path: string, target: string) {
  // Recreate links without following them. External/absolute links are not portable
  // and must never pull user files or credentials into the bundle.
  return target && !isAbsolute(target) && !target.includes('\0') && !target.includes('\\') && contains('/backup-data', resolve('/backup-data', dirname(path), target));
}
function fileBytes(source: string, destination?: string) {
  const before = regular(source), input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output: number | undefined;
  try {
    const opened = fstatSync(input);
    if (opened.ino !== before.ino || opened.dev !== before.dev) throw new Error('File changed during backup');
    if (destination) output = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, before.mode & 0o100 ? 0o700 : 0o600);
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(256 * 1024); let bytes = 0, size;
    while ((size = readSync(input, buffer, 0, buffer.length, null))) {
      hash.update(buffer.subarray(0, size)); bytes += size;
      if (output !== undefined) for (let written = 0; written < size;) written += writeSync(output, buffer, written, size - written);
    }
    const after = fstatSync(input);
    if (before.size !== bytes || after.size !== bytes || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('File changed during backup');
    if (output !== undefined) fsyncSync(output);
    return { bytes, sha256: hash.digest('hex'), executable: Boolean(before.mode & 0o100) };
  } finally { closeSync(input); if (output !== undefined) closeSync(output); }
}
function dbCheck(db: DatabaseSync, path: string) {
  const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
  const maximum = path === databases[0] ? migrations.length : 3;
  if (version < 1 || version > maximum) throw new Error('Unsupported database version; use a compatible app before backing up or restoring');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name));
  const required = path === databases[0] ? ['workspace', 'resources', 'nodes', 'links', 'todos'] : ['owner', 'sessions'];
  if (required.some(table => !tables.includes(table))) throw new Error('Backup database is missing required tables');
  const checks = db.prepare('PRAGMA integrity_check').all();
  if (checks.length !== 1 || Object.values(checks[0])[0] !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Backup database integrity check failed');
  return tables;
}
function assertStopped(db: DatabaseSync, path: string, tables: string[]) {
  const table = path === databases[0] ? 'service_owner' : 'owner';
  if (tables.includes(table) && db.prepare(`SELECT pid FROM ${table}`).all().some(row => alive(Number(row.pid)))) throw new Error('Quit the app and stop its services before creating a backup');
  if (path === databases[1]) for (const row of db.prepare('SELECT body FROM sessions').all()) {
    const session = JSON.parse(String(row.body));
    if (['running', 'starting', 'lost'].includes(session.state) && session.pid !== undefined && alive(session.pid)) throw new Error('A recorded session process is still alive; stop it before creating a backup');
  }
}
function privateJson(path: string, value: unknown) {
  const file = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); fsyncSync(file); } finally { closeSync(file); }
}
function reserveOutput(output: string) {
  directory(dirname(output));
  mkdirSync(output, { mode: 0o700 }); // Exclusive; never reuse or overwrite an existing path.
  const identity = lstatSync(output);
  return () => { const current = lstatSync(output); if (current.ino === identity.ino && current.dev === identity.dev) rmSync(output, { recursive: true }); };
}

/** Both stores are locked before owner checks/copies. SQLite serializes service
 * startup claims too. VACUUM's separate read connection includes committed WAL
 * without copying WAL/SHM or modifying source records. No source migration runs. */
export function createBackup(rawSource: string, rawOutput: string, progress?: (phase: 'locked' | 'copied') => void): BackupManifest {
  const source = canonical(rawSource), output = canonical(rawOutput); disjoint(source, output); directory(source);
  // Reject symlink destinations even if their resolved targets do not yet exist.
  if (exists(resolve(rawOutput))) throw new Error('Backup destination already exists');
  const locks: { path: typeof databases[number]; db: DatabaseSync; identity: { ino: number; dev: number } }[] = [];
  let removeOutput: (() => void) | undefined;
  const initiallyPresent = databases.filter(path => exists(join(source, path)));
  if (!initiallyPresent.includes(databases[0])) throw new Error('Workspace database is missing');
  try {
    for (const path of initiallyPresent) {
      const file = join(source, path); safeParents(source, file); const identity = regular(file);
      for (const suffix of ['-wal', '-shm', '-journal']) if (exists(file + suffix)) regular(file + suffix);
      const db = new DatabaseSync(file);
      try { db.exec('PRAGMA busy_timeout=100; BEGIN IMMEDIATE'); }
      catch (error) { db.close(); throw error; }
      locks.push({ path, db, identity });
    }
    for (const { path, db } of locks) assertStopped(db, path, dbCheck(db, path));
    progress?.('locked');
    removeOutput = reserveOutput(output); const data = join(output, 'data'); mkdirSync(data, { mode: 0o700 });
    for (const { path } of locks) {
      mkdirSync(dirname(join(data, path)), { recursive: true, mode: 0o700 });
      const read = new DatabaseSync(join(source, path), { readOnly: true });
      try { read.prepare('VACUUM INTO ?').run(join(data, path)); } finally { read.close(); }
      chmodSync(join(data, path), 0o600);
      const copy = new DatabaseSync(join(data, path));
      try {
        const table = path === databases[0] ? 'service_owner' : 'owner';
        if (dbCheck(copy, path).includes(table)) copy.exec(`DELETE FROM ${table}`);
        copy.exec('PRAGMA journal_mode=DELETE');
      } finally { copy.close(); }
    }
    const entries: Entry[] = [];
    const record = (path: string, copy: boolean) => {
      if (entries.length >= MAX_ENTRIES || !validPath(path)) throw new Error('Workspace backup exceeds supported file count or path limits');
      const from = join(copy ? source : data, path), to = join(data, path), stat = lstatSync(from);
      if (stat.isDirectory()) {
        if (copy) mkdirSync(to, { recursive: true, mode: 0o700 });
        entries.push({ type: 'directory', path });
        for (const child of readdirSync(from).sort()) record(path + '/' + child, copy);
      } else if (stat.isSymbolicLink()) {
        const target = readlinkSync(from);
        if (!validLink(path, target)) throw new Error('Workspace contains an external symbolic link; no backup was published');
        if (copy) symlinkSync(target, to);
        entries.push({ type: 'symlink', path, target });
      } else entries.push({ type: 'file', path, ...fileBytes(from, copy ? to : undefined) });
    };
    // Snapshot entries first, then copy only known durable auxiliary folders.
    record(databases[0], false);
    if (exists(join(data, 'runtime'))) record('runtime', false);
    for (const folder of folders) if (exists(join(source, folder))) {
      safeParents(source, join(source, folder)); directory(join(source, folder));
      if (folder.startsWith('runtime/') && !entries.some(entry => entry.path === 'runtime')) { mkdirSync(join(data, 'runtime'), { mode: 0o700 }); entries.push({ type: 'directory', path: 'runtime' }); }
      record(folder, true);
    }
    // A concurrently starting first supervisor may create its DB before claiming
    // ownership. Reject that changing profile instead of publishing a partial pair.
    if (databases.some(path => exists(join(source, path)) !== initiallyPresent.includes(path))) throw new Error('Workspace changed during backup; quit the app and retry');
    for (const { path, identity } of locks) { const current = regular(join(source, path)); if (current.ino !== identity.ino || current.dev !== identity.dev) throw new Error('Workspace database was replaced during backup'); }
    const manifest: BackupManifest = { format: 'agent-crafting-table-backup', version: 1, createdAt: new Date().toISOString(), sourceDirectory: source, entries: entries.sort((a, b) => a.path.localeCompare(b.path)) };
    const encoded = JSON.stringify(manifest); if (Buffer.byteLength(encoded) * 2 > MAX_MANIFEST) throw new Error('Backup manifest exceeds the size limit');
    progress?.('copied');
    privateJson(join(output, 'manifest.pending'), manifest);
    renameSync(join(output, 'manifest.pending'), join(output, 'manifest.json')); // Last: incomplete copies are never valid backups.
    return manifest;
  } catch (error) { removeOutput?.(); throw error; }
  finally { for (const { db } of locks.reverse()) { try { db.exec('ROLLBACK'); } finally { db.close(); } } }
}

export function verifyBackup(rawBackup: string): BackupManifest {
  const backup = canonical(rawBackup); directory(backup); const data = join(backup, 'data'); directory(data);
  const manifestPath = join(backup, 'manifest.json');
  if (regular(manifestPath).size > MAX_MANIFEST) throw new Error('Backup manifest exceeds the size limit');
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
  if (!isAbsolute(manifest.sourceDirectory)) throw new Error('Invalid source directory in backup');
  const byPath = new Map<string, Entry>();
  for (const entry of manifest.entries) {
    if (!validPath(entry.path) || byPath.has(entry.path)) throw new Error('Invalid or duplicate backup path');
    byPath.set(entry.path, entry);
  }
  if (byPath.get(databases[0])?.type !== 'file') throw new Error('Backup has no workspace database');
  for (const path of databases) if (byPath.has(path) && byPath.get(path)?.type !== 'file') throw new Error('Backup database must be a regular file');
  for (const path of ['runtime', ...folders]) if (byPath.has(path) && byPath.get(path)?.type !== 'directory') throw new Error('Backup folder must be a directory');
  for (const entry of manifest.entries) {
    for (let parent = dirname(entry.path); parent !== '.'; parent = dirname(parent)) if (byPath.get(parent)?.type !== 'directory') throw new Error('Backup path has a missing or unsafe parent');
    const path = join(data, entry.path); safeParents(data, path);
    if (entry.type === 'directory') directory(path);
    else if (entry.type === 'symlink') { if (!validLink(entry.path, entry.target) || !lstatSync(path).isSymbolicLink() || readlinkSync(path) !== entry.target) throw new Error('Backup symbolic link mismatch'); }
    else {
      const actual = fileBytes(path);
      if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256 || actual.executable !== entry.executable) throw new Error('Backup file checksum or mode mismatch');
      if (databases.includes(entry.path as typeof databases[number])) {
        const db = new DatabaseSync(path, { readOnly: true }); try { dbCheck(db, entry.path); } finally { db.close(); }
      }
    }
  }
  const inspect = (relativePath: string) => {
    for (const name of readdirSync(join(data, relativePath))) {
      const path = relativePath ? relativePath + '/' + name : name, entry = byPath.get(path);
      if (!entry) throw new Error('Backup contains an unlisted file');
      if (entry.type === 'directory') inspect(path);
    }
  };
  inspect(''); return manifest;
}

/** Produces a separate recovery copy. It cannot activate/overwrite a profile,
 * launch a session, load repository code or contact a provider. */
export function prepareRecovery(rawBackup: string, rawOutput: string) {
  const backup = canonical(rawBackup), output = canonical(rawOutput), manifest = verifyBackup(backup);
  disjoint(backup, output); disjoint(canonical(manifest.sourceDirectory), output);
  if (exists(resolve(rawOutput))) throw new Error('Recovery destination already exists');
  const removeOutput = reserveOutput(output), profile = join(output, 'profile');
  try {
    mkdirSync(profile, { mode: 0o700 });
    const entries = [...manifest.entries].sort((a, b) => a.path.split('/').length - b.path.split('/').length);
    for (const entry of entries.filter(entry => entry.type === 'directory')) mkdirSync(join(profile, entry.path), { mode: 0o700 });
    for (const entry of entries.filter(entry => entry.type === 'file')) {
      const from = join(backup, 'data', entry.path); safeParents(join(backup, 'data'), from);
      const actual = fileBytes(from, join(profile, entry.path));
      if (actual.sha256 !== entry.sha256 || actual.bytes !== entry.bytes || actual.executable !== entry.executable) throw new Error('Backup changed while preparing recovery');
    }
    for (const entry of entries) if (entry.type === 'symlink') symlinkSync(entry.target, join(profile, entry.path));
    privateJson(join(output, 'READY.json'), { format: 'agent-crafting-table-recovery', version: 1, preparedAt: new Date().toISOString(), sourceDirectory: manifest.sourceDirectory, backupCreatedAt: manifest.createdAt, instruction: 'Keep the app and services stopped. Preserve the existing profile separately before moving profile to sourceDirectory. Native conversation files, working directories, credentials and agent executables must still exist. Opening the recovered profile uses normal startup recovery and may resume saved sessions. This copy has not been activated.' });
    return { profile, sourceDirectory: manifest.sourceDirectory, files: manifest.entries.length };
  } catch (error) { removeOutput(); throw error; }
}
