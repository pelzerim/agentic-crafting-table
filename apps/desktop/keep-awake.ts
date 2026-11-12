import type { PowerSaveBlocker } from 'electron';

type Blocker = Pick<PowerSaveBlocker, 'start' | 'stop'>;

/** One scoped assertion, released on disable/quit. Never changes macOS lock or sleep preferences. */
export function createKeepAwake(blocker: Blocker, type: Parameters<Blocker['start']>[0] = 'prevent-display-sleep') {
  let id: number | undefined;
  return {
    apply(enabled: boolean) {
      if (enabled && id === undefined) id = blocker.start(type);
      else if (!enabled && id !== undefined) { blocker.stop(id); id = undefined; }
    },
  };
}

type BoardNode = { id: string; projectId?: string; activity?: string; archivedAt?: string; rework?: unknown };
/** Archiving a project archives its items without marking them, so they are skipped through the project.
 * A rework note only marks the item: the agent doing the rework holds on its own, and a note left uncleared never does. */
export function boardWorking(nodes: readonly BoardNode[]) {
  const archived = new Set(nodes.filter(node => node.archivedAt).map(node => node.id));
  return nodes.some(node => node.activity === 'working' && !node.rework && !node.archivedAt && !(node.projectId && archived.has(node.projectId)));
}

/** Holds off idle system sleep while the setting is on and any board item is working; the display may still sleep. */
export function createWorkAwake(blocker: Blocker) {
  const hold = createKeepAwake(blocker, 'prevent-app-suspension');
  let enabled = false, working = false;
  return {
    setting(value: boolean) { enabled = value; hold.apply(enabled && working); },
    /** `below` counts working items the map layer leaves out of `nodes`. */
    nodes(nodes: Parameters<typeof boardWorking>[0], below = 0) { working = below > 0 || boardWorking(nodes); hold.apply(enabled && working); },
    /** No snapshot while disconnected, so unknown work does not hold; the next snapshot restores it. */
    disconnected() { working = false; hold.apply(false); },
    release() { enabled = false; hold.apply(false); },
  };
}
