/** The agents that can review a pull request directly, in menu order. */
export const REVIEW_AGENTS = [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'Codex' }] as const;
export type ReviewAgentId = typeof REVIEW_AGENTS[number]['id'];
export const REVIEW_AGENT_IDS = REVIEW_AGENTS.map(agent => agent.id) as [ReviewAgentId, ...ReviewAgentId[]];
