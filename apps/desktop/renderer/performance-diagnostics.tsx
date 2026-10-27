import { useEffect, useState } from 'react';
import { performanceMetrics, performanceReport } from './performance.ts';
import { SettingRow } from './settings-ui.tsx';

/** Saves `value` as a JSON file through the browser download. */
export function downloadJson(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function PerformanceDiagnostics() {
  const [open, setOpen] = useState(false), [report, setReport] = useState(performanceReport);
  useEffect(() => {
    if (!open) return;
    setReport(performanceReport());
    const timer = setInterval(() => setReport(performanceReport()), 1000);
    return () => clearInterval(timer);
  }, [open]);
  const download = () => downloadJson(performanceReport(), 'agentic-performance.json');
  return <>
    <SettingRow label="Performance measurements" description={`Timings and counts for this window; no terminal text, prompts, paths or session IDs. p95 over the latest ${report.sampleLimit} samples.`}
      meta={<button type="button" className="settings-quiet" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'Hide measurements' : 'Show measurements'}</button>}>
      <button type="button" aria-label="Reset measurements" onClick={() => { performanceMetrics.reset(); setReport(performanceReport()); }}>Reset</button>
      <button type="button" aria-label="Download performance report" onClick={download}>Download</button>
    </SettingRow>
    {open && <div className="performance-diagnostics">
      {!report.longTasksSupported && <p className="setting-row-meta">Long-task measurements are unavailable in this browser.</p>}
      <table><thead><tr><th>Measurement</th><th>p95</th><th>Peak</th><th>Samples</th></tr></thead><tbody>
        {Object.entries(report.metrics).map(([name, value]) => <tr key={name} data-over-budget={value.overBudget}>
          <td>{name}{value.overBudget ? ' · slow' : ''}</td><td>{value.p95.toFixed(1)} {value.unit}</td><td>{value.max.toFixed(1)}</td><td>{value.count}</td>
        </tr>)}
      </tbody></table>
    </div>}
  </>;
}
