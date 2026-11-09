import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { powerShell } from './shell.ts';

let linuxBootId: string | undefined;

function linuxProcessStart(pid: number) {
  let status: string, stat: string;
  try { status = readFileSync(`/proc/${pid}/status`, 'utf8'); stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); }
  catch (error) { if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined; throw error; }
  // Linux also opens /proc/<id> for a thread ID, and `kill(id, 0)` accepts it.
  if (status.match(/^Tgid:\s*(\d+)$/m)?.[1] !== String(pid)) return undefined;
  // Field 22 counts clock ticks since boot, so the boot ID keeps it unique after a restart.
  const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  linuxBootId ??= readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  return `${linuxBootId}:${ticks}`;
}

function windowsProcessStart(pid: number) {
  const output = execFileSync(powerShell(), ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CreationDate.Ticks`], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  return output.trim() || undefined;
}

function posixProcessStart(pid: number) {
  try { return execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim() || undefined; }
  catch (error) { if ((error as { status?: number }).status === 1) return undefined; throw error; }
}

/** When the process with this ID started, or undefined when no process has it. Two processes that had the same ID get different values. */
export function processStart(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid process ID');
  if (process.platform === 'linux') return linuxProcessStart(pid);
  if (process.platform === 'win32') return windowsProcessStart(pid);
  return posixProcessStart(pid);
}

/** This process's start, to record next to its ID. Null when it cannot be read, so the record is not lost; `isProcessRunning` then checks the ID only. */
export function currentProcessStart() {
  try { return processStart(process.pid) ?? null; } catch { return null; }
}

/** Whether the process recorded with this ID and start still runs. After a crash or restart the system can give the ID to another process.
 * A record without a start, from an older version, can only show that some process has the ID. A failed lookup counts as running, so a live owner is never replaced. */
export function isProcessRunning(pid: number, started: string | null) {
  let current: string | undefined;
  try { current = processStart(pid); } catch { return true; }
  if (current === undefined) return false;
  return started === null || current === started;
}
