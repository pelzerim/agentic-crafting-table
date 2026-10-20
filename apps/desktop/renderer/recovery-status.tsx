import { useEffect, useState } from 'react';
import type { RecoveryState } from '../../../packages/workspace-service/lifecycle.ts';
import { useNativeAnnouncement } from './use-native-announcement.ts';
import { useNotice } from './use-notice.ts';
import { recoveryNotice } from './recovery-notice.ts';
import { PixelGlyph } from './ui/pixel-glyph.tsx';

export function RecoveryStatus() {
  const [state, setState] = useState<RecoveryState>(), [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    const read = () => { void window.craftingTable.recoveryStatus().then(next => { if (!cancelled) { setState(next); setError(''); } }).catch(error => { if (!cancelled) setError(error.message); }); };
    read(); const timer = setInterval(read, 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);
  const { failed, identity, title } = recoveryNotice(state, error);
  useNativeAnnouncement(identity, { title, body: failed.length ? 'Open ACT to review recovery details.' : '' }, true);
  const notice = useNotice(identity, !error && !state?.error && !failed.length && state?.phase === 'open');
  if (!notice.visible) return null;
  return <aside className="recovery-status" aria-label="Workspace recovery" role="status">
    <div><strong>{title}</strong>
      <button aria-label="Dismiss recovery status" onClick={notice.dismiss}><PixelGlyph name="close" /></button></div>
    {(error || state?.error) && <p>{error || state?.error}</p>}
    {failed.map(entry => <p key={entry.sessionId}><strong>{entry.title}</strong> — {entry.error}</p>)}
    {(failed.length > 0 || state?.error) && <button disabled={state?.phase === 'recovering'} onClick={() => { void window.craftingTable.retryRecovery().then(setState).catch(error => setError(error.message)); }}>Retry recovery</button>}
  </aside>;
}
