/** Ship/Show/Ask title tags: one `[show]` or `[ship]` prefix, never stacked. */
export type ShowShipTag = 'show' | 'ship';
export const TITLE_LIMIT = 256;
const LEADING = /^\s*\[(show|ship)\]\s*/i, TRAILING = /\s*\[(show|ship)\]\s*$/i;

/** The current tag (the first leading one, else the last trailing one) and the title without any tags. */
export function titleTag(title: string): { tag: ShowShipTag | ''; base: string } {
  let rest = title, tag = '';
  for (let match; (match = LEADING.exec(rest)); rest = rest.slice(match[0].length)) tag ||= match[1];
  for (let match; (match = TRAILING.exec(rest)); rest = rest.slice(0, match.index)) tag ||= match[1];
  return { tag: tag.toLowerCase() as ShowShipTag | '', base: rest.trim() };
}
export function taggedTitle(title: string, tag: ShowShipTag | ''): string {
  const { base } = titleTag(title);
  return tag ? `[${tag}] ${base}`.trim() : base;
}
/** A new title GitHub accepts: non-empty and at most 256 characters. */
export function titleProblem(title: string) {
  if (!title.trim()) return 'The title would be empty. Rename the pull request on GitHub instead.';
  if (title.length > TITLE_LIMIT) return `The tagged title would exceed GitHub’s ${TITLE_LIMIT}-character limit. Shorten it on GitHub first.`;
}
const quote = (title: string) => `“${title.length > 120 ? `${title.slice(0, 119)}…` : title}”`;
/** GitHub decides whether the title changes; a closed or merged PR only adds a warning. */
export function showShipChoices(pull: { number: number; title: string; state: string; merged?: boolean | null }): { current: ShowShipTag | ''; prompt: string; options: { id: ShowShipTag | 'none'; label: string; description: string; disabled?: boolean }[] } {
  const { tag } = titleTag(pull.title), warning = pull.merged ? ' GitHub reports it is merged.' : pull.state !== 'open' ? ' GitHub reports it is closed.' : '';
  const option = (id: ShowShipTag | 'none', label: string) => {
    const next = taggedTitle(pull.title, id === 'none' ? '' : id), problem = id === tag ? undefined : titleProblem(next);
    return { id, label, description: id === tag ? 'Current tag' : problem ?? `Becomes ${quote(next)}`, ...(problem ? { disabled: true } : {}) };
  };
  return { current: tag, prompt: `Retitle #${pull.number} ${quote(pull.title)} on GitHub?${warning}`, options: [option('show', '[show]'), option('ship', '[ship]'), ...(tag ? [option('none', 'Remove tag')] : [])] };
}
