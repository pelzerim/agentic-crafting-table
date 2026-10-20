import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultDirectory, directoryOptions, splitDirectory } from './working-directories.ts';

test('a new launch prefers the project folder, then the global default, then the most recent folder', () => {
  assert.equal(defaultDirectory({ project: '/p', global: '/g', recent: ['/r1', '/r2'] }), '/p');
  assert.equal(defaultDirectory({ project: '', global: '/g', recent: ['/r1'] }), '/g');
  assert.equal(defaultDirectory({ global: '', recent: ['/r1', '/r2'] }), '/r1');
  assert.equal(defaultDirectory({ recent: [] }), '');
});

test('directory choices label each default and list the remaining recent folders once', () => {
  assert.deepEqual(directoryOptions({ project: '/p', global: '/g', recent: ['/g', '/r', '/p'] }), [
    { value: '/p', label: '/p', group: 'Project default' },
    { value: '/g', label: '/g', group: 'Global default' },
    { value: '/r', label: '/r', group: 'Recent' },
  ]);
  assert.deepEqual(directoryOptions({ project: '/same', global: '/same', recent: [] }), [{ value: '/same', label: '/same', group: 'Project default' }]);
  assert.deepEqual(directoryOptions({ recent: ['/a', '/b'] }).map(option => option.group), ['Recent', 'Recent']);
});

test('a path splits into its parent and folder name so the name can stay visible', () => {
  assert.deepEqual(splitDirectory('/Users/me/code/project'), { parent: '/Users/me/code/', name: 'project' });
  assert.deepEqual(splitDirectory('/Users/me/code/'), { parent: '/Users/me/', name: 'code/' });
  assert.deepEqual(splitDirectory('/'), { parent: '', name: '/' });
  assert.deepEqual(splitDirectory('relative'), { parent: '', name: 'relative' });
  for (const path of ['/a/b/c', '/a/b/c/', '/', 'x', 'C:\\work\\repo']) { const { parent, name } = splitDirectory(path); assert.equal(parent + name, path); }
  assert.deepEqual(splitDirectory('C:\\work\\repo'), { parent: 'C:\\work\\', name: 'repo' });
});
