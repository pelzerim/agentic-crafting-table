import { lstatSync } from 'node:fs';
import type { Stats } from 'node:fs';

export const isOwnedByCurrentUser = (info: Pick<Stats, 'uid'>) => !process.getuid || info.uid === process.getuid();

/** A regular file, not a link, that only the current user can reach. */
export function isPrivateFile(path: string) {
  const info = lstatSync(path);
  return info.isFile() && isOwnedByCurrentUser(info) && !(info.mode & 0o077);
}
