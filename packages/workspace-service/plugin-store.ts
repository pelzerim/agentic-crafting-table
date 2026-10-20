import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { parsePluginManifest } from '../plugin-sdk/manifest.ts';
import type { PluginManifest } from '../plugin-sdk/manifest.ts';
import { INTEGRITY_FILE, MANIFEST_FILE, RELEASE_DIRECTORY, readIntegrity, verifyRelease } from '../plugin-sdk/integrity.ts';
import { bundledPackages } from '../../src/resource-plugins/bundled/packages.generated.ts';
import { GitError, nativeGit } from './plugin-git.ts';
import type { GitRunner } from './plugin-git.ts';
import { isCommit, parseGitSource, shortCommit } from './plugin-source.ts';
import { readPluginLock } from './plugin-lock.ts';
import type { InstalledPlugin, PluginRelease, PluginSource } from './plugin-lock.ts';
import type { SqliteStore } from './sqlite-store.ts';

/** What the user reviews before trusting a package build. */
export interface PluginCandidate {
  id: string; name: string; version: string; description?: string; apiRange: string;
  commit: string; source: PluginSource; dev: boolean;
  contributes: PluginManifest['contributes']; code: PluginRelease['code'];
  /** Set when the remote could not be reached and the cached copy of the repository was used. */
  offline?: string;
  installed?: { commit: string; version: string; removed: boolean };
  /** Contributions added or removed compared with the installed build. */
  changes: { added: string[]; removed: string[] };
}

const FETCH_TIMEOUT = 180_000, LOCAL_TIMEOUT = 60_000;

/** Readable lines for each contribution, used for consent and update diffs. */
export function describeContributions(contributes: PluginManifest['contributes'], code: PluginRelease['code']): string[] {
  return [
    ...contributes.itemTypes.map(id => `Item type ${id}`),
    ...contributes.accountTypes.map(id => `Account type ${id}`),
    ...contributes.runtimeOperations.map(id => `Runtime operation ${id}`),
    ...contributes.mcpTools.map(id => `Agent tool ${id}`),
    ...contributes.settingsPages.map(id => `Settings on ${id}`),
    ...Object.entries(contributes.actionContributions).flatMap(([target, actions]) => actions.map(action => `Action ${action} on ${target}`)),
    ...contributes.agentGuide.map(id => `Agent guide text ${id}`),
    ...contributes.settingsPresets.map(id => `Preset for another package’s settings ${id}`),
    ...contributes.css.map(file => `Stylesheet ${file}`),
    ...(code.service ? ['Service code (runs with the app’s full access)'] : []),
    ...(code.renderer ? ['Window code (runs in the app window)'] : []),
  ];
}

function untar(archive: string, directory: string) {
  return new Promise<void>((resolve, reject) => execFile('tar', ['-x', '-f', archive, '-C', directory], { timeout: LOCAL_TIMEOUT, killSignal: 'SIGKILL', windowsHide: true },
    error => error ? reject(new Error('The plugin release could not be unpacked.')) : resolve()));
}

/** Plugins installed from git or a development folder: fetch, verify, approve, roll back and remove.
 * Releases live in `<data>/plugins/store/<id>/<commit>/`; the lock lives in the workspace database. */
export class PluginStore {
  readonly root: string;
  private readonly store: Pick<SqliteStore, 'pluginLock' | 'writePluginLock'>;
  private readonly git: GitRunner;
  private readonly now: () => Date;
  private readonly pending = new Map<string, { release: PluginRelease; source: PluginSource }>();

  constructor(dataDirectory: string, store: Pick<SqliteStore, 'pluginLock' | 'writePluginLock'>, options: { git?: GitRunner; now?: () => Date } = {}) {
    this.root = join(dataDirectory, 'plugins'); this.store = store;
    this.git = options.git ?? nativeGit; this.now = options.now ?? (() => new Date());
  }

  list(): InstalledPlugin[] { return readPluginLock(this.store).plugins; }
  get(id: string): InstalledPlugin | undefined { return this.list().find(plugin => plugin.id === id); }

  /** The directory a release loads from. */
  releaseRoot(plugin: Pick<InstalledPlugin, 'id' | 'source'>, release: Pick<PluginRelease, 'commit'>): string {
    return plugin.source.kind === 'folder' ? plugin.source.path : join(this.root, 'store', plugin.id, release.commit);
  }

