import { execFileSync } from 'node:child_process';
import { powerShell } from './shell.ts';

const WINDOWS_PROCESS_LIST = `Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.Ticks }`;

/** Windows keeps a parent ID after that parent exits, so a parent younger than its child is a reused ID. */
export function parseWindowsProcesses(output: string) {
  const listed = output.trim().split(/\r?\n/).flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), started: match[3] }] : [];
  });
  const started = new Map(listed.map(process => [process.pid, BigInt(process.started)]));
  return listed.map(process => (started.get(process.parent) ?? 0n) > BigInt(process.started) ? { ...process, parent: 0 } : process);
}

function processes() {
  if (process.platform === 'win32') return parseWindowsProcesses(execFileSync(powerShell(), ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_LIST], { encoding: 'utf8', timeout: 5000, windowsHide: true }));
  return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,lstart='], { encoding: 'utf8', timeout: 2000 }).trim().split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), started: match[3] }] : [];
  });
}

/** Stop tools and shell jobs belonging to this PTY, including separate job-control groups. */
function stopDescendants(parent: number, preservePids: number[] = []) {
  const all = processes(), owned = new Set([parent]);
  for (let changed = true; changed;) {
    changed = false;
    for (const process of all) if (owned.has(process.parent) && !owned.has(process.pid) && !preservePids.includes(process.pid)) { owned.add(process.pid); changed = true; }
  }
  const children = all.filter(process => process.pid !== parent && owned.has(process.pid));
  const signal = (name: NodeJS.Signals) => {
    const current = processes();
    for (const child of children) {
      // Never signal a reused PID after the original child has exited.
      if (!current.some(process => process.pid === child.pid && process.started === child.started)) continue;
      try { process.kill(child.pid, name); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
  };
  signal('SIGTERM');
  return () => signal('SIGKILL');
}

/** Stops a pseudo-terminal's process. node-pty refuses signals on Windows, where only the first request does anything. */
export function killPty(pty: { kill(signal?: string): void }, signal: NodeJS.Signals, platform: NodeJS.Platform = process.platform) {
  if (platform !== 'win32') { pty.kill(signal); return; }
  if (signal === 'SIGTERM') pty.kill();
}

const STOP_GRACE_MS = 1000;
export interface ProcessTreeStop { settle(): void }

/** Asks a process and its descendants to stop, and forces them after a grace period. Call `settle` once the process has exited.
 * Windows has no stop request: `process.kill` ends a process at once with any signal, so there the grace period does nothing. */
export function stopProcessTree(target: { pid: number; kill(signal: NodeJS.Signals): void }, preservePids: number[] = []): ProcessTreeStop {
  // Failing to list descendants must not leave the process itself running.
  let finish = () => {};
  try { finish = stopDescendants(target.pid, preservePids); } catch { /* The process is still stopped below. */ }
  target.kill('SIGTERM');
  const force = setTimeout(() => { finish(); target.kill('SIGKILL'); }, STOP_GRACE_MS);
  return { settle() { clearTimeout(force); finish(); } };
}
