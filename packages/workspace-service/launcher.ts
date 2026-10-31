import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareWorkspace } from './paths.ts';
import { connectWorkspace } from './client.ts';

export async function ensureWorkspace(directory: string, executable: string, entrypoint: string, electronRuntime = false, signal?: AbortSignal) {
  return ensureLocalService(directory, executable, entrypoint, electronRuntime, connectWorkspace, signal);
}

export async function ensureLocalService<T>(directory: string, executable: string, entrypoint: string, electronRuntime: boolean, connect: (directory: string, signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const paths = prepareWorkspace(directory);
  try { return await connect(directory, signal); } catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
  signal?.throwIfAborted();
  const logEntry = extname(entrypoint) === '.ts'
    ? join(dirname(entrypoint), '../diagnostics/log-entry.ts')
    : join(dirname(entrypoint), 'service-log.cjs');
  if (!existsSync(logEntry)) throw new Error('Service log launcher is missing. Rebuild or reinstall the app.');
  const child = spawn(executable, [logEntry, entrypoint], { detached: true, stdio: 'ignore', windowsHide: true, env: {
    ...process.env, ACT_DATA_DIR: paths.dataDirectory, ...(electronRuntime ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  } });
  child.unref();
  let spawnError: Error | undefined;
  child.on('error', error => { spawnError = error; });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (spawnError) throw spawnError;
    if (child.exitCode !== null && child.exitCode !== 0) throw new Error(`Workspace service did not start (exit ${child.exitCode}). See ${join(paths.dataDirectory, 'service.log')}. If the log is missing, check data-directory permissions and available disk space.`);
    try { return await connect(directory, signal); } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    await delay(50, undefined, { signal });
  }
  throw new Error(`Workspace service did not start. See ${join(paths.dataDirectory, 'service.log')}`);
}
