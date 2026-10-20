import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import type { WorkspaceControl, WorkspaceState } from '../core/control.ts';
import type { SqliteStore } from './sqlite-store.ts';
import type { GitHubClient, InboxPull } from '../provider-runtime/github.ts';
import { pullKey } from '../provider-runtime/github.ts';
import type { ProviderConnection } from '../core/connections.ts';
import { isArchived, isBelow } from '../../src/graph/archive.ts';
import { canonical } from '../core/control.ts';
import { inBackground, knownBudget } from '../provider-runtime/request-budget.ts';

export const INBOX_REFRESH_MS = 60_000;
/** Refresh interval as multiples of a minute, by consecutive unchanged lists. */
export const INBOX_CADENCE = [1, 1, 2, 5, 10] as const;
interface Cached { items: InboxPull[]; refreshedAt?: string; error?: string; retryAt?: number }
/** `seen`: marked Seen with no newer activity, so it shows outside the Inbox tab only. */
export interface InboxAccount { connectionId: string; login: string; items: (InboxPull & { nodeId?: string; below?: boolean; seen?: boolean })[]; refreshedAt?: string; error?: string }
type SeenStamp = { updatedAt: string; reasons: string[] };
const pullKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_.-]{1,100}\/pull\/[1-9]\d{0,9}$/, 'Invalid pull request');
/** New activity since it was seen: a newer update on GitHub or a reason it did not have then. */
const stillSeen = (item: InboxPull, stamp: SeenStamp | undefined) => !!stamp && Date.parse(item.updatedAt) <= Date.parse(stamp.updatedAt) && item.reasons.every(reason => stamp.reasons.includes(reason));

/** Open PRs that involve each connected GitHub account (github.com/pulls/inbox).
 * Reads are cached per account and refreshed at most once a minute; an unchanged
 * list backs off to ten minutes until it changes or the panel opens. */
