import type { ITheme } from '@xterm/xterm';
import type { ISearchOptions } from '@xterm/addon-search';
import type { ColorScheme } from '../appearance.ts';

/** xterm draws on a canvas, so its colours cannot read the CSS tokens. The dark terminal keeps xterm's
 * own ANSI colours; the light one darkens them so agent output stays readable on a pale ground. */
export const TERMINAL_THEMES: Readonly<Record<ColorScheme, ITheme>> = {
  dark: { background: '#101612', foreground: '#dce8df', cursor: '#98d6ac' },
  light: {
    background: '#fbfcfa', foreground: '#17231b', cursor: '#2c7a49', cursorAccent: '#fbfcfa', selectionBackground: '#b9d9c3',
    black: '#17231b', red: '#b42e26', green: '#22713d', yellow: '#8a6200', blue: '#2b5fae', magenta: '#8a3f9e', cyan: '#18727a', white: '#c9d2cb',
    brightBlack: '#5d6f62', brightRed: '#c2412f', brightGreen: '#2c7a49', brightYellow: '#946c08', brightBlue: '#3b6fc0', brightMagenta: '#9b52ad', brightCyan: '#1f7f87', brightWhite: '#e5ebe6',
  },
};

/** ⌘F highlights: every match, and the active one in the Needs me amber of each theme. */
export const FIND_DECORATIONS: Readonly<Record<ColorScheme, NonNullable<ISearchOptions['decorations']>>> = {
  dark: { matchBackground: '#2f4a37', matchBorder: '#6f9a7a', matchOverviewRuler: '#6f9a7a', activeMatchBackground: '#7a5c1c', activeMatchBorder: '#f0c674', activeMatchColorOverviewRuler: '#f0c674' },
  light: { matchBackground: '#cfe6d6', matchBorder: '#6c8d75', matchOverviewRuler: '#6c8d75', activeMatchBackground: '#f3dca6', activeMatchBorder: '#a86f0e', activeMatchColorOverviewRuler: '#a86f0e' },
};
