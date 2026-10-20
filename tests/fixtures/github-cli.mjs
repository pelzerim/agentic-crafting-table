// Account discovery only; this fixture cannot retrieve tokens or make API calls.
import assert from 'node:assert/strict';
const args = process.argv.slice(2);
assert.equal(args[0], 'auth'); assert.equal(args[1], 'status');
assert.ok(args.includes('--json')); assert.ok(!args.includes('--show-token'));
console.log(JSON.stringify([
  { login: 'fixture-developer', active: true, state: 'success', tokenSource: 'keyring' },
  { login: 'fixture-reviewer', active: false, state: 'success', tokenSource: 'keyring' },
  { login: 'fixture-expired', active: false, state: 'error', tokenSource: 'keyring' },
]));
