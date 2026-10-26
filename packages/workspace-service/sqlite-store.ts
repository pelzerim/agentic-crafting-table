import { settingsSchema, settingsWriteSchema } from '../core/settings.ts';
import { DEFAULT_MAP_DASHBOARDS, FORMER_DASHBOARD_ZOOM } from '../../src/graph/project-dashboard.ts';
import { validateMapSettings } from '../core/item-map-sizes.ts';
import { createResourcePluginRegistry } from '../../src/resource-plugins/builtins.ts';
import { layoutFootprints, repairLayout } from '../../src/graph/movement.ts';
import { SNAP_PITCH, type MapLayout } from '../../src/graph/snap.ts';
import type { AppSettings, SettingsSnapshot } from '../core/settings.ts';
import { MAX_RECENT_DIRECTORIES } from '../core/working-directories.ts';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonical, CommandIdConflict, emptyState, receiptRevision, RevisionConflict, stateSchema, viewSchema } from '../core/control.ts';
import type { CommandEnvelope, CommandResult, WorkspaceCommand, WorkspaceState, WorkspaceStore } from '../core/control.ts';
import type { RecoveryState } from './lifecycle.ts';
import { attentionItems, nodeAttentionReasons } from '../../src/graph/attention.ts';
import type { AttentionReason } from '../../src/graph/attention.ts';
import type { CachedResponse, ValidatorStore } from '../provider-runtime/request-budget.ts';
import type { Validation, RolloutEvent } from '../../src/resource-plugins/items/github-rollout/validation.ts';
import { applyBackground } from './agent-background.ts';
import type { BackgroundChange, BackgroundState } from './agent-background.ts';
import type { JsonValue } from '../../src/resource-plugins/types.ts';
import type { PluginRecord, PluginStorage } from '../plugin-sdk/host.ts';
import { REMINDER_SEEDS } from '../core/reminders.ts';
import type { Reminder, ReminderDay } from '../core/reminders.ts';
import type { StandupEvidence } from '../core/standup.ts';
import { migrateTodoHorizons } from './todo-horizon-migration.ts';
import { migrateValidationLinks } from './validation-link-migration.ts';

/** Marks settings saved before package settings existed, so the values they relied on can be kept. */
const SETTINGS_BEFORE_PLUGINS = 'settings:before-plugin-settings';
/** Set once the first-run reminders exist, so deleting them sticks. */
const REMINDERS_SEEDED = 'reminders_seeded';
export const migrations = [
  `CREATE TABLE workspace (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL, view TEXT NOT NULL);
   CREATE TABLE resources (id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, connection_id TEXT NOT NULL, provider_key TEXT, body TEXT NOT NULL);
   CREATE UNIQUE INDEX provider_identity ON resources(plugin_id, connection_id, provider_key) WHERE provider_key IS NOT NULL;
   CREATE TABLE nodes (id TEXT PRIMARY KEY, resource_id TEXT REFERENCES resources(id) DEFERRABLE INITIALLY DEFERRED, project_id TEXT REFERENCES nodes(id) DEFERRABLE INITIALLY DEFERRED, ordinal INTEGER NOT NULL UNIQUE, body TEXT NOT NULL);
   CREATE TABLE links (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES nodes(id) DEFERRABLE INITIALLY DEFERRED, target_id TEXT NOT NULL REFERENCES nodes(id) DEFERRABLE INITIALLY DEFERRED, ordinal INTEGER NOT NULL UNIQUE, body TEXT NOT NULL);
   CREATE TABLE todos (id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE, body TEXT NOT NULL);`,
  `CREATE TABLE receipts (command_id TEXT PRIMARY KEY, input TEXT NOT NULL, result TEXT NOT NULL);
   CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, revision INTEGER NOT NULL, subject_id TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE TABLE event_meta (id INTEGER PRIMARY KEY CHECK(id = 1), floor INTEGER NOT NULL DEFAULT 0);
   INSERT INTO event_meta(id, floor) VALUES (1, 0);
   CREATE TABLE views (client_id TEXT PRIMARY KEY, body TEXT NOT NULL);
   CREATE TABLE imports (digest TEXT PRIMARY KEY, imported_at TEXT NOT NULL);
   CREATE TABLE jobs (id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, input TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, correlation TEXT NOT NULL DEFAULT '{}', result TEXT, error TEXT, updated_at TEXT NOT NULL);`,
  `CREATE TABLE service_owner (id INTEGER PRIMARY KEY CHECK(id = 1), instance_id TEXT NOT NULL, pid INTEGER NOT NULL);`,
  `CREATE TABLE agent_observations (session_id TEXT PRIMARY KEY, observed_at INTEGER NOT NULL, event TEXT NOT NULL);`,
  `CREATE TABLE recovery_checkpoint (id INTEGER PRIMARY KEY CHECK(id = 1), body TEXT NOT NULL);`,
  `CREATE TABLE app_settings (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL, body TEXT NOT NULL);`,
  `CREATE TABLE activity_summaries (resource_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, expected_summary TEXT NOT NULL, attempted_at INTEGER NOT NULL, text TEXT, generated INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE summary_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL);
   CREATE INDEX summary_attempts_time ON summary_attempts(started_at);`,
  `CREATE TABLE resource_cache (resource_id TEXT NOT NULL, cache_key TEXT NOT NULL, fingerprint TEXT NOT NULL, body TEXT, error TEXT, retry_at INTEGER, checked_at INTEGER NOT NULL, PRIMARY KEY(resource_id, cache_key));`,
  `CREATE TABLE provider_observations (scope TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL);`,
  `CREATE TABLE github_inbox (connection_id TEXT PRIMARY KEY, account TEXT NOT NULL, body TEXT NOT NULL, checked_at INTEGER NOT NULL);
   CREATE TABLE github_inbox_hidden (pull_key TEXT PRIMARY KEY, hidden_at INTEGER NOT NULL);`,
  `CREATE TABLE review_sends (id TEXT PRIMARY KEY, review_node_id TEXT NOT NULL, review_session_id TEXT NOT NULL, agent_node_id TEXT NOT NULL, finding_ids TEXT NOT NULL, note TEXT NOT NULL, prompt TEXT NOT NULL, state TEXT NOT NULL, linked INTEGER NOT NULL DEFAULT 0, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE INDEX review_sends_review ON review_sends(review_session_id);
   CREATE INDEX review_sends_state ON review_sends(state);
   CREATE TABLE review_finding_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, review_session_id TEXT NOT NULL, finding_id TEXT NOT NULL, status TEXT NOT NULL, send_id TEXT, agent_node_id TEXT, actor TEXT NOT NULL, commit_sha TEXT, note TEXT, at INTEGER NOT NULL);
   CREATE INDEX review_finding_events_review ON review_finding_events(review_session_id);`,
  `CREATE TABLE attention_history (cycle_key TEXT PRIMARY KEY, node_id TEXT NOT NULL, resource_id TEXT, title TEXT NOT NULL, reasons TEXT NOT NULL, project TEXT NOT NULL, raised_at INTEGER, seen_at INTEGER, outcome TEXT);
   CREATE INDEX attention_history_seen ON attention_history(seen_at);`,
  `CREATE TABLE provider_validators (provider TEXT NOT NULL, account TEXT NOT NULL, path TEXT NOT NULL, etag TEXT, last_modified TEXT, link TEXT, body TEXT NOT NULL, size INTEGER NOT NULL, used_at INTEGER NOT NULL, PRIMARY KEY(provider, account, path));
   CREATE INDEX provider_validators_used ON provider_validators(provider, account, used_at);`,
  `CREATE TABLE rollout_validations (id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL, rollout_resource_id TEXT NOT NULL, agent_node_id TEXT NOT NULL, agent TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, scope TEXT NOT NULL, state TEXT NOT NULL, verdict TEXT,
     sequence INTEGER NOT NULL DEFAULT 0, reports INTEGER NOT NULL DEFAULT 0, report TEXT, requested_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, updated_at INTEGER NOT NULL, idle_since INTEGER, UNIQUE(rollout_resource_id, ordinal));
   CREATE TABLE rollout_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, rollout_resource_id TEXT NOT NULL, run_id INTEGER NOT NULL, attempt INTEGER NOT NULL, kind TEXT NOT NULL, job_id INTEGER NOT NULL DEFAULT 0, environment TEXT NOT NULL DEFAULT '',
     actor TEXT, body TEXT NOT NULL, observed_at INTEGER NOT NULL, UNIQUE(rollout_resource_id, run_id, attempt, kind, job_id, environment));`,
  `CREATE TABLE IF NOT EXISTS agent_background (session_id TEXT PRIMARY KEY, body TEXT NOT NULL);`,
  `ALTER TABLE attention_history ADD COLUMN notes TEXT;`,
  `CREATE TABLE IF NOT EXISTS recent_directories (path TEXT PRIMARY KEY, used_at INTEGER NOT NULL);`,
  `CREATE TABLE IF NOT EXISTS plots (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, member_ids TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, name TEXT, generated INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, changed_at INTEGER NOT NULL, fingerprint TEXT, attempted_at INTEGER);
   CREATE INDEX IF NOT EXISTS plots_project ON plots(project_id);
   CREATE TABLE IF NOT EXISTS plot_projects (project_id TEXT PRIMARY KEY);`,
  `CREATE TABLE IF NOT EXISTS plugin_records (plugin_id TEXT NOT NULL, collection TEXT NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL, ordinal INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY(plugin_id, collection, key));
   CREATE INDEX IF NOT EXISTS plugin_records_order ON plugin_records(plugin_id, collection, ordinal, key);`,
  `INSERT OR IGNORE INTO provider_observations(scope, revision, body) SELECT '${SETTINGS_BEFORE_PLUGINS}', 1, '{}' WHERE EXISTS (SELECT 1 FROM app_settings);`,
  `CREATE TABLE IF NOT EXISTS plugin_lock (id TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at INTEGER NOT NULL);`,
  `CREATE TABLE IF NOT EXISTS reminders (id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE, label TEXT NOT NULL, enabled INTEGER NOT NULL, rules TEXT NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS reminder_days (reminder_id TEXT NOT NULL, date TEXT NOT NULL, due_at INTEGER NOT NULL, fired_at INTEGER, done_at INTEGER, snoozed_until INTEGER, PRIMARY KEY(reminder_id, date));`,
  // To-do context (TODO-11) lives in the todos and nodes bodies. The version step keeps a build from before it,
  // which would drop the text on its next save, from opening the workspace.
  `SELECT 1;`,
  // Standup report (STANDUP-01): one digest per kind, subject and local day, and composed reports by input key.
  `CREATE TABLE IF NOT EXISTS standup_digests (kind TEXT NOT NULL, subject TEXT NOT NULL, day TEXT NOT NULL, text TEXT, evidence TEXT NOT NULL DEFAULT '[]', model TEXT, fingerprint TEXT, created_at INTEGER,
     failed_fingerprint TEXT, attempted_at INTEGER NOT NULL, PRIMARY KEY(kind, subject, day));
   CREATE TABLE IF NOT EXISTS standup_reports (key TEXT PRIMARY KEY, body TEXT NOT NULL, model TEXT NOT NULL, created_at INTEGER NOT NULL);`,
  // To-do horizons (TODO-12) live in the todos and nodes bodies; `migrateTodoHorizons` files the saved to-dos once.
  `SELECT 1;`,
  // Links that show only on hover (reveal) live in the links bodies; `migrateValidationLinks` marks the saved validation links once.
  `SELECT 1;`,
  `CREATE TABLE IF NOT EXISTS github_inbox_seen (pull_key TEXT PRIMARY KEY, updated_at TEXT NOT NULL, reasons TEXT NOT NULL, seen_at INTEGER NOT NULL);`,
  // Plot colors (MAP-24): the assigned color and a person's override, added once as `color` and `chosen_color` columns.
  `SELECT 1;`,
  `CREATE TABLE IF NOT EXISTS revision_conflicts (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, commands TEXT NOT NULL, expected INTEGER NOT NULL, current INTEGER NOT NULL, landed TEXT NOT NULL);`,
  // Project summaries for the project column (MAP-22): the input last sent per project and the latest text.
  `CREATE TABLE IF NOT EXISTS project_summaries (project_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, attempted_at INTEGER NOT NULL, text TEXT, model TEXT);`,
] as const;
const CONFLICTS_KEPT = 1000, CONFLICT_LANDED_SHOWN = 20;
export interface RevisionConflictRecord { at: string; actor: string; commands: CommandSubject[]; expected: number; current: number; landed: { revision: number; actor: string; commands: CommandSubject[] }[] }
type CommandSubject = { type: string; id?: string; ids?: string[] };
/** A command's type and the ids it names, without the data it carries. */
function commandSubject(command: WorkspaceCommand): CommandSubject {
  const { type, id, ids } = command as { type: string; id?: unknown; ids?: unknown };
  return { type, ...(typeof id === 'string' ? { id } : {}), ...(Array.isArray(ids) ? { ids: ids.map(String) } : {}) };
}
const TODO_HORIZONS_VERSION = 25, VALIDATION_LINKS_VERSION = 26, PLOT_COLORS_VERSION = 28;
/** Per-package storage quota and largest single record, in bytes of stored JSON. */
export const PLUGIN_STORAGE_BYTES = 16 * 1024 * 1024, PLUGIN_RECORD_BYTES = 1024 * 1024;
/** Conditional-request cache bounds per provider account (least recently used first out). */
export const VALIDATOR_ROWS = 2000, VALIDATOR_BYTES = 32 * 1024 * 1024;

