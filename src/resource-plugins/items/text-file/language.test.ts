import test from 'node:test';
import assert from 'node:assert/strict';
import { isMarkdown, textFileLanguage } from './language.ts';

test('the language of a file comes from its name', () => {
  const names = (paths: string[]) => paths.map(path => textFileLanguage(path)?.name);
  assert.deepEqual(names(['/notes/plan.md', '/src/app.ts', '/src/view.tsx', '/etc/config.yaml', '/repo/Dockerfile', '~/run.sh', '/data/rows.json', '/src/main.go']),
    ['Markdown', 'TypeScript', 'TSX', 'YAML', 'Dockerfile', 'Shell', 'JSON', 'Go']);
  assert.deepEqual(names(['/notes/todo.txt', '/home/me/.zshrc', '/a/b/LICENSE']), [undefined, undefined, undefined], 'a name no language claims is plain text');
  assert.equal(textFileLanguage('/folder.md/readme')?.name, undefined, 'only the file name counts, not a folder');
});

test('a language named on the item wins over the file name', () => {
  assert.equal(textFileLanguage('/notes/query.txt', 'sql')?.name, 'SQL');
  assert.equal(textFileLanguage('/notes/readme.md', 'Python')?.name, 'Python');
  assert.equal(textFileLanguage('/notes/readme.md', ' ts ')?.name, 'TypeScript');
  assert.equal(textFileLanguage('/notes/readme.md', 'no such language')?.name, 'Markdown', 'an unknown name falls back to the file name');
  assert.equal(textFileLanguage('/notes/readme.md', '')?.name, 'Markdown');
});

test('only Markdown has a rendered preview', () => {
  assert.equal(isMarkdown(textFileLanguage('/notes/plan.md')), true);
  assert.equal(isMarkdown(textFileLanguage('/notes/plan.markdown')), true);
  assert.equal(isMarkdown(textFileLanguage('/src/app.ts')), false);
  assert.equal(isMarkdown(undefined), false);
});
