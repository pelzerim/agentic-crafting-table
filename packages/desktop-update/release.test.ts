import test from 'node:test';
import assert from 'node:assert/strict';
import { LAUNCHER_MARKER, UpdateRefused, chooseReleaseTag, parseLauncher, planUpdate } from './release.ts';

const tags = ['v0.1.0', 'v0.2.0', 'v0.10.0', 'nightly'];

test('the update plan checks out the newest release tag and then builds and installs', () => {
  assert.deepEqual(planUpdate({ status: '', tags, head: 'abcdef1234567890', tagsAtHead: ['v0.2.0'] }), {
    tag: 'v0.10.0', current: 'v0.2.0', steps: ['git checkout --detach v0.10.0', 'npm ci', 'npm run package', 'npm run install:local'],
  });
  const untagged = planUpdate({ status: '', tags, head: 'abcdef1234567890', tagsAtHead: [] });
  assert.ok('current' in untagged); assert.equal(untagged.current, 'abcdef12', 'an untagged checkout is named by its commit');
});

test('a checkout already at the newest tag has nothing to do', () => {
  assert.deepEqual(planUpdate({ status: '', tags, head: 'abc', tagsAtHead: ['v0.10.0', 'v0.10.0-docs'] }), { unchanged: 'v0.10.0' });
});

test('local changes stop the update before anything is touched, naming the files; untracked files do not', () => {
  assert.throws(() => planUpdate({ status: ' M src/a.ts\nD  src/b.ts\n?? notes.md\n', tags, head: 'abc', tagsAtHead: [] }), (error: Error) => error instanceof UpdateRefused && /^  src\/a\.ts$/m.test(error.message) && /^  src\/b\.ts$/m.test(error.message) && !/notes\.md/.test(error.message));
  assert.throws(() => planUpdate({ status: 'M src/a.ts\n', tags, head: 'abc', tagsAtHead: [] }), /src\/a\.ts/, 'a trimmed first line still names the whole path');
  assert.equal('tag' in planUpdate({ status: '?? notes.md\n', tags, head: 'abc', tagsAtHead: [] }), true);
});

test('a remote without release tags is refused in words', () => {
  assert.throws(() => chooseReleaseTag(['main', 'latest']), (error: Error) => error instanceof UpdateRefused && /No release tag/.test(error.message));
});

test('the login shell launcher is read after the marker, past any profile output, and a shell without node gives none', () => {
  assert.deepEqual(parseLauncher(`Welcome!\n${LAUNCHER_MARKER}\nnot this\n\n${LAUNCHER_MARKER}\n/Users/me/.nvm/versions/node/v24.1.0/bin/node\n/usr/bin:/bin`), { node: '/Users/me/.nvm/versions/node/v24.1.0/bin/node', path: '/usr/bin:/bin' });
  assert.equal(parseLauncher(`\n${LAUNCHER_MARKER}\n\n/usr/bin:/bin`), undefined);
  assert.equal(parseLauncher(`\n${LAUNCHER_MARKER}\nnode: aliased to x\n/usr/bin`), undefined);
  assert.equal(parseLauncher('zsh: command not found'), undefined);
});
