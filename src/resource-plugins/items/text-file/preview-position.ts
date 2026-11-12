/** A text shorter than this occurs all over a file. */
const SHORT_TEXT_LENGTH = 3;
/** A short text is taken only when it is found this near; further away it is some other occurrence. */
const SHORT_TEXT_FOUND_WITHIN = 120;
/** A line is first looked for this far after the last text found, and each time it is not found there,
 * this many times as far. */
const FIRST_SEARCH_LENGTH = 1024, SEARCH_LENGTH_GROWS_BY = 4;
/** What a Markdown source writes differently from what the preview shows: punctuation with a backslash
 * before it, and the entities of & < > " '. */
const WRITTEN_DIFFERENTLY = /\\([!-/:-@[-`{-~])|&(amp|lt|gt|quot|#39|apos);/g;
const ENTITY_SHOWN: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" };
/** The row under a table's header, and the line under a heading. */
const SEPARATOR_ROW = /^ {0,3}(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/;
const RULE = /^ {0,3}(?:- *){3,}$/;

/** True when the line of `text` that holds `index` shows no text of its own: the row under a table's
 * header, the line under a heading, a rule. Dashes after an empty line are a paragraph unless they are a rule. */
function lineShowsNoText(text: string, index: number) {
  const start = text.lastIndexOf('\n', index - 1) + 1, end = text.indexOf('\n', index);
  const line = text.slice(start, end < 0 ? undefined : end);
  if (!SEPARATOR_ROW.test(line)) return false;
  const lineBefore = text.slice(text.lastIndexOf('\n', start - 2) + 1, Math.max(start - 1, 0));
  return Boolean(lineBefore.trim()) || RULE.test(line);
}

/** A text a line is looked for in, with the place in the source of each of its characters and of its end. */
type SearchedText = {
  text: string;
  placeOf(index: number): number;
  /** The first character that is at `place` of the source or after it. */
  indexAt(place: number): number;
};

/** `text` as a preview shows it outside code. Undefined when `text` writes nothing differently. */
function asShown(text: string): SearchedText | undefined {
  const places = new Int32Array(text.length + 1), parts: string[] = [];
  let length = 0, copied = 0;
  const copyUpTo = (end: number) => { for (let index = copied; index < end; index++) places[length++] = index; parts.push(text.slice(copied, end)); };
  for (const written of text.matchAll(WRITTEN_DIFFERENTLY)) {
    copyUpTo(written.index);
    places[length++] = written.index;
    parts.push(written[1] ?? ENTITY_SHOWN[written[2]!]!);
    copied = written.index + written[0].length;
  }
  if (!copied) return undefined;
  copyUpTo(text.length);
  places[length] = text.length;
  const indexAt = (place: number) => {
    let low = 0, high = length;
    while (low < high) { const middle = (low + high) >> 1; if (places[middle]! < place) low = middle + 1; else high = middle; }
    return low;
  };
  return { text: parts.join(''), placeOf: index => places[index]!, indexAt };
}

/** Where a line of the preview is in the source: `start` is the place of its first character, `place` the
 * place of any of its characters. */
type FoundLine = { start: number; place(character: number): number };

/** Where in a Markdown source the character is that was clicked in its rendered preview. `before` holds the
 * texts the preview shows ahead of the clicked one, in order; `at` is the clicked character in `clicked`.
 * Each line of each text is looked for after the one before it, in the source as the preview shows it and
 * in the source as it is, so a text that occurs twice is found at the right place, and a quoted or indented
 * paragraph is found line by line. When the source holds the clicked line in neither way (a numbered
 * entity), the place is where the last text found before it ends. The offset counts a line end as one
 * character, as the editor does. Undefined when nothing of the preview was found in the source. */
export function sourceOffsetOfPreviewText(source: string, before: readonly string[], clicked: string, at: number): number | undefined {
  const text = source.replace(/\r\n?/g, '\n'), character = Math.min(Math.max(at, 0), clicked.length);
  const shown = asShown(text), written: SearchedText = { text, placeOf: index => index, indexAt: place => place };
  // Where both hold a line at the same place the first is taken: there the line ends after an entity or an
  // escaped character, not inside it.
  const searched = shown ? [shown, written] : [written];
  let from = 0;

  /** The occurrence of `line` in `within` nearest to `from`, of those that start at it or after it and
   * before `limit`; with `backward`, of those that start after `limit` and no later than the first
   * character of `within` at `from` or after it. A line of dashes, colons and bars is not found in a line
   * of the source that shows no text. */
  const occurrence = (line: string, within: SearchedText, limit: number, backward: boolean): FoundLine | undefined => {
    const withoutText = /^[-:| ]+$/.test(line);
    const upToLimit = backward ? within.text : within.text.slice(0, within.indexAt(limit) + line.length - 1);
    const next = (index: number) => backward ? upToLimit.lastIndexOf(line, index) : upToLimit.indexOf(line, index);
    for (let found = next(within.indexAt(from)); found >= 0;) {
      const index = found, place = within.placeOf(index);
      if (backward && place <= limit) return undefined;
      if (!withoutText || !lineShowsNoText(text, place)) return { start: place, place: inLine => within.placeOf(index + inLine) };
      const lineBreak = backward ? text.lastIndexOf('\n', place) : text.indexOf('\n', place);
      if (lineBreak < 0) return undefined;
      found = next(within.indexAt(lineBreak));
    }
    return undefined;
  };
  /** The occurrence of `line` nearest to `from`: at it or after it, with `backward` at it or before it. A
   * short line is looked for only as far as it may be taken from. */
  const find = (line: string, backward = false) => {
    const maximumSearchLength = line.trim().length < SHORT_TEXT_LENGTH ? SHORT_TEXT_FOUND_WITHIN + 1 : text.length + 1;
    for (let searchLength = backward ? maximumSearchLength : Math.min(FIRST_SEARCH_LENGTH, maximumSearchLength); ; searchLength = Math.min(searchLength * SEARCH_LENGTH_GROWS_BY, maximumSearchLength)) {
      let nearest: FoundLine | undefined;
      for (const within of searched) nearest = occurrence(line, within, nearest?.start ?? (backward ? from - searchLength : from + searchLength), backward) ?? nearest;
      if (nearest || searchLength === maximumSearchLength) return nearest;
    }
  };
  const continueAfter = (line: string) => {
    const found = line.trim() ? find(line) : undefined;
    if (found) from = found.place(line.length);
  };

  for (const earlier of before) for (const line of earlier.split('\n')) continueAfter(line);
  const clickedLineStart = clicked.lastIndexOf('\n', character - 1) + 1, clickedLineEnd = clicked.indexOf('\n', character);
  for (const line of clicked.slice(0, clickedLineStart).split('\n')) continueAfter(line);
  const clickedLine = clicked.slice(clickedLineStart, clickedLineEnd < 0 ? undefined : clickedLineEnd);
  const clickedLineFound = clickedLine.trim() ? find(clickedLine) ?? find(clickedLine, true) : undefined;
  return clickedLineFound ? clickedLineFound.place(character - clickedLineStart) : from > 0 ? from : undefined;
}
