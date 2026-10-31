import { useSyncExternalStore } from 'react';
import { openingColorScheme } from '../appearance.ts';
import type { ColorScheme } from '../appearance.ts';

/** Main resolves Settings → General → Appearance through Electron's nativeTheme. The page does not
 * read prefers-color-scheme, which test runs emulate; it draws whatever main says, as `data-theme`
 * on <html> for the CSS tokens and through `useColorScheme()` for canvas colours. */
let current: ColorScheme = openingColorScheme(location.search);
const listeners = new Set<() => void>();
function apply(scheme: ColorScheme) {
  current = scheme; document.documentElement.dataset.theme = scheme;
  for (const listener of listeners) listener();
}
apply(current);
window.craftingTable?.onColorScheme(scheme => { if (scheme !== current) apply(scheme); });

function subscribe(changed: () => void) { listeners.add(changed); return () => { listeners.delete(changed); }; }
export function useColorScheme(): ColorScheme { return useSyncExternalStore(subscribe, () => current); }
