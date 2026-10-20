import { powerSaveBlocker } from 'electron';

/** One scoped assertion, released on disable/quit. Never changes macOS lock or sleep preferences. */
export function createKeepAwake() {
  let id: number | undefined;
  return {
    apply(enabled: boolean) {
      if (enabled && id === undefined) id = powerSaveBlocker.start('prevent-display-sleep');
      else if (!enabled && id !== undefined) { powerSaveBlocker.stop(id); id = undefined; }
    },
  };
}