export class GitHubInbox {
  private store: SqliteStore; private control: WorkspaceControl; private connections: () => ProviderConnection[];
  private clientFor: (connection: ProviderConnection) => GitHubClient; private now: () => number;
  private pending = new Map<string, Promise<void>>(); private timer?: ReturnType<typeof setInterval>; private closed = false;
  private unchanged = new Map<string, number>();
  constructor(store: SqliteStore, control: WorkspaceControl, connections: () => ProviderConnection[], clientFor: (connection: ProviderConnection) => GitHubClient, now = Date.now) {
    this.store = store; this.control = control; this.connections = connections; this.clientFor = clientFor; this.now = now;
  }
  private accounts() { return this.connections().filter(connection => connection.providerId === 'github' && connection.enabled); }
  private cached(connection: ProviderConnection): Cached { return (this.store.inbox(connection.id, connection.account) as Cached | undefined) ?? { items: [] }; }
  /** `poll` is the background timer; `open` (the panel opened) and `force` (Refresh) are a person's reads. */
  private refreshOne(connection: ProviderConnection, mode: 'poll' | 'open' | 'force') {
    if (this.closed) return Promise.resolve();
    const old = this.cached(connection), last = old.refreshedAt ? Date.parse(old.refreshedAt) : 0;
    if (mode !== 'poll') this.unchanged.set(connection.id, 0);
    const steps = INBOX_CADENCE[Math.min(this.unchanged.get(connection.id) ?? 0, INBOX_CADENCE.length - 1)], factor = mode === 'poll' ? knownBudget('github', connection.account)?.backgroundFactor() ?? 1 : 1;
    if ((old.retryAt ?? 0) > this.now() || (mode !== 'force' && this.now() - last < INBOX_REFRESH_MS * steps * factor)) return Promise.resolve();
    const running = this.pending.get(connection.id); if (running) return running;
    const work = (async () => {
      try {
        const read = () => this.clientFor(connection).inbox(AbortSignal.timeout(90_000));
        const items = await (mode === 'poll' ? inBackground(read) : read());
        if (this.closed) return;
        this.unchanged.set(connection.id, mode === 'poll' && old.refreshedAt && canonical(items) === canonical(old.items) ? (this.unchanged.get(connection.id) ?? 0) + 1 : 0);
        this.store.saveInbox(connection.id, connection.account, { items, refreshedAt: new Date(this.now()).toISOString() }, this.now());
        this.pruneSeen();
      } catch (error) {
        // Keep the last complete list; show why it is stale and honor rate-limit backoff.
        const failure = error as Error & { retryAt?: number };
        if (this.closed) return;
        this.store.saveInbox(connection.id, connection.account, { ...old, error: failure.message, retryAt: failure.retryAt ?? this.now() + 30_000 }, this.now());
      } finally { this.pending.delete(connection.id); }
    })();
    this.pending.set(connection.id, work); return work;
  }
  /** Once every account has a complete list, seen rows of pull requests in none of them go. */
  private pruneSeen() {
    const lists = this.accounts().map(connection => this.cached(connection));
    if (lists.every(list => list.refreshedAt)) this.store.pruneSeenInboxPulls(new Set(lists.flatMap(list => list.items.map(item => item.key))));
  }
  async refresh(force = false) { await Promise.all(this.accounts().map(connection => this.refreshOne(connection, force ? 'force' : 'poll'))); }
  /** The panel opened: return to one-minute refreshes and read any list older than a minute now. */
  async opened() { await Promise.all(this.accounts().map(connection => this.refreshOne(connection, 'open'))); }
  start() { this.timer ??= setInterval(() => { void this.refresh(); }, INBOX_REFRESH_MS); void this.refresh(); }
  stop() { clearInterval(this.timer); this.timer = undefined; }
  /** Stops for good; a read still in flight finishes without writing to the store. */
  async close() { this.closed = true; this.stop(); await Promise.allSettled([...this.pending.values()]); }
  /** Cached lists, each PR marked with its map item when one exists. */
  async read(): Promise<{ accounts: InboxAccount[] }> {
    // A newly connected account is fetched right away rather than at the next minute.
    for (const connection of this.accounts()) if (!this.cached(connection).refreshedAt) void this.refreshOne(connection, 'poll');
    const state = await this.control.read(), hidden = this.store.hiddenInboxPulls(), seen = this.store.seenInboxPulls();
    return { accounts: this.accounts().map(connection => {
      const cached = this.cached(connection);
      return { connectionId: connection.id, login: connection.account, ...(cached.refreshedAt ? { refreshedAt: cached.refreshedAt } : {}), ...(cached.error ? { error: cached.error } : {}),
        items: cached.items.filter(item => !hidden.has(item.key)).map(item => {
          const node = mapNode(state, item.key);
          return { ...item, ...(node ? { nodeId: node.id, below: isBelow(node, state.nodes) } : {}), ...(stillSeen(item, seen.get(item.key)) ? { seen: true } : {}) };
        }) };
    }) };
  }
  /** Hides a pull request from the inbox for good, for every account. */
  async hide(input: unknown) {
    const { key } = z.object({ key: pullKeySchema }).parse(input);
    this.store.hideInboxPull(key.toLowerCase(), this.now()); return { hidden: true };
  }
  /** Marks a pull request Seen with the activity it has now, or puts it back in the Inbox. */
  async seen(input: unknown) {
    const { key: raw, seen } = z.object({ key: pullKeySchema, seen: z.boolean() }).parse(input), key = raw.toLowerCase();
    if (!seen) { this.store.unseeInboxPull(key); return { seen }; }
    const copies = this.accounts().flatMap(connection => this.cached(connection).items.filter(item => item.key === key));
    if (!copies.length) throw new Error('This pull request is no longer in your inbox. Refresh it and try again.');
    const updatedAt = copies.map(item => item.updatedAt).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1)!;
    this.store.seeInboxPull(key, { updatedAt, reasons: [...new Set(copies.flatMap(item => item.reasons))] }, this.now());
    return { seen };
  }
  /** Adds the PR beside the project that already holds PRs from its repository, or
   * floating at `position`. An existing item is reused, never duplicated. */
  async showOnMap(input: unknown) {
    const { connectionId, key, position } = z.object({ connectionId: z.string().min(1), key: z.string().min(1).max(400), position: z.object({ x: z.number().finite(), y: z.number().finite() }) }).parse(input);
    const connection = this.accounts().find(candidate => candidate.id === connectionId);
    const item = connection && this.cached(connection).items.find(candidate => candidate.key === key);
    if (!connection || !item) throw new Error('This pull request is no longer in your inbox. Refresh it and try again.');
    for (let attempt = 0; attempt < 5; attempt++) {
      const state = await this.control.read(), existing = mapNode(state, key);
      if (existing) return { nodeId: existing.id, created: false };
      const repository = `${item.owner}/${item.repo}`.toLowerCase(), projects = new Set<string>();
      for (const node of state.nodes) {
        const resource = state.resources.find(record => record.id === node.resourceId);
        if (node.projectId && !isArchived(node, state.nodes) && resource?.pluginId === 'github.pull-request' && `${resource.data.owner}/${resource.data.repo}`.toLowerCase() === repository) projects.add(node.projectId);
      }
      const projectId = projects.size === 1 ? [...projects][0] : undefined, project = state.nodes.find(node => node.id === projectId);
      const nodeId = randomUUID();
      try {
        await this.control.dispatch({ commandId: randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'github-inbox' }, commands: [
          { type: 'item.add', id: nodeId, resourceId: randomUUID(), pluginId: 'github.pull-request', connectionId: connection.id, title: item.title,
            data: { owner: item.owner, repo: item.repo, number: item.number }, ...(projectId ? { projectId } : {}), position: project?.position ?? position },
        ] });
        return { nodeId, created: true };
      } catch (error) { if ((error as { code?: string }).code !== 'REVISION_CONFLICT') throw error; }
    }
    throw new Error('The table kept changing. Try Show on map again.');
  }
}

function mapNode(state: WorkspaceState, key: string) {
  const resource = state.resources.find(record => record.pluginId === 'github.pull-request' && (() => { try { return pullKey({ owner: String(record.data.owner), repo: String(record.data.repo), number: Number(record.data.number) }) === key; } catch { return false; } })());
  return resource ? state.nodes.find(node => node.resourceId === resource.id && !isArchived(node, state.nodes)) : undefined;
}
