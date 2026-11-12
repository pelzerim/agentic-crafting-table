import test from 'node:test';
import assert from 'node:assert/strict';
import { filePathToReveal } from './reveal-file.ts';

test('a file to reveal is an absolute path, with a leading ~ expanded to the home directory', () => {
  assert.equal(filePathToReveal('/work/acme/plan.md', '/Users/example'), '/work/acme/plan.md');
  assert.equal(filePathToReveal('~/notes/plan.md', '/Users/example'), '/Users/example/notes/plan.md');
  assert.equal(filePathToReveal('/work/acme/../plan.md', '/Users/example'), '/work/plan.md');
});

test('anything that is not one absolute path is refused', () => {
  for (const input of ['', 'notes/plan.md', './plan.md', '~other/plan.md', '/work/plan.md\n/etc/hosts', '/work/\0plan.md', `/${'a'.repeat(5000)}`, undefined, null, 7, ['/work/plan.md'], { path: '/work/plan.md' }])
    assert.throws(() => filePathToReveal(input, '/Users/example'), /Invalid file path/, JSON.stringify(input)?.slice(0, 40));
});