export const ATTENTION_HISTORY_LIMIT = 100;
export interface StandupDigestRow { kind: string; subject: string; day: string; text?: string; evidence: StandupEvidence[]; model?: string; fingerprint?: string; createdAt?: number; failedFingerprint?: string; attemptedAt: number }
/** `notes` are the cycle's trigger-supplied reasons; rows recorded before notes existed have none. */
export interface AttentionHistoryEntry { key: string; nodeId: string; resourceId?: string; title: string; reasons: AttentionReason[]; notes?: string[]; project: string; raisedAt?: number; seenAt: number; outcome: 'seen' | 'cleared' }
type AttentionCycle = Omit<AttentionHistoryEntry, 'raisedAt' | 'seenAt' | 'outcome'> & { versions: Record<string, number> };
/** One cycle per resource identity and version, as the Needs me list presents it. */
function attentionCycles(state: WorkspaceState): Map<string, AttentionCycle> {
  const titles = new Map(state.nodes.filter(node => !node.resourceId).map(node => [node.id, node.title]));
  const items = attentionItems(state.nodes.filter(node => !node.resourceId || nodeAttentionReasons(node).length));
  return new Map(items.map(item => {
    const key = `${item.identity}:${Math.max(...item.aliases.map(alias => alias.attentionVersion ?? 0))}`;
    return [key, { key, nodeId: item.node.id, ...(item.node.resourceId ? { resourceId: item.node.resourceId } : {}), title: item.node.title, reasons: item.reasons, ...(item.notes.length ? { notes: item.notes } : {}),
      project: [...new Set(item.aliases.map(alias => titles.get(alias.projectId ?? '') ?? 'Floating item'))].join(' · '), versions: Object.fromEntries(item.aliases.map(alias => [alias.id, alias.attentionVersion ?? 0])) }];
  }));
}

/** Former plots a re-formed group can reclaim by identity; the oldest are forgotten. */
export const DORMANT_PLOTS_PER_PROJECT = 20;
/** A plot's identity, name and color. `generated` is false for a user's name; no name means the local fallback.
 * `color` is assigned once, `chosenColor` is a person's override. */
export interface ProjectSummaryRecord { projectId: string; fingerprint: string; attemptedAt: number; text?: string; model?: string }
export interface PlotRecord { id: string; projectId: string; memberIds: string[]; active: boolean; name?: string; generated: boolean; hidden: boolean; changedAt: number; fingerprint?: string; attemptedAt?: number; color?: string; chosenColor?: string }
/** The latest hook a Claude process sent, and when its hook process saw it. */
export interface AgentObservation { event: string; observedAt: number }
export type RolloutValidationPatch = Partial<Pick<Validation, 'state' | 'verdict' | 'sequence' | 'reports' | 'report' | 'scope' | 'startedAt' | 'finishedAt'>> & { idleSince?: number | null };
export type ReviewSendState = 'queued' | 'delivering' | 'sent' | 'failed' | 'cancelled' | 'uncertain';
export interface ReviewSend { id: string; reviewNodeId: string; reviewSessionId: string; agentNodeId: string; findingIds: string[]; note: string; prompt: string; state: ReviewSendState; linked: boolean; error?: string; createdAt: number; updatedAt: number }
export interface ReviewFindingEvent { sequence: number; reviewSessionId: string; findingId: string; status: 'queued' | 'sent' | 'fixed' | 'open'; sendId?: string; agentNodeId?: string; actor: 'user' | 'agent' | 'system'; commit?: string; note?: string; at: number }
export type JobState = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'outcome-unknown';
export interface JobInput { action: string; nodeId: string; arguments: Record<string, unknown> }
export interface JobRecord { id: string; requestKey: string; input: JobInput; state: JobState; attempts: number; correlation: Record<string, unknown>; result?: unknown; error?: string; updatedAt: string }
export interface WorkspaceEvent { sequence: number; kind: 'workspace.changed' | 'job.changed'; revision: number; subjectId: string; createdAt: string }
type Row = Record<string, string | number | bigint | Uint8Array | null>;
const decode = <T>(value: unknown): T => JSON.parse(String(value)) as T;
/** Free pages worth reclaiming when a workspace is opened. */
const RECLAIM_BYTES = 32 * 1024 * 1024;
const transitions: Record<JobState, readonly JobState[]> = {
  queued: ['running', 'cancelled'], running: ['running', 'waiting', 'succeeded', 'failed', 'cancelled', 'outcome-unknown'],
  waiting: ['waiting', 'running', 'failed', 'cancelled', 'outcome-unknown'], 'outcome-unknown': ['outcome-unknown', 'waiting', 'queued', 'succeeded', 'failed', 'cancelled'],
  succeeded: [], failed: ['queued'], cancelled: [],
};

export class SqliteStore implements WorkspaceStore, ValidatorStore {
  readonly file: string;
  readonly backupFile?: string;
  private db: DatabaseSync;
  private identity: (resource: WorkspaceState['resources'][number]) => string | undefined;
  private now: () => number;
  private reminderSeeds: readonly Omit<Reminder, 'id'>[];
  private rolloutListeners = new Set<(rolloutResourceId: string) => void>();
  private changedRollouts = new Set<string>();

  constructor(file: string, options: { identity?: (resource: WorkspaceState['resources'][number]) => string | undefined; now?: () => number; reminderSeeds?: readonly Omit<Reminder, 'id'>[] } = {}) {
    this.file = resolve(file);
    this.identity = options.identity ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.reminderSeeds = options.reminderSeeds ?? REMINDER_SEEDS;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const existed = existsSync(this.file);
    this.db = new DatabaseSync(this.file);
    try {
      if (!existed) chmodSync(this.file, 0o600);
      // Schema reads can meet another process opening/checkpointing this file.
      // Install the wait policy before the first read, not only before writes.
      this.db.exec('PRAGMA busy_timeout = 2000; PRAGMA foreign_keys = ON;');
      const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
      if (version > migrations.length) throw new Error(`Workspace schema ${version} is newer than this app supports (${migrations.length})`);
      if (existed && version > 0 && version < migrations.length) {
        this.backupFile = `${this.file}.backup-v${version}-${randomUUID()}.sqlite`;
        this.db.prepare('VACUUM INTO ?').run(this.backupFile);
        chmodSync(this.backupFile, 0o600);
      }
      this.transaction(() => {
        const current = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
        for (let i = current; i < migrations.length; i++) {
          this.db.exec(migrations[i]);
          this.db.exec(`PRAGMA user_version = ${i + 1}`);
        }
        this.db.prepare('INSERT OR IGNORE INTO workspace(id, revision, view) VALUES (1, 0, ?)').run(JSON.stringify(emptyState().view));
        if (current > 0 && current < TODO_HORIZONS_VERSION) {
          const imported = new Map(this.db.prepare("SELECT body FROM provider_observations WHERE scope LIKE 'triage:%'").all()
            .flatMap(row => (decode<{ entries?: { todoId?: string; title?: string }[] }>(row.body).entries ?? []).flatMap(entry => entry.todoId && entry.title !== undefined ? [[entry.todoId, entry.title] as const] : [])));
          this.writeState(migrateTodoHorizons(this.readState(), imported, new Date(this.now()).toISOString()));
        }
        if (current > 0 && current < VALIDATION_LINKS_VERSION) this.writeState(migrateValidationLinks(this.readState()));
        if (current < PLOT_COLORS_VERSION) {
          const columns = new Set(this.db.prepare('PRAGMA table_info(plots)').all().map(row => String(row.name)));
          for (const column of ['color', 'chosen_color']) if (!columns.has(column)) this.db.exec(`ALTER TABLE plots ADD COLUMN ${column} TEXT`);
        }
      });
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      if (this.backupFile) this.keepOnlyBackup(this.backupFile);
      this.trimReceipts();
      const pages = (name: string) => Number(Object.values(this.db.prepare(`PRAGMA ${name}`).get()!)[0]);
      if (pages('freelist_count') * pages('page_size') > RECLAIM_BYTES) this.db.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
    } catch (error) { this.db.close(); throw error; }
  }

  close() { this.db.close(); }

  /** Empties workspace copies that earlier versions saved in receipts; the space is reclaimed on open. */
  private trimReceipts() {
    this.db.prepare("UPDATE receipts SET result = '' WHERE result <> ''").run();
  }

