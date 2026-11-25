import test from 'node:test';
import assert from 'node:assert/strict';
import { agentModelLabel, shortModelName } from './model-label.ts';

test('a Claude model ID reads as its family and version', () => {
  assert.equal(shortModelName('claude-opus-5-5'), 'opus 5.5');
  assert.equal(shortModelName('claude-fable-5-2'), 'fable 5.2');
  assert.equal(shortModelName('claude-haiku-4-5-20251001'), 'haiku 4.5', 'the release date is left out');
  assert.equal(shortModelName('claude-sonnet-5-5[1m]'), 'sonnet 5.5 [1m]', 'a context variant stays visible');
});

test('other model IDs and aliases stay as the CLI names them', () => {
  assert.equal(shortModelName('gpt-6.2-sol'), 'gpt-6.2-sol');
  assert.equal(shortModelName('opus'), 'opus');
  assert.equal(shortModelName('claude-opus-5'), 'opus 5');
});

test('the label names the model and effort the session runs on now, else the launch model', () => {
  assert.equal(agentModelLabel({ provider: 'claude', model: 'opus' }), 'claude · opus');
  assert.equal(agentModelLabel({ provider: 'claude', model: 'opus', currentModel: 'claude-fable-5-2' }), 'claude · fable 5.2');
  assert.equal(agentModelLabel({ provider: 'claude', model: 'opus', currentModel: 'claude-opus-5-5', currentEffort: 'high' }), 'claude · opus 5.5 high');
  assert.equal(agentModelLabel({ provider: 'codex', model: 'gpt-6-astra', currentModel: 'gpt-6.2-sol', currentEffort: 'medium' }), 'codex · gpt-6.2-sol medium');
  assert.equal(agentModelLabel({ provider: 'claude', model: 'opus', currentEffort: 'low' }), 'claude · opus low', 'an effort without a reported model keeps the launch model');
  assert.equal(agentModelLabel({ provider: 'claude', model: 'native' }), 'claude', 'a resumed native conversation names no model until it reports one');
  assert.equal(agentModelLabel({ provider: 'claude', model: '' }), 'claude');
});
