import { useState } from 'react';
import type { LogPolicy } from '../../../packages/core/log-policy.ts';
import { performanceReport } from './performance.ts';
import { NumberField, SettingRow, SettingsSection } from './settings-ui.tsx';
import type { RowStatus } from './settings-ui.tsx';

export function LocalDiagnostics({ policy, change }: { policy: LogPolicy; change(value: LogPolicy): void }) {
  return <SettingsSection label="Diagnostic logs" className="settings-section local-diagnostics" description="Terminal recordings are preserved; log limits never erase session history or native conversations.">
    <SettingRow label="Diagnostic log size" meta="Per file · default 1 MiB"><NumberField unit="MiB" min="1" max="16" step="1" required value={policy.fileMiB} onChange={event => change({ ...policy, fileMiB: Number(event.target.value) })} /></SettingRow>
    <SettingRow label="Diagnostic log backups" meta={`Up to ${policy.fileMiB * (policy.backups + 1)} MiB per service · saving a lower limit trims older output`}><NumberField unit="files" min="0" max="5" step="1" required value={policy.backups} onChange={event => change({ ...policy, backups: Number(event.target.value) })} /></SettingRow>
  </SettingsSection>;
}

/** Versions, aggregate counts and performance only; saved locally, never uploaded. */
export async function downloadSupportReport() {
  const [service, app] = await Promise.all([window.craftingTable.diagnosticsReport(), window.craftingTable.appInfo()]);
  const report = { ...service, app: { version: app.version, packaged: app.packaged }, performance: performanceReport() };
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'agentic-support.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SupportReport() {
  const [status, setStatus] = useState<RowStatus>(), busy = status?.tone === 'pending';
  return <SettingRow label="Support report" immediate description="Versions, aggregate counts and performance only. No account details, titles, IDs, paths, URLs, prompts, output or log text." status={status}>
    <button type="button" aria-label="Download support report" disabled={busy} onClick={async () => {
      setStatus({ tone: 'pending', text: 'Preparing report…' });
      try {
        await downloadSupportReport();
        setStatus({ tone: 'ok', text: 'Downloaded' });
      } catch (error) { setStatus({ tone: 'error', text: (error as Error).message }); }
    }}>Download</button>
  </SettingRow>;
}
