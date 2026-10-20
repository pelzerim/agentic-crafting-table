import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalLocale } from './terminal-locale.ts';

test('GUI terminal launches supply a UTF-8 locale without mutating the parent environment', () => {
  const environment = { PATH: '/usr/bin:/bin', LANG: '', LC_ALL: '', LC_CTYPE: '' };
  assert.deepEqual(terminalLocale(environment, 'darwin'), { ...environment, LANG: 'en_US.UTF-8' });
  assert.equal(environment.LANG, '');
  assert.equal(terminalLocale({}, 'darwin').LANG, 'en_US.UTF-8');
  assert.equal(terminalLocale({}, 'linux').LANG, 'C.UTF-8');
});

test('explicit language, encoding and locale category choices remain intact', () => {
  for (const LANG of ['de_DE.UTF-8', 'ja_JP.UTF-8', 'C', 'en_US.ISO8859-1']) {
    const environment = { LANG, LC_ALL: 'fr_FR.UTF-8', LC_CTYPE: 'UTF-8', LC_TIME: 'de_DE.UTF-8' };
    assert.deepEqual(terminalLocale(environment, 'darwin'), environment);
  }
  assert.equal(terminalLocale({ LC_CTYPE: 'de_DE.UTF-8' }, 'darwin').LC_CTYPE, 'de_DE.UTF-8');
});
