import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { lastPathPart } from '../../generated-title.ts';

/** The language a file is highlighted as: the one named on the item when CodeMirror knows it, otherwise the
 * one its file name stands for. Undefined is plain text. */
export function textFileLanguage(path: string, named?: string): LanguageDescription | undefined {
  const name = named?.trim();
  return (name ? LanguageDescription.matchLanguageName(languages, name, false) : null)
    ?? LanguageDescription.matchFilename(languages, lastPathPart(path) ?? path) ?? undefined;
}

export const isMarkdown = (language: LanguageDescription | undefined) => language?.name === 'Markdown';
