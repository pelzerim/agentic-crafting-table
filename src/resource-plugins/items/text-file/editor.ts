import { basicSetup, EditorView } from 'codemirror';
import { Annotation, Compartment, EditorState, Transaction } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { autocompletion, completionStatus } from '@codemirror/autocomplete';
import { searchPanelOpen } from '@codemirror/search';
import { type LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { classHighlighter } from '@lezer/highlight';
import { type GlyphName, pixelGlyphMask } from '../../pixel-glyphs.ts';
import { isMarkdown } from './language.ts';

export { isMarkdown, textFileLanguage } from './language.ts';
export { highlightCodeBlocks } from './highlight.ts';

export interface MountedTextEditor {
  /** The text with the line endings the file had. */
  text(): string;
  /** Replaces the text with what the disk holds, keeping the scroll position and undo history where it can. */
  setText(text: string): void;
  setWritable(writable: boolean): void;
  /** Takes the keyboard. With `at`, the caret goes to that character of the text, a line end counted as one,
   * and the editor scrolls so it shows. */
  focus(at?: number): void;
  dispose(): void;
}

/** The marks CodeMirror draws as characters, and the glyph the stylesheet draws in place of each. */
const MARK_GLYPHS: Record<string, GlyphName> = { fold: 'chevron', unfold: 'chevron-right', folded: 'more', close: 'close' };

const fromDisk = Annotation.define<boolean>();
const usesCarriageReturns = (text: string) => text.includes('\r\n') && !/(^|[^\r])\n/.test(text);
const writableState = (writable: boolean) => [EditorState.readOnly.of(!writable), EditorView.editable.of(writable), EditorView.contentAttributes.of(writable ? {} : { tabindex: '0' })];

/** CodeMirror with its stock setup. Highlighting marks tokens with `tok-*` classes, coloured by the stylesheet,
 * which also draws pixel glyphs over the characters CodeMirror uses as marks. */
export function mountTextEditor(parent: HTMLElement, options: { text: string; language?: LanguageDescription; writable: boolean; onEdit(text: string): void; onSave(): void }): MountedTextEditor {
  const language = new Compartment(), writable = new Compartment(), prose = !options.language || isMarkdown(options.language);
  let carriageReturns = usesCarriageReturns(options.text), disposed = false;
  const text = () => carriageReturns ? view.state.doc.toString().replaceAll('\n', '\r\n') : view.state.doc.toString();
  const view = new EditorView({
    parent, doc: options.text,
    extensions: [
      basicSetup,
      autocompletion({ icons: false }),
      keymap.of([{ key: 'Mod-s', run: () => { options.onSave(); return true; } }]),
      syntaxHighlighting(classHighlighter),
      language.of(isMarkdown(options.language) ? markdown({ codeLanguages: languages }) : []),
      writable.of(writableState(options.writable)),
      prose ? EditorView.lineWrapping : [],
      EditorView.updateListener.of(update => {
        // The app leaves Escape to an element marked this way, so Escape first closes what the editor has open.
        update.view.dom.toggleAttribute('data-owns-escape', completionStatus(update.state) !== null || searchPanelOpen(update.state));
        if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(fromDisk))) options.onEdit(text());
      }),
    ],
  });
  for (const [mark, glyph] of Object.entries(MARK_GLYPHS)) view.dom.style.setProperty(`--text-file-mark-${mark}`, pixelGlyphMask(glyph));
  if (options.language && !isMarkdown(options.language)) void options.language.load().then(support => { if (!disposed) view.dispatch({ effects: language.reconfigure(support) }); }).catch(() => {});
  return {
    text,
    setText(next) {
      carriageReturns = usesCarriageReturns(next);
      const current = view.state.doc.toString(), wanted = next.replace(/\r\n?/g, '\n');
      if (current === wanted) return;
      let start = 0, end = 0;
      const shorter = Math.min(current.length, wanted.length);
      while (start < shorter && current.charCodeAt(start) === wanted.charCodeAt(start)) start++;
      while (end < shorter - start && current.charCodeAt(current.length - 1 - end) === wanted.charCodeAt(wanted.length - 1 - end)) end++;
      view.dispatch({ changes: { from: start, to: current.length - end, insert: wanted.slice(start, wanted.length - end) }, annotations: [fromDisk.of(true), Transaction.addToHistory.of(false)] });
    },
    setWritable(next) { view.dispatch({ effects: writable.reconfigure(writableState(next)) }); },
    focus(at) {
      if (at !== undefined) { const caret = Math.min(Math.max(at, 0), view.state.doc.length); view.dispatch({ selection: { anchor: caret }, effects: EditorView.scrollIntoView(caret, { y: 'center' }) }); }
      view.focus();
    },
    dispose() { disposed = true; view.destroy(); },
  };
}
