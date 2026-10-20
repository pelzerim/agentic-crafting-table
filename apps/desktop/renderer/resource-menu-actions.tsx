import { useEffect, useMemo, useRef, useState } from 'react';
import { createResourceViews } from '../../../src/resource-plugins/catalog.client.ts';
import type { ResourcePluginRegistry } from '../../../src/resource-plugins/registry.ts';
import type { JsonObject, ResourceRecord, ResourceViewServices } from '../../../src/resource-plugins/types.ts';
import { useNativeAnnouncement } from './use-native-announcement.ts';
import { useNotice } from './use-notice.ts';
import { Toast } from './ui/notice.tsx';

/** `confirming` is the expected state a change shows until the provider confirms it ("Merged · confirming"). */
interface ActionNotice { originNodeId: string; key: string; title: string; pending: boolean; nodeId?: string; mutation?: boolean; confirming?: string }
export function useResourceMenuActions(registry: ResourcePluginRegistry, onError: (message: string) => void) {
  const views = useMemo(() => createResourceViews(registry), [registry]);
  const pending = useRef(new Map<string, AbortController>());
  const [notices, setNotices] = useState<ActionNotice[]>([]);
  useEffect(() => () => { for (const controller of pending.current.values()) controller.abort(); pending.current.clear(); }, []);
  const dismiss = (key: string) => setNotices(old => old.filter(notice => notice.key !== key));
  const start = (nodeId: string, resource: ResourceRecord, actionId: string, label: string) => {
    const key = `${resource.id}:${actionId}`;
    if (pending.current.has(key)) return;
    const controller = new AbortController(); pending.current.set(key, controller);
    const title = `${label} · ${resource.title}`;
    setNotices(old => [...old.filter(notice => notice.key !== key), { originNodeId: nodeId, key, title, pending: true }]);
    void views.runContextAction(structuredClone(resource), actionId, {
      runAction: (action, input) => window.craftingTable.runtimeRun({ action: action as 'agent.resume', nodeId, arguments: input ?? {} }) as ReturnType<ResourceViewServices['runAction']>,
    }, controller.signal).then(result => {
      if (!controller.signal.aborted) setNotices(old => old.map(notice => notice.key === key ? { ...notice, pending: false, nodeId: result.nodeId } : notice));
    }).catch(error => {
      if (!controller.signal.aborted) { dismiss(key); onError(`${title}: ${error.message ?? String(error)}`); }
    }).finally(() => { pending.current.delete(key); });
  };
  const mutate = (nodeId: string, resource: ResourceRecord, actionId: string, input: JsonObject, label: string, runtime?: string) => {
    const key = `mutation:${resource.id}`; if (pending.current.has(key)) return;
    const controller = new AbortController(); pending.current.set(key, controller);
    const title = `${label} · ${resource.title}`;
    setNotices(old => [...old.filter(notice => notice.key !== key), { originNodeId: nodeId, key, title, pending: true, mutation: true }]);
    void (runtime ? window.craftingTable.runtimeRun({ nodeId, action: runtime as 'resource.action', arguments: { operation: actionId, ...input } }) : window.craftingTable.runtimeRun({ nodeId, action: 'resource.action', arguments: { actionId, input } })).then(result => {
      const confirming = (result as { pending?: unknown } | null)?.pending;
      if (!controller.signal.aborted) setNotices(old => old.map(notice => notice.key === key ? { ...notice, pending: false, ...(typeof confirming === 'string' ? { confirming } : {}) } : notice));
    }).catch(error => { if (!controller.signal.aborted) { dismiss(key); onError(`${title}: ${error.message ?? String(error)}`); } }).finally(() => pending.current.delete(key));
  };
  return { start, mutate, notices, dismiss };
}

export function ResourceActionNotice({ notice, open, dismiss }: { notice: ActionNotice; open(id: string): void; dismiss(): void }) {
  const detail = notice.mutation ? notice.pending ? 'Updating…' : notice.confirming ?? 'Status updated' : notice.pending ? 'Starting…' : 'Added to the map';
  useNativeAnnouncement(notice, { title: notice.title, body: detail, nodeId: notice.nodeId ?? notice.originNodeId });
  const visibility = useNotice(notice, !notice.pending);
  useEffect(() => { if (!visibility.visible) dismiss(); }, [visibility.visible, dismiss]);
  if (!visibility.visible) return null;
  return <Toast tone={notice.pending || notice.confirming ? 'info' : 'done'} label={notice.title} title={notice.title} detail={detail}
    {...(notice.nodeId ? { action: { label: 'Open', run: () => { open(notice.nodeId!); dismiss(); } } } : {})} dismiss={dismiss} dismissLabel={`Dismiss notification: ${notice.title}`} />;
}
