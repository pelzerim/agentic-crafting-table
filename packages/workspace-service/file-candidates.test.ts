import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResourcePluginRegistry } from '../../src/resource-plugins/builtins.ts';
import { existingFileCandidates } from './file-candidates.ts';

test('a path is offered as a file item only while a file is there', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'act-file-candidates-')));
  try {
    mkdirSync(join(home, 'notes'));
    writeFileSync(join(home, 'notes', 'plan.md'), '# Plan\n');
    const registry = createResourcePluginRegistry(), offered = async (input: string) => (await existingFileCandidates(registry, input, home)).map(candidate => [candidate.pluginId, candidate.title, candidate.data]);
    assert.deepEqual(await offered(join(home, 'notes', 'plan.md')), [['workspace.text', 'plan.md', { path: join(home, 'notes', 'plan.md') }]]);
    assert.deepEqual(await offered('~/notes/plan.md'), [['workspace.text', 'plan.md', { path: '~/notes/plan.md' }]], 'a leading ~ is the home directory');
    assert.deepEqual(await offered(join(home, 'notes', 'absent.md')), [], 'no file');
    assert.deepEqual(await offered(join(home, 'notes')), [], 'a folder');
    assert.deepEqual(await offered('/review the change'), [], 'text that only looks like a path');
    assert.deepEqual(await offered('https://example.com/plan.md'), [], 'a URL');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
