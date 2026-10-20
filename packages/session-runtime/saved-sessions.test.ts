import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { discoverClaudeSessions, resolveClaudeSession } from './saved-sessions.ts';
import { emptyState } from '../core/control.ts';

test('saved Claude discovery spans native folders, paginates, searches and deduplicates table sessions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-native-history-')), before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = directory;
  try {
    const ids: string[] = [];
    for (let index = 0; index < 53; index++) {
      const cwd = join(directory, index % 2 ? 'first-repo' : 'second-repo'), folder = join(directory, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
      await mkdir(folder, { recursive: true });
      const sessionId = randomUUID(); ids.push(sessionId);
      await writeFile(join(folder, `${sessionId}.jsonl`), JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId, cwd, isSidechain: false, timestamp: new Date().toISOString(), message: { role: 'user', content: `Saved work ${index}` } }) + '\n');
    }
    const state = emptyState();
    state.nodes.push({ id: 'on-table', resourceId: 'r', title: 'Already on table', summary: '', activity: 'idle', attention: 'none', position: { x: 0, y: 0 } });
    state.resources.push({ id: 'r', pluginId: 'agent.session', schemaVersion: 1, title: 'Already on table', data: { provider: 'claude', nativeSessionId: ids[0], cwd: join(directory, 'second-repo') } });
    const first = await discoverClaudeSessions(state);
    assert.equal(first.total, 53); assert.equal(first.sessions.length, 50); assert.equal(first.nextOffset, 50);
    const second = await discoverClaudeSessions(state, '', first.nextOffset);
    assert.equal(second.sessions.length, 3);
    assert.equal(new Set([...first.sessions, ...second.sessions].map(s => s.id)).size, 53);
    const existing = await discoverClaudeSessions(state, 'Already on table');
    assert.equal(existing.sessions[0].nodeId, 'on-table'); assert.equal(existing.total, 1);
    const folder = await discoverClaudeSessions(state, 'first-repo'); assert.equal(folder.total, 26);
    assert.equal((await resolveClaudeSession(ids[0])).cwd, join(directory, 'second-repo'));
    await assert.rejects(resolveClaudeSession(randomUUID()), /no longer available/);
    await assert.rejects(resolveClaudeSession('../../credentials'), /UUID/);
  } finally { if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = before; await rm(directory, { recursive: true, force: true }); }
});
