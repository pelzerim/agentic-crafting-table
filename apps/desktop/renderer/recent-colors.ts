import { useEffect, useState } from 'react';
import { withRecentColor } from '../../../src/graph/colors.ts';
import type { SettingsSnapshot } from '../../../packages/core/settings.ts';

/** Your colours from the shared settings, kept current by the settings broadcast. `remember` writes a committed custom
 * colour through the settings write path, reading the newest revision first and trying once more if another write won. */
export function useRecentColors(): { recent: readonly string[]; remember(color: string): void } {
  const [recent, setRecent] = useState<readonly string[]>([]);
  useEffect(() => {
    const bridge = window.craftingTable;
    if (!bridge) return;
    let disposed = false, revision = -1;
    const receive = (snapshot: SettingsSnapshot) => { if (disposed || snapshot.revision < revision) return; revision = snapshot.revision; setRecent(snapshot.value.recentColors); };
    const off = bridge.onSettings(receive);
    void bridge.settingsRead().then(receive).catch(() => {});
    return () => { disposed = true; off(); };
  }, []);
  const remember = (color: string) => {
    setRecent(old => withRecentColor(old, color));
    const write = async (attempts: number): Promise<void> => {
      const saved = await window.craftingTable.settingsRead();
      try { await window.craftingTable.settingsWrite({ expectedRevision: saved.revision, value: { ...saved.value, recentColors: withRecentColor(saved.value.recentColors, color) } }); }
      catch (error) { if (attempts > 1) return write(attempts - 1); throw error; }
    };
    void write(2).catch(() => {});
  };
  return { recent, remember };
}
