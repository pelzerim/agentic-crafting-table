import test from 'node:test';
import assert from 'node:assert/strict';
import { codeBlockLanguages, codeRuns, highlightedRuns } from './highlight.ts';
import { textFileLanguage } from './language.ts';

test('the language of each code block of a Markdown source, in the order the blocks are rendered', () => {
  const source = '# Plan\n\n```ts title="a.ts"\nconst a = 1;\n```\n\n- step\n\n  ```py\n  b = 2\n  ```\n\n> ```\n> plain\n> ```\n\n    indented\n\n~~~Shell\nls\n~~~\n';
  assert.deepEqual(codeBlockLanguages(source), ['ts', 'py', undefined, undefined, 'Shell']);
  assert.deepEqual(codeBlockLanguages('No code here, only `inline`.'), []);
});

test('code is split into runs with tok- classes, and the runs together are the code unchanged', async () => {
  const code = 'export const answer = 42; // why\nconst name = "a<b>";\n';
  const runs = (await highlightedRuns(code, 'ts'))!;
  assert.equal(runs.map(run => run.text).join(''), code);
  const classesOf = (text: string) => runs.find(run => run.text === text)?.classes;
  assert.equal(classesOf('export'), 'tok-keyword'); assert.equal(classesOf('42'), 'tok-number');
  assert.equal(classesOf('// why'), 'tok-comment'); assert.equal(classesOf('"a<b>"'), 'tok-string');
  assert.equal(classesOf(' '), '');
});

test('a fence names its language by name, alias or file extension, in any letter case', async () => {
  for (const name of ['typescript', 'TS', 'js', 'py', 'sh', 'json', 'yaml', 'go']) assert.ok((await highlightedRuns('a', name)), name);
  assert.ok((await highlightedRuns('echo "hi" # say\n', 'bash'))!.some(run => run.classes === 'tok-comment'), 'a stream-parsed language is highlighted too');
});

test('a fence with a name no grammar has stays plain', async () => {
  assert.equal(await highlightedRuns('graph TD', 'mermaid'), undefined);
  assert.equal(await highlightedRuns('text', 'not-a-language'), undefined);
});

test(`a file's text is split into runs by the language of its name or the one named on the item`, async () => {
  const code = 'answer = 42  # why\n';
  const runs = await codeRuns(code, textFileLanguage('/work/answer.py')!);
  assert.equal(runs.map(run => run.text).join(''), code);
  assert.equal(runs.find(run => run.text === '# why')?.classes, 'tok-comment');
  assert.ok((await codeRuns(code, textFileLanguage('/work/answer', 'Python')!)).some(run => run.classes === 'tok-number'));
});
