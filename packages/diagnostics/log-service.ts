import { spawn } from 'node:child_process';
import { chmodSync, closeSync, constants, lstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { RotatingLog } from './rotating-log.ts';
import { DEFAULT_LOG_POLICY, logPolicySchema } from '../core/log-policy.ts';

/** One detached log owner per service directory. The service's own lease still
 * owns RPC/process identity. No renderer, terminal stream or provider request is
 * routed through this process. Its pipes outlive the desktop that launched it. */
export async function runLoggedService(options: { directory: string; entrypoint: string; executable?: string; limit?: number; backups?: number }) {
  const leasePath = join(options.directory, 'diagnostic-owner.sqlite');
  const fd = openSync(leasePath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  closeSync(fd);
  const info = lstatSync(leasePath);
  if (!info.isFile() || info.nlink !== 1) throw new Error('Invalid diagnostic ownership file');
  chmodSync(leasePath, 0o600);
  const db = new DatabaseSync(leasePath), owner = randomUUID();
  let log: RotatingLog | undefined, claimed = false;
  try {
    db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS policy (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1), instance TEXT NOT NULL, pid INTEGER NOT NULL); BEGIN IMMEDIATE');
    const previous = db.prepare('SELECT pid FROM owner WHERE id=1').get();
    if (previous) {
      let alive = true;
      try { process.kill(Number(previous.pid), 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
      if (alive) { db.exec('ROLLBACK'); return 0; }
    }
    db.prepare('INSERT OR REPLACE INTO owner(id, instance, pid) VALUES(1, ?, ?)').run(owner, process.pid);
    db.exec('COMMIT'); claimed = true;
    const saved = db.prepare('SELECT body FROM policy WHERE id=1').get();
    const policy = saved ? logPolicySchema.parse(JSON.parse(String(saved.body))) : DEFAULT_LOG_POLICY;
    log = new RotatingLog(join(options.directory, 'service.log'), options.limit ?? policy.fileMiB * 1024 * 1024, options.backups ?? policy.backups);
    // Policy persistence may have won a race with a crash/full disk during file
    // cleanup. Reapply before starting the service, even when the values match.
    log.reconfigure(options.limit ?? policy.fileMiB * 1024 * 1024, options.backups ?? policy.backups, true);
    const child = spawn(options.executable ?? process.execPath, [options.entrypoint], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: process.env });
    let loggingFailed = false;
    const write = (data: Buffer | string) => {
      try { log!.write(data); } catch { loggingFailed = true; }
      // A full disk or unreadable log must not stop a user's ongoing work. Keep
      // draining both pipes even when diagnostics cannot be written.
    };
    child.stdout!.on('data', write); child.stderr!.on('data', write);
    child.on('message', message => {
      if (!message || typeof message !== 'object' || !('kind' in message) || message.kind !== 'diagnostic-policy' || !('policy' in message)) return;
      const parsed = logPolicySchema.safeParse(message.policy); if (!parsed.success) return;
      try {
        db.prepare('INSERT OR REPLACE INTO policy(id,body) VALUES(1,?)').run(JSON.stringify(parsed.data));
        log!.reconfigure(parsed.data.fileMiB * 1024 * 1024, parsed.data.backups);
      } catch { loggingFailed = true; }
    });
    const terminate = () => child.kill('SIGTERM'), interrupt = () => child.kill('SIGINT');
    process.on('SIGTERM', terminate); process.on('SIGINT', interrupt);
    try {
      return await new Promise<number>(resolve => {
        child.once('error', error => write(`Service process could not start (${(error as NodeJS.ErrnoException).code ?? 'unknown'}).\n`));
        child.once('close', (code, signal) => {
          write(`Service stopped (${signal ?? code ?? 'unknown'})${loggingFailed ? '; diagnostic output was incomplete' : ''}.\n`);
          resolve(code !== null && code >= 0 ? code : 1);
        });
      });
    } finally { process.off('SIGTERM', terminate); process.off('SIGINT', interrupt); }
  } finally {
    try { log?.close(); } finally {
      try { if (claimed) db.prepare('DELETE FROM owner WHERE instance=?').run(owner); }
      finally { db.close(); }
    }
  }
}
