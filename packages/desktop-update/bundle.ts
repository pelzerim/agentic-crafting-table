import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink, statfs } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

type Entry = { path: string; kind: 'file' | 'directory' | 'link'; mode?: number; bytes?: number; hash?: string; target?: string };
export type Bundle = { entries: Entry[] };
export type Capacity = { availableBytes: bigint; blockSize: bigint };

/** Compare actual bundle contents, not just app.asar or the version string.
 * Read sequentially with bounded buffers and never follow framework symlinks. */
export async function inspectBundle(contents: string): Promise<Bundle> {
  const entries: Entry[] = [];
  const visit = async (relative: string) => {
    const path = join(contents, relative), stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      entries.push({ path: relative, kind: 'link', target: await readlink(path) });
    } else if (stat.isDirectory()) {
      entries.push({ path: relative, kind: 'directory', mode: stat.mode & 0o7777 });
      for (const child of (await readdir(path)).sort()) await visit(join(relative, child));
    } else if (stat.isFile()) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      entries.push({ path: relative, kind: 'file', mode: stat.mode & 0o7777, bytes: stat.size, hash: hash.digest('hex') });
    } else throw new Error('Staged or installed app contains an unsupported filesystem entry');
  };
  await visit(''); return { entries };
}

export function sameBundle(a: Bundle, b: Bundle) { return JSON.stringify(a.entries) === JSON.stringify(b.entries); }

export async function volumeCapacity(parent: string): Promise<Capacity> {
  const stat = await statfs(parent, { bigint: true });
  return { availableBytes: stat.bavail * stat.bsize, blockSize: stat.bsize };
}

export function requireCopyCapacity(bundle: Bundle, capacity: Capacity) {
  if (capacity.blockSize <= 0n || capacity.availableBytes < 0n) throw new Error('Cannot determine available installation space');
  // Round each payload to the destination allocation unit, allow a metadata block
  // per entry and leave 16 MiB for the journal and incidental filesystem work.
  const required = bundle.entries.reduce((total, entry) => {
    const bytes = BigInt(entry.bytes ?? Buffer.byteLength(entry.target ?? ''));
    return total + (bytes + capacity.blockSize - 1n) / capacity.blockSize * capacity.blockSize + capacity.blockSize;
  }, 16n * 1024n * 1024n);
  if (capacity.availableBytes < required) {
    const mib = (bytes: bigint) => (bytes + 1024n * 1024n - 1n) / (1024n * 1024n);
    throw Object.assign(new Error(`Not enough disk space to stage the update: need ${mib(required)} MiB, ${mib(capacity.availableBytes)} MiB available. No new update was staged. Free space and retry.`), { code: 'INSTALL_SPACE', requiredBytes: required, availableBytes: capacity.availableBytes });
  }
  return required;
}
