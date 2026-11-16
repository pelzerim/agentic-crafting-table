/** An empty map is not necessarily a new workspace: edits, archives and Undermap
 * all count as prior use. Call only when no saved guide preference exists. */
export function initialFirstRunActive(state: { revision: number; nodes: readonly unknown[]; resources: readonly unknown[] }, belowCount: number): boolean {
  return state.revision === 0 && state.nodes.length === 0 && state.resources.length === 0 && belowCount === 0;
}
