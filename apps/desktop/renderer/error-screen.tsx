import { Component, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import type { RootOptions } from 'react-dom/client';
import { errorCause } from './error-cause.ts';
import { downloadSupportReport } from './local-diagnostics.tsx';

const describe = (error: unknown) => error instanceof Error ? error : new Error(String(error));
const report = (kind: 'uncaught' | 'caught' | 'recoverable') => (error: unknown, info: Partial<ErrorInfo>) => {
  const failure = describe(error);
  try { window.craftingTable.reportError({ kind, message: failure.message.slice(0, 2000), stack: `${failure.stack ?? ''}${info.componentStack ?? ''}`.slice(0, 8000) }); }
  catch { /* Diagnostics must never turn a recoverable failure into a crash. */ }
};
export const rootErrorOptions: RootOptions = { onUncaughtError: report('uncaught'), onCaughtError: report('caught'), onRecoverableError: report('recoverable') };

export class ErrorBoundary extends Component<{ children: ReactNode; fallback(error: Error, reset: () => void): ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: unknown) { return { error: describe(error) }; }
  reset = () => this.setState({ error: undefined });
  render() { return this.state.error ? this.props.fallback(this.state.error, this.reset) : this.props.children; }
}

function Actions({ retry }: { retry(): void }) {
  const [status, setStatus] = useState('');
  const run = (label: string, action: () => Promise<void>) => { setStatus(''); void action().then(() => setStatus(label), error => setStatus((error as Error).message)); };
  return <>
    <div className="error-screen-actions">
      <button type="button" className="error-screen-retry" onClick={retry}>Try again</button>
      <button type="button" onClick={() => run('', () => window.craftingTable.openLogs())}>Open logs folder</button>
      <button type="button" className="error-screen-quiet" aria-label="Download support report" onClick={() => run('Support report downloaded', downloadSupportReport)}>Support report</button>
    </div>
    {status && <p className="error-screen-status" role="status">{status}</p>}
  </>;
}

/** Shown for a failed initial load or a crashed window: what failed, that data is safe, and ways out. */
export function ErrorScreen({ error, kind, retry }: { error: Error | string; kind: 'load' | 'render'; retry(): void }) {
  const message = typeof error === 'string' ? error : error.message;
  return <div className="error-screen" role="alert" aria-labelledby="error-screen-title">
    <span className="error-screen-icon" aria-hidden="true">!</span>
    <h1 id="error-screen-title">Couldn’t open your table</h1>
    <p>{errorCause(message, kind)} <b>Your workspace data is untouched</b> — nothing was reset or overwritten.</p>
    <Actions retry={retry} />
    <details className="error-screen-details"><summary>Error details</summary><pre>{message}</pre></details>
  </div>;
}

/** A crashed view keeps the rest of the window usable. */
export function PanelError({ error, retry }: { error: Error; retry(): void }) {
  return <div className="panel-error" role="alert">
    <p><b>This view stopped working.</b> Your workspace data is untouched.</p>
    <button type="button" onClick={retry}>Reload view</button>
    <details><summary>Error details</summary><pre>{error.message}</pre></details>
  </div>;
}
