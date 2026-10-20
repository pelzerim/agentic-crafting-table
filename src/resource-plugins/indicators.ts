import * as z from 'zod/v4';

/** Provider-neutral saved cues. The renderer supplies every icon and color. */
export const indicatorsSchema = z.array(z.object({
  id: z.string().min(1).max(80), label: z.string().min(1).max(120),
  icon: z.enum(['check', 'message-square', 'git-pull-request', 'git-merge', 'x', 'clock', 'alert-triangle']),
  tone: z.enum(['neutral', 'green', 'blue', 'amber', 'violet', 'red']),
  showLabel: z.boolean().optional(),
  /** Provider-neutral progress for far-zoom summaries: ready to ship, failing, or finished. */
  stage: z.enum(['ready', 'failing', 'done']).optional(),
})).max(4);
export type ResourceIndicator = z.infer<typeof indicatorsSchema>[number];

/** The one cue for comments waiting for the person, so every type shows them alike: the message
 * glyph in blue with the count leading its label (a narrow card keeps icon and number). `word`
 * is the type's own term for its local read state. `showLabel` keeps the count on a type whose
 * default card is a single row. */
export function unreadCommentsIndicator(count: number, word: 'unread' | 'unseen', options: { showLabel?: boolean } = {}): ResourceIndicator {
  return { id: 'comments', label: `${count} ${word} comment${count === 1 ? '' : 's'}`, icon: 'message-square', tone: 'blue', ...(options.showLabel ? { showLabel: true } : {}) };
}