  observation<T>(scope: string): { revision: number; value?: T } {
    const row = this.db.prepare('SELECT revision, body FROM provider_observations WHERE scope = ?').get(scope);
    return row ? { revision: Number(row.revision), value: decode<T>(row.body) } : { revision: 0 };
  }
  /** Provider checkpoints and their shared graph commands commit atomically.
   * Unchanged observations never need to bump the workspace revision. */
  commitObservation(scope: string, expectedRevision: number, value: unknown, graph?: { envelope: CommandEnvelope; reduce(state: WorkspaceState): WorkspaceState }) {
    const body = JSON.stringify(value);
    if (!scope || scope.length > 200 || Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error('Invalid provider observation');
    return this.transaction(() => {
      if (this.observation(scope).revision !== expectedRevision) throw Object.assign(new Error('Provider observation changed; reconcile again.'), { code: 'OBSERVATION_CONFLICT' });
      const result = graph ? this.commitDraft(graph.envelope, graph.reduce) : undefined;
      if (result?.replayed) throw new Error('Provider observation command was already committed');
      this.db.prepare('INSERT INTO provider_observations(scope, revision, body) VALUES (?, ?, ?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision, body=excluded.body').run(scope, expectedRevision + 1, body);
      return result;
    });
  }

  resourceCache(resourceId: string, key: string, fingerprint: string): { value?: unknown; error?: string; retryAt?: number; checkedAt: number } | undefined {
    const row = this.db.prepare('SELECT * FROM resource_cache WHERE resource_id = ? AND cache_key = ? AND fingerprint = ?').get(resourceId, key, fingerprint);
    return row ? { value: row.body === null ? undefined : decode(row.body), error: row.error === null ? undefined : String(row.error), retryAt: row.retry_at === null ? undefined : Number(row.retry_at), checkedAt: Number(row.checked_at) } : undefined;
  }
  cacheResource(resourceId: string, key: string, fingerprint: string, value: unknown, checkedAt: number, error?: string, retryAt?: number) {
    const body = value === undefined ? null : JSON.stringify(value);
    if (body && Buffer.byteLength(body) > 4 * 1024 * 1024) throw new Error('Provider content exceeds the saved-content limit.');
    // No cascade: graph commits replace resource rows. Explicitly prune only
    // records whose logical resource is gone, and obsolete comparison entries.
    this.db.exec('DELETE FROM resource_cache WHERE resource_id NOT IN (SELECT id FROM resources)');
    this.db.prepare('INSERT INTO resource_cache(resource_id, cache_key, fingerprint, body, error, retry_at, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(resource_id, cache_key) DO UPDATE SET fingerprint=excluded.fingerprint, body=excluded.body, error=excluded.error, retry_at=excluded.retry_at, checked_at=excluded.checked_at').run(resourceId, key, fingerprint, body, error ?? null, retryAt ?? null, checkedAt);
  }

  validator(provider: string, account: string, path: string): CachedResponse | undefined {
    const row = this.db.prepare('SELECT etag, last_modified, link, body FROM provider_validators WHERE provider = ? AND account = ? AND path = ?').get(provider, account, path);
    return row ? { ...(row.etag === null ? {} : { etag: String(row.etag) }), ...(row.last_modified === null ? {} : { lastModified: String(row.last_modified) }), ...(row.link === null ? {} : { link: String(row.link) }), body: decode(row.body) } : undefined;
  }
  touchValidator(provider: string, account: string, path: string, usedAt: number) { this.db.prepare('UPDATE provider_validators SET used_at = ? WHERE provider = ? AND account = ? AND path = ?').run(usedAt, provider, account, path); }
  saveValidator(provider: string, account: string, path: string, value: CachedResponse, usedAt: number) {
    const body = JSON.stringify(value.body ?? null), size = Buffer.byteLength(body) + path.length;
    this.transaction(() => {
      this.db.prepare('INSERT INTO provider_validators(provider, account, path, etag, last_modified, link, body, size, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(provider, account, path) DO UPDATE SET etag=excluded.etag, last_modified=excluded.last_modified, link=excluded.link, body=excluded.body, size=excluded.size, used_at=excluded.used_at')
        .run(provider, account, path, value.etag ?? null, value.lastModified ?? null, value.link ?? null, body, size, usedAt);
      this.db.prepare('DELETE FROM provider_validators WHERE rowid IN (SELECT rowid FROM (SELECT rowid, ROW_NUMBER() OVER recent AS position, SUM(size) OVER recent AS total FROM provider_validators WHERE provider = ? AND account = ? WINDOW recent AS (ORDER BY used_at DESC, rowid DESC)) WHERE position > ? OR total > ?)')
        .run(provider, account, VALIDATOR_ROWS, VALIDATOR_BYTES);
    });
  }

  /** The GitHub inbox is account-level, not a map resource, so it has its own table. */
  inbox(connectionId: string, account: string): unknown {
    const row = this.db.prepare('SELECT body FROM github_inbox WHERE connection_id = ? AND account = ?').get(connectionId, account);
    return row ? decode(row.body) : undefined;
  }
  saveInbox(connectionId: string, account: string, value: unknown, checkedAt: number) {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > 4 * 1024 * 1024) throw new Error('Provider content exceeds the saved-content limit.');
    this.db.prepare('INSERT INTO github_inbox(connection_id, account, body, checked_at) VALUES (?, ?, ?, ?) ON CONFLICT(connection_id) DO UPDATE SET account=excluded.account, body=excluded.body, checked_at=excluded.checked_at').run(connectionId, account, body, checkedAt);
  }
  hiddenInboxPulls() { return new Set(this.db.prepare('SELECT pull_key FROM github_inbox_hidden').all().map(row => String(row.pull_key))); }
  hideInboxPull(key: string, at: number) {
    this.transaction(() => {
      this.db.prepare('INSERT INTO github_inbox_hidden(pull_key, hidden_at) VALUES (?, ?) ON CONFLICT(pull_key) DO NOTHING').run(key, at);
      this.unseeInboxPull(key);
    });
  }
  /** Pull requests marked Seen, with the activity they had at that moment. */
  seenInboxPulls() {
    return new Map(this.db.prepare('SELECT pull_key, updated_at, reasons FROM github_inbox_seen').all()
      .map(row => [String(row.pull_key), { updatedAt: String(row.updated_at), reasons: decode<string[]>(row.reasons) }] as const));
  }
  seeInboxPull(key: string, stamp: { updatedAt: string; reasons: string[] }, at: number) {
    this.db.prepare('INSERT INTO github_inbox_seen(pull_key, updated_at, reasons, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(pull_key) DO UPDATE SET updated_at=excluded.updated_at, reasons=excluded.reasons, seen_at=excluded.seen_at')
      .run(key, stamp.updatedAt, JSON.stringify(stamp.reasons), at);
  }
  unseeInboxPull(key: string) { this.db.prepare('DELETE FROM github_inbox_seen WHERE pull_key = ?').run(key); }
  /** Drops seen rows for pull requests no longer in any inbox list. */
  pruneSeenInboxPulls(keep: Set<string>) {
    const remove = this.db.prepare('DELETE FROM github_inbox_seen WHERE pull_key = ?');
    this.transaction(() => { for (const key of this.seenInboxPulls().keys()) if (!keep.has(key)) remove.run(key); });
  }

