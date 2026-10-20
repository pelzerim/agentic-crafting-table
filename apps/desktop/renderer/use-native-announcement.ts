import { useEffect, useRef } from 'react';
import type { DesktopAnnouncement } from '../notifications.ts';

/** A new message is one event, even if its component renders repeatedly. */
export function useNativeAnnouncement(identity: unknown, notice: Omit<DesktopAnnouncement, 'key'>, stable = false) {
  const last = useRef<unknown>(undefined);
  useEffect(() => {
    if (!identity) { last.current = undefined; return; }
    if (last.current === identity) return;
    last.current = identity;
    void (async () => {
      const event = stable ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(identity))))).map(byte => byte.toString(16).padStart(2, '0')).join('') : crypto.randomUUID();
      await window.craftingTable.notifyAnnouncement({ ...notice, title: notice.title.slice(0, 250), body: notice.body.slice(0, 1000), key: `announcement:${event}` });
    })().catch(() => {});
  }, [identity, notice.title, notice.body, notice.nodeId, stable]);
}
