import { useEffect, useRef, useState } from 'react';

/** Expiry/dismissal belongs to a specific message, never the next notification. */
export function useNotice(identity: string | object | undefined, transient: boolean) {
  const current = useRef(identity); current.current = identity;
  const [dismissed, setDismissed] = useState<string | object>();
  useEffect(() => {
    if (!identity) { setDismissed(undefined); return; }
    if (!transient) return;
    const timer = setTimeout(() => { if (current.current === identity) setDismissed(identity); }, 5000);
    return () => clearTimeout(timer);
  }, [identity, transient]);
  return { visible: Boolean(identity && identity !== dismissed), dismiss: () => setDismissed(identity) };
}
