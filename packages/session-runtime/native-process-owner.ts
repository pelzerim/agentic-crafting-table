import { spawn } from 'node:child_process';
import { stopProcessTree } from '../platform/process-tree.ts';
import type { ProcessTreeStop } from '../platform/process-tree.ts';

// A small guardian for native servers that otherwise outlive a crashed supervisor.
// IPC disconnect is an OS-owned lifetime signal, not a timer or PID-name heuristic.
const request = JSON.parse(process.argv[2]) as { executable: string; args: string[]; cwd: string };
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(request.executable, request.args, { cwd: request.cwd, env, stdio: ['ignore', 'ignore', 'inherit'] });
let stopping = false, tree: ProcessTreeStop | undefined;
const stop = () => {
  if (stopping) return; stopping = true;
  if (!child.pid) return;
  tree = stopProcessTree({ pid: child.pid, kill: signal => child.kill(signal) });
};
process.on('disconnect', stop); process.on('SIGTERM', stop); process.on('SIGINT', stop);
child.once('error', error => { process.stderr.write(error.message + '\n'); process.exit(1); });
child.once('exit', code => { tree?.settle(); process.exit(code ?? 1); });
if (!process.connected) stop();
