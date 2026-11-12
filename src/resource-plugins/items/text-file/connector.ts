import { createHash, randomUUID } from 'node:crypto';
import { access, constants, mkdir, open, readFile, readlink, realpath, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { expandHomePath } from '../../../../packages/core/home-path.ts';
import type { JsonObject, ResourcePluginConnector, ResourceRecord } from '../../types.ts';

export const MAXIMUM_TEXT_FILE_BYTES = 2 * 1024 * 1024;
export const MAXIMUM_EXCERPT_LINES = 60, MAXIMUM_EXCERPT_CHARACTERS = 6000;

type Missing = { state: 'missing' };
type Refused = { state: 'refused'; reason: string };
/** What the `stat`, `read`, `excerpt` and `write` actions answer. */
export type FileCheck = { state: 'present'; modifiedAt: number; size: number } | Missing | Refused;
export type FileRead = { state: 'present'; text: string; version: string; modifiedAt: number; size: number } | Missing | Refused;
export type FileExcerpt = { state: 'present'; text: string; complete: boolean; modifiedAt: number; size: number } | Missing | Refused;
export type FileWrite = { state: 'written'; version: string; modifiedAt: number; size: number } | { state: 'conflict'; disk: FileRead } | Refused;

const TOO_LARGE = 'File is larger than 2 MB', OTHER_FILE = 'The item now edits another file';
const refused = (reason: string): Refused => ({ state: 'refused', reason });
const versionOf = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The file an item edits. A leading `~` stands for the home directory. */
export function textFilePath(resource: ResourceRecord): string {
  return expandHomePath(String(resource.data.path ?? ''), homedir());
}

/** Whether the path holds a file this item can edit, from its metadata alone. */
async function checkFile(path: string): Promise<FileCheck> {
  if (!isAbsolute(path)) return refused('Path is not absolute');
  let info;
  try { info = await stat(path); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'missing' };
    if (code === 'EACCES' || code === 'EPERM') return refused('No permission to read the file');
    throw error;
  }
  if (!info.isFile()) return refused('Not a file');
  if (info.size > MAXIMUM_TEXT_FILE_BYTES) return refused(TOO_LARGE);
  return { state: 'present', modifiedAt: info.mtimeMs, size: info.size };
}

async function readTextFile(path: string): Promise<FileRead> {
  // The metadata is taken before the content: a change in between leaves an older time beside
  // newer text, which the next check then reports as a change instead of hiding it.
  const check = await checkFile(path);
  if (check.state !== 'present') return check;
  let bytes;
  try { bytes = await readFile(path); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { state: 'missing' };
    if (code === 'EACCES' || code === 'EPERM') return refused('No permission to read the file');
    throw error;
  }
  if (bytes.byteLength > MAXIMUM_TEXT_FILE_BYTES) return refused(TOO_LARGE);
  if (bytes.includes(0)) return refused('Not a text file');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return refused('Not a text file'); }
  return { state: 'present', text, version: versionOf(bytes), modifiedAt: check.modifiedAt, size: bytes.byteLength };
}

/** The first lines of a text, ended at a line end where one is within the limit. */
export function textExcerpt(text: string): { text: string; complete: boolean } {
  const limit = Math.min(text.length, MAXIMUM_EXCERPT_CHARACTERS);
  let end = 0;
  for (let lines = 0; lines < MAXIMUM_EXCERPT_LINES && end < limit; lines++) {
    const lineEnd = text.indexOf('\n', end) + 1 || text.length;
    if (lineEnd > limit) {
      const splitsCharacter = limit < text.length && (text.charCodeAt(limit - 1) & 0xfc00) === 0xd800;
      if (end === 0) end = splitsCharacter ? limit - 1 : limit;
      break;
    }
    end = lineEnd;
  }
  return { text: text.slice(0, end), complete: end === text.length };
}

async function readTextFileExcerpt(path: string): Promise<FileExcerpt> {
  const read = await readTextFile(path);
  return read.state === 'present' ? { state: 'present', ...textExcerpt(read.text), modifiedAt: read.modifiedAt, size: read.size } : read;
}

const isDenied = (error: unknown) => ['EACCES', 'EPERM', 'EROFS'].includes((error as NodeJS.ErrnoException).code ?? '');

const MAXIMUM_LINKS_FOLLOWED = 16;

/** Where the first write to a path with no file lands: the path, or the file a link at the path points at.
 * Nothing when that is behind more links than are followed. A relative link counts from the real folder it
 * is in, as the system resolves it, which is not the folder in the path when that folder is itself a link. */
async function pathBehindLinks(path: string): Promise<string | undefined> {
  let target = path;
  for (let followed = 0; ; followed++) {
    let link;
    try { link = await readlink(target); } catch { return target; }
    if (followed === MAXIMUM_LINKS_FOLLOWED) return undefined;
    target = resolve(await realpath(dirname(target)).catch(() => dirname(target)), link);
  }
}

