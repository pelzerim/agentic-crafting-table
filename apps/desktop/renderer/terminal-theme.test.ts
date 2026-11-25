import test from 'node:test';
import assert from 'node:assert/strict';
import { TERMINAL_CONTRAST, TERMINAL_THEMES } from './terminal-theme.ts';

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255).map(c => c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
  return .2126 * r + .7152 * g + .0722 * b;
};
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;

test('the dark terminal keeps its colours', () => {
  const { background, foreground, cursor } = TERMINAL_THEMES.dark;
  assert.deepEqual({ background, foreground, cursor }, { background: '#101612', foreground: '#dce8df', cursor: '#98d6ac' });
});

test('on the light terminal the text and every coloured ANSI colour stay readable', () => {
  const theme = TERMINAL_THEMES.light, background = theme.background!;
  assert.ok(contrast(theme.foreground!, background) >= 7, 'foreground');
  /** White and bright white are pale on purpose (bars, highlights); TERMINAL_CONTRAST darkens them when used as text. */
  for (const name of ANSI.filter(name => name !== 'white')) {
    for (const key of [name, `bright${name[0].toUpperCase()}${name.slice(1)}`] as const) {
      const colour = theme[key as keyof typeof theme] as string;
      assert.ok(contrast(colour, background) >= 3, `${key} ${colour}`);
    }
  }
});

test('the light greys keep their order, white bars stay light and the highlight row reads without help', () => {
  const theme = TERMINAL_THEMES.light;
  const [black, brightBlack, white, brightWhite] = [theme.black!, theme.brightBlack!, theme.white!, theme.brightWhite!].map(luminance);
  assert.ok(black < brightBlack && brightBlack < white && white < brightWhite, 'black < bright black < white < bright white');
  assert.ok(contrast(theme.black!, theme.white!) >= 4.5, 'black on white (SGR 30;47)');
  assert.ok(contrast(theme.black!, theme.brightWhite!) >= 4.5, 'black on bright white (SGR 30;107)');
  assert.ok(contrast(theme.brightWhite!, theme.brightBlack!) >= 4.5, 'bright white on bright black (SGR 97;100)');
});

test('only the light terminal raises faint text to a minimum contrast', () => {
  assert.deepEqual(TERMINAL_CONTRAST, { dark: 1, light: 4.5 });
});
