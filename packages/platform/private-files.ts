import { lstatSync } from 'node:fs';
import type { Stats } from 'node:fs';

export const isOwnedByCurrentUser = (info: Pick<Stats, 'uid'>) => !process.getuid || info.uid === process.getuid();

/** A regular file, not a link, that only the current user can reach.
 * Windows reports no permission bits; the profile folder's access list guards files there. */
export function isPrivateFile(path: string, platform: NodeJS.Platform = process.platform) {
  const info = lstatSync(path);
  return info.isFile() && isOwnedByCurrentUser(info) && (platform === 'win32' || !(info.mode & 0o077));
}
