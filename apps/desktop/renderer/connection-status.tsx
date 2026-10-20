import { useEffect, useRef, useState } from 'react';
import { Chip } from './ui/chip.tsx';

const LABELS = { connected: 'Desktop connected', connecting: 'Connecting…', reconnecting: 'Reconnecting…', reconnected: 'Reconnected' } as const;
const RECONNECTED_MS = 2000;

/** Silent while connected. Losing the desktop service shows an amber chip until
 * it returns, then "Reconnected" for two seconds. */
export function ConnectionStatus({ connection }: { connection: string }) {
  const connected = connection === 'connected', [flash, setFlash] = useState(false), down = useRef(false), ever = useRef(false);
  useEffect(() => {
    if (!connected) { down.current = ever.current; return; }
    ever.current = true;
    if (!down.current) return;
    down.current = false; setFlash(true);
    const timer = setTimeout(() => setFlash(false), RECONNECTED_MS);
    return () => clearTimeout(timer);
  }, [connected]);
  const state = connected ? flash ? 'reconnected' : 'connected' : ever.current ? 'reconnecting' : 'connecting';
  return <span className="connection-status" role="status" aria-label={LABELS[state]} data-state={state} data-connected={connected}>
    {state === 'connected' ? <span className="connection-label">{LABELS.connected}</span>
      : <Chip tone={state === 'reconnected' ? 'ok' : 'pending'} className="connection-chip"><i aria-hidden="true" />{LABELS[state]}</Chip>}
  </span>;
}
