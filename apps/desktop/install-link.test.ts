import test from 'node:test';
import assert from 'node:assert/strict';
import { installLinkArgument, parseInstallLink } from './install-link.ts';

test('an install link names a remote git repository and an optional ref', () => {
  assert.deepEqual(parseInstallLink('act://plugins/install?source=https://github.com/acme/my-plugin-pack.git&ref=v1.0.0'), { source: 'https://github.com/acme/my-plugin-pack.git', ref: 'v1.0.0' });
  assert.deepEqual(parseInstallLink('act://plugins/install?source=https%3A%2F%2Fgithub.com%2Facme%2Fmy-plugin-pack.git&ref=v1.0.0'), { source: 'https://github.com/acme/my-plugin-pack.git', ref: 'v1.0.0' });
  assert.deepEqual(parseInstallLink('act://plugins/install?source=git@github.com:acme/my-plugin-pack.git'), { source: 'git@github.com:acme/my-plugin-pack.git' });
  assert.deepEqual(parseInstallLink('act://plugins/install?ref=0123456789abcdef0123456789abcdef01234567&source=ssh://git@example.com/acme/pack.git'), { source: 'ssh://git@example.com/acme/pack.git', ref: '0123456789abcdef0123456789abcdef01234567' });
});

test('an install link is refused unless it is exactly a plugin install from a remote the install form accepts', () => {
  const refused: [string, RegExp][] = [
    ['act://plugins/remove?source=https://github.com/acme/pack.git', /only plugins\/install/i],
    ['act://settings/install?source=https://github.com/acme/pack.git', /only plugins\/install/i],
    ['act:plugins/install?source=https://github.com/acme/pack.git', /only plugins\/install/i],
    ['act://plugins/install/?source=https://github.com/acme/pack.git', /only plugins\/install/i],
    ['craft://plugins/install?source=https://github.com/acme/pack.git', /not an act:\/\/ link/i],
    ['https://plugins/install?source=https://github.com/acme/pack.git', /not an act:\/\/ link/i],
    ['act://plugins/install', /needs a source/i],
    ['act://plugins/install?source=', /needs a source/i],
    ['act://plugins/install?source=https://github.com/acme/pack.git&source=https://github.com/acme/other.git', /once/i],
    ['act://plugins/install?source=https://github.com/acme/pack.git&ref=v1&ref=v2', /once/i],
    ['act://plugins/install?source=https://github.com/acme/pack.git&commit=abc', /unknown parameter commit/i],
    ['act://plugins/install?source=https://github.com/acme/pack.git#fragment', /cannot carry/i],
    ['act://user:secret@plugins/install?source=https://github.com/acme/pack.git', /cannot carry/i],
    ['act://plugins:8080/install?source=https://github.com/acme/pack.git', /cannot carry/i],
    ['act://plugins/install?source=file:///Users/example/pack.git', /https:\/\/, ssh:\/\/ or git@/i],
    ['act://plugins/install?source=/Users/example/pack.git', /https:\/\/, ssh:\/\/ or git@/i],
    ['act://plugins/install?source=http://example.com/pack.git', /not supported/i],
    ['act://plugins/install?source=ext::sh%20-c%20touch%20x', /git repository URL/i],
    ['act://plugins/install?source=ext::sh', /not supported/i],
    ['act://plugins/install?source=-upload-pack=touch', /cannot start with/i],
    ['act://plugins/install?source=https://token@github.com/acme/pack.git', /credentials/i],
    ['act://plugins/install?source=https://github.com/acme/pack.git&ref=', /branch, tag or commit/i],
    ['act://plugins/install?source=https://github.com/acme/pack.git&ref=--upload-pack=x', /branch, tag or commit/i],
    ['act://plugins/install?source=https://github.com/acme/pack.git&ref=a..b', /branch, tag or commit/i],
    [`act://plugins/install?source=https://github.com/acme/${'a'.repeat(5000)}.git`, /too long/i],
    ['act://plugins/install?source=https://github.com/acme/pack.git\n', /not valid/i],
  ];
  for (const [link, reason] of refused) assert.throws(() => parseInstallLink(link), reason, link);
  for (const input of [undefined, null, 42, {}]) assert.throws(() => parseInstallLink(input), /not an act:\/\/ link/i);
});

test('only an act:// argument counts as an install link on the command line', () => {
  assert.equal(installLinkArgument(['/Applications/App.app/Contents/MacOS/App', '--flag', 'act://plugins/install?source=https://github.com/acme/pack.git']), 'act://plugins/install?source=https://github.com/acme/pack.git');
  assert.equal(installLinkArgument(['app', '.', '--renderer-spike']), undefined);
  assert.equal(installLinkArgument(['app', 'ACT://plugins/install?source=x']), 'ACT://plugins/install?source=x');
});
