import { canonical } from '../../packages/core/control.ts';
import type { WorkspaceState } from '../../packages/core/control.ts';

const SHARED = ['nodes', 'resources', 'links', 'todos'] as const;
/** Each object's serialisation, computed once, so a snapshot compares against the previous one without re-serialising it. */
const serialised = new WeakMap<object, string>();
const key = (value: object) => { let text = serialised.get(value); if (text === undefined) { text = canonical(value); serialised.set(value, text); } return text; };

/** `next` with the previous object in place of every node, resource, link and to-do whose content did not change,
 * and the previous array where no member changed. A snapshot arrives as fresh JSON, so without this every card on
 * the map would see a new item and render again for a change to one of them. */
export function shareUnchanged(previous: WorkspaceState | undefined, next: WorkspaceState): WorkspaceState {
  if (!previous || SHARED.some(field => !Array.isArray(previous[field]) || !Array.isArray(next[field]))) return next;
  const shared: WorkspaceState = { ...next };
  for (const field of SHARED) {
    const before = new Map<string, { id: string }>(previous[field].map(item => [item.id, item]));
    let changed = previous[field].length !== next[field].length;
    const items = next[field].map((item: { id: string }, index) => {
      const old = before.get(item.id);
      if (old && key(old) === key(item)) { if (old !== previous[field][index]) changed = true; return old; }
      changed = true; return item;
    });
    (shared as Record<typeof field, unknown>)[field] = changed ? items : previous[field];
  }
  return shared;
}
