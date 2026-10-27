import { useCallback, useEffect, useId, useState } from 'react';
import type { ServiceHealthReport } from '../../../packages/workspace-service/service-health.ts';
import type { DesktopBridge } from '../bridge.ts';
import { downloadJson } from './performance-diagnostics.tsx';
import { SettingRow } from './settings-ui.tsx';
import type { RowStatus } from './settings-ui.tsx';

interface Health { service: ServiceHealthReport; connection: Awaited<ReturnType<DesktopBridge['connectionEvents']>> }

const bytes = (value: number) => value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${value} B`;
const time = (iso: string) => new Date(iso).toLocaleTimeString();

/** The local service's lag, snapshot traffic and dropped clients, and this app's disconnects with their reasons. */
export function ServiceHealthDiagnostics() {
  const [open, setOpen] = useState(false), [health, setHealth] = useState<Health>(), [status, setStatus] = useState<RowStatus>(), heading = useId();
  const refresh = useCallback(async () => {
    try {
      const [service, connection] = await Promise.all([window.craftingTable.serviceHealth(), window.craftingTable.connectionEvents()]);
      setHealth({ service, connection }); setStatus(undefined);
      return { service, connection };
    } catch (error) { setStatus({ tone: 'error', text: (error as Error).message }); }
  }, []);
  useEffect(() => { if (open) void refresh(); }, [open, refresh]);
  const download = async () => { const current = await refresh(); if (current) downloadJson(current, 'agentic-service-health.json'); };
  const recent = health?.service.lastTenMinutes, disconnects = health?.connection.events.filter(event => event.status === 'disconnected').slice(-5).reverse() ?? [];
  return <section aria-labelledby={heading}>
    <SettingRow label={<span id={heading}>Service health</span>} status={status}
      description="Lag, snapshot traffic and disconnects of the local workspace service over the last 10 minutes. Operation names and counts only; no titles, paths or content."
      meta={<button type="button" className="settings-quiet" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'Hide service health' : 'Show service health'}</button>}>
      <button type="button" aria-label="Refresh service health" onClick={() => void refresh()}>Refresh</button>
      <button type="button" aria-label="Download service health" onClick={() => void download()}>Download</button>
    </SettingRow>
    {open && health && recent && <div className="performance-diagnostics">
      <p>Event-loop lag: max {recent.lagMaxMs} ms · p95 {recent.lagP95Ms} ms</p>
      <p>Snapshots: {recent.snapshotsPerMinute} per minute · {bytes(recent.snapshotBytesPerMinute)} per minute</p>
      <p>Coalesced snapshots: {recent.coalesced} · Dropped clients: {recent.drops}</p>
      {disconnects.length ? <table aria-label="Last disconnects"><thead><tr><th>Disconnect</th><th>Time</th></tr></thead><tbody>
        {disconnects.map(event => <tr key={`${event.at}-${event.reason}`}><td>{event.reason ?? 'closed'}</td><td>{time(event.at)}</td></tr>)}
      </tbody></table> : <p>No disconnects since the app started.</p>}
      <table aria-label="Slowest operations"><thead><tr><th>Operation</th><th>Duration</th><th>Time</th></tr></thead><tbody>
        {health.service.slowestOperations.slice(0, 10).map((operation, index) => <tr key={index}><td>{operation.name}</td><td>{operation.ms} ms</td><td>{time(operation.at)}</td></tr>)}
      </tbody></table>
    </div>}
  </section>;
}
