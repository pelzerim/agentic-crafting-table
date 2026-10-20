/** A ticket reference as providers write it: an upper-case key, a dash and a number ("BIL-128"). */
export const TICKET_REFERENCE = '[A-Z][A-Z0-9]+-\\d+';
const LEADING = new RegExp(`^(${TICKET_REFERENCE}) · (.+)$`, 's');

/** Splits a title that leads with a ticket reference ("BIL-128 · Plan changes") so a card can
 * show the words as its title and the reference as a tag. The title itself is never changed:
 * lists, search and accessible names keep it whole. */
export function splitReference(title: string): { reference: string; rest: string } | undefined {
  const match = title.trim().match(LEADING), rest = match?.[2].trim();
  return match && rest ? { reference: match[1], rest } : undefined;
}
