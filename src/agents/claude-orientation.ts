/** A new general-purpose Claude turn only; never replayed on resume or substituted
 * for an explicit task/skill. Source material arrives separately through hooks/MCP. */
export const CLAUDE_ORIENTATION_PROMPT = [
  'Read the table context offer (or workspace_run agent.context with your nodeId) and acknowledge its deliveryId.',
  'If nothing is connected to this agent, reply in one or two sentences: say so and ask what to work on or which item to connect. Do not list project background.',
  'Otherwise give a short "What next" list of at most 3 steps for the directly connected items, one line each with the item and why. Read a connected review before citing it and check its captured revision against the PR. Do not invent work.',
  'Suggest only: do not edit, run state-changing commands or post anything. Then wait for my choice.',
].join(' ');
