/** Service-only: turns a saved link plus its plugin_records row into a snapshot for the map and view. */
import type { JsonObject, PluginStorage, ResourcePluginConnector, ResourceRecord, ResourceSnapshot } from '@agent-crafting-table/plugin-sdk/index.ts';
import { parseTags } from './definition.ts';
import type { CheckResult, PageCheck } from './check.ts';

/** One plugin_records row per item, keyed by resource id, in this collection. */
export const LINKS = 'links';
export interface LinkRecord { readAt?: string; lastCheck?: CheckResult }

export function linkRecord(storage: PluginStorage | undefined, resourceId: string): LinkRecord {
  return (storage?.get(LINKS, resourceId)?.value ?? {}) as LinkRecord;
}
export function saveLinkRecord(storage: PluginStorage, resourceId: string, change: LinkRecord) {
  return storage.put(LINKS, resourceId, { ...linkRecord(storage, resourceId), ...change } as JsonObject);
}

/** A check younger than this is reused, so opening, refreshing and marking read cost one request. */
export const CHECK_REUSE_MS = 60_000;
export const POLL_MS = 6 * 60 * 60_000;

export interface ConnectorOptions {
  check: PageCheck;
  /** Undefined until the workspace has started; reads then work without saved state. */
  storage(): PluginStorage | undefined;
  settings(): JsonObject;
  now?(): number;
}

export function readingLinkConnector(options: ConnectorOptions): ResourcePluginConnector {
  const now = options.now ?? Date.now;
  async function current(resource: ResourceRecord, signal: AbortSignal, background: boolean): Promise<{ record: LinkRecord; check?: CheckResult }> {
    const storage = options.storage(), record = linkRecord(storage, resource.id), last = record.lastCheck;
    if (options.settings().checkLinks === false) return { record };
    const recent = last && now() - Date.parse(last.checkedAt) < CHECK_REUSE_MS;
    // Background polls skip links already read: nobody is waiting on them.
    if (recent || (background && record.readAt && last)) return { record, check: last };
    const check = await options.check(String(resource.data.url), signal);
    signal.throwIfAborted();
    return { record: storage ? saveLinkRecord(storage, resource.id, { lastCheck: check }).value as LinkRecord : record, check };
  }
  return {
    pollIntervalMs: POLL_MS,
    async load(resource, signal, { background = false } = {}): Promise<ResourceSnapshot> {
      const url = String(resource.data.url), site = new URL(url).hostname, { record, check } = await current(resource, signal, background);
      const broken = check?.state === 'broken', read = Boolean(record.readAt);
      return {
        activity: 'idle', attention: 'none', connection: 'connected', observedAt: new Date(now()).toISOString(),
        label: broken ? 'Link is broken' : `${read ? 'Read' : 'Unread'} · ${site}`,
        // null clears Needs me when the link works again; the note is the short reason people see.
        attentionReason: broken ? 'error' : null, ...(broken ? { attentionNote: 'Link is broken' } : {}),
        detail: { url, site, note: String(resource.data.note ?? ''), tags: parseTags(resource.data.tags), readAt: record.readAt ?? null,
          checks: options.settings().checkLinks === false ? 'off' : 'on', check: check ? { ...check } as JsonObject : null },
      };
    },
    async getContext(resource) {
      const check = linkRecord(options.storage(), resource.id).lastCheck;
      return { resourceId: resource.id, title: resource.title, sourceUrl: String(resource.data.url),
        content: [check?.pageTitle && `Page title: ${check.pageTitle}`, resource.data.note && `Note: ${resource.data.note}`].filter(Boolean).join('\n') };
    },
  };
}
