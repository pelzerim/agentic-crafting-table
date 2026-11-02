import { chmodSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import type { Server } from 'node:net';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { isOwnedByCurrentUser } from './private-files.ts';

const isPipe = (path: string) => path.startsWith('\\\\.\\pipe\\');

/** Where one service listens for processes of the same user. Windows has named pipes in place of a socket directory. */
export function localEndpoint(key: string, platform: NodeJS.Platform = process.platform) {
  if (platform === 'win32') return { directory: '', path: `\\\\.\\pipe\\agent-crafting-table-${userInfo().username.replace(/[^\w.-]/g, '_')}-${key}` };
  const uid = process.getuid?.() ?? 'local';
  // macOS has a short Unix socket path limit; Application Support paths can exceed it.
  const directory = join('/tmp', `agent-crafting-table-${uid}`);
  return { directory, path: join(directory, `${key}.sock`) };
}

export function prepareEndpointDirectory(directory: string) {
  if (!directory) return;
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const info = lstatSync(directory);
  if (!info.isDirectory() || !isOwnedByCurrentUser(info)) throw new Error('Workspace socket directory has an invalid owner');
  chmodSync(directory, 0o700);
}

/** The system removes a named pipe with its last handle. */
export const removeEndpoint = (path: string) => { if (!isPipe(path)) rmSync(path, { force: true }); };

/** Replaces a stale endpoint, so the caller must already hold process ownership. */
export async function listenOnEndpoint(server: Server, path: string) {
  removeEndpoint(path);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => { server.removeListener('error', reject); resolve(); }); });
  if (!isPipe(path)) chmodSync(path, 0o600);
}
