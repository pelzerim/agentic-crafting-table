/** Screen pixels, matched by `.item-indicators` in cards.css: 12px glyph, 3px inner and 7px outer gaps, 10px text. */
const ICON = 12, INNER = 3, OUTER = 7, CHAR = 5.6;
/** Characters a truncated label keeps visible, counting its ellipsis. */
const TRUNCATED = 3;
const span = (text: string) => ICON + (text ? INNER + text.length * CHAR : 0);
const TIME_UNIT = /^(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|mo|months?|y|years?)$/i;

/** The number a cue keeps when its words do not fit: a leading count or fraction
 * followed only by words ("3 unseen comments" → "3", "1/3 done" → "1/3"). Other
 * labels, such as durations and status words, have none. */
export function cueCount(label: string): string | undefined {
  const match = label.match(/^(\d+(?:\/\d+)?)((?:\s+\p{L}+)*)$/u);
  if (!match || TIME_UNIT.test(match[2].trim().split(/\s+/)[0])) return undefined;
  return match[1];
}

/** Status cues in priority order. Each starts short (a count cue as icon plus its
 * number, any other cue as a label that truncates with an ellipsis) and regains its
 * full label, first cue first, while the row still fits. */
export function fitIndicators(labels: readonly string[], width: number): { text: string; short: boolean }[] {
  const forms = labels.map(label => ({ text: cueCount(label) ?? label, short: true }));
  const cost = (form: { text: string; short: boolean }, label: string) => span(form.short && form.text === label ? label.slice(0, TRUNCATED) : form.text);
  let used = forms.reduce((sum, form, index) => sum + cost(form, labels[index]) + (index ? OUTER : 0), 0);
  labels.forEach((label, index) => {
    const grown = used - cost(forms[index], label) + span(label);
    if (grown <= width) { forms[index] = { text: label, short: false }; used = grown; }
  });
  return forms;
}
