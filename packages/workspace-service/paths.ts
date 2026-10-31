import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { localEndpoint, prepareEndpointDirectory } from '../platform/local-endpoint.ts';
import { isPrivateFile } from '../platform/private-files.ts';

export function workspacePaths(directory: string) {
  const dataDirectory = resolve(directory);
  const key = createHash('sha256').update(dataDirectory).digest('hex').slice(0, 24);
  const endpoint = localEndpoint(key);
  return { dataDirectory, socketDirectory: endpoint.directory, socket: endpoint.path, token: join(dataDirectory, '.service-token'), database: join(dataDirectory, 'workspace.sqlite') };
}

export function prepareWorkspace(directory: string) {
  const paths = workspacePaths(directory);
  mkdirSync(paths.dataDirectory, { recursive: true, mode: 0o700 });
  prepareEndpointDirectory(paths.socketDirectory);
  try { writeFileSync(paths.token, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  return { ...paths, secret: readWorkspaceSecret(paths.token) };
}

export function readWorkspaceSecret(file: string) {
  if (!isPrivateFile(file)) throw new Error('Workspace token must be an owner-only regular file');
  const token = readFileSync(file, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid workspace token');
  return token;
}
