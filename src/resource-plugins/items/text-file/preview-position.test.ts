import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceOffsetOfPreviewText } from './preview-position.ts';

const SOURCE = '# Plan\n\nFirst **step** here\n\n- one\n- two\n\nLast step here\n';

test('a clicked text is found in the source, at the clicked character', () => {
  assert.equal(sourceOffsetOfPreviewText(SOURCE, ['Plan'], 'First ', 0), SOURCE.indexOf('First'));
  assert.equal(sourceOffsetOfPreviewText(SOURCE, ['Plan'], 'First ', 3), SOURCE.indexOf('First') + 3);
  assert.equal(sourceOffsetOfPreviewText(SOURCE, [], 'Plan', 4), SOURCE.indexOf('Plan') + 4);
});

test('a text that occurs twice is found after the texts shown before it', () => {
  const before = ['Plan', '\n', 'First ', 'step', ' here', '\n', 'one', '\n', 'two', '\n'];
  assert.equal(sourceOffsetOfPreviewText(SOURCE, before, 'Last step here', 5), SOURCE.lastIndexOf('step'));
  assert.equal(sourceOffsetOfPreviewText(SOURCE, ['Plan', 'First '], 'step', 0), SOURCE.indexOf('step'));
  assert.equal(sourceOffsetOfPreviewText('same\n\nsame\n\nsame\n', ['same', 'same'], 'same', 0), 12);
});

test('table cells of one character are found in their own row', () => {
  const table = '| k | v |\n|---|---|\n| a | 1 |\n| b | 1 |\n| c | 1 |\n';
  const cells = ['\n', 'k', '\n', 'v', '\n', 'a', '\n', '1', '\n', 'b', '\n', '1', '\n', 'c', '\n'];
  assert.equal(sourceOffsetOfPreviewText(table, cells, '1', 0), table.lastIndexOf('1'));
  assert.equal(sourceOffsetOfPreviewText(table, cells.slice(0, 11), '1', 1), table.indexOf('| b | 1') + 7);
});

test('a table cell of dashes or colons is not found in the row that separates the header', () => {
  const dash = '| A | B |\n|---|---|\n| - | x |\n';
  assert.equal(sourceOffsetOfPreviewText(dash, ['\n', 'A', '\n', 'B', '\n'], '-', 0), dash.lastIndexOf('-'));
  const colon = '| a | b |\n|:--|--:|\n| : | ok |\n';
  assert.equal(sourceOffsetOfPreviewText(colon, ['\n', 'a', '\n', 'b', '\n'], ':', 0), colon.lastIndexOf(':'));
  const rule = 'Above\n\n---\n\n-- below\n';
  assert.equal(sourceOffsetOfPreviewText(rule, ['Above', '\n'], '-- below', 0), rule.indexOf('-- below'));
  assert.equal(sourceOffsetOfPreviewText('a\n\n--\n', ['a', '\n'], '--', 1), 4);
  assert.equal(sourceOffsetOfPreviewText('Above\n    ---\n', [], 'Above\n---', 7), 11);
});

test('the tokens of a code block are found on their own line', () => {
  const code = '```js\nif (a) b = 1;\nif (a) c = 2;\n```\n';
  const tokens = ['if', ' (', 'a', ') ', 'b', ' = ', '1', ';\n', 'if', ' ('];
  assert.equal(sourceOffsetOfPreviewText(code, tokens, 'a', 0), code.lastIndexOf('a'));
});

test('a short text the source writes differently is not taken from far below', () => {
  const source = `**x** &#38; **y**\n\nTarget one\n\n${'filler '.repeat(30)}\n\na & b\n\nTarget one\n`;
  assert.equal(sourceOffsetOfPreviewText(source, ['x', ' & ', 'y', '\n'], 'Target one', 0), source.indexOf('Target one'));
});

test('a quoted or indented paragraph of several lines is found line by line', () => {
  const quote = 'Intro\n\n> first line\n> second line\n';
  assert.equal(sourceOffsetOfPreviewText(quote, ['Intro', '\n'], 'first line\nsecond line', 11), quote.indexOf('second'));
  assert.equal(sourceOffsetOfPreviewText(quote, ['Intro', '\n'], 'first line\nsecond line', 6), quote.indexOf('line'));
  const list = '- item one\n  continues here\n- item two\n';
  assert.equal(sourceOffsetOfPreviewText(list, ['\n'], 'item one\ncontinues here', 19), list.indexOf('here'));
});

test('a text of several lines is found in a file with Windows line ends, counted as the editor counts them', () => {
  assert.equal(sourceOffsetOfPreviewText('# Plan\r\n\r\nfirst line\r\nsecond line\r\n', ['Plan'], 'first line\nsecond line', 11), 19);
});

test('a text the source writes with an entity or a backslash is found as it is written', () => {
  const entities = 'Tom &amp; Jerry\n\nnote\n\nTom & Jerry go\n\nnote\n';
  assert.equal(sourceOffsetOfPreviewText(entities, ['Tom & Jerry', '\n'], 'note', 0), entities.indexOf('note'));
  assert.equal(sourceOffsetOfPreviewText('a &lt;b&gt; &quot;c&quot; d\n', [], 'a <b> "c" d', 10), 26);
  const escaped = '1\\. not a list \\*here\\* (a_b.c)\n';
  assert.equal(sourceOffsetOfPreviewText(escaped, [], '1. not a list *here* (a_b.c)', 15), escaped.indexOf('here'));
  assert.equal(sourceOffsetOfPreviewText(escaped, [], '1. not a list *here* (a_b.c)', 22), escaped.indexOf('a_b'));
});

test('a clicked line the source writes differently is placed where the last text found before it ends', () => {
  const source = '# Plan\n\nFirst step\n\na &#38; b\n';
  assert.equal(sourceOffsetOfPreviewText(source, ['Plan', '\n', 'First step', '\n'], 'a & b', 2), source.indexOf('First step') + 'First step'.length);
});

test('a clicked text found only ahead of the texts shown before it is taken there', () => {
  // "A & B" is written with a numbered entity where it is shown, and as shown only further down.
  assert.equal(sourceOffsetOfPreviewText('A &#38; B\n\nTarget\n\nA & B\n', ['A & B'], 'Target', 0), 11);
});

test('nothing of the preview in the source has no place', () => {
  assert.equal(sourceOffsetOfPreviewText('a &#38; b\n', [], 'a & b', 2), undefined);
  assert.equal(sourceOffsetOfPreviewText('', ['\n'], '\n', 0), undefined);
});

test('a text that ends in a character the source writes as an entity or with a backslash ends after it', () => {
  assert.equal(sourceOffsetOfPreviewText('Tom &amp; **Jerry**\n', [], 'Tom &', 5), 9);
  assert.equal(sourceOffsetOfPreviewText('C:\\\\ **x**\n', [], 'C:\\', 3), 4);
  assert.equal(sourceOffsetOfPreviewText('&amp;amp;\n', [], '&amp;', 1), 5);
  const table = '&amp;amp;\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
  assert.equal(sourceOffsetOfPreviewText(table, ['&amp;'], 'a', 0), table.indexOf('| a') + 2);
});
