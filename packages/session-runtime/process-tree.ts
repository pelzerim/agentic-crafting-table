import { execFileSync } from 'node:child_process';

function processes() {
  return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,lstart='], { encoding: 'utf8', timeout: 2000 }).trim().split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), started: match[3] }] : [];
  });
}

/** Stop tools and shell jobs belonging to this PTY, including separate job-control groups. */
export function stopDescendants(parent: number, preservePids: number[] = []) {
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
