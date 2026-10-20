import { clip } from '../../../pull-requests/review-findings.ts';

/** Text an agent wrote for a validation report, made fit to keep and to read: paragraphs, list
 * lines and code blocks survive; control characters, stray spaces and extra blank lines do not. */
export function reportText(value: string, max: number) {
  let fenced = false;
  const lines = value.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ' ').split('\n').map(line => {
    if (/^\s*```/.test(line)) { fenced = !fenced; return line.trimEnd(); }
    if (fenced) return line.trimEnd();
    const indent = /^[\t ]*/.exec(line)![0].replace(/\t/g, '  ');
    return indent + line.trim().replace(/[\t ]+/g, ' ');
  });
  return clip(lines.join('\n').replace(/\n[\t ]*(?=\n)/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), max);
}

const ABBREVIATION = /^(?:\(?(?:[A-Za-z]\.){2,}|vs\.|cf\.|approx\.|incl\.)$/i;
/** A paragraph's sentences: a full stop, question or exclamation mark followed by a capital starts the next one. */
export function sentences(text: string) {
  const result: string[] = [];
  let start = 0;
  for (const match of text.matchAll(/[.!?]\s+(?=["“(\[]?[A-Z])/g)) {
    const end = match.index + 1, word = text.slice(text.lastIndexOf(' ', match.index) + 1, end);
    if (ABBREVIATION.test(word)) continue;
    result.push(text.slice(start, end).trim()); start = end;
  }
  const last = text.slice(start).trim();
  if (last) result.push(last);
  return result;
}

const STRUCTURE = /^\s*(?:[-*+]\s|\d+[.)]\s|```|#|\||>)/;
const unbalanced = (text: string) => (text.match(/`/g)?.length ?? 0) % 2 === 1 || (text.match(/\*\*/g)?.length ?? 0) % 2 === 1;
/** The summary's head: the first sentence of its first paragraph, when that is a short sentence of prose. */
export function splitLead(summary: string, max = 200) {
  const text = summary.trim(), end = text.includes('\n') ? text.indexOf('\n') : text.length, first = text.slice(0, end);
  const lead = sentences(first)[0] ?? '';
  if (!lead || lead.length > max || STRUCTURE.test(first) || unbalanced(lead)) return { lead: '', rest: text };
  const remainder = first.slice(first.indexOf(lead) + lead.length).trim(), after = text.slice(end).replace(/^\n+/, '');
  return { lead, rest: remainder ? remainder + text.slice(end) : after };
}

/** What to render for an observation or summary body: a long single paragraph of prose reads one sentence
 * per line; anything the agent laid out itself, or that holds code, is left as written. */
export function readableSource(text: string, long = 280) {
  if (text.length <= long || text.includes('\n') || text.includes('`')) return text;
  return sentences(text).join('\n\n');
}

/** One line of plain text for a collapsed row: Markdown marks, links and code blocks reduced to their words. */
export function plainLine(text: string) {
  return text.replace(/```[^\n]*\n?([\s\S]*?)```/g, ' $1 ').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^\s*(?:[-*+]|\d+[.)]|#+|>)\s+/gm, '')
    .replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
}