/** Puts the bytes at the path in one step: a temporary file beside it is renamed over it, so a crash leaves
 * the old file or the new one. `mode` is the mode of the file being replaced. Where the folder takes no new
 * file, that file is written in place instead, which is not one step: a crash there can leave a mix of both.
 * It is written over from its start and cut to length afterwards, so it is never empty in between. */
async function putFile(target: string, bytes: Uint8Array, mode: number | undefined) {
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  let handle, renamed = true;
  try { handle = await open(temporary, 'wx', mode ?? 0o666); } catch (error) {
    if (mode === undefined || !isDenied(error)) throw error;
    handle = await open(target, 'r+'); renamed = false;
  }
  try {
    try {
      await handle.writeFile(bytes);
      if (!renamed) await handle.truncate(bytes.byteLength);
      else if (mode !== undefined) await handle.chmod(mode);
      await handle.sync();
    } finally { await handle.close(); }
    if (renamed) await rename(temporary, target);
  } catch (error) {
    if (renamed) await rm(temporary, { force: true });
    throw error;
  }
}

/** Replaces the file only while it still has `baseVersion`; without one, only while there is no file.
 * A file the service may not write, and a file it may not create, are refused. */
async function writeTextFile(path: string, text: string, baseVersion: string | undefined, signal: AbortSignal): Promise<FileWrite> {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength > MAXIMUM_TEXT_FILE_BYTES) return refused(TOO_LARGE);
  const disk = await readTextFile(path);
  if (disk.state === 'refused') return disk;
  if (disk.state === 'missing' ? baseVersion !== undefined : disk.version !== baseVersion) return { state: 'conflict', disk };
  signal.throwIfAborted();
  const target = disk.state === 'present' ? await realpath(path) : await pathBehindLinks(path);
  if (target === undefined) return refused('Too many links to follow');
  try {
    // The rename only needs a writable folder, so without this it would replace a file its own mode protects.
    if (disk.state === 'present') await access(target, constants.W_OK);
    else await mkdir(dirname(target), { recursive: true });
    await putFile(target, bytes, disk.state === 'present' ? (await stat(target)).mode & 0o7777 : undefined);
  } catch (error) {
    if (isDenied(error)) return refused('No permission to write the file');
    throw error;
  }
  const written = await stat(target);
  return { state: 'written', version: versionOf(bytes), modifiedAt: written.mtimeMs, size: written.size };
}

/** Local file access only: no network or credentials. The content never enters the saved snapshot, the
 * host's cache of action results or the context saved for agents. An action may name the item's path as the
 * caller knows it, and a write must: when the item has another path by then, the action is refused. */
export const textFileConnector: ResourcePluginConnector = {
  async load(resource) {
    const path = textFilePath(resource), check = await checkFile(path);
    return { activity: 'idle', attention: 'none', connection: 'connected', label: path, observedAt: new Date().toISOString(),
      ...(check.state === 'missing' ? { error: 'File missing' } : check.state === 'refused' ? { error: check.reason } : {}) };
  },
  actions: () => [
    { id: 'read', label: 'Read file', readOnly: true, uncached: true, description: `The file's text and the version of its content.` },
    { id: 'excerpt', label: 'Read first lines', readOnly: true, uncached: true, description: `The first lines of the file's text, and whether they are all of it.` },
    { id: 'stat', label: 'Check file', readOnly: true, description: 'The modification time and size, without reading the content.' },
    { id: 'write', label: 'Save file', readOnly: false, humanOnly: true, description: 'Replaces the content while the file still has the version the text was read at.',
      inputFields: { text: { label: 'Text', kind: 'text', multiline: true }, path: { label: 'Path the text was read from', kind: 'text' }, baseVersion: { label: 'Version the text was read at', kind: 'text' } } },
  ],
  async execute(resource, actionId, signal, input) {
    signal.throwIfAborted();
    if (input?.path !== undefined && input.path !== String(resource.data.path ?? '')) return refused(OTHER_FILE) as JsonObject;
    const path = textFilePath(resource);
    if (actionId === 'read') return await readTextFile(path) as JsonObject;
    if (actionId === 'excerpt') return await readTextFileExcerpt(path) as JsonObject;
    if (actionId === 'stat') return await checkFile(path) as JsonObject;
    if (actionId === 'write') {
      if (typeof input?.text !== 'string' || typeof input.path !== 'string' || (input.baseVersion !== undefined && typeof input.baseVersion !== 'string')) throw new Error('A write needs text, the path the text was read from and, for an existing file, the version it was read at');
      return await writeTextFile(path, input.text, input.baseVersion, signal) as JsonObject;
    }
    throw new Error(`Unknown action: ${actionId}`);
  },
  /** The path and the file's state. The host saves context it hands to agents, so the text stays out of it. */
  async getContext(resource) {
    const path = textFilePath(resource), check = await checkFile(path);
    const state = check.state === 'present' ? 'Read the file at this path for its content.' : check.state === 'missing' ? 'File missing' : check.reason;
    return { resourceId: resource.id, title: resource.title, content: `Path: ${path}\n\n${state}` };
  },
};
