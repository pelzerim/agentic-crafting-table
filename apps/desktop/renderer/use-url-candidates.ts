import { useEffect, useState } from 'react';
import type { AttachmentCandidate } from '../../../src/resource-plugins/registry.ts';
import { isResourceUrl } from '../../../src/resource-plugins/url-input.ts';

export function useUrlCandidates(input: string, enabled: boolean) {
  const url = input.trim();
  const [result, setResult] = useState<{ url: string; candidates: AttachmentCandidate[]; error?: string }>();
  useEffect(() => {
    if (!enabled || !isResourceUrl(url)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void window.craftingTable.resourceMatchUrl(url).then(candidates => {
        if (!cancelled) setResult({ url, candidates });
      }).catch(error => { if (!cancelled) setResult({ url, candidates: [], error: error.message }); });
    }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [url, enabled]);
  // Never allow the previous URL's result to be submitted while the new one resolves.
  const current = enabled && result?.url === url ? result : undefined;
  return { candidates: current?.candidates ?? [], loading: enabled && isResourceUrl(url) && !current,
    error: current?.error, valid: isResourceUrl(url) };
}
