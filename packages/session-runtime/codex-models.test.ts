import test from 'node:test';
import assert from 'node:assert/strict';
import { latestSolModel } from './codex-models.ts';

test('the latest Sol model is the highest version in the catalog', () => {
  assert.equal(latestSolModel(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-luna']), 'gpt-6.1-sol');
  assert.equal(latestSolModel(['gpt-6.1-sol', 'gpt-7-sol']), 'gpt-7-sol');
});

test('Sol versions compare by number, not as text', () => {
  assert.equal(latestSolModel(['gpt-5.9-sol', 'gpt-5.10-sol']), 'gpt-5.10-sol');
  assert.equal(latestSolModel(['gpt-6-sol', 'gpt-6.0.1-sol']), 'gpt-6.0.1-sol');
});

test('a catalog without a Sol model has no latest Sol', () => {
  assert.equal(latestSolModel([]), undefined);
  assert.equal(latestSolModel(['gpt-6-astra', 'gpt-6.1-sol-mini', 'solar', 'sol']), undefined);
});
