import type { WorkspaceState } from '../core/control.ts';

/** The rollout → agent context link a validation saves. */
export const VALIDATION_LINK = { label: 'Validation', reveal: 'hover' } as const;

/** Schema 26: a validation link saved before links could wait for hover is marked to. It is the context link labelled
 * Validation with a rollout at one end, which only rollout validation saves. Every other link is left as it was. */
export function migrateValidationLinks(input: WorkspaceState): WorkspaceState {
  const state = structuredClone(input);
  const rollouts = new Set(state.resources.filter(resource => resource.pluginId === 'github.rollout').map(resource => resource.id));
  const rolloutNodes = new Set(state.nodes.filter(node => node.resourceId && rollouts.has(node.resourceId)).map(node => node.id));
  for (const link of state.links)
    if (link.kind === 'context' && link.label === VALIDATION_LINK.label && (rolloutNodes.has(link.sourceId) || rolloutNodes.has(link.targetId))) link.reveal = VALIDATION_LINK.reveal;
  return state;
}
