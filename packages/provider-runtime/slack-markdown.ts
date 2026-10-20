import { escapeMarkdown } from './notion-markdown.ts';

const decode = (value: string) => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const STYLE = /(^|[\s(])([*_~])([^\s*_~](?:[^\n]*?[^\s])?)\2(?=$|[\s.,!?;:)])/g;
const MARKER: Record<string, string> = { '*': '**', _: '*', '~': '~~' };

function styled(value: string): string {
  let result = '', last = 0;
  for (const match of value.matchAll(STYLE)) {
    const start = match.index! + match[1].length;
    result += escapeMarkdown(decode(value.slice(last, start))) + MARKER[match[2]] + escapeMarkdown(decode(match[3])) + MARKER[match[2]];
    last = start + match[2].length * 2 + match[3].length;
  }
  return result + escapeMarkdown(decode(value.slice(last)));
}

function reference(inner: string, names: Readonly<Record<string, string>>): string {
  const [target, label] = inner.split('|', 2);
  if (/^@[UW][A-Z0-9]+$/.test(target)) return escapeMarkdown(`@${label || names[target.slice(1)] || target.slice(1)}`);
  if (/^#[CG][A-Z0-9]+$/.test(target)) return escapeMarkdown(`#${label || target.slice(1)}`);
  if (/^!(here|channel|everyone)$/.test(target)) return `@${target.slice(1)}`;
  if (/^!subteam\^/.test(target)) return escapeMarkdown(label || '@group');
  if (/^(https?:\/\/|mailto:)/.test(target)) return `[${label ? styled(label) : escapeMarkdown(target)}](${target.replace(/[()\s]/g, encodeURIComponent)})`;
  return escapeMarkdown(decode(`<${inner}>`));
}

/** Slack mrkdwn as Markdown for the shared renderer: links, code, bold, italic, strike,
 * quotes and mentions. Provider text never becomes markup. */
export function slackMarkdown(text: string, names: Readonly<Record<string, string>> = {}): string {
  return text.split(/(```[\s\S]*?```|`[^`\n]+`)/).map((part, index) => {
    if (index % 2) return part.startsWith('```') ? `\n\`\`\`\n${decode(part.slice(3, -3)).replace(/^\n|\n$/g, '')}\n\`\`\`\n` : decode(part);
    return part.split('\n').map(line => {
      const quote = line.startsWith('&gt; ') ? '> ' : '', body = quote ? line.slice(5) : line;
      return quote + body.split(/<([^<>\n]+)>/).map((chunk, inner) => inner % 2 ? reference(chunk, names) : styled(chunk)).join('');
    }).join('\n');
  }).join('');
}
