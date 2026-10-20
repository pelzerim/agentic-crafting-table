const LEAST = 2;
/** Heights in layout pixels around a collapsed card's title: the title itself, the label holding it with
 * the type eyebrow, the heading row holding the label, how far the card's in-flow rows reach and where the
 * card's content box ends. */
export interface TitleRoom { title: number; label: number; heading: number; rowsBottom: number; contentBottom: number }

/** The lines a title may use: its own height plus what its heading leaves around the label and what the
 * card leaves under its last row, never fewer than `least`. A short title gives back exactly the room it
 * does not take, so the answer does not depend on how long the title is. */
export function titleLines(room: TitleRoom, lineHeight: number, least = LEAST) {
  const free = room.title + Math.max(0, room.heading - room.label) + room.contentBottom - room.rowsBottom;
  return lineHeight > 0 ? Math.max(least, Math.floor((free + .5) / lineHeight)) : least;
}

const ROWS = ':scope > :is(.card-heading,.card-pips,.card-summary,.map-size-fields,.indicator-labels)';
function measure(card: HTMLElement) {
  const heading = card.querySelector<HTMLElement>(':scope > .card-heading'), label = heading?.querySelector<HTMLElement>(':scope > .card-label');
  const title = label?.querySelector<HTMLElement>(':scope > strong');
  if (!heading || !label || !title) return undefined;
  let rowsBottom = 0;
  for (const row of card.querySelectorAll<HTMLElement>(ROWS)) rowsBottom = Math.max(rowsBottom, row.offsetTop + row.offsetHeight);
  const room = { title: title.offsetHeight, label: label.offsetHeight, heading: heading.clientHeight, rowsBottom, contentBottom: card.clientHeight - parseFloat(getComputedStyle(card).paddingBottom) };
  return titleLines(room, parseFloat(getComputedStyle(title).lineHeight));
}

const pending = new Set<HTMLElement>(), fitted = new Set<HTMLElement>();
/** A title that changes lines costs a text layout, so a frame changes at most this many; a whole map coming
 * to full size settles over a few frames instead of stalling one. */
const BATCH = 24;
let queued = false;
/** Reads queued cards until a batch of them needs a change, then writes that batch. A title that keeps the
 * stylesheet's two lines writes nothing and costs no layout. */
function flush() {
  const changes: [HTMLElement, string][] = [];
  for (const card of pending) {
    pending.delete(card);
    if (!card.isConnected) continue;
    const lines = measure(card), value = lines === undefined || lines === LEAST ? '' : String(lines);
    if (card.style.getPropertyValue('--title-lines') !== value && changes.push([card, value]) === BATCH) break;
  }
  for (const [card, value] of changes) value ? card.style.setProperty('--title-lines', value) : card.style.removeProperty('--title-lines');
  queued = pending.size > 0;
  if (queued) requestAnimationFrame(flush);
}
/** Lets a collapsed card's title take the lines its card has left. Call again whenever what the card shows or its size changes. */
export function fitTitle(card: HTMLElement) {
  fitted.add(card); pending.add(card);
  if (!queued) { queued = true; queueMicrotask(flush); }
}
/** Returns the card's title to its stylesheet clamp. */
export function releaseTitle(card: HTMLElement) {
  fitted.delete(card); pending.delete(card);
  card.style.removeProperty('--title-lines');
}
if (typeof document !== 'undefined') document.fonts.addEventListener('loadingdone', () => { for (const card of fitted) fitTitle(card); });
