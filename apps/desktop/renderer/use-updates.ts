import { useCallback, useEffect, useState } from 'react';
import type { UpdateStatus } from '../../../packages/core/updates.ts';

const POLL_MS = 10 * 60 * 1000;
/** What the window knows about newer releases (UPDATE-01): read on open and every ten minutes, or at once after Check now. */
export function useUpdates(enabled = true) {
  const [status, setStatus] = useState<UpdateStatus>();
  const refresh = useCallback(() => window.craftingTable.updatesStatus().then(setStatus).catch(() => {}), []);
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, refresh]);
  const check = useCallback(() => window.craftingTable.updatesCheck().then(setStatus), []);
  return { status, refresh, check };
}
/** The offers still worth showing: newer than what runs and not the version the person dismissed. */
export function pendingOffers(status: UpdateStatus | undefined, dismissed: Record<string, string> = {}) {
  if (!status) return [];
  const offers: { key: string; title: string; latest: string; plugin?: { id: string; source: string } }[] = [];
  if (status.app.available && status.app.latest && dismissed.app !== status.app.latest) offers.push({ key: 'app', title: 'Agentic Crafting Table', latest: status.app.latest });
  for (const plugin of status.plugins) {
    if (plugin.available && plugin.latest && dismissed[`plugin:${plugin.id}`] !== plugin.latest) offers.push({ key: `plugin:${plugin.id}`, title: plugin.name, latest: plugin.latest, plugin: { id: plugin.id, source: plugin.source } });
  }
  return offers;
}
