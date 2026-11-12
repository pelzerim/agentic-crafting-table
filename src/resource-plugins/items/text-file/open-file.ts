import type { JsonObject } from '../../types.ts';
import type { FileCheck, FileExcerpt, FileRead, FileWrite } from './connector.ts';

export type RunFileAction = (actionId: 'read' | 'stat' | 'write', input?: JsonObject) => Promise<unknown>;

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
/** What a check compares to know whether the file has to be read again. */
export const stampOf = (file: FileCheck | FileRead | FileExcerpt | { state: 'written'; modifiedAt: number; size: number }) =>
  file.state === 'missing' ? 'missing' : file.state === 'refused' ? `refused:${file.reason}` : `${file.modifiedAt}:${file.size}`;

/** A text file as its open view holds it: the text being edited, the version of the content that text was read
 * at, and the decision to make when the file changes on disk beside unsaved edits. Every action on the file runs
 * after the one before it, so a check never sees a save half done. `onChange` is called after each change of
 * state, with true when the text itself was replaced by what the disk holds. */
export class OpenTextFile {
  status: 'loading' | 'present' | 'missing' | 'refused' = 'loading';
  /** Why the file cannot be edited, while `status` is `refused`. */
  refusal = '';
  text = '';
  /** What the disk holds while that differs from unsaved edits. Nothing is saved until `reload` or `keepMine`. */
  changedOnDisk?: { state: 'present'; text: string; version: string } | { state: 'missing' };
  /** Why the last save did not reach the disk. */
  saveError = '';
  private savedText?: string;
  private version?: string;
  private stamp?: string;
  private last: Promise<void> = Promise.resolve();
  private path: string;
  private run: RunFileAction;
  private onChange: (textReplaced: boolean) => void;

  /** `path` is the item's path as the view was given it. Every action names it, so an action that arrives
   * after the item was pointed at another file is refused instead of run on that file. */
  constructor(path: string, run: RunFileAction, onChange: (textReplaced: boolean) => void) { this.path = path; this.run = run; this.onChange = onChange; }

  get unsaved() { return this.status === 'present' && this.text !== this.savedText; }

  /** A new view takes the file over: its actions run through `run`, its changes go to `onChange`. */
  attach(run: RunFileAction, onChange: (textReplaced: boolean) => void) { this.run = run; this.onChange = onChange; }

  /** The view is gone. Actions already asked for still run; no one is told what they change. */
  detach() { this.onChange = () => {}; }

  load() {
    return this.next(async () => {
      let disk: FileRead;
      try { disk = await this.ask('read') as FileRead; } catch (error) { disk = { state: 'refused', reason: message(error) }; }
      this.stamp = disk.state === 'refused' ? undefined : stampOf(disk);
      this.take(disk);
    });
  }

  /** The text as the editor has it now. Only a file that is there can be edited. Edits that end at the saved
   * text leave nothing to decide, so an open decision closes and the disk's text is taken, after this call. */
  edit(text: string) {
    if (this.status !== 'present') return;
    this.text = text;
    if (this.changedOnDisk && !this.unsaved) void this.next(async () => { if (this.changedOnDisk && !this.unsaved) this.take(this.changedOnDisk); });
  }

  save() {
    return this.next(async () => {
      if (!this.unsaved || this.changedOnDisk) return;
      await this.write(this.text);
    });
  }

  /** Asks for the file's time and size, and reads it only when they differ from the last look. */
  check() {
    return this.next(async () => {
      if (this.status === 'loading') return;
      let disk: FileRead;
      try {
        const stamp = stampOf(await this.ask('stat') as FileCheck);
        if (stamp === this.stamp) return;
        disk = await this.ask('read') as FileRead;
        this.stamp = stamp;
      } catch { return; }
      this.compare(disk);
    });
  }

  /** Drops the unsaved edits for what the disk holds. */
  reload() {
    return this.next(async () => {
      if (this.changedOnDisk) this.take(this.changedOnDisk);
    });
  }

  /** Saves the unsaved edits over the change on disk that waits for a decision. */
  keepMine() {
    return this.next(async () => {
      if (this.changedOnDisk) await this.writeOverDisk();
    });
  }

  /** Saves the unsaved edits whatever the disk holds: over a change that waits for a decision, and over one
   * the write itself finds. A file deleted on disk is written again. */
  saveOverDisk() {
    return this.next(async () => {
      if (!this.unsaved) return;
      await this.writeOverDisk();
      if (this.changedOnDisk && this.unsaved) await this.writeOverDisk();
    });
  }

