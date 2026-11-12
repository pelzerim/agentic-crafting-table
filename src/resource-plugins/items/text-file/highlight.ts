import type { LanguageDescription } from '@codemirror/language';
import { classHighlighter, highlightCode } from '@lezer/highlight';
import { lexer, walkTokens } from 'marked';
import { textFileLanguage } from './language.ts';

/** The language named on each code block of a Markdown source, in the order the blocks are rendered.
 * A block that names none is undefined. */
export function codeBlockLanguages(source: string): (string | undefined)[] {
  const names: (string | undefined)[] = [];
  walkTokens(lexer(source, { gfm: true }), token => { if (token.type === 'code') names.push(String(token.lang ?? '').trim().split(/\s+/)[0] || undefined); });
  return names;
}

export interface CodeRun { text: string; /** `tok-*` class names, or empty for plain text. */ classes: string }

/** Code as runs of text that share their `tok-*` classes, by the grammar of `language`. */
export async function codeRuns(code: string, language: LanguageDescription): Promise<CodeRun[]> {
  const { language: loaded } = await language.load(), runs: CodeRun[] = [];
  highlightCode(code, loaded.parser.parse(code), classHighlighter, (text, classes) => { runs.push({ text, classes }); }, () => { runs.push({ text: '\n', classes: '' }); });
  return runs;
}

/** Code as runs, by the language a code fence names. Undefined when no grammar goes by that name. */
export async function highlightedRuns(code: string, languageName: string): Promise<CodeRun[] | undefined> {
  const language = textFileLanguage(`file.${languageName}`, languageName);
  return language ? codeRuns(code, language) : undefined;
}

/** Runs as what a `code` element holds: a `span` for each run with classes, text for the rest. */
export function runNodes(document: Document, runs: CodeRun[]): (string | HTMLSpanElement)[] {
  return runs.map(run => {
    if (!run.classes) return run.text;
    const span = document.createElement('span'); span.className = run.classes; span.textContent = run.text;
    return span;
  });
}

/** Colours the code blocks of Markdown that `renderMarkdown` put into `container`. The rendered blocks carry
 * no language, so each takes the one its fence names in `source`. Only text and `span` elements are written. */
export async function highlightCodeBlocks(container: HTMLElement, source: string): Promise<void> {
  const blocks = [...container.querySelectorAll('pre > code')], names = codeBlockLanguages(source);
  if (blocks.length !== names.length) return;
  await Promise.all(blocks.map(async (block, index) => {
    const name = names[index];
    const runs = name ? await highlightedRuns(block.textContent ?? '', name).catch(() => undefined) : undefined;
    if (runs && block.isConnected) block.replaceChildren(...runNodes(container.ownerDocument, runs));
  }));
}
