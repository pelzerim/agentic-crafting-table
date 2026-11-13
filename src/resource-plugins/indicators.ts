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

/** A row of small marks a type's presentation draws on its map card, with a count line after them. `tone` and `style` are the type's
 * own words; its stylesheet colours them. Drawn at the map sizes whose preset sets `presentationPips`. */
export const cardPipsSchema = z.object({
  pips: z.array(z.object({ tone: z.string().regex(/^[a-z][a-z-]{0,23}$/), style: z.string().regex(/^[a-z][a-z-]{0,23}$/) })).min(1).max(24),
  label: z.string().min(1).max(120).optional(),
});
export type CardPips = z.infer<typeof cardPipsSchema>;

/** The one cue for comments waiting for the person, so every type shows them alike: the message
 * glyph in blue with the count leading its label (a narrow card keeps icon and number). `word`
 * is the type's own term for its local read state. `showLabel` keeps the count on a type whose
 * default card is a single row. */
export function unreadCommentsIndicator(count: number, word: 'unread' | 'unseen', options: { showLabel?: boolean } = {}): ResourceIndicator {
  return { id: 'comments', label: `${count} ${word} comment${count === 1 ? '' : 's'}`, icon: 'message-square', tone: 'blue', ...(options.showLabel ? { showLabel: true } : {}) };
}

/** A coloured chip a type's map preset reads from its item data (`MapSizePreset.tags`), such as a GitHub label. */
export interface CardTag { name: string; color: string }
/** The well-formed `{ name, color }` entries of `value`, colours as six lower-case hex digits; anything else, a missing list included, reads as none. */
export function cardTags(value: unknown): CardTag[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    const { name, color } = (entry ?? {}) as { name?: unknown; color?: unknown };
    return typeof name === 'string' && name.trim() && typeof color === 'string' && /^[0-9a-f]{6}$/i.test(color) ? [{ name: name.trim().slice(0, 100), color: color.toLowerCase() }] : [];
  }).slice(0, 50);
}
/** Dark or white text, whichever reads on the tag's own colour; the chip looks the same in either theme. */
export function tagInk(color: string) {
  const [red, green, blue] = [0, 2, 4].map(index => parseInt(color.slice(index, index + 2), 16));
  return (red * 299 + green * 587 + blue * 114) / 255_000 > .6 ? '#1f2328' : '#ffffff';
}
