import { lstat, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const requestFolder = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface PruneOptions { finished: (requestId: string) => boolean | Promise<boolean>; now: number; minAgeMs?: number }
export interface PruneResult { pruned: string[]; bytes: number }

/** Bytes that removing `path` returns to the disk: files linked only from here.
 * Objects hardlinked with the shared git cache stay on disk and are not counted. */
async function ownBytes(path: string): Promise<number> {
  const info = await lstat(path).catch(() => undefined);
  if (!info) return 0;
  if (!info.isDirectory()) return info.nlink === 1 ? info.size : 0;
  const entries = await readdir(path).catch(() => [] as string[]);
  let total = 0; for (const entry of entries) total += await ownBytes(join(path, entry));
  return total;
}

/** Removes the checkout and manifest of every request folder under `comparisons/`
 * that is older than `minAgeMs` and finished. The folder and its request/result
 * Markdown stay. The manifest goes first, so an interrupted prune leaves a folder
 * that a later capture rebuilds from the cache. `git-cache` is never read or changed. */
export async function pruneComparisons(directory: string, { finished, now, minAgeMs = 60 * 60 * 1000 }: PruneOptions): Promise<PruneResult> {
  const root = join(directory, 'comparisons'), result: PruneResult = { pruned: [], bytes: 0 };
  const entries = await readdir(root, { withFileTypes: true }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; });
  for (const entry of entries) {
    if (!entry.isDirectory() || !requestFolder.test(entry.name)) continue;
    const folder = join(root, entry.name), manifest = join(folder, 'comparison.json'), repository = join(folder, 'repository');
    const saved = await stat(manifest).catch(() => undefined), checkout = await stat(repository).catch(() => undefined);
    if (!saved && !checkout) continue;
    const modified = (saved ?? await stat(folder).catch(() => undefined))?.mtimeMs;
    if (modified === undefined || now - modified < minAgeMs) continue;
    if (!(await finished(entry.name))) continue;
    const bytes = await ownBytes(repository);
    await rm(manifest, { force: true }); await rm(repository, { recursive: true, force: true });
    result.pruned.push(entry.name); result.bytes += bytes;
  }
  return result;
}
