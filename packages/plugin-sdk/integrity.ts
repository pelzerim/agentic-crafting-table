/** Release integrity for git-installed plugin packages. Node only; not part of the platform-neutral SDK entry. */
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Committed next to act-plugin.json on a release tag. Lists every released file except itself. */
export const INTEGRITY_FILE = 'act-plugin.integrity.json';
export const MANIFEST_FILE = 'act-plugin.json';
/** A release is the manifest plus the prebuilt `dist/` folder. */
export const RELEASE_DIRECTORY = 'dist';
export const MAX_RELEASE_FILES = 2000, MAX_RELEASE_BYTES = 64 * 1024 * 1024;

export interface IntegrityManifest { algorithm: 'sha256'; files: Record<string, string> }
export class IntegrityError extends Error {}

const segment = /^(?!\.\.?$)[A-Za-z0-9._@+-]{1,200}$/;
const isReleasePath = (path: string) => path === MANIFEST_FILE
  || (path.length <= 400 && path.startsWith(`${RELEASE_DIRECTORY}/`) && path.split('/').slice(1).every(part => segment.test(part)));
const digest = /^[0-9a-f]{64}$/;

/** Released files as sorted relative paths. Symbolic links and other special files are refused. */
export async function releaseFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  let bytes = 0;
  const visit = async (relative: string) => {
    const info = await lstat(join(root, relative)).catch(() => undefined);
    if (!info) { if (relative === MANIFEST_FILE) throw new IntegrityError(`The release has no ${MANIFEST_FILE}`); return; }
    if (info.isSymbolicLink()) throw new IntegrityError(`Releases cannot contain symbolic links: ${relative}`);
    if (info.isDirectory()) {
      for (const entry of (await readdir(join(root, relative))).sort()) await visit(`${relative}/${entry}`);
      return;
    }
    if (!info.isFile()) throw new IntegrityError(`Releases contain only regular files: ${relative}`);
    if (!isReleasePath(relative)) throw new IntegrityError(`Unsupported file name in release: ${relative}`);
    bytes += info.size; files.push(relative);
    if (files.length > MAX_RELEASE_FILES || bytes > MAX_RELEASE_BYTES) throw new IntegrityError(`Releases are limited to ${MAX_RELEASE_FILES} files and ${MAX_RELEASE_BYTES / 1024 / 1024} MiB`);
  };
  await visit(MANIFEST_FILE);
  await visit(RELEASE_DIRECTORY);
  return files.sort();
}

export async function hashFile(root: string, file: string): Promise<string> {
  return createHash('sha256').update(await readFile(join(root, file))).digest('hex');
}

export async function hashRelease(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const file of await releaseFiles(root)) files[file] = await hashFile(root, file);
  return files;
}

export function parseIntegrity(input: unknown): IntegrityManifest {
  const value = input as Partial<IntegrityManifest> | null;
  if (!value || typeof value !== 'object' || value.algorithm !== 'sha256' || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) throw new IntegrityError(`${INTEGRITY_FILE} must be { "algorithm": "sha256", "files": { path: hex } }`);
  const entries = Object.entries(value.files);
  if (!entries.length || entries.length > MAX_RELEASE_FILES) throw new IntegrityError(`${INTEGRITY_FILE} lists no files or too many`);
  for (const [path, hash] of entries) {
    if (!isReleasePath(path)) throw new IntegrityError(`${INTEGRITY_FILE} lists an unsupported path: ${path}`);
    if (typeof hash !== 'string' || !digest.test(hash)) throw new IntegrityError(`${INTEGRITY_FILE} has an invalid sha256 for ${path}`);
  }
  if (!Object.hasOwn(value.files, MANIFEST_FILE)) throw new IntegrityError(`${INTEGRITY_FILE} must cover ${MANIFEST_FILE}`);
  return { algorithm: 'sha256', files: Object.fromEntries(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) };
}

export async function readIntegrity(root: string): Promise<IntegrityManifest> {
  let text: string;
  try { text = await readFile(join(root, INTEGRITY_FILE), 'utf8'); } catch { throw new IntegrityError(`The release has no ${INTEGRITY_FILE}. Run act-plugin pack and commit it with dist/.`); }
  try { return parseIntegrity(JSON.parse(text)); } catch (error) { throw error instanceof IntegrityError ? error : new IntegrityError(`${INTEGRITY_FILE} is not valid JSON`); }
}

/** Every released file must match `expected`, and nothing else may be present. */
export async function verifyRelease(root: string, expected: Readonly<Record<string, string>>): Promise<void> {
  const actual = await hashRelease(root);
  const changed = Object.keys(expected).filter(file => actual[file] !== undefined && actual[file] !== expected[file]);
  const missing = Object.keys(expected).filter(file => actual[file] === undefined);
  const unexpected = Object.keys(actual).filter(file => !Object.hasOwn(expected, file));
  const problems = [changed.length && `changed: ${changed.join(', ')}`, missing.length && `missing: ${missing.join(', ')}`, unexpected.length && `not listed: ${unexpected.join(', ')}`].filter(Boolean);
  if (problems.length) throw new IntegrityError(`Plugin files do not match their integrity record (${problems.join('; ')}). The plugin was not loaded.`);
}

/** Writes the integrity file for the release in `root` and returns it. */
export async function packRelease(root: string): Promise<IntegrityManifest> {
  const integrity: IntegrityManifest = { algorithm: 'sha256', files: await hashRelease(root) };
  await writeFile(join(root, INTEGRITY_FILE), `${JSON.stringify(integrity, null, 2)}\n`);
  return integrity;
}
