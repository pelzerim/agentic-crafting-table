import type { SqliteStore } from './sqlite-store.ts';
import { nativeGit } from './plugin-git.ts';
import type { GitRunner } from './plugin-git.ts';
import type { PluginSource } from './plugin-lock.ts';
import { APP_TAGS_URL, updateOffers } from '../core/updates.ts';
import type { PluginUpdate, UpdateStatus, UpdateSubject } from '../core/updates.ts';

const CHECK_EVERY_MS = 24 * 60 * 60 * 1000, TICK_MS = 60 * 60 * 1000, FIRST_CHECK_MS = 20_000, REMOTE_TIMEOUT_MS = 20_000;

export interface InstalledPack { id: string; name: string; version: string; source: PluginSource }
export interface UpdateCheckerOptions {
  /** The running app's version (package.json); `dev` or any non-release string is never offered an update. */
  version: string;
  /** Release tag names of the app repository. The default reads the GitHub tags API without credentials. */
  tags?: () => Promise<string[]>;
  plugins: () => InstalledPack[];
  git?: GitRunner;
  clock?: () => number;
  allowed?: () => boolean;
}
/** `git ls-remote --tags` lines to tag names; a `^{}` line names the same tag again and is dropped. */
export function parseRemoteTags(output: string): string[] {
  const tags = new Set<string>();
  for (const line of output.split('\n')) {
    const match = /\trefs\/tags\/(.+?)(\^\{\})?$/.exec(line.trim());
    if (match) tags.add(match[1]);
  }
  return [...tags];
}
/** Where the app's tags come from: GitHub, or in a test run the URL the test names (nothing, so no network, when it names none). */
export function tagsSource(env: NodeJS.ProcessEnv): (() => Promise<string[]>) | undefined {
  if (env.ACT_TEST_UPDATE_TAGS_URL) return () => githubTags(env.ACT_TEST_UPDATE_TAGS_URL);
  return env.ACT_TEST_DATA_DIR ? async () => [] : undefined;
}
async function githubTags(url = APP_TAGS_URL): Promise<string[]> {
  const response = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'agentic-crafting-table' }, signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (!Array.isArray(body)) throw new Error('Unexpected tags response');
  return body.flatMap(entry => typeof entry?.name === 'string' ? [entry.name] : []);
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/** Looks up the newest release tag of the app and of every git-installed pack once a day (UPDATE-01).
 * It only reads tag names; downloading or installing anything stays with the person. */
export class UpdateChecker {
  private store: SqliteStore;
  private options: Required<Pick<UpdateCheckerOptions, 'tags' | 'git' | 'clock' | 'allowed'>> & UpdateCheckerOptions;
  private app: UpdateSubject;
  private plugins: PluginUpdate[] = [];
  private running?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private lastCheck?: number;
  constructor(store: SqliteStore, options: UpdateCheckerOptions) {
    this.store = store;
    this.options = { ...options, tags: options.tags ?? githubTags, git: options.git ?? nativeGit, clock: options.clock ?? Date.now, allowed: options.allowed ?? (() => true) };
    this.app = { current: options.version, available: false };
  }
  status(): UpdateStatus { return { app: { ...this.app }, plugins: this.plugins.map(plugin => ({ ...plugin })), checking: Boolean(this.running) }; }
  start() {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.tick().finally(() => { if (!this.closed) this.start(); }); }, this.lastCheck === undefined ? FIRST_CHECK_MS : TICK_MS);
  }
  async pause() { clearTimeout(this.timer); this.timer = undefined; await this.running?.catch(() => {}); }
  async close() { this.closed = true; await this.pause(); }
  /** The daily look, when the setting allows it and a day has passed. */
  async tick() {
    if (this.closed || !this.options.allowed() || !this.store.readSettings().value.updates.check) return;
    if (this.lastCheck !== undefined && this.options.clock() - this.lastCheck < CHECK_EVERY_MS) return;
    await this.check();
  }
  /** A check the person asked for, or the daily one: shared while in flight. */
  check(): Promise<void> {
    this.running ??= this.run().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async run() {
    const packs = this.options.plugins().flatMap(pack => pack.source.kind === 'git' ? [{ ...pack, source: pack.source }] : []);
    const [app, ...plugins] = await Promise.all([
      this.options.tags().then(tags => ({ tags }), error => ({ error: message(error) })),
      ...packs.map(pack => this.options.git(['ls-remote', '--tags', '--refs', '--', pack.source.url], { timeoutMs: REMOTE_TIMEOUT_MS }).then(output => ({ tags: parseRemoteTags(output) }), error => ({ error: message(error) }))),
    ]);
    const checkedAt = this.options.clock();
    this.lastCheck = checkedAt;
    this.app = subject(this.options.version, app, checkedAt);
    this.plugins = packs.map((pack, index) => ({ id: pack.id, name: pack.name, source: pack.source.url, ...subject(pack.version, plugins[index], checkedAt) }));
  }
}
function subject(current: string, result: { tags: string[] } | { error: string }, checkedAt: number): UpdateSubject {
  if ('error' in result) return { current, available: false, checkedAt, error: result.error };
  const offer = updateOffers({ current, tags: result.tags });
  return { current, ...(offer.latest ? { latest: offer.latest } : {}), available: offer.available, checkedAt };
}
