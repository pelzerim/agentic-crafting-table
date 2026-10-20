import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function workspacePaths(directory: string) {
  const dataDirectory = resolve(directory);
  const uid = process.getuid?.() ?? 'local';
  // macOS has a short Unix socket path limit; Application Support paths can exceed it.
  const socketDirectory = join('/tmp', `agent-crafting-table-${uid}`);
  const key = createHash('sha256').update(dataDirectory).digest('hex').slice(0, 24);
  return { dataDirectory, socketDirectory, socket: join(socketDirectory, `${key}.sock`), token: join(dataDirectory, '.service-token'), database: join(dataDirectory, 'workspace.sqlite') };
}

export function prepareWorkspace(directory: string) {
  const paths = workspacePaths(directory);
  mkdirSync(paths.dataDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(paths.socketDirectory, { mode: 0o700, recursive: true });
  const info = lstatSync(paths.socketDirectory);
  if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) throw new Error('Workspace socket directory has an invalid owner');
  chmodSync(paths.socketDirectory, 0o700);
  try { writeFileSync(paths.token, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  return { ...paths, secret: readWorkspaceSecret(paths.token) };
}

export function readWorkspaceSecret(file: string) {
  const info = lstatSync(file);
  if (!info.isFile() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077)) throw new Error('Workspace token must be an owner-only regular file');
  const token = readFileSync(file, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid workspace token');
  return token;
}