  /** Drops the unsaved edits, an open decision and a save error for what the disk holds now. */
  discard() { return this.load(); }

  /** Makes the missing file, empty. */
  create() {
    return this.next(async () => {
      if (this.status !== 'missing') return;
      await this.write('');
    });
  }

  private ask(actionId: Parameters<RunFileAction>[0], input: JsonObject = {}) { return this.run(actionId, { ...input, path: this.path }); }

  private next(action: () => Promise<void>) {
    const run = this.last.then(action);
    this.last = run.catch(() => {});
    return run;
  }

  /** What the disk holds becomes the open text. */
  private take(disk: { state: 'present'; text: string; version: string } | Exclude<FileRead, { state: 'present' }>) {
    this.changedOnDisk = undefined; this.saveError = '';
    this.status = disk.state; this.refusal = disk.state === 'refused' ? disk.reason : '';
    this.text = disk.state === 'present' ? disk.text : ''; this.savedText = disk.state === 'present' ? disk.text : undefined;
    this.version = disk.state === 'present' ? disk.version : undefined;
    this.onChange(true);
  }

  private compare(disk: FileRead) {
    const known = this.changedOnDisk ? this.changedOnDisk.state === 'present' && this.changedOnDisk.version : this.status === 'present' && this.version;
    if (disk.state === 'present' && disk.version === known) return;
    if (!this.unsaved) return this.take(disk);
    if (disk.state === 'refused') { this.saveError = disk.reason; this.onChange(false); return; }
    this.changedOnDisk = disk.state === 'missing' ? disk : disk.version === this.version ? undefined : { state: 'present', text: disk.text, version: disk.version };
    this.onChange(false);
  }

  /** Writes the open text against what the disk is known to hold, which closes an open decision. */
  private async writeOverDisk() {
    const disk = this.changedOnDisk;
    if (disk) {
      this.changedOnDisk = undefined;
      this.version = disk.state === 'present' ? disk.version : undefined; this.savedText = disk.state === 'present' ? disk.text : undefined;
    }
    await this.write(this.text);
  }

  private async write(text: string) {
    const created = this.status === 'missing';
    let result: FileWrite;
    try { result = await this.ask('write', { text, ...(this.version === undefined ? {} : { baseVersion: this.version }) }) as FileWrite; }
    catch (error) { this.saveError = message(error); this.onChange(false); return; }
    if (result.state === 'refused') { this.saveError = result.reason; this.onChange(false); return; }
    if (result.state === 'conflict') {
      this.stamp = result.disk.state === 'refused' ? undefined : stampOf(result.disk);
      if (created) this.take(result.disk); else this.compare(result.disk);
      return;
    }
    this.stamp = stampOf(result); this.version = result.version; this.savedText = text; this.saveError = '';
    if (created) { this.status = 'present'; this.text = text; }
    this.onChange(created);
  }
}

/** The files of the text file views in one window, by item and path. A file outlives the view that closes it for as long
 * as it holds edits the disk does not: through the closing save, after it when the save failed, and when the
 * view closed without saving. The next view of the item takes that file back, edits and any open decision
 * included, so a view that goes away never drops what was typed. Held edits last until the window is closed. */
export class OpenTextFiles {
  private held = new Map<string, OpenTextFile>();

  /** The file for a new view of the item: the one a closed view of the same path left behind, or a new one
   * being read. Edits made to one path are never shown for another. A file taken back is checked against the
   * disk; nothing is written. */
  open(resourceId: string, path: string, run: RunFileAction, onChange: (textReplaced: boolean) => void): OpenTextFile {
    const key = JSON.stringify([resourceId, path]), left = this.held.get(key);
    if (!left) { const file = new OpenTextFile(path, run, onChange); void file.load(); return file; }
    this.held.delete(key);
    left.attach(run, onChange);
    void left.check().catch(() => {});
    return left;
  }

  /** The closing view hands its file over. With `saveEdits` its edits are written, over a change on disk too;
   * without, nothing is written. The file is kept while it holds edits the disk does not. */
  async close(resourceId: string, path: string, file: OpenTextFile, saveEdits: boolean) {
    const key = JSON.stringify([resourceId, path]);
    file.detach();
    this.held.set(key, file);
    if (saveEdits) await file.saveOverDisk().catch(() => {});
    if (this.held.get(key) === file && !file.unsaved) this.held.delete(key);
  }
}
