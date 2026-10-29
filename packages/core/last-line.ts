/** Characters a Needs me row shows of the last line an agent said. */
export const LAST_LINE_LENGTH = 160;

/** The last non-empty line of a message as a row can show it: list, heading and quote markers, code fences,
 * emphasis and inline code ticks removed, clipped with an ellipsis. */
export function agentLastLine(message: string): string | undefined {
  const lines = message.split(/\r?\n/).map(line => line.replace(/^\s*(?:```\w*|[-*+>]|#{1,6}|\d+[.)])\s*/, '').replace(/```\s*$/, '').trim()).filter(Boolean);
  const line = lines.at(-1)?.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
  if (!line) return undefined;
  return line.length > LAST_LINE_LENGTH ? `${line.slice(0, LAST_LINE_LENGTH - 1)}…` : line;
}

/** What a Needs me row and a large agent card quote: the agent's recap when it has one, else the line it ended its turn on. */
export const agentSaid = (node: { lastLine?: string; recap?: { text: string } } | undefined) => node?.recap?.text ?? node?.lastLine;
