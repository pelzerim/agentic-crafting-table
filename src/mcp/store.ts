import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { emptyState, stateSchema } from './control.ts';
import type { WorkspaceState, WorkspaceStore } from './control.ts';

/** Local, single-machine store. A lock coordinates multiple stdio agent processes. */
export class FileStore implements WorkspaceStore {
  readonly file: string;
  constructor(file: string) { this.file = resolve(file); }
  async read() {
    try { return stateSchema.parse(JSON.parse(await readFile(this.file, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState(); throw error; }
  }
  async update(change: (state: WorkspaceState) => WorkspaceState) {
    await mkdir(dirname(this.file), { recursive: true });
    const lock = `${this.file}.lock`;
    const deadline = Date.now() + 5000;
    while (true) {
      try { await mkdir(lock, { mode: 0o700 }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() > deadline) throw new Error(`Workspace is locked: ${lock}. If its owner crashed, stop all workspace servers before removing the lock.`);
        await new Promise(r => setTimeout(r, 25));
      }
    }
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const next = stateSchema.parse(change(await this.read()));
      await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, this.file);
      return next;
    } finally {
      await rm(temporary, { force: true });
      await rm(lock, { recursive: true, force: true });
    }
  }
}
