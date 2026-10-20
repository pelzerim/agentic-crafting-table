import type { SessionCoordinator } from './sessions.ts';

/** The typed line every prompt from the table opens with, ahead of what it asks for. */
export const FROM_TABLE = 'I asked for this from the Agentic Crafting Table.';

/**
 * Sends a prompt to an agent's terminal: a short request typed on the input line,
 * its details pasted behind it, then Enter. An agent treats text that arrives only
 * as a paste as quoted material and waits for the person to say what to do with it,
 * so the request itself is typed. Neither part can end the paste or submit early.
 */
export const promptAgent = async (sessions: SessionCoordinator, sessionId: string, request: string, details: string) => {
  const typed = request.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
  const pasted = details.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
  await sessions.runtime.call('sessions.input', { sessionId, data: `${typed} \x1b[200~${pasted}\x1b[201~` });
  await sessions.runtime.call('sessions.input', { sessionId, data: '\r' });
};
