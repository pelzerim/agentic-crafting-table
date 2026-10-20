import { useCallback, useEffect, useRef, useState } from 'react';
import { attentionReceipt } from '../../../src/graph/attention.ts';
import { isOffMap } from '../../../src/graph/archive.ts';
import { isMuted, mutedProjectIds } from '../../../src/graph/mute.ts';
import { blockingState, unblockedSince } from '../../../src/graph/blocking.ts';
import type { WorkspaceSnapshot } from '../../../packages/workspace-service/protocol.ts';
import type { OpenContext } from '../../../packages/core/settings.ts';

/** A finished item, or one whose blockers all resolved: a quiet notice, never Needs me.
 * `failed` is a provider change the person made that did not go through; it stays until dismissed. */
export interface CompletionNotice { key: string; nodeId: string; title: string; note?: string; unblocked?: boolean; failed?: boolean }
type NoticeState = WorkspaceSnapshot['state'];
/** Needs me sources of a person's provider change that was taken back (`action:<item type>`). */
const ACTION_SOURCE = 'action:';
/** What became finished or unblocked between two states, and changes that did not go through.
 * Items off the map or in a muted project (MAP-25) announce nothing, then or later. */
export function completionNotices(before: NoticeState, after: NoticeState): CompletionNotice[] {
  const seen = new Set(before.nodes.flatMap(node => Object.entries(node.attentionEvents ?? {}).map(([source, event]) => `${node.resourceId ?? node.id}:${source}:${event}`)));
  const fresh = new Map<string, CompletionNotice>(), quiet = mutedProjectIds(after.nodes);
  const silent = (node: NoticeState['nodes'][number]) => isOffMap(node, after.nodes) || Boolean(node.hiddenAt) || isMuted(node, after.nodes, quiet);
  for (const node of after.nodes) {
    for (const [source, event] of Object.entries(node.attentionEvents ?? {})) {
      const key = `${node.resourceId ?? node.id}:${source}:${event}`;
      const failed = source.startsWith(ACTION_SOURCE) && node.attentionSources?.[source] === 'error';
      if (!seen.has(key) && (failed || node.attentionSources?.[source] === 'finished') && !silent(node))
        fresh.set(key, { key, nodeId: node.id, title: node.title, ...(node.attentionNotes?.[source] ? { note: node.attentionNotes[source] } : {}), ...(failed ? { failed } : {}) });
    }
  }
  for (const node of unblockedSince(blockingState(before.nodes, before.links), after.nodes, after.links)) {
    const key = `unblocked:${node.resourceId ?? node.id}:${after.revision}`;
    if (!silent(node)) fresh.set(key, { key, nodeId: node.id, title: node.title, unblocked: true });
  }
  return [...fresh.values()];
}
/** Needs me clears through an explicit acknowledgement (the panel's Seen or the item
 * frame's Mark seen). A person opening an item acknowledges it only where `seenOnOpen`
 * allows: the attention shown at that moment. An open made while the window is in the
 * background (a notification click) waits for the window to gain focus with that item
 * still open. Attention that arrives for the item open in the front window is seen as it
 * arrives, since the person is looking at it; an item that was already waiting is left alone. */
export function useAttention(snapshot: WorkspaceSnapshot | undefined,
  accept: (snapshot: WorkspaceSnapshot) => void, error: (message: string) => void,
  seenOnOpen: (nodeId: string, context: OpenContext) => boolean = () => false) {
  const latest = useRef({ snapshot, accept, error, seenOnOpen }); latest.current = { snapshot, accept, error, seenOnOpen };
  const previous = useRef<WorkspaceSnapshot>(undefined), pending = useRef(new Set<string>());
  const focused = useRef(false), viewing = useRef<string>(undefined);
  const sendRef = useRef<(id: string, presented?: ReturnType<typeof attentionReceipt>) => Promise<void>>(async () => {});
  const [notices, setNotices] = useState<CompletionNotice[]>([]);
  useEffect(() => {
    const before = previous.current; previous.current = snapshot;
    if (!snapshot || !before) return; // Saved completions stay unread, without replaying old toasts on launch.
    const fresh = completionNotices(before.state, snapshot.state);
    if (fresh.length) setNotices(old => [...old, ...fresh].slice(-4));
    const open = viewing.current;
    if (!open || !focused.current || document.visibilityState !== 'visible') return;
    const arrived = attentionReceipt(snapshot.state.nodes, open);
    if (Object.keys(arrived.versions).length && !Object.keys(attentionReceipt(before.state.nodes, open).versions).length) void sendRef.current(open, arrived);
  }, [snapshot]);
  const send = useCallback(async (id: string, presented?: ReturnType<typeof attentionReceipt>) => {
    const current = latest.current.snapshot;
    if (!current) return;
    const receipt = presented ?? attentionReceipt(current.state.nodes, id);
    if (!Object.keys(receipt.versions).length) return;
    const key = JSON.stringify(receipt);
    if (pending.current.has(key)) return;
    pending.current.add(key);
    try {
      let next = current;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!next.state.nodes.some(node => node.id === id)) return;
        try {
          await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: next.state.revision,
            actor: { kind: 'user', id: 'desktop' }, commands: [{ type: 'attention.acknowledge', ...receipt }] });
          latest.current.accept(await window.craftingTable.workspaceRead()); return;
        } catch (failure) {
          if (!(failure as Error).message.includes('Revision conflict') || attempt === 2) throw failure;
          next = await window.craftingTable.workspaceRead();
        }
      }
    } catch (failure) { latest.current.error((failure as Error).message); }
    finally { pending.current.delete(key); }
  }, []);
  sendRef.current = send;
  const acknowledge = useCallback((id: string) => send(id), [send]);
  const awaitingFocus = useRef<ReturnType<typeof attentionReceipt>>(undefined);
  useEffect(() => {
    let changed = false, disposed = false;
    const focus = (value: boolean) => {
      focused.current = value;
      const waiting = awaitingFocus.current;
      if (!value || !waiting) return;
      awaitingFocus.current = undefined;
      if (viewing.current === waiting.id && document.visibilityState === 'visible') void send(waiting.id, waiting);
    };
    const off = window.craftingTable.onWindowFocus(value => { changed = true; focus(value); });
    void window.craftingTable.windowFocused().then(value => { if (!changed && !disposed) focus(value); }).catch(() => {});
    return () => { disposed = true; off(); };
  }, [send]);
  const opened = useCallback((id: string, origin: OpenContext['origin'] = 'user') => {
    awaitingFocus.current = undefined;
    const context = { origin, windowFocused: focused.current, documentVisible: document.visibilityState === 'visible' };
    if (latest.current.seenOnOpen(id, context)) { void send(id); return; }
    const nodes = latest.current.snapshot?.state.nodes;
    if (nodes && latest.current.seenOnOpen(id, { origin, windowFocused: true, documentVisible: true })) awaitingFocus.current = attentionReceipt(nodes, id);
  }, [send]);
  const view = useCallback((id: string | undefined) => {
    viewing.current = id;
    if (awaitingFocus.current && awaitingFocus.current.id !== id) awaitingFocus.current = undefined;
  }, []);
  return { acknowledge, notices, opened, view };
}