  /** Fetches a git source with the user's git, resolves the ref to a commit and verifies the release.
   * Nothing from the package runs. Falls back to the cached repository when the remote is unreachable. */
  async prepare(input: { url: string; ref?: string }): Promise<PluginCandidate> {
    const source = parseGitSource(input);
    const repository = join(this.root, 'repos', `${createHash('sha256').update(source.url).digest('hex').slice(0, 32)}.git`);
    mkdirSync(join(this.root, 'repos'), { recursive: true, mode: 0o700 });
    let offline: string | undefined;
    if (!existsSync(repository)) {
      const temporary = `${repository}.tmp-${randomUUID()}`;
      try { await this.git(['clone', '--bare', '--quiet', '--', source.url, temporary], { timeoutMs: FETCH_TIMEOUT }); renameSync(temporary, repository); }
      catch (error) { rmSync(temporary, { recursive: true, force: true }); throw new Error(`Could not fetch ${source.url}: ${(error as Error).message}`); }
    } else {
      try { await this.git(['fetch', '--quiet', '--prune', '--force', '--tags', '--', source.url, '+refs/heads/*:refs/heads/*'], { cwd: repository, timeoutMs: FETCH_TIMEOUT }); }
      catch (error) { offline = (error as Error).message; }
    }
    let commit: string;
    try { commit = (await this.git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${source.ref}^{commit}`], { cwd: repository, timeoutMs: LOCAL_TIMEOUT })).trim(); }
    catch (error) { throw new Error(error instanceof GitError && offline ? `Could not reach ${source.url} (${offline}) and ${source.ref} is not in the cached copy.` : `${source.ref} was not found in ${source.url}.`); }
    if (!isCommit(commit)) throw new Error(`${source.ref} did not resolve to a commit.`);
    const staging = join(this.root, 'staging', randomUUID());
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    try {
      try { await this.git(['archive', '--format=tar', `--output=${staging}.tar`, commit, '--', MANIFEST_FILE, INTEGRITY_FILE, RELEASE_DIRECTORY], { cwd: repository, timeoutMs: LOCAL_TIMEOUT }); }
      catch { throw new Error(`The commit ${shortCommit(commit)} is not a plugin release: it needs ${MANIFEST_FILE}, ${INTEGRITY_FILE} and a built ${RELEASE_DIRECTORY}/ folder. Run act-plugin pack and commit its output.`); }
      await untar(`${staging}.tar`, staging);
      const integrity = await readIntegrity(staging);
      await verifyRelease(staging, integrity.files);
      const manifest = await this.manifest(staging);
      const absent = this.entryFiles(manifest).filter(file => !Object.hasOwn(integrity.files, file));
      if (absent.length) throw new Error(`act-plugin.json names files that are not in the release: ${absent.join(', ')}`);
      this.assertInstallable(manifest);
      const target = join(this.root, 'store', manifest.id, commit);
      if (existsSync(target)) {
        try { await verifyRelease(target, integrity.files); rmSync(staging, { recursive: true, force: true }); }
        catch { rmSync(target, { recursive: true, force: true }); renameSync(staging, target); }
      } else { mkdirSync(join(this.root, 'store', manifest.id), { recursive: true, mode: 0o700 }); renameSync(staging, target); }
      return this.candidate(manifest, { kind: 'git', url: source.url, ref: source.ref }, { ...this.release(manifest, commit), integrity: integrity.files }, offline);
    } finally {
      rmSync(staging, { recursive: true, force: true }); rmSync(`${staging}.tar`, { force: true });
    }
  }

  /** An unpacked development build. It is loaded in place, without an integrity record. */
  async prepareFolder(path: string): Promise<PluginCandidate> {
    if (!isAbsolute(path)) throw new Error('Choose a plugin folder.');
    let folder: string;
    try { folder = realpathSync(path); } catch { throw new Error('That folder does not exist.'); }
    if (!statSync(folder).isDirectory()) throw new Error('Choose a plugin folder.');
    const manifest = await this.manifest(folder);
    for (const file of this.entryFiles(manifest)) {
      let resolved: string;
      try { resolved = realpathSync(join(folder, file)); } catch { throw new Error(`act-plugin.json names ${file}, which does not exist. Build the plugin first.`); }
      if (!resolved.startsWith(folder + sep) || !statSync(resolved).isFile()) throw new Error(`${file} must be a file inside the plugin folder.`);
    }
    this.assertInstallable(manifest);
    return this.candidate(manifest, { kind: 'folder', path: folder }, this.release(manifest, 'dev'));
  }

  /** Records the user's approval of exactly the prepared build. */
  async install(input: { id: string; commit: string }): Promise<InstalledPlugin> {
    const key = `${input.id}@${input.commit}`, pending = this.pending.get(key);
    if (!pending) throw new Error('Fetch this plugin again, then approve it.');
    const existing = this.get(input.id);
    const plugin = { id: input.id, source: pending.source };
    if (pending.release.integrity) await verifyRelease(this.releaseRoot(plugin, pending.release), pending.release.integrity);
    const kept = existing && !existing.removed && existing.source.kind === 'git' && pending.source.kind === 'git' ? [existing.current, ...existing.previous] : [];
    const previous = kept.filter(release => release.integrity && release.commit !== pending.release.commit).slice(0, 3);
    const entry: InstalledPlugin = { ...plugin, enabled: true, removed: false, current: { ...pending.release, approvedAt: this.now().toISOString() }, previous };
    this.save(entry); this.pending.delete(key);
    return entry;
  }

  setEnabled(id: string, enabled: boolean): InstalledPlugin {
    const entry = this.require(id);
    if (entry.removed) throw new Error('Reinstall this plugin first.');
    const { failure, ...rest } = entry;
    const next = enabled ? { ...rest, enabled } : { ...entry, enabled };
    this.save(next); return next;
  }

  /** Switches to an earlier approved build that is still on disk. No network is used. */
  async rollback(id: string, commit: string): Promise<InstalledPlugin> {
    const entry = this.require(id), target = entry.previous.find(release => release.commit === commit);
    if (!target || !target.integrity) throw new Error('That version is no longer available for rollback.');
    await verifyRelease(this.releaseRoot(entry, target), target.integrity);
    const { failure, ...rest } = entry;
    const next: InstalledPlugin = { ...rest, enabled: true, current: target, previous: [entry.current, ...entry.previous.filter(release => release !== target)].slice(0, 3) };
    this.save(next); return next;
  }

  /** Stops loading the package and deletes its code. Its items, links and settings stay; reinstalling restores them. */
  remove(id: string): InstalledPlugin {
    const entry = this.require(id);
    const { failure, ...rest } = entry;
    const next: InstalledPlugin = { ...rest, enabled: false, removed: true, previous: [] };
    this.writeLock(next);
    rmSync(join(this.root, 'store', id), { recursive: true, force: true });
    return next;
  }

  /** The loader turns a package off when it cannot load; the reason is shown until the user enables it again. */
  recordFailure(id: string, reason: string) {
    const entry = this.get(id);
    if (entry) this.writeLock({ ...entry, enabled: false, failure: { reason, at: this.now().toISOString() } });
  }

  private require(id: string) {
    const entry = this.get(id);
    if (!entry) throw new Error(`Plugin ${id} is not installed.`);
    return entry;
  }

  private save(entry: InstalledPlugin) {
    this.writeLock(entry);
    const keep = new Set([entry.current, ...entry.previous].map(release => release.commit));
    const directory = join(this.root, 'store', entry.id);
    if (existsSync(directory)) for (const commit of readdirSync(directory)) if (!keep.has(commit)) rmSync(join(directory, commit), { recursive: true, force: true });
  }

  private writeLock(entry: InstalledPlugin) { this.store.writePluginLock(entry.id, entry); }

  private async manifest(root: string): Promise<PluginManifest> {
    let input: unknown;
    try { input = JSON.parse(await readFile(join(root, MANIFEST_FILE), 'utf8')); } catch { throw new Error(`The plugin has no readable ${MANIFEST_FILE}.`); }
    return parsePluginManifest(input);
  }

  private entryFiles(manifest: PluginManifest) {
    return [...Object.values(manifest.entries).filter((entry): entry is string => Boolean(entry)), ...manifest.contributes.css];
  }

  /** Built-in packages and other installed packages keep their ids and item types. */
  private assertInstallable(manifest: PluginManifest) {
    const bundled = bundledPackages.map(entry => parsePluginManifest(entry.manifest));
    const others = [...bundled.map(other => ({ id: other.id, itemTypes: other.contributes.itemTypes, builtIn: true })),
      ...this.list().filter(other => !other.removed && other.id !== manifest.id).map(other => ({ id: other.id, itemTypes: other.current.contributes.itemTypes, builtIn: false }))];
    for (const other of others) {
      const shared = other.itemTypes.filter(type => manifest.contributes.itemTypes.includes(type));
      if (other.id === manifest.id || shared.length) throw new Error(`${manifest.id} conflicts with the ${other.builtIn ? 'built-in' : 'installed'} plugin ${other.id}${shared.length ? ` (${shared.join(', ')})` : ''}.`);
    }
  }

  private release(manifest: PluginManifest, commit: string): PluginRelease {
    return { commit, name: manifest.name, version: manifest.version, apiRange: manifest.apiRange, contributes: manifest.contributes,
      code: { service: Boolean(manifest.entries.service), renderer: Boolean(manifest.entries.renderer) }, approvedAt: '' };
  }

  private candidate(manifest: PluginManifest, source: PluginSource, release: PluginRelease, offline?: string): PluginCandidate {
    this.pending.set(`${manifest.id}@${release.commit}`, { release, source });
    const installed = this.get(manifest.id);
    const now = describeContributions(release.contributes, release.code);
    const before = installed && !installed.removed ? describeContributions(installed.current.contributes, installed.current.code) : [];
    return {
      id: manifest.id, name: manifest.name, version: manifest.version, ...(manifest.description ? { description: manifest.description } : {}), apiRange: manifest.apiRange,
      commit: release.commit, source, dev: source.kind === 'folder', contributes: manifest.contributes, code: release.code, ...(offline ? { offline } : {}),
      ...(installed ? { installed: { commit: installed.current.commit, version: installed.current.version, removed: installed.removed } } : {}),
      changes: { added: now.filter(line => !before.includes(line)), removed: before.filter(line => !now.includes(line)) },
    };
  }
}
