/** A local bare git repository holding a fixture plugin package, created inside a test directory. */
import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packRelease } from '../../packages/plugin-sdk/integrity.ts';

const fixtures = resolve(import.meta.dirname, 'plugins'), fixture = join(fixtures, 'sample');
const isolated = ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'init.defaultBranch=main', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com'];
const git = (cwd: string, ...args: string[]) => execFileSync('git', [...isolated, ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trim();

export interface PluginRepository {
  /** file:// URL of the bare repository. */
  url: string;
  /** The checkout the releases are authored in. */
  work: string;
  /** Writes `files` (relative to the package), packs, commits and tags; returns the commit. */
  release(tag: string, files?: Record<string, string>, options?: { pack?: boolean }): Promise<string>;
  /** Moves the bare repository's main branch and tag without packing, e.g. to publish a tampered build. */
  commit(tag: string, files: Record<string, string>): string;
}

/** `name` is a package folder under tests/fixtures/plugins. */
export async function samplePluginRepository(directory: string, name = 'sample'): Promise<PluginRepository> {
  const work = join(directory, `${name}-plugin`), bare = join(directory, `${name}-plugin.git`);
  cpSync(join(fixtures, name), work, { recursive: true });
  git(work, 'init', '-q');
  const commit = (tag: string, files: Record<string, string>) => {
    for (const [file, text] of Object.entries(files)) writeFileSync(join(work, file), text);
    git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', tag); git(work, 'tag', tag);
    git(work, 'push', '-q', '--force', bare, 'main', '--tags');
    return git(work, 'rev-parse', 'HEAD');
  };
  const release = async (tag: string, files: Record<string, string> = {}, options: { pack?: boolean } = {}) => {
    for (const [file, text] of Object.entries(files)) writeFileSync(join(work, file), text);
    if (options.pack !== false) await packRelease(work);
    return commit(tag, {});
  };
  git(directory, 'init', '-q', '--bare', bare);
  await release('v1.0.0');
  return { url: pathToFileURL(bare).href, work, release, commit };
}

/** The sample manifest with a new version number. */
export function sampleManifest(version: string, extra: Record<string, unknown> = {}) {
  const manifest = JSON.parse(readFileSync(join(fixture, 'act-plugin.json'), 'utf8'));
  return JSON.stringify({ ...manifest, version, ...extra }, null, 2);
}
