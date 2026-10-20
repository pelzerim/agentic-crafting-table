import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorCause } from './error-cause.ts';

test('failure screens name the cause in one line without the raw message', () => {
  assert.equal(errorCause("Error invoking remote method 'workspace:request': SqliteError: database disk image is malformed", 'load'), 'The workspace database couldn’t be read.');
  assert.equal(errorCause('Workspace service did not start (exit 1). See /Users/me/service.log.', 'load'), 'The workspace service didn’t start.');
  assert.equal(errorCause('connect ECONNREFUSED /tmp/agent-crafting-table-1000/abc.sock', 'load'), 'The workspace service isn’t responding.');
  assert.equal(errorCause('Something odd', 'load'), 'Your table couldn’t be loaded.');
  assert.equal(errorCause("Cannot read properties of undefined (reading 'find')", 'render'), 'Part of the window stopped working.');
});
