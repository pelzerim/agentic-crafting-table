import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeConfigFile, trustClaudeFolder } from './claude-trust.ts';

test('the folder is marked trusted in Claude Code\'s config once, keeping every other entry and the file mode', async () => {
  const home = await mkdtemp(join(tmpdir(), 'craft-claude-trust-'));
  try {
    const file = join(home, '.claude.json');
    await writeFile(file, JSON.stringify({ numStartups: 3, projects: { '/work/app': { hasTrustDialogAccepted: true, allowedTools: ['Read'] } } }));
    await chmod(file, 0o600);
    assert.equal(trustClaudeFolder('/data/comparisons', file), true);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(saved, { numStartups: 3, projects: { '/work/app': { hasTrustDialogAccepted: true, allowedTools: ['Read'] }, '/data/comparisons': { hasTrustDialogAccepted: true } } });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(trustClaudeFolder('/data/comparisons', file), false, 'already trusted: nothing is written');
    assert.equal(trustClaudeFolder('/work/app/comparisons', file), false, 'a trusted parent covers it');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a missing or unreadable config is left alone, so Claude asks as before', async () => {
  const home = await mkdtemp(join(tmpdir(), 'craft-claude-trust-'));
  try {
    const file = join(home, '.claude.json');
    assert.equal(trustClaudeFolder('/data/comparisons', file), false);
    await writeFile(file, '{ not json');
    assert.equal(trustClaudeFolder('/data/comparisons', file), false);
    assert.equal(await readFile(file, 'utf8'), '{ not json');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('the config file follows CLAUDE_CONFIG_DIR when it is set', () => {
  assert.equal(claudeConfigFile({ CLAUDE_CONFIG_DIR: '/custom' }, '/home/example'), '/custom/.claude.json');
  assert.equal(claudeConfigFile({}, '/home/example'), '/home/example/.claude.json');
});