  /** Findings sent from a review to an agent: a durable queue plus per-finding history. */
  reviewSend(id: string) { const row = this.db.prepare('SELECT * FROM review_sends WHERE id = ?').get(id); return row ? this.send(row) : undefined; }
  reviewSends(filter: { reviewSessionId?: string; states?: ReviewSendState[] } = {}) {
    return this.db.prepare('SELECT * FROM review_sends ORDER BY created_at, rowid').all().map(row => this.send(row))
      .filter(send => (!filter.reviewSessionId || send.reviewSessionId === filter.reviewSessionId) && (!filter.states || filter.states.includes(send.state)));
  }
  reviewFindingEvents(reviewSessionId: string): ReviewFindingEvent[] {
    return this.db.prepare('SELECT * FROM review_finding_events WHERE review_session_id = ? ORDER BY sequence').all(reviewSessionId).map(row => ({
      sequence: Number(row.sequence), reviewSessionId: String(row.review_session_id), findingId: String(row.finding_id), status: String(row.status) as ReviewFindingEvent['status'],
      ...(row.send_id === null ? {} : { sendId: String(row.send_id) }), ...(row.agent_node_id === null ? {} : { agentNodeId: String(row.agent_node_id) }), actor: String(row.actor) as ReviewFindingEvent['actor'],
      ...(row.commit_sha === null ? {} : { commit: String(row.commit_sha) }), ...(row.note === null ? {} : { note: String(row.note) }), at: Number(row.at) }));
  }
  /** Creates the send and its queued events together; an existing id is returned unchanged. */
  createReviewSend(send: Omit<ReviewSend, 'state' | 'createdAt' | 'updatedAt' | 'error'>, at: number) {
    return this.transaction(() => {
      const existing = this.reviewSend(send.id); if (existing) return { send: existing, created: false };
      this.db.prepare('INSERT INTO review_sends(id, review_node_id, review_session_id, agent_node_id, finding_ids, note, prompt, state, linked, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(send.id, send.reviewNodeId, send.reviewSessionId, send.agentNodeId, JSON.stringify(send.findingIds), send.note, send.prompt, 'queued', Number(send.linked), at, at);
      this.insertFindingEvents(send.findingIds.map(findingId => ({ reviewSessionId: send.reviewSessionId, findingId, status: 'queued', sendId: send.id, agentNodeId: send.agentNodeId, actor: 'user', at })));
      return { send: this.reviewSend(send.id)!, created: true };
    });
  }
  /** Compare-and-set on the send state, with its finding events in the same transaction. */
  transitionReviewSend(id: string, from: readonly ReviewSendState[], to: ReviewSendState, at: number, patch: { error?: string; status?: ReviewFindingEvent['status']; actor?: ReviewFindingEvent['actor'] } = {}) {
    return this.transaction(() => {
      const send = this.reviewSend(id);
      if (!send || !from.includes(send.state)) return undefined;
      this.db.prepare('UPDATE review_sends SET state = ?, error = ?, updated_at = ? WHERE id = ?').run(to, patch.error ?? null, at, id);
      if (patch.status) this.insertFindingEvents(send.findingIds.map(findingId => ({ reviewSessionId: send.reviewSessionId, findingId, status: patch.status!, sendId: id, agentNodeId: send.agentNodeId, actor: patch.actor ?? 'system', note: patch.error, at })));
      return this.reviewSend(id)!;
    });
  }
  addReviewFindingEvents(events: Omit<ReviewFindingEvent, 'sequence'>[]) { this.transaction(() => this.insertFindingEvents(events)); }
  private insertFindingEvents(events: Omit<ReviewFindingEvent, 'sequence'>[]) {
    const insert = this.db.prepare('INSERT INTO review_finding_events(review_session_id, finding_id, status, send_id, agent_node_id, actor, commit_sha, note, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const event of events) insert.run(event.reviewSessionId, event.findingId, event.status, event.sendId ?? null, event.agentNodeId ?? null, event.actor, event.commit ?? null, event.note ?? null, event.at);
  }
  private send(row: Row): ReviewSend {
    return { id: String(row.id), reviewNodeId: String(row.review_node_id), reviewSessionId: String(row.review_session_id), agentNodeId: String(row.agent_node_id), findingIds: decode<string[]>(row.finding_ids),
      note: String(row.note), prompt: String(row.prompt), state: String(row.state) as ReviewSendState, linked: Boolean(row.linked), ...(row.error === null ? {} : { error: String(row.error) }), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
  }

  /** Rollout validations: one row per request, holding the latest report snapshot. */
  /** `ordinal` takes an id an agent reported without a request; otherwise the next one is issued. */
  createRolloutValidation(input: Omit<Validation, 'ordinal' | 'sequence' | 'reports' | 'state' | 'updatedAt'> & { rolloutResourceId: string; ordinal?: number }) {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM rollout_validations WHERE request_id = ?').get(input.requestId); if (existing) return this.validation(existing);
      const ordinal = input.ordinal ?? Number(this.db.prepare('SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM rollout_validations WHERE rollout_resource_id = ?').get(input.rolloutResourceId)!.next);
      this.db.prepare('INSERT INTO rollout_validations(id, ordinal, rollout_resource_id, agent_node_id, agent, request_id, scope, state, requested_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(input.id, ordinal, input.rolloutResourceId, input.agentNodeId, JSON.stringify(input.agent), input.requestId, JSON.stringify(input.scope), 'requested', input.requestedAt, input.requestedAt);
      this.rolloutChanged(input.rolloutResourceId);
      return this.validation(this.db.prepare('SELECT * FROM rollout_validations WHERE id = ?').get(input.id)!);
    });
  }
  rolloutValidations(filter: { rolloutResourceId?: string; open?: boolean } = {}) {
    return this.db.prepare(`SELECT * FROM rollout_validations WHERE (? IS NULL OR rollout_resource_id = ?) AND (? = 0 OR state IN ('requested', 'running')) ORDER BY rollout_resource_id, ordinal`)
      .all(filter.rolloutResourceId ?? null, filter.rolloutResourceId ?? null, filter.open ? 1 : 0).map(row => this.validation(row));
  }
  /** Compare-and-set on the sequence, so a replayed or older report never overwrites a newer one. */
  updateRolloutValidation(id: string, expectedSequence: number, patch: RolloutValidationPatch, at = this.now()) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM rollout_validations WHERE id = ?').get(id);
      if (!row || Number(row.sequence) !== expectedSequence) return undefined;
      const current = this.validation(row), next = { ...current, ...patch }, touched = Object.keys(patch).some(key => key !== 'idleSince');
      this.db.prepare('UPDATE rollout_validations SET state = ?, verdict = ?, sequence = ?, reports = ?, report = ?, scope = ?, started_at = ?, finished_at = ?, updated_at = ?, idle_since = ? WHERE id = ?')
        .run(next.state, next.verdict ?? null, next.sequence, next.reports, next.report ? JSON.stringify(next.report) : null, JSON.stringify(next.scope), next.startedAt ?? null, next.finishedAt ?? null,
          touched ? at : current.updatedAt, patch.idleSince === undefined ? (row.idle_since === null ? null : Number(row.idle_since)) : patch.idleSince, id);
      if (touched) this.rolloutChanged(current.rolloutResourceId);
      return this.validation(this.db.prepare('SELECT * FROM rollout_validations WHERE id = ?').get(id)!);
    });
  }
  private validation(row: Row): Validation & { rolloutResourceId: string; idleSince?: number } {
    return { id: String(row.id), ordinal: Number(row.ordinal), rolloutResourceId: String(row.rollout_resource_id), agentNodeId: String(row.agent_node_id), agent: decode(row.agent), requestId: String(row.request_id),
      scope: decode(row.scope), state: String(row.state) as Validation['state'], ...(row.verdict === null ? {} : { verdict: String(row.verdict) as Validation['verdict'] }), sequence: Number(row.sequence), reports: Number(row.reports),
      ...(row.report === null ? {} : { report: decode(row.report) }), requestedAt: Number(row.requested_at), ...(row.started_at === null ? {} : { startedAt: Number(row.started_at) }),
      ...(row.finished_at === null ? {} : { finishedAt: Number(row.finished_at) }), updatedAt: Number(row.updated_at), ...(row.idle_since === null ? {} : { idleSince: Number(row.idle_since) }) };
  }
  /** Persisted rollout transitions; each is recorded once, except the per-attempt job snapshot, which is replaced. */
  addRolloutEvents(rolloutResourceId: string, events: readonly RolloutEvent[]) {
    this.transaction(() => {
      const insert = this.db.prepare(`INSERT INTO rollout_events(rollout_resource_id, run_id, attempt, kind, job_id, environment, actor, body, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(rollout_resource_id, run_id, attempt, kind, job_id, environment) DO UPDATE SET body = excluded.body, observed_at = excluded.observed_at WHERE excluded.kind = 'jobs-snapshot'`);
      let stored = 0;
      for (const event of events) stored += Number(insert.run(rolloutResourceId, event.runId, event.attempt, event.kind, event.jobId, event.environment, event.actor ?? null, JSON.stringify(event.body), event.observedAt).changes);
      if (stored) this.rolloutChanged(rolloutResourceId);
    });
  }
  /** Validations and rollout events live beside the graph: an event moves the snapshot cursor so subscribers re-read them,
   * and listeners hear of it once the change is committed, since no command broadcasts it. */
  private rolloutChanged(rolloutResourceId: string) { this.appendEvent('workspace.changed', this.readState().revision, `rollout:${rolloutResourceId}`); this.changedRollouts.add(rolloutResourceId); }
  onRolloutChange(listener: (rolloutResourceId: string) => void) { this.rolloutListeners.add(listener); return () => { this.rolloutListeners.delete(listener); }; }
  rolloutEvents(rolloutResourceId: string): RolloutEvent[] {
    return this.db.prepare('SELECT * FROM rollout_events WHERE rollout_resource_id = ? ORDER BY sequence').all(rolloutResourceId).map(row => ({ runId: Number(row.run_id), attempt: Number(row.attempt), kind: String(row.kind) as RolloutEvent['kind'],
      jobId: Number(row.job_id), environment: String(row.environment), ...(row.actor === null ? {} : { actor: String(row.actor) }), body: decode(row.body), observedAt: Number(row.observed_at) }));
  }

  /** Needs me cycles that left the list (seen, cleared, archived or deleted), newest first:
   * the latest one per item, and none for an item whose attention is active again. */
  attentionHistory(offset = 0, limit = 10): { entries: AttentionHistoryEntry[]; more: boolean } {
    const size = Math.max(0, Math.min(limit, ATTENTION_HISTORY_LIMIT - offset));
    const rows = this.db.prepare(`SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY COALESCE(resource_id, node_id) ORDER BY seen_at DESC, rowid DESC) AS latest, rowid AS position FROM attention_history history
      WHERE seen_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM attention_history active WHERE active.seen_at IS NULL AND COALESCE(active.resource_id, active.node_id) = COALESCE(history.resource_id, history.node_id)))
      WHERE latest = 1 ORDER BY seen_at DESC, position DESC LIMIT ? OFFSET ?`).all(size + 1, offset);
    return { more: rows.length > size, entries: rows.slice(0, size).map(row => ({ key: String(row.cycle_key), nodeId: String(row.node_id), ...(row.resource_id === null ? {} : { resourceId: String(row.resource_id) }),
      title: String(row.title), reasons: decode<AttentionReason[]>(row.reasons), ...(row.notes === null ? {} : { notes: decode<string[]>(row.notes) }), project: String(row.project), ...(row.raised_at === null ? {} : { raisedAt: Number(row.raised_at) }), seenAt: Number(row.seen_at), outcome: String(row.outcome) as AttentionHistoryEntry['outcome'] })) };
  }
  /** Runs inside graph commits: pending rows carry the raise time of active cycles;
   * a cycle absent after the commit is history, recorded once per cycle key. */
  private recordAttention(before: Map<string, AttentionCycle>, state: WorkspaceState) {
    const after = attentionCycles(state), now = this.now();
    if ([...after.keys()].every(key => before.has(key)) && [...before.keys()].every(key => after.has(key))) return;
    const nodes = new Map(state.nodes.map(node => [node.id, node]));
    const notes = (cycle: AttentionCycle) => cycle.notes ? JSON.stringify(cycle.notes) : null;
    const pending = this.db.prepare('INSERT INTO attention_history(cycle_key, node_id, resource_id, title, reasons, notes, project, raised_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(cycle_key) DO NOTHING');
    for (const cycle of after.values()) if (!before.has(cycle.key)) pending.run(cycle.key, cycle.nodeId, cycle.resourceId ?? null, cycle.title, JSON.stringify(cycle.reasons), notes(cycle), cycle.project, now);
    const ended = this.db.prepare(`INSERT INTO attention_history(cycle_key, node_id, resource_id, title, reasons, notes, project, seen_at, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cycle_key) DO UPDATE SET node_id = excluded.node_id, title = excluded.title, reasons = excluded.reasons, notes = excluded.notes, project = excluded.project, seen_at = excluded.seen_at, outcome = excluded.outcome`);
    const identities = new Set([...after.values()].map(cycle => cycle.resourceId ?? cycle.nodeId));
    for (const cycle of before.values()) {
      if (after.has(cycle.key) || identities.has(cycle.resourceId ?? cycle.nodeId)) continue;
      const seen = Object.entries(cycle.versions).some(([id, version]) => nodes.get(id)?.attentionSeenVersion === version);
      ended.run(cycle.key, cycle.nodeId, cycle.resourceId ?? null, cycle.title, JSON.stringify(cycle.reasons), notes(cycle), cycle.project, now, seen ? 'seen' : 'cleared');
    }
    this.db.prepare(`DELETE FROM attention_history WHERE seen_at IS NULL AND cycle_key NOT IN (SELECT value FROM json_each(?))`).run(JSON.stringify([...after.keys()]));
    this.db.prepare('DELETE FROM attention_history WHERE seen_at IS NOT NULL AND rowid NOT IN (SELECT rowid FROM attention_history WHERE seen_at IS NOT NULL ORDER BY seen_at DESC, rowid DESC LIMIT ?)').run(ATTENTION_HISTORY_LIMIT);
  }

  summary(resourceId: string) {
    const row = this.db.prepare('SELECT * FROM activity_summaries WHERE resource_id = ?').get(resourceId);
    return row ? { fingerprint: String(row.fingerprint), expectedSummary: String(row.expected_summary), attemptedAt: Number(row.attempted_at), text: row.text === null ? undefined : String(row.text), generated: Boolean(row.generated) } : undefined;
  }
  /** Reserve before invoking the provider. Failed/uncertain attempts consume the
   * same rolling allowance, including after service restarts. Never store output. */
  reserveSummary(resourceId: string, fingerprint: string, expectedSummary: string, policy: AppSettings['summaries'], now: number) {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM summary_attempts WHERE started_at <= ?').run(now - 86_400_000);
      this.db.exec('DELETE FROM activity_summaries WHERE resource_id NOT IN (SELECT id FROM resources)');
      const prior = this.summary(resourceId);
      if (prior?.fingerprint === fingerprint || (prior && now - prior.attemptedAt < policy.intervalSeconds * 1000)) return false;
      const usage = this.db.prepare('SELECT COUNT(*) AS day, COALESCE(SUM(started_at > ?), 0) AS hour FROM summary_attempts').get(now - 3_600_000)!;
      if (Number(usage.day) >= policy.requestsPerDay || Number(usage.hour) >= policy.requestsPerHour) return false;
      if (!this.db.prepare('SELECT id FROM resources WHERE id = ?').get(resourceId)) return false;
      this.db.prepare('INSERT INTO summary_attempts(started_at) VALUES (?)').run(now);
      this.db.prepare(`INSERT INTO activity_summaries(resource_id, fingerprint, expected_summary, attempted_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(resource_id) DO UPDATE SET fingerprint = excluded.fingerprint, expected_summary = excluded.expected_summary, attempted_at = excluded.attempted_at, text = NULL, generated = 0`).run(resourceId, fingerprint, expectedSummary, now);
      return true;
    });
  }
  finishSummary(resourceId: string, fingerprint: string, text: string, generated: boolean) {
    if (!text || text.length > 48) throw new Error('Invalid activity summary');
    return this.db.prepare('UPDATE activity_summaries SET text = ?, generated = ? WHERE resource_id = ? AND fingerprint = ?').run(text, Number(generated), resourceId, fingerprint).changes > 0;
  }

  /** One shared rolling allowance for every AI helper that has no per-item row of its own. `keep` leaves that many requests to the others. */
  reserveAiRequest(policy: AppSettings['summaries'], now: number, keep = 0) {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM summary_attempts WHERE started_at <= ?').run(now - 86_400_000);
      const usage = this.db.prepare('SELECT COUNT(*) AS day, COALESCE(SUM(started_at > ?), 0) AS hour FROM summary_attempts').get(now - 3_600_000)!;
      if (Number(usage.day) + keep >= policy.requestsPerDay || Number(usage.hour) + keep >= policy.requestsPerHour) return false;
      this.db.prepare('INSERT INTO summary_attempts(started_at) VALUES (?)').run(now); return true;
    });
  }
  standupDigest(kind: string, subject: string, day: string): StandupDigestRow | undefined {
    const row = this.db.prepare('SELECT * FROM standup_digests WHERE kind = ? AND subject = ? AND day = ?').get(kind, subject, day);
    return row ? this.digest(row) : undefined;
  }
  /** Written digests for these local days, oldest day first. */
  standupDigests(days: readonly string[]): StandupDigestRow[] {
    return this.db.prepare('SELECT * FROM standup_digests WHERE text IS NOT NULL AND day IN (SELECT value FROM json_each(?)) ORDER BY day, kind, subject').all(JSON.stringify(days)).map(row => this.digest(row));
  }
  saveStandupDigest(digest: { kind: string; subject: string; day: string; text: string; evidence: StandupEvidence[]; model: string; fingerprint: string }, at: number) {
    this.db.prepare(`INSERT INTO standup_digests(kind, subject, day, text, evidence, model, fingerprint, created_at, attempted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, subject, day) DO UPDATE SET text = excluded.text, evidence = excluded.evidence, model = excluded.model, fingerprint = excluded.fingerprint, created_at = excluded.created_at, failed_fingerprint = NULL, attempted_at = excluded.attempted_at`)
      .run(digest.kind, digest.subject, digest.day, digest.text, JSON.stringify(digest.evidence), digest.model, digest.fingerprint, at, at);
  }
  /** A failed or uncertain attempt keeps the earlier digest and records what was tried. */
  failStandupDigest(kind: string, subject: string, day: string, fingerprint: string, at: number) {
    this.db.prepare(`INSERT INTO standup_digests(kind, subject, day, failed_fingerprint, attempted_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(kind, subject, day) DO UPDATE SET failed_fingerprint = excluded.failed_fingerprint, attempted_at = excluded.attempted_at`).run(kind, subject, day, fingerprint, at);
  }
  standupReport(key: string) {
    const row = this.db.prepare('SELECT * FROM standup_reports WHERE key = ?').get(key);
    return row ? { body: decode(row.body), model: String(row.model), createdAt: Number(row.created_at) } : undefined;
  }
  saveStandupReport(key: string, body: unknown, model: string, at: number) {
    this.db.prepare('INSERT INTO standup_reports(key, body, model, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body, model = excluded.model, created_at = excluded.created_at').run(key, JSON.stringify(body), model, at);
  }
  /** Drops digests of days before `oldestDay` and reports older than 14 days. */
  pruneStandup(oldestDay: string, now: number) {
    this.db.prepare('DELETE FROM standup_digests WHERE day < ?').run(oldestDay);
    this.db.prepare('DELETE FROM standup_reports WHERE created_at < ?').run(now - 14 * 86_400_000);
  }
  private digest(row: Row): StandupDigestRow {
    return { kind: String(row.kind), subject: String(row.subject), day: String(row.day), ...(row.text === null ? {} : { text: String(row.text) }), evidence: decode<StandupEvidence[]>(row.evidence),
      ...(row.model === null ? {} : { model: String(row.model) }), ...(row.fingerprint === null ? {} : { fingerprint: String(row.fingerprint) }), ...(row.created_at === null ? {} : { createdAt: Number(row.created_at) }),
      ...(row.failed_fingerprint === null ? {} : { failedFingerprint: String(row.failed_fingerprint) }), attemptedAt: Number(row.attempted_at) };
  }

  agentTitle(resourceId: string) {
    const row = this.db.prepare(`SELECT fingerprint, checked_at FROM resource_cache WHERE resource_id = ? AND cache_key = 'agent-title'`).get(resourceId);
    return row ? { fingerprint: String(row.fingerprint), attemptedAt: Number(row.checked_at) } : undefined;
  }
  /** Shares the durable summary allowance. `minIntervalMs` 0 is an explicit request:
   * it skips the per-item interval and unchanged-fingerprint checks, not the allowance. */
  reserveAgentTitle(resourceId: string, fingerprint: string, policy: AppSettings['summaries'], now: number, minIntervalMs: number) {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM summary_attempts WHERE started_at <= ?').run(now - 86_400_000);
      const prior = this.agentTitle(resourceId);
      if (minIntervalMs && prior && (prior.fingerprint === fingerprint || now - prior.attemptedAt < minIntervalMs)) return false;
      const usage = this.db.prepare('SELECT COUNT(*) AS day, COALESCE(SUM(started_at > ?), 0) AS hour FROM summary_attempts').get(now - 3_600_000)!;
      if (Number(usage.day) >= policy.requestsPerDay || Number(usage.hour) >= policy.requestsPerHour) return false;
      if (!this.db.prepare('SELECT id FROM resources WHERE id = ?').get(resourceId)) return false;
      this.db.prepare('INSERT INTO summary_attempts(started_at) VALUES (?)').run(now);
      this.db.exec('DELETE FROM resource_cache WHERE resource_id NOT IN (SELECT id FROM resources)');
      this.db.prepare(`INSERT INTO resource_cache(resource_id, cache_key, fingerprint, checked_at) VALUES (?, 'agent-title', ?, ?)
        ON CONFLICT(resource_id, cache_key) DO UPDATE SET fingerprint = excluded.fingerprint, checked_at = excluded.checked_at`).run(resourceId, fingerprint, now);
      return true;
    });
  }

  /** Queues one automatic title for a newly attached item. The row outlives the
   * attempt as `attempted`/`skipped`, so no later refresh or restart queues it again. */
  queueAttachTitle(resourceId: string, sourceTitle: string, sample: { kind: string; text: string }, now: number) {
    this.transaction(() => {
      if (this.db.prepare(`SELECT 1 FROM resource_cache WHERE resource_id = ? AND cache_key = 'attach-title'`).get(resourceId)) return;
      this.cacheResource(resourceId, 'attach-title', 'pending', { sourceTitle, kind: sample.kind, text: sample.text.slice(0, 8000) }, now);
    });
  }
  pendingAttachTitles() {
    return this.db.prepare(`SELECT resource_id, body FROM resource_cache WHERE cache_key = 'attach-title' AND fingerprint = 'pending' ORDER BY checked_at, resource_id`).all()
      .map(row => ({ resourceId: String(row.resource_id), ...decode<{ sourceTitle: string; kind: string; text: string }>(row.body) }));
  }
  /** Spends the item's single attempt from the shared summary allowance. */
  reserveAttachTitle(resourceId: string, policy: AppSettings['summaries'], now: number) {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM summary_attempts WHERE started_at <= ?').run(now - 86_400_000);
      if (!this.db.prepare(`SELECT 1 FROM resource_cache WHERE resource_id = ? AND cache_key = 'attach-title' AND fingerprint = 'pending'`).get(resourceId)) return false;
      const usage = this.db.prepare('SELECT COUNT(*) AS day, COALESCE(SUM(started_at > ?), 0) AS hour FROM summary_attempts').get(now - 3_600_000)!;
      if (Number(usage.day) >= policy.requestsPerDay || Number(usage.hour) >= policy.requestsPerHour) return false;
      this.db.prepare('INSERT INTO summary_attempts(started_at) VALUES (?)').run(now);
      this.settleAttachTitle(resourceId, 'attempted', now);
      return true;
    });
  }
  settleAttachTitle(resourceId: string, outcome: 'attempted' | 'skipped', now: number) {
    this.db.prepare(`UPDATE resource_cache SET fingerprint = ?, body = NULL, checked_at = ? WHERE resource_id = ? AND cache_key = 'attach-title'`).run(outcome, now, resourceId);
  }

  plotRecords(): PlotRecord[] {
    return this.db.prepare('SELECT * FROM plots ORDER BY project_id, id').all().map(row => ({ id: String(row.id), projectId: String(row.project_id), memberIds: decode<string[]>(row.member_ids),
      active: Boolean(row.active), ...(row.name === null ? {} : { name: String(row.name) }), generated: Boolean(row.generated), hidden: Boolean(row.hidden), changedAt: Number(row.changed_at),
      ...(row.fingerprint === null ? {} : { fingerprint: String(row.fingerprint) }), ...(row.attempted_at === null ? {} : { attemptedAt: Number(row.attempted_at) }),
      ...(row.color === null ? {} : { color: String(row.color) }), ...(row.chosen_color === null ? {} : { chosenColor: String(row.chosen_color) }) }));
  }
  /** Records the current plots; any other plot becomes dormant, kept only for identity. */
  savePlots(plots: readonly { id: string; projectId: string; memberIds: readonly string[] }[], now: number) {
    this.transaction(() => {
      const known = new Map(this.plotRecords().map(record => [record.id, record]));
      const upsert = this.db.prepare(`INSERT INTO plots(id, project_id, member_ids, active, changed_at) VALUES (?, ?, ?, 1, ?)
        ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, member_ids = excluded.member_ids, active = 1, changed_at = excluded.changed_at`);
      for (const plot of plots) {
        const members = JSON.stringify([...plot.memberIds].sort()), record = known.get(plot.id);
        if (record?.active && record.projectId === plot.projectId && JSON.stringify(record.memberIds) === members) continue;
        upsert.run(plot.id, plot.projectId, members, record && JSON.stringify(record.memberIds) === members ? record.changedAt : now);
      }
      this.db.prepare('UPDATE plots SET active = 0 WHERE active = 1 AND id NOT IN (SELECT value FROM json_each(?))').run(JSON.stringify(plots.map(plot => plot.id)));
      this.db.prepare(`DELETE FROM plots WHERE active = 0 AND rowid NOT IN (SELECT rowid FROM (SELECT rowid, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY changed_at DESC, id) AS rank FROM plots WHERE active = 0) WHERE rank <= ?)`).run(DORMANT_PLOTS_PER_PROJECT);
    });
  }
  /** A user name (`generated` false) always applies; a generated one only for the evidence it was asked for and never over a user name. */
  renamePlot(id: string, name: string | undefined, generated: boolean, fingerprint?: string) {
    return this.transaction(() => {
      const record = this.plotRecords().find(record => record.id === id);
      if (!record) return false;
      if (generated && (record.fingerprint !== fingerprint || (record.name !== undefined && !record.generated))) return false;
      if (name === undefined) this.db.prepare('UPDATE plots SET name = NULL, generated = 0, fingerprint = NULL, attempted_at = NULL WHERE id = ?').run(id);
      else this.db.prepare('UPDATE plots SET name = ?, generated = ? WHERE id = ?').run(name, Number(generated), id);
      return true;
    });
  }
  colorPlots(colors: ReadonlyMap<string, string>) {
    if (!colors.size) return;
    this.transaction(() => { const update = this.db.prepare('UPDATE plots SET color = ? WHERE id = ?'); for (const [id, color] of colors) update.run(color, id); });
  }
  /** A person's color for a plot; `undefined` hands it back to the assigned one. */
  choosePlotColor(id: string, color: string | undefined) { this.db.prepare('UPDATE plots SET chosen_color = ? WHERE id = ?').run(color ?? null, id); }
  hidePlot(id: string, hidden: boolean) { this.db.prepare('UPDATE plots SET hidden = ? WHERE id = ?').run(Number(hidden), id); }
  setPlotsShown(projectId: string, shown: boolean) {
    if (shown) this.db.prepare('DELETE FROM plot_projects WHERE project_id = ?').run(projectId);
    else this.db.prepare('INSERT OR IGNORE INTO plot_projects(project_id) VALUES (?)').run(projectId);
  }
  hiddenPlotProjects() { return this.db.prepare('SELECT project_id FROM plot_projects ORDER BY project_id').all().map(row => String(row.project_id)); }
  /** Shares the durable summary allowance. `minIntervalMs` 0 is an explicit request:
   * it skips the per-plot interval and unchanged-evidence checks, not the allowance. */
  reservePlotName(id: string, fingerprint: string, policy: AppSettings['summaries'], now: number, minIntervalMs: number) {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM summary_attempts WHERE started_at <= ?').run(now - 86_400_000);
      const record = this.plotRecords().find(record => record.id === id);
      if (!record?.active) return false;
      if (minIntervalMs && (record.fingerprint === fingerprint || (record.attemptedAt !== undefined && now - record.attemptedAt < minIntervalMs))) return false;
      const usage = this.db.prepare('SELECT COUNT(*) AS day, COALESCE(SUM(started_at > ?), 0) AS hour FROM summary_attempts').get(now - 3_600_000)!;
      if (Number(usage.day) >= policy.requestsPerDay || Number(usage.hour) >= policy.requestsPerHour) return false;
      this.db.prepare('INSERT INTO summary_attempts(started_at) VALUES (?)').run(now);
      this.db.prepare('UPDATE plots SET fingerprint = ?, attempted_at = ? WHERE id = ?').run(fingerprint, now, id);
      return true;
    });
  }

  projectSummaries(): ProjectSummaryRecord[] {
    return this.db.prepare('SELECT * FROM project_summaries ORDER BY project_id').all().map(row => ({ projectId: String(row.project_id), fingerprint: String(row.fingerprint), attemptedAt: Number(row.attempted_at),
      ...(row.text === null ? {} : { text: String(row.text) }), ...(row.model === null ? {} : { model: String(row.model) }) }));
  }
  /** Shares the durable summary allowance and leaves `keep` requests to the other helpers.
   * A project is sent at most once per `minIntervalMs`, and never twice with the same input;
   * its earlier text stays until the new attempt is answered. */
  reserveProjectSummary(projectId: string, fingerprint: string, policy: AppSettings['summaries'], now: number, minIntervalMs: number, keep = 0) {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM summary_attempts WHERE started_at <= ?').run(now - 86_400_000);
      const prior = this.db.prepare('SELECT fingerprint, attempted_at FROM project_summaries WHERE project_id = ?').get(projectId);
      if (prior && (String(prior.fingerprint) === fingerprint || now - Number(prior.attempted_at) < minIntervalMs)) return false;
      const usage = this.db.prepare('SELECT COUNT(*) AS day, COALESCE(SUM(started_at > ?), 0) AS hour FROM summary_attempts').get(now - 3_600_000)!;
      if (Number(usage.day) + keep >= policy.requestsPerDay || Number(usage.hour) + keep >= policy.requestsPerHour) return false;
      this.db.prepare('INSERT INTO summary_attempts(started_at) VALUES (?)').run(now);
      this.db.prepare(`INSERT INTO project_summaries(project_id, fingerprint, attempted_at) VALUES (?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET fingerprint = excluded.fingerprint, attempted_at = excluded.attempted_at`).run(projectId, fingerprint, now);
      return true;
    });
  }
  /** Saves the text only for the input it was asked for. */
  finishProjectSummary(projectId: string, fingerprint: string, text: string, model: string) {
    return this.db.prepare('UPDATE project_summaries SET text = ?, model = ? WHERE project_id = ? AND fingerprint = ?').run(text, model, projectId, fingerprint).changes > 0;
  }
  forgetProjectSummaries(projectIds: readonly string[]) {
    if (projectIds.length) this.db.prepare('DELETE FROM project_summaries WHERE project_id IN (SELECT value FROM json_each(?))').run(JSON.stringify(projectIds));
  }

  /** The ordered reminder list; the first access in a workspace seeds the defaults. */
  reminders(): Reminder[] {
    if (!this.observation(REMINDERS_SEEDED).revision) this.saveReminders(this.reminderSeeds.map(seed => ({ ...seed, id: randomUUID() })));
    return this.db.prepare('SELECT id, label, enabled, rules FROM reminders ORDER BY ordinal').all()
      .map(row => ({ id: String(row.id), label: String(row.label), enabled: Boolean(row.enabled), rules: decode<Reminder['rules']>(row.rules) }));
  }
  saveReminders(list: readonly Reminder[]) {
    this.transaction(() => {
      const created = new Map(this.db.prepare('SELECT id, created_at FROM reminders').all().map(row => [String(row.id), Number(row.created_at)]));
      const ids = JSON.stringify(list.map(reminder => reminder.id)), now = this.now();
      this.db.prepare('DELETE FROM reminder_days WHERE reminder_id NOT IN (SELECT value FROM json_each(?))').run(ids);
      this.db.exec('DELETE FROM reminders');
      const insert = this.db.prepare('INSERT INTO reminders(id, ordinal, label, enabled, rules, created_at) VALUES (?, ?, ?, ?, ?, ?)');
      list.forEach((reminder, ordinal) => insert.run(reminder.id, ordinal, reminder.label, Number(reminder.enabled), JSON.stringify(reminder.rules), created.get(reminder.id) ?? now));
      this.db.prepare('INSERT OR IGNORE INTO provider_observations(scope, revision, body) VALUES (?, 1, ?)').run(REMINDERS_SEEDED, '{}');
    });
  }
  reminderDays(date: string): ReminderDay[] {
    const optional = (key: 'firedAt' | 'doneAt' | 'snoozedUntil', value: unknown) => value === null ? {} : { [key]: Number(value) };
    return this.db.prepare('SELECT * FROM reminder_days WHERE date = ? ORDER BY reminder_id').all(date).map(row => ({ reminderId: String(row.reminder_id), date: String(row.date), dueAt: Number(row.due_at),
      ...optional('firedAt', row.fired_at), ...optional('doneAt', row.done_at), ...optional('snoozedUntil', row.snoozed_until) }));
  }
  writeReminderDay(day: ReminderDay) {
    this.db.prepare(`INSERT INTO reminder_days(reminder_id, date, due_at, fired_at, done_at, snoozed_until) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(reminder_id, date) DO UPDATE SET due_at = excluded.due_at, fired_at = excluded.fired_at, done_at = excluded.done_at, snoozed_until = excluded.snoozed_until`)
      .run(day.reminderId, day.date, day.dueAt, day.firedAt ?? null, day.doneAt ?? null, day.snoozedUntil ?? null);
  }
  deleteReminderDay(reminderId: string, date: string) { this.db.prepare('DELETE FROM reminder_days WHERE reminder_id = ? AND date = ?').run(reminderId, date); }
  /** Removes day rows dated before `date`. */
  pruneReminderDays(date: string) { this.db.prepare('DELETE FROM reminder_days WHERE date < ?').run(date); }

  readSettings(): SettingsSnapshot {
    const row = this.db.prepare('SELECT revision, body FROM app_settings WHERE id = 1').get();
    return row ? { revision: Number(row.revision), value: settingsSchema.parse(decode(row.body)) } : { revision: 0, value: settingsSchema.parse({}) };
  }
  readMapLayout(): MapLayout { const { itemMapSizes, snapToGrid, mapCollisions } = this.readSettings().value; return { sizes: itemMapSizes, ...(snapToGrid ? { snap: SNAP_PITCH } : {}), ...(mapCollisions === 'solid' ? { collisions: mapCollisions } : {}) }; }
  /** Settings are saved whole, so an old default is stored like a choice. Runs once
   * per workspace: a saved former dashboard default takes the current default. */
  migrateSettingsDefaults() {
    const scope = 'settings-defaults:map-dashboards';
    this.transaction(() => {
      if (this.observation(scope).revision) return;
      const row = this.db.prepare('SELECT revision, body FROM app_settings WHERE id = 1').get();
      const body = row ? decode<{ mapDashboards?: { belowZoom?: unknown } }>(row.body) : undefined;
      if (row && body?.mapDashboards?.belowZoom === FORMER_DASHBOARD_ZOOM) {
        const value = settingsSchema.parse({ ...body, mapDashboards: { ...body.mapDashboards, belowZoom: DEFAULT_MAP_DASHBOARDS.belowZoom } });
        this.db.prepare('UPDATE app_settings SET revision = ?, body = ? WHERE id = 1').run(Number(row.revision) + 1, JSON.stringify(value));
      }
      this.db.prepare('INSERT INTO provider_observations(scope, revision, body) VALUES (?, 1, ?)').run(scope, JSON.stringify({ belowZoom: DEFAULT_MAP_DASHBOARDS.belowZoom }));
    });
    const warning = 'settings-defaults:warn-before-closing';
    this.transaction(() => {
      if (this.observation(warning).revision) return;
      const row = this.db.prepare('SELECT revision, body FROM app_settings WHERE id = 1').get();
      const body = row ? decode<{ warnBeforeClosing?: unknown }>(row.body) : undefined;
      if (row && body?.warnBeforeClosing === true) {
        const value = settingsSchema.parse({ ...body, warnBeforeClosing: false });
        this.db.prepare('UPDATE app_settings SET revision = ?, body = ? WHERE id = 1').run(Number(row.revision) + 1, JSON.stringify(value));
      }
      this.db.prepare('INSERT INTO provider_observations(scope, revision, body) VALUES (?, 1, ?)').run(warning, JSON.stringify({ warnBeforeClosing: false }));
    });
    // Show/Ship title tags are opt-in; settings saved before the option existed keep them on.
    this.keepFormerPluginSettings('settings-defaults:show-ship', 'github.pull-request', { showShip: true });
  }
  /** Applies a package's settings preset once per workspace (see `SettingsPreset`): each value goes to a
   * setting that is unset or still at its declared default; changed values stay. `defaults` are the
   * target package's declared defaults; while it is unknown (undefined) nothing is recorded, so a later
   * start applies the preset once the package is there. Returns whether the preset was applied now. */
  applySettingsPreset(preset: { id: string; packageId: string; values: Record<string, unknown> }, defaults: Record<string, unknown> | undefined): boolean {
    if (!defaults) return false;
    const scope = `settings-preset:${preset.id}`;
    return this.transaction(() => {
      // Recorded `{ applied: false }` by the former rule, which skipped workspaces without earlier settings.
      const recorded = this.observation<{ applied?: boolean }>(scope);
      if (recorded.revision && recorded.value?.applied !== false) return false;
      const row = this.db.prepare('SELECT revision, body FROM app_settings WHERE id = 1').get();
      this.mergePluginDefaults(row, preset.packageId, preset.values, defaults);
      this.db.prepare('INSERT INTO provider_observations(scope, revision, body) VALUES (?, ?, ?) ON CONFLICT(scope) DO UPDATE SET revision = excluded.revision, body = excluded.body')
        .run(scope, recorded.revision + 1, JSON.stringify({ applied: true }));
      return true;
    });
  }
  /** Once, give settings saved before package settings existed the values that reproduce their former behaviour. */
  private keepFormerPluginSettings(scope: string, pluginId: string, values: Record<string, unknown>, defaults: Record<string, unknown> = {}) {
    this.transaction(() => {
      if (this.observation(scope).revision) return;
      const row = this.db.prepare('SELECT revision, body FROM app_settings WHERE id = 1').get(), former = Boolean(row) && this.observation(SETTINGS_BEFORE_PLUGINS).revision > 0;
      if (row && former) this.mergePluginDefaults(row, pluginId, values, defaults);
      this.db.prepare('INSERT INTO provider_observations(scope, revision, body) VALUES (?, 1, ?)').run(scope, JSON.stringify({ applied: former }));
    });
  }
  /** Writes `values` into a package's saved settings where a setting is unset or equal to its default. */
  private mergePluginDefaults(row: Record<string, unknown> | undefined, pluginId: string, values: Record<string, unknown>, defaults: Record<string, unknown>) {
    const body = row ? decode<{ plugins?: Record<string, Record<string, unknown>> }>(row.body as string) : settingsSchema.parse({}), plugins = body.plugins ?? {};
    const changed = Object.fromEntries(Object.entries(plugins[pluginId] ?? {}).filter(([key, saved]) => !(key in values) || !(key in defaults) || canonical(saved) !== canonical(defaults[key])));
    const value = settingsSchema.parse({ ...body, plugins: { ...plugins, [pluginId]: { ...values, ...changed } } });
    this.db.prepare('INSERT INTO app_settings(id, revision, body) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, body = excluded.body').run(Number(row?.revision ?? 0) + 1, JSON.stringify(value));
  }
  writeSettings(input: unknown, registry = createResourcePluginRegistry()): SettingsSnapshot {
    const request = settingsWriteSchema.parse(input);
    return this.transaction(() => {
      const current = this.readSettings();
      if (current.revision !== request.expectedRevision) throw Object.assign(new Error('Settings changed elsewhere. Reopen Settings and try again.'), { code: 'REVISION_CONFLICT' });
      validateMapSettings(request.value.itemMapSizes, registry.list());
      registry.validatePluginSettings(request.value.plugins);
      const folder = request.value.defaultWorkingDirectory;
      if (folder && folder !== current.value.defaultWorkingDirectory) {
        let exists = false;
        try { exists = isAbsolute(folder) && statSync(folder).isDirectory(); } catch { /* Reported below. */ }
        if (!exists) throw new Error('The default working directory must be an existing folder.');
      }
      for (const connection of request.value.connections) {
        const previous = current.value.connections.find(saved => saved.id === connection.id);
        if (previous && (previous.providerId !== connection.providerId || previous.account !== connection.account)) throw new Error('Provider account bindings are immutable. Choose a new binding for another account.');
      }
      const next = { revision: current.revision + 1, value: request.value };
      if (canonical(current.value.itemMapSizes) !== canonical(next.value.itemMapSizes)) {
        const state = this.readState();
        const before = new Map(layoutFootprints(state.nodes, state.resources, registry, current.value.itemMapSizes).map(box => [box.id, box]));
        const after = layoutFootprints(state.nodes, state.resources, registry, next.value.itemMapSizes);
        if (after.some(box => box.width > before.get(box.id)!.width || box.height > before.get(box.id)!.height)) {
          state.nodes = repairLayout(state.nodes, state.resources, registry, next.value.itemMapSizes, next.value.snapToGrid ? SNAP_PITCH : undefined);
        }
        state.revision++;
        this.writeState(state);
        this.appendEvent('workspace.changed', state.revision, 'map-size-settings');
      }
      this.db.prepare('INSERT INTO app_settings(id, revision, body) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, body = excluded.body').run(next.revision, JSON.stringify(next.value));
      return next;
    });
  }

  /** Moves a launch directory to the front of the recent list, by real path. */
  recordDirectory(path: string) {
    let real: string;
    try {
      if (!isAbsolute(path) || !statSync(path).isDirectory()) return;
      real = realpathSync(path);
    } catch { return; }
    this.transaction(() => {
      const latest = Number(this.db.prepare('SELECT COALESCE(MAX(used_at), 0) AS latest FROM recent_directories').get()!.latest);
      this.db.prepare('INSERT INTO recent_directories(path, used_at) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET used_at = excluded.used_at').run(real, Math.max(this.now(), latest + 1));
      this.db.prepare('DELETE FROM recent_directories WHERE path NOT IN (SELECT path FROM recent_directories ORDER BY used_at DESC LIMIT ?)').run(MAX_RECENT_DIRECTORIES);
    });
  }
  /** Most recent first; directories that no longer exist are dropped. */
  recentDirectories(): string[] {
    const paths = this.db.prepare('SELECT path FROM recent_directories ORDER BY used_at DESC').all().map(row => String(row.path));
    const missing = paths.filter(path => { try { return !statSync(path).isDirectory(); } catch { return true; } });
    if (missing.length) this.transaction(() => { for (const path of missing) this.db.prepare('DELETE FROM recent_directories WHERE path = ?').run(path); });
    return paths.filter(path => !missing.includes(path));
  }

  readRecovery(): RecoveryState {
    const row = this.db.prepare('SELECT body FROM recovery_checkpoint WHERE id = 1').get();
    return row ? decode<RecoveryState>(row.body) : { phase: 'open', entries: [] };
  }
  writeRecovery(state: RecoveryState) {
    this.db.prepare('INSERT INTO recovery_checkpoint(id, body) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body').run(JSON.stringify(state));
  }

  /** SQLite serializes ownership acquisition, including recovery of a dead process. */
  claimService(instanceId: string, pid = process.pid) {
    this.transaction(() => {
      const previous = this.db.prepare('SELECT instance_id, pid FROM service_owner WHERE id = 1').get();
      if (previous) {
        let alive = true;
        try { process.kill(Number(previous.pid), 0); }
        catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
        if (alive) throw Object.assign(new Error('Workspace service already running'), { code: 'SERVICE_RUNNING' });
      }
      this.db.prepare('INSERT INTO service_owner(id, instance_id, pid) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET instance_id = excluded.instance_id, pid = excluded.pid').run(instanceId, pid);
    });
  }
  releaseService(instanceId: string) { this.db.prepare('DELETE FROM service_owner WHERE instance_id = ?').run(instanceId); }

  agentObservation(sessionId: string): AgentObservation | undefined {
    const row = this.db.prepare('SELECT event, observed_at FROM agent_observations WHERE session_id = ?').get(sessionId);
    return row ? { event: String(row.event), observedAt: Number(row.observed_at) } : undefined;
  }
  /** Hook ordering is durable but does not invalidate the agent's graph revision. */
  observeAgent(sessionId: string, observedAt: number, event: string) {
    return this.db.prepare(`INSERT INTO agent_observations(session_id, observed_at, event) VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET observed_at = excluded.observed_at, event = excluded.event
      WHERE excluded.observed_at >= agent_observations.observed_at`).run(sessionId, observedAt, event).changes > 0;
  }

  agentBackground(sessionId: string): BackgroundState | undefined {
    const row = this.db.prepare('SELECT body FROM agent_background WHERE session_id = ?').get(sessionId);
    return row ? JSON.parse(String(row.body)) as BackgroundState : undefined;
  }
  observeBackground(sessionId: string, change: BackgroundChange) {
    return this.transaction(() => {
      const next = applyBackground(this.agentBackground(sessionId), change);
      this.db.prepare('INSERT INTO agent_background(session_id, body) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET body = excluded.body').run(sessionId, JSON.stringify(next));
      return next;
    });
  }
  clearBackground(sessionId: string) { this.db.prepare('DELETE FROM agent_background WHERE session_id = ?').run(sessionId); }

  /** Rows owned by one package. Calls inside `transaction` must only use this storage. */
  /** Installed plugins and their pinned commits. Kept apart from the settings document so no
   * settings write, including an agent's, can install, update or enable plugin code. */
  pluginLock(): { id: string; body: unknown }[] {
    return this.db.prepare('SELECT id, body FROM plugin_lock ORDER BY id').all().map(row => ({ id: String(row.id), body: decode<unknown>(row.body) }));
  }
  writePluginLock(id: string, value: unknown) {
    this.db.prepare('INSERT INTO plugin_lock(id, body, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at').run(id, JSON.stringify(value), this.now());
  }

  pluginStorage(pluginId: string): PluginStorage {
    if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/.test(pluginId)) throw new Error('Plugin storage needs a package id');
    const name = (value: string) => { if (!/^[a-z][a-z0-9._-]{0,63}$/.test(value)) throw new Error('Use a lowercase collection name of at most 64 characters'); return value; };
    const key = (value: string) => { if (!value || value.length > 512) throw new Error('Record keys are 1 to 512 characters'); return value; };
    const record = (row: Row): PluginRecord => ({ key: String(row.key), value: decode<JsonValue>(row.body), ...(row.ordinal === null ? {} : { ordinal: Number(row.ordinal) }), updatedAt: Number(row.updated_at) });
    let depth = 0;
    const storage: PluginStorage = {
      get: (collection, id) => { const row = this.db.prepare('SELECT key, body, ordinal, updated_at FROM plugin_records WHERE plugin_id = ? AND collection = ? AND key = ?').get(pluginId, name(collection), key(id)); return row ? record(row) : undefined; },
      put: (collection, id, value, options = {}) => {
        const body = JSON.stringify(value), size = Buffer.byteLength(body);
        if (size > PLUGIN_RECORD_BYTES) throw new Error('This plugin record is too large');
        if (options.ordinal !== undefined && !Number.isSafeInteger(options.ordinal)) throw new Error('Record ordinals are integers');
        const used = Number(this.db.prepare('SELECT COALESCE(SUM(length(CAST(body AS BLOB))), 0) AS used FROM plugin_records WHERE plugin_id = ? AND NOT (collection = ? AND key = ?)').get(pluginId, name(collection), key(id))!.used);
        if (used + size > PLUGIN_STORAGE_BYTES) throw new Error(`Plugin ${pluginId} reached its storage limit`);
        const updatedAt = this.now();
        this.db.prepare('INSERT INTO plugin_records(plugin_id, collection, key, body, ordinal, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(plugin_id, collection, key) DO UPDATE SET body = excluded.body, ordinal = excluded.ordinal, updated_at = excluded.updated_at')
          .run(pluginId, collection, id, body, options.ordinal ?? null, updatedAt);
        return { key: id, value: decode<JsonValue>(body), ...(options.ordinal === undefined ? {} : { ordinal: options.ordinal }), updatedAt };
      },
      delete: (collection, id) => Number(this.db.prepare('DELETE FROM plugin_records WHERE plugin_id = ? AND collection = ? AND key = ?').run(pluginId, name(collection), key(id)).changes) > 0,
      list: (collection, options = {}) => {
        const limit = Math.min(Math.max(Math.trunc(options.limit ?? 1000), 1), 1000), after = options.after;
        const rows = after
          ? this.db.prepare(`SELECT key, body, ordinal, updated_at FROM plugin_records WHERE plugin_id = ? AND collection = ? AND (COALESCE(ordinal, ${Number.MAX_SAFE_INTEGER}) > ? OR (COALESCE(ordinal, ${Number.MAX_SAFE_INTEGER}) = ? AND key > ?)) ORDER BY COALESCE(ordinal, ${Number.MAX_SAFE_INTEGER}), key LIMIT ?`)
            .all(pluginId, name(collection), after.ordinal ?? Number.MAX_SAFE_INTEGER, after.ordinal ?? Number.MAX_SAFE_INTEGER, key(after.key), limit)
          : this.db.prepare(`SELECT key, body, ordinal, updated_at FROM plugin_records WHERE plugin_id = ? AND collection = ? ORDER BY COALESCE(ordinal, ${Number.MAX_SAFE_INTEGER}), key LIMIT ?`).all(pluginId, name(collection), limit);
        return rows.map(record);
      },
      transaction: work => {
        if (depth) return work();
        depth++;
        try { return this.transaction(work); } finally { depth--; }
      },
    };
    return storage;
  }

  /** Never await or call external services inside these synchronous transactions. */
  private transaction<T>(change: () => T, readOnly = false): T {
    this.db.exec(readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE');
    let result: T;
    try { result = change(); this.db.exec('COMMIT'); }
    catch (error) { this.changedRollouts.clear(); this.decoded = undefined; this.db.exec('ROLLBACK'); throw error; }
    if (this.changedRollouts.size) {
      const changed = [...this.changedRollouts]; this.changedRollouts.clear();
      for (const id of changed) for (const listener of this.rolloutListeners) try { listener(id); } catch { /* A committed change stands whatever a listener does. */ }
    }
    return result;
  }

  /** The decoded workspace as of a SQLite `data_version`; another connection's commit changes that version,
   * and this connection's writes and rollbacks drop the copy. Readers get their own deep copy. */
  private decoded?: { version: number; state: WorkspaceState };
  private readState(): WorkspaceState {
    const version = Number(this.db.prepare('PRAGMA data_version').get()!.data_version);
    if (this.decoded?.version !== version) this.decoded = { version, state: this.decodeState() };
    return structuredClone(this.decoded.state);
  }
  private decodeState(): WorkspaceState {
    const metadata = this.db.prepare('SELECT revision, view FROM workspace WHERE id = 1').get()!;
    const records = (table: string, order: string) => this.db.prepare(`SELECT body FROM ${table} ORDER BY ${order}`).all().map(row => decode(row.body));
    return stateSchema.parse({ version: 1, revision: metadata.revision, view: decode(metadata.view),
      resources: records('resources', 'rowid'), nodes: records('nodes', 'ordinal'), links: records('links', 'ordinal'), todos: records('todos', 'ordinal') });
  }

  private writeState(input: WorkspaceState): WorkspaceState {
    this.decoded = undefined;
    const state = stateSchema.parse(input);
    const nodeIds = new Set(state.nodes.map(node => node.id));
    for (const node of state.nodes) {
      if (node.projectId) {
        const project = state.nodes.find(candidate => candidate.id === node.projectId);
        if (!node.resourceId || !project || project.resourceId || project.projectId) throw new Error('Invalid project membership in saved state');
      }
    }
    for (const todo of state.todos) if (todo.nodeIds.some(id => !nodeIds.has(id))) throw new Error('To-do references a missing node');
    // Preserve identity bindings for unavailable plugins until their connector returns.
    const previousKeys = new Map(this.db.prepare('SELECT id, provider_key FROM resources').all().map(row => [String(row.id), row.provider_key === null ? null : String(row.provider_key)]));
    this.writeRows('resources', ['plugin_id', 'connection_id', 'provider_key', 'body'], state.resources.map(record => [record.id, record.pluginId, record.connectionId ?? '', this.identity(record) ?? previousKeys.get(record.id) ?? null, JSON.stringify(record)]));
    this.writeRows('nodes', ['resource_id', 'project_id', 'ordinal', 'body'], state.nodes.map((record, i) => [record.id, record.resourceId ?? null, record.projectId ?? null, i, JSON.stringify(record)]));
    this.writeRows('links', ['source_id', 'target_id', 'ordinal', 'body'], state.links.map((record, i) => [record.id, record.sourceId, record.targetId, i, JSON.stringify(record)]));
    this.writeRows('todos', ['ordinal', 'body'], state.todos.map((record, i) => [record.id, i, JSON.stringify(record)]));
    this.db.prepare('UPDATE workspace SET revision = ?, view = ? WHERE id = 1').run(state.revision, JSON.stringify(state.view));
    return state;
  }

  /** Rewrites only the rows whose columns changed, in place so a row keeps its position. Changed rows first give up
   * their unique ordinal or provider identity, so one moving to another row never collides; references are checked
   * at commit. Resources are read back in row order, so a save that reorders them rewrites that table. */
  private writeRows(table: string, columns: readonly string[], rows: readonly (string | number | null)[][]) {
    const saved = new Map(this.db.prepare(`SELECT id, ${columns.join(', ')} FROM ${table} ORDER BY rowid`).all().map(row => [String(row.id), JSON.stringify(columns.map(column => row[column] ?? null))]));
    const wanted = new Set(rows.map(([id]) => String(id))), kept = [...saved.keys()].filter(id => wanted.has(id));
    const reordered = !columns.includes('ordinal') && rows.some(([id], index) => index < kept.length ? String(id) !== kept[index] : saved.has(String(id)));
    if (reordered) { this.db.exec(`DELETE FROM ${table}`); saved.clear(); }
    const remove = this.db.prepare(`DELETE FROM ${table} WHERE id = ?`);
    for (const id of saved.keys()) if (!wanted.has(id)) remove.run(id);
    const changed = rows.filter(([id, ...values]) => saved.has(String(id)) && saved.get(String(id)) !== JSON.stringify(values));
    const release = this.db.prepare(columns.includes('ordinal') ? `UPDATE ${table} SET ordinal = -1 - rowid WHERE id = ?` : `UPDATE ${table} SET provider_key = NULL WHERE id = ?`);
    for (const [id] of changed) release.run(id);
    const update = this.db.prepare(`UPDATE ${table} SET ${columns.map(column => `${column} = ?`).join(', ')} WHERE id = ?`);
    for (const [id, ...values] of changed) update.run(...values, id);
    const insert = this.db.prepare(`INSERT INTO ${table}(id, ${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}, ?)`);
    for (const row of rows) if (!saved.has(String(row[0]))) insert.run(...row);
  }

  backupResources() {
    const path = `${this.file}.backup-resources-${randomUUID()}.sqlite`;
    this.db.prepare('VACUUM INTO ?').run(path); chmodSync(path, 0o600); this.keepOnlyBackup(path); return path;
  }
  /** One backup is enough to step back from the change it precedes. Earlier ones only
   * accumulate, each a full copy of the workspace. Called once the new one is complete. */
  private keepOnlyBackup(kept: string) {
    const directory = dirname(this.file), prefix = `${basename(this.file)}.backup-`;
    for (const name of readdirSync(directory)) {
      if (!name.startsWith(prefix) || !/\.sqlite(-wal|-shm)?$/.test(name) || join(directory, name) === kept) continue;
      try { rmSync(join(directory, name), { force: true }); } catch { /* A leftover backup is harmless. */ }
    }
  }

  private appendEvent(kind: WorkspaceEvent['kind'], revision: number, subjectId: string) {
    this.db.prepare('INSERT INTO events(kind, revision, subject_id, created_at) VALUES (?, ?, ?, ?)').run(kind, revision, subjectId, new Date().toISOString());
  }

  async read() { return this.transaction(() => this.readState(), true); }
  async update(change: (state: WorkspaceState) => WorkspaceState) {
    return this.transaction(() => {
      const before = this.readState(), active = attentionCycles(before);
      const next = this.writeState(change(before));
      this.recordAttention(active, next);
      this.appendEvent('workspace.changed', next.revision, randomUUID());
      return next;
    });
  }
  async commit(envelope: CommandEnvelope, change: (state: WorkspaceState) => WorkspaceState): Promise<CommandResult> {
    try { return this.transaction(() => this.commitDraft(envelope, change)); }
    catch (error) { if (error instanceof RevisionConflict) this.recordConflict(envelope, error.currentRevision); throw error; }
  }
  /** Refused stale commands, newest first, with the commits that landed after the revision each one named. */
  revisionConflicts(limit = 100): RevisionConflictRecord[] {
    return this.db.prepare('SELECT * FROM revision_conflicts ORDER BY id DESC LIMIT ?').all(limit).map(row => ({
      at: String(row.at), actor: String(row.actor), commands: decode(row.commands), expected: Number(row.expected), current: Number(row.current), landed: decode(row.landed),
    }));
  }
  private recordConflict(envelope: CommandEnvelope, current: number) {
    try {
      const landed = this.db.prepare(`SELECT e.revision, r.input FROM events e LEFT JOIN receipts r ON r.command_id = e.subject_id
        WHERE e.kind = 'workspace.changed' AND e.revision > ? AND e.revision <= ? ORDER BY e.revision LIMIT ?`).all(envelope.expectedRevision, current, CONFLICT_LANDED_SHOWN).map(row => {
        const input = row.input === null || row.input === undefined ? undefined : decode<CommandEnvelope>(row.input);
        return { revision: Number(row.revision), actor: input ? `${input.actor.kind}:${input.actor.id}` : 'unrecorded', commands: input ? input.commands.map(commandSubject) : [] };
      });
      this.db.prepare('INSERT INTO revision_conflicts(at, actor, commands, expected, current, landed) VALUES (?, ?, ?, ?, ?, ?)')
        .run(new Date(this.now()).toISOString(), `${envelope.actor.kind}:${envelope.actor.id}`, JSON.stringify(envelope.commands.map(commandSubject)), envelope.expectedRevision, current, JSON.stringify(landed));
      this.db.prepare('DELETE FROM revision_conflicts WHERE id <= (SELECT MAX(id) FROM revision_conflicts) - ?').run(CONFLICTS_KEPT);
    } catch { /* The conflict itself still reaches the caller. */ }
  }
  receiptRevision(commandId: string) {
    return receiptRevision(this.db.prepare('SELECT input FROM receipts WHERE command_id = ?').get(commandId)?.input as string | undefined);
  }
  private commitDraft(envelope: CommandEnvelope, change: (state: WorkspaceState) => WorkspaceState): CommandResult {
      const input = canonical(envelope);
      const receipt = this.db.prepare('SELECT input, result FROM receipts WHERE command_id = ?').get(envelope.commandId);
      if (receipt) {
        if (receipt.input !== input) throw new CommandIdConflict();
        return { state: receipt.result === '' ? this.readState() : stateSchema.parse(decode(receipt.result)), replayed: true };
      }
      const before = this.readState(), active = attentionCycles(before);
      const next = this.writeState(change(before));
      this.recordAttention(active, next);
      this.db.prepare(`INSERT INTO receipts(command_id, input, result) VALUES (?, ?, '')`).run(envelope.commandId, input);
      this.appendEvent('workspace.changed', next.revision, envelope.commandId);
      return { state: next, replayed: false };
  }

  private sequence() { return Number(this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get()?.seq ?? 0); }
  async snapshot() { return this.transaction(() => ({ state: this.readState(), cursor: this.sequence() }), true); }
  async events(after: number, limit = 200) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid event cursor or limit');
    return this.transaction(() => {
      const latest = this.sequence();
      const floor = Number(this.db.prepare('SELECT floor FROM event_meta WHERE id = 1').get()!.floor);
      const resetRequired = after < floor || after > latest;
      const rows = resetRequired ? [] : this.db.prepare('SELECT * FROM events WHERE sequence > ? ORDER BY sequence LIMIT ?').all(after, limit);
      const events: WorkspaceEvent[] = rows.map(row => ({ sequence: Number(row.sequence), kind: row.kind as WorkspaceEvent['kind'], revision: Number(row.revision), subjectId: String(row.subject_id), createdAt: String(row.created_at) }));
      return { events, latest, resetRequired };
    }, true);
  }
  compactEvents(through: number) {
    if (!Number.isSafeInteger(through) || through < 0) throw new Error('Invalid event cursor');
    this.transaction(() => {
      const floor = Math.min(through, this.sequence());
      this.db.prepare('DELETE FROM events WHERE sequence <= ?').run(floor);
      this.db.prepare('UPDATE event_meta SET floor = MAX(floor, ?) WHERE id = 1').run(floor);
    });
  }
  async readView(clientId: string) {
    const row = this.db.prepare('SELECT body FROM views WHERE client_id = ?').get(clientId);
    return row ? viewSchema.parse(decode(row.body)) : (await this.read()).view;
  }
  async writeView(clientId: string, input: unknown) {
    if (!clientId.trim() || clientId.length > 200) throw new Error('Invalid view client ID');
    const view = viewSchema.parse(input);
    this.db.prepare('INSERT INTO views(client_id, body) VALUES (?, ?) ON CONFLICT(client_id) DO UPDATE SET body = excluded.body').run(clientId, JSON.stringify(view));
    return view;
  }

  /** Import is explicit, identity-preserving, repeatable, and never overwrites an occupied workspace. */
  async importJson(file: string) {
    const source = readFileSync(file, 'utf8');
    const state = stateSchema.parse(JSON.parse(source));
    const digest = createHash('sha256').update(canonical(state)).digest('hex');
    return this.transaction(() => {
      if (this.db.prepare('SELECT digest FROM imports WHERE digest = ?').get(digest)) return { imported: false, state: this.readState() };
      const before = this.readState();
      if (before.revision || before.nodes.length || before.resources.length || before.todos.length || before.links.length) throw new Error('Import requires an empty workspace');
      this.writeState(state);
      this.db.prepare('INSERT INTO imports(digest, imported_at) VALUES (?, ?)').run(digest, new Date().toISOString());
      this.appendEvent('workspace.changed', state.revision, `import:${digest}`);
      return { imported: true, state };
    });
  }

  private job(row: Row): JobRecord {
    return { id: String(row.id), requestKey: String(row.request_key), input: decode(row.input), state: row.state as JobState,
      attempts: Number(row.attempts), correlation: decode(row.correlation), result: row.result === null ? undefined : decode(row.result),
      error: row.error === null ? undefined : String(row.error), updatedAt: String(row.updated_at) };
  }
  getJob(id: string): JobRecord | undefined { const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id); return row ? this.job(row) : undefined; }
  jobByRequest(requestKey: string): JobRecord | undefined { const row = this.db.prepare('SELECT * FROM jobs WHERE request_key = ?').get(requestKey); return row ? this.job(row) : undefined; }
  listJobs(): JobRecord[] { return this.db.prepare('SELECT * FROM jobs ORDER BY rowid').all().map(row => this.job(row)); }
  /** Succeeded rollout approvals, picked out in SQL: decoding every job on each rollout pass blocked the service. */
  rolloutApprovalJobs(): JobRecord[] {
    return this.db.prepare(`SELECT * FROM jobs WHERE state = 'succeeded' AND json_extract(input, '$.action') = 'resource.action' AND json_extract(input, '$.arguments.actionId') = 'rollout.approve' ORDER BY rowid`).all().map(row => this.job(row));
  }
  enqueueJob(requestKey: string, input: JobInput): JobRecord {
    if (!requestKey.trim() || requestKey.length > 200 || !input.action.trim() || !input.nodeId.trim()) throw new Error('Invalid job request');
    const encoded = canonical(input);
    return this.transaction(() => {
      const saved = this.db.prepare('SELECT * FROM jobs WHERE request_key = ?').get(requestKey);
      if (saved) { if (saved.input !== encoded) throw new CommandIdConflict(); return this.job(saved); }
      const id = randomUUID();
      this.db.prepare("INSERT INTO jobs(id, request_key, input, state, updated_at) VALUES (?, ?, ?, 'queued', ?)").run(id, requestKey, encoded, new Date().toISOString());
      this.appendEvent('job.changed', this.readState().revision, id);
      return this.getJob(id)!;
    });
  }
  transitionJob(id: string, expected: JobState, next: JobState, patch: { correlation?: Record<string, unknown>; result?: unknown; error?: string } = {}): JobRecord {
    return this.transaction(() => {
      const job = this.getJob(id);
      if (!job) throw new Error('Job not found');
      if (job.state !== expected) throw new Error(`Job state conflict: expected ${expected}, current ${job.state}`);
      if (!transitions[job.state].includes(next)) throw new Error(`Invalid job transition: ${job.state} → ${next}`);
      if (job.state === 'outcome-unknown' && next === 'queued' && patch.correlation?.reconciledAbsent !== true) throw new Error('Reconcile uncertain external outcomes before retrying');
      this.db.prepare('UPDATE jobs SET state = ?, attempts = ?, correlation = ?, result = ?, error = ?, updated_at = ? WHERE id = ?').run(
        next, job.attempts + Number(next === 'running' && expected !== 'running'), canonical({ ...job.correlation, ...patch.correlation }),
        patch.result === undefined ? (job.result === undefined ? null : JSON.stringify(job.result)) : JSON.stringify(patch.result),
        patch.error ?? (['queued', 'running', 'succeeded'].includes(next) ? null : job.error ?? null), new Date().toISOString(), id);
      this.appendEvent('job.changed', this.readState().revision, id);
      return this.getJob(id)!;
    });
  }
  recoverInterruptedJobs(): JobRecord[] {
    // The service invokes this only after acquiring exclusive service ownership.
    return this.transaction(() => {
      const interrupted = this.listJobs().filter(job => job.state === 'running');
      for (const job of interrupted) {
        this.db.prepare("UPDATE jobs SET state = 'outcome-unknown', updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
        this.appendEvent('job.changed', this.readState().revision, job.id);
      }
      return interrupted.map(job => this.getJob(job.id)!);
    });
  }
}
