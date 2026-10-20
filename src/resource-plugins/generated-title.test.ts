import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultItemTitle } from './generated-title.ts';

const terminal = { name: 'Terminal', acceptsContext: false, creation: { requires: 'runtime' as const } };
const agent = { name: 'Agent', acceptsContext: true, creation: { requires: 'runtime' as const } };

test('a terminal without a name is called after its folder', () => {
  assert.equal(defaultItemTitle(terminal, { cwd: '/Users/me/work/hivemind' }), 'Terminal · hivemind');
  assert.equal(defaultItemTitle(terminal, { cwd: '/Users/me/work/hivemind/' }), 'Terminal · hivemind');
  assert.equal(defaultItemTitle(terminal, { cwd: '/' }), 'Terminal');
  assert.equal(defaultItemTitle(terminal, {}), 'Terminal');
});

test('an agent without a name is called after its provider', () => {
  assert.equal(defaultItemTitle(agent, { provider: 'codex', cwd: '/work/app' }), 'Codex session');
  assert.equal(defaultItemTitle(agent, {}), 'Claude session');
});

test('items that are not sessions have no default name', () => {
  assert.equal(defaultItemTitle({ name: 'Bookmark', creation: {} }, { cwd: '/work/app' }), undefined);
  assert.equal(defaultItemTitle(undefined, {}), undefined);
});
